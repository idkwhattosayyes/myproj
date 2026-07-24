import * as itemsService from "../../services/itemsService.js";
import { createRichTextEditor } from "./richTextEditor.js";
import { showContextMenu } from "./contextMenu.js";
import { openConfirm, openPrompt } from "../../utils/modal.js";
import { escapeHtml, escapeAttr } from "../../utils/dom.js";
import { t } from "../../i18n/i18n.js";
import { consumePendingTarget } from "../../search/searchTarget.js";

// Что сейчас перетаскивается (id + вид). Модульная переменная, т.к. dragstart и
// drop навешиваются на разные элементы, пересоздаваемые при каждом render.
let dragged = null; // { kind: "item" | "folder", id } | null

// История undo/redo хранится вне редактора — иначе она терялась бы при каждом
// пересоздании редактора (переключение заметок). Ключ — id заметки, значение —
// { history, historyIndex }. Держим в памяти сессии и только для последних
// HISTORY_NOTES_LIMIT редактированных заметок: полная история для всех съела бы
// слишком много памяти. Map хранит порядок вставки — самый старый ключ первый.
const HISTORY_NOTES_LIMIT = 5;
const historyStore = new Map();

function saveNoteHistory(itemId, state) {
  historyStore.delete(itemId); // переставить в конец (освежить в LRU)
  historyStore.set(itemId, state);
  while (historyStore.size > HISTORY_NOTES_LIMIT) {
    historyStore.delete(historyStore.keys().next().value);
  }
}

// "Пустая" заметка = в теле нет текста (заголовок не считается). От этого
// зависит, показывать ли крестик мгновенного удаления в списке.
function isItemEmpty(item) {
  const div = document.createElement("div");
  div.innerHTML = item.content || "";
  return div.textContent.trim() === "";
}

function countItemsInFolder(state, folderId) {
  return state.items.filter((i) => i.folderId === folderId).length;
}

// Сколько всего в «Избранном»: считаем только напрямую отмеченные заметки И
// папки. Обычные заметки внутри избранной папки НЕ учитываем — избранное это
// плоский набор по флагу isFavorite, а не содержимое папок.
function countFavorites(state) {
  const items = state.items.filter((i) => i.isFavorite).length;
  const folders = state.folders.filter((f) => f.isFavorite).length;
  return items + folders;
}

/**
 * Переименование прямо в списке: подпись строки превращается в поле ввода, как
 * при переименовании файла в проводнике — без отдельного окна.
 *
 * Enter, Esc и потеря фокуса одинаково ПРИМЕНЯЮТ введённое имя. Esc при этом не
 * всплывает дальше: общий обработчик в app.js иначе снял бы фокус и увёл на
 * главную вместо сохранения.
 *
 * @param {HTMLElement} rowEl строка списка (.folder-item или .item-list-row)
 * @param {string} currentValue
 * @param {(value: string) => void} onCommit вызывается только если имя изменилось
 */
function startInlineRename(rowEl, currentValue, onCommit) {
  const nameEl = rowEl.querySelector(".folder-name, .item-title");
  if (!nameEl) return;

  const input = document.createElement("input");
  input.type = "text";
  input.className = "inline-rename";
  input.value = currentValue;
  nameEl.replaceWith(input);

  // Пока правим имя, строку нельзя тащить — иначе выделение текста мышью
  // превращается в drag-and-drop.
  const wasDraggable = rowEl.draggable;
  rowEl.draggable = false;
  input.focus();
  input.select();

  let finished = false;
  function commit() {
    if (finished) return;
    finished = true;
    rowEl.draggable = wasDraggable;
    const value = input.value.trim();
    if (!value || value === currentValue) {
      input.replaceWith(nameEl);
      return;
    }
    onCommit(value);
  }

  input.addEventListener("keydown", (event) => {
    if (event.key !== "Enter" && event.key !== "Escape") return;
    event.preventDefault();
    event.stopPropagation();
    commit();
  });
  input.addEventListener("blur", commit);
  // Клики внутри поля не должны попадать в обработчики самой строки — иначе
  // правка имени переключала бы выбранную заметку или открывала меню.
  ["mousedown", "click", "dblclick", "contextmenu"].forEach((type) => {
    input.addEventListener(type, (event) => event.stopPropagation());
  });
}

/**
 * Переиспользуемый каркас "папки слева + список заметок + редактор справа",
 * используется и Задачами, и Документами — отличаются только набором кнопок
 * тулбара (config.toolbarButtons) и section-ключом хранения (config.section).
 *
 * @param {HTMLElement} container
 * @param {{section: string, toolbarButtons: string[]}} config
 */
export async function renderPanelSection(container, config) {
  const state = {
    folders: await itemsService.listFolders(config.section),
    items: await itemsService.listItems(config.section),
    selectedFolderId: "all", // "all" | "unfiled" | id папки
    selectedItemId: null,
    foldersCollapsed: false,
    listCollapsed: false,
    pendingMatch: null, // {query, index} — куда прокрутить открытую заметку
    flashFolderId: null, // папка, найденная поиском, — мигнуть ею один раз
  };

  applySearchTarget(state);
  render(container, config, state);
}

// Пришли по результату поиска: открываем нужную папку или заметку. Заметку
// показываем из "Все" — она может лежать в папке, которая сейчас не выбрана.
function applySearchTarget(state) {
  const target = consumePendingTarget("item", "folder");
  if (!target) return;

  if (target.kind === "folder") {
    state.selectedFolderId = target.id;
    state.flashFolderId = target.id;
    return;
  }
  state.selectedFolderId = "all";
  state.selectedItemId = target.id;
  state.pendingMatch = { query: target.query, index: target.matchIndex };
}

function render(container, config, state) {
  // Свёрнутый список заметок не исчезает. Пока панель папок развёрнута — он
  // складывается в неё горизонтальной вкладкой. Но когда и сами папки свёрнуты
  // в полоску, этой вкладке внутри них места нет (её содержимое скрыто вместе с
  // телом папок) — поэтому список показываем отдельной вертикальной полоской
  // рядом. Так обе панели сворачиваются и разворачиваются независимо.
  const listAsTab = state.listCollapsed && !state.foldersCollapsed;
  const listAsStrip = state.listCollapsed && state.foldersCollapsed;

  const listTab = listAsTab
    ? `<button type="button" class="panel-tab" data-action="toggle-list" title="${t("panel.togglePanel")}">
         <span class="panel-tab-title">${escapeHtml(getListTitle(state))}</span>
         <span class="panel-tab-icon">›</span>
       </button>`
    : "";

  const listStrip = listAsStrip
    ? `<button type="button" class="panel-strip panel-strip-list" data-action="toggle-list" title="${escapeAttr(getListTitle(state))}"></button>`
    : "";

  container.innerHTML = `
    <a href="#/" class="back-link">${t("nav.backHome")}</a>
    <div class="panel-layout">
      <aside class="panel panel-folders ${state.foldersCollapsed ? "is-collapsed" : ""}">
        <div class="panel-header">
          <button type="button" class="panel-toggle" data-action="toggle-folders" title="${t("panel.togglePanel")}">☰</button>
          <span class="panel-title">${t("panel.folders")}</span>
        </div>
        ${listTab}
        <div class="panel-body" data-role="folder-body"></div>
      </aside>

      ${listStrip}

      <section class="panel panel-list ${state.listCollapsed ? "is-collapsed" : ""}">
        <div class="panel-header">
          <button type="button" class="panel-toggle" data-action="toggle-list" title="${t("panel.togglePanel")}">☰</button>
          <span class="panel-title" data-role="list-title">${t("panel.all")}</span>
          <button type="button" class="btn btn-small" data-action="new-item" title="${t("panel.newItem")}">+</button>
        </div>
        <div class="panel-body" data-role="list-body"></div>
      </section>

      <section class="panel-detail" data-role="detail"></section>
    </div>
  `;

  renderFolders(container, config, state);
  renderList(container, config, state);
  renderDetail(container, config, state);
  wireHeaderActions(container, config, state);
}

function wireHeaderActions(container, config, state) {
  // Панель папок сворачивается в тонкую полоску у левого края. Нужен полный
  // render: если список тоже свёрнут, его индикатор при сворачивании папок
  // переезжает из вкладки внутри папок в отдельную полоску рядом (и обратно).
  container.querySelector('[data-action="toggle-folders"]').addEventListener("click", () => {
    state.foldersCollapsed = !state.foldersCollapsed;
    render(container, config, state);
  });

  // Список заметок переезжает в панель папок и обратно, поэтому здесь нужен
  // полный render. Кнопок две: в шапке самого списка и вкладка внутри папок.
  container.querySelectorAll('[data-action="toggle-list"]').forEach((btn) => {
    btn.addEventListener("click", () => {
      state.listCollapsed = !state.listCollapsed;
      render(container, config, state);
    });
  });

  // Между строками и над шапками панелей никто перетаскивание не принимает, и
  // браузер рисует там "запрещено" — хотя перемещение разрешено и работает.
  // Объявляем обе панели допустимой зоной: сброс мимо строки просто ничего не делает.
  container.querySelectorAll(".panel-folders, .panel-list").forEach((panel) => {
    panel.addEventListener("dragover", (event) => {
      if (!dragged) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = "move";
    });
    panel.addEventListener("drop", (event) => event.preventDefault());
  });

  container.querySelector('[data-action="new-item"]').addEventListener("click", async () => {
    const folderId = isRealFolderId(state.selectedFolderId) ? state.selectedFolderId : null;
    // В «Избранном» ведём себя как в папке: новая заметка сразу попадает в него.
    const inFavorites = state.selectedFolderId === "favorites";
    const item = await itemsService.createItem(config.section, {
      title: t("panel.untitled"),
      content: "",
      folderId,
      isFavorite: inFavorites,
    });
    state.items = await itemsService.listItems(config.section);
    state.selectedItemId = item.id;
    // Разово попросить деталь поставить курсор в поле названия — чтобы печатать
    // сразу, без клика мышкой.
    state.focusTitleOnCreate = true;
    render(container, config, state);
  });
}

function isRealFolderId(id) {
  return id && id !== "all" && id !== "unfiled" && id !== "favorites";
}

// Ниже или выше строки встанет перетаскиваемый элемент — по тому, в какую
// половину строки указывает курсор. Без этого вставка всегда шла ПЕРЕД целью и
// последняя позиция списка оставалась недостижимой.
function isDropAfter(el, event) {
  const rect = el.getBoundingClientRect();
  return event.clientY > rect.top + rect.height / 2;
}

function markDropSide(el, after) {
  el.classList.toggle("is-drop-before", !after);
  el.classList.toggle("is-drop-after", after);
}

function clearDropMarks(el) {
  el.classList.remove("is-drop-target", "is-drop-before", "is-drop-after");
}

// Значки у строки: сердечко избранного и булавка закрепления. Оба свойства
// глобальные, поэтому показываем везде (pinActive у заметок теперь всегда true; у
// папок закрепление тоже глобальное). Закреплённые поднимаются наверх списка.
function rowBadges(entity, pinActive) {
  const heart = entity.isFavorite ? `<span class="fav-heart" title="${t("panel.favorites")}">♥</span>` : "";
  // Булавка — инлайн-SVG с fill="currentColor": цвет задаём в CSS (#C2D1C9), как у
  // сердечка. Эмодзи 📌 не красится, поэтому именно SVG.
  const pin = pinActive && entity.pinned
    ? `<span class="pin-badge" title="${t("panel.pinned")}"><svg viewBox="0 0 16 16" width="11" height="11" aria-hidden="true"><path fill="currentColor" d="M8 1c-2.5 0-4.5 2-4.5 4.5 0 3.4 4.5 9 4.5 9s4.5-5.6 4.5-9C12.5 3 10.5 1 8 1zm0 6.2a1.7 1.7 0 1 1 0-3.4 1.7 1.7 0 0 1 0 3.4z"/></svg></span>`
    : "";
  return heart + pin;
}

// Закреплённые — наверх, остальные ниже. Стабильно: массив приходит уже
// отсортированным по order, а фильтры сохраняют порядок, поэтому внутри каждой
// группы относительный порядок (в т.ч. порядок среди закреплённых) не рушится.
function sortPinnedFirst(list) {
  return [...list.filter((e) => e.pinned), ...list.filter((e) => !e.pinned)];
}

function renderFolders(container, config, state) {
  const bodyEl = container.querySelector('[data-role="folder-body"]');

  bodyEl.innerHTML = `
    <ul class="folder-list">
      <li class="folder-item ${state.selectedFolderId === "favorites" ? "is-active" : ""}" data-folder-id="favorites">
        <span class="folder-name">${t("panel.favorites")}</span>
        <span class="folder-count">(${countFavorites(state)})</span>
      </li>
      <li class="folder-item ${state.selectedFolderId === "all" ? "is-active" : ""}" data-folder-id="all">${t("panel.all")}</li>
      <li class="folder-item ${state.selectedFolderId === "unfiled" ? "is-active" : ""}" data-folder-id="unfiled">${t("panel.unfiled")}</li>
      ${sortPinnedFirst(state.folders)
        .map((folder) => {
          const count = countItemsInFolder(state, folder.id);
          return `
        <li class="folder-item ${state.selectedFolderId === folder.id ? "is-active" : ""} ${folder.pinned ? "is-pinned" : ""}" data-folder-id="${folder.id}" draggable="true">
          <span class="folder-name">${escapeHtml(folder.name)}</span>
          ${rowBadges(folder, true)}
          <span class="folder-count">(${count})</span>
          ${count === 0 ? `<button type="button" class="folder-delete" data-delete-folder="${folder.id}" title="${t("panel.deleteFolder")}">✕</button>` : ""}
        </li>`;
        })
        .join("")}
    </ul>
  `;

  // Пришли из поиска: показываем, какая именно папка нашлась. Метка одноразовая.
  if (state.flashFolderId) {
    const found = bodyEl.querySelector(`[data-folder-id="${state.flashFolderId}"]`);
    if (found) found.classList.add("is-search-flash");
    state.flashFolderId = null;
  }

  bodyEl.querySelectorAll("[data-folder-id]").forEach((el) => {
    const folderId = el.dataset.folderId;

    el.addEventListener("click", () => {
      state.selectedFolderId = folderId;
      state.selectedItemId = null;
      render(container, config, state);
    });

    // Настоящие папки можно тащить; псевдо-папки — нет.
    if (isRealFolderId(folderId)) {
      el.addEventListener("dragstart", (event) => {
        dragged = { kind: "folder", id: folderId };
        event.dataTransfer.effectAllowed = "move";
        // Перетаскивание без данных браузер считает неполноценным и рисует
        // курсор "запрещено", даже когда цель готова принять сброс.
        event.dataTransfer.setData("text/plain", folderId);
      });
      el.addEventListener("dragend", () => {
        dragged = null;
      });
    }

    // Приёмники drop: реальные папки, "Без папки" и "Избранное".
    if (isRealFolderId(folderId) || folderId === "unfiled" || folderId === "favorites") {
      wireFolderDropTarget(el, folderId, container, config, state);
    }

    // ПКМ по настоящей папке: избранное + удаление (для непустых — единственный способ).
    if (isRealFolderId(folderId)) {
      el.addEventListener("contextmenu", (event) => {
        event.preventDefault();
        event.stopPropagation();
        const folder = state.folders.find((f) => f.id === folderId);
        showContextMenu(event.clientX, event.clientY, [
          {
            label: t("panel.rename"),
            onClick: () => {
              startInlineRename(el, folder.name, async (name) => {
                await itemsService.updateFolder(folder.id, { name });
                state.folders = await itemsService.listFolders(config.section);
                render(container, config, state);
              });
            },
          },
          {
            label: folder.isFavorite ? t("panel.removeFromFavorites") : t("panel.addToFavorites"),
            onClick: async () => {
              await itemsService.updateFolder(folder.id, { isFavorite: !folder.isFavorite });
              state.folders = await itemsService.listFolders(config.section);
              render(container, config, state);
            },
          },
          {
            label: folder.pinned ? t("panel.unpin") : t("panel.pin"),
            onClick: async () => {
              await itemsService.updateFolder(folder.id, { pinned: !folder.pinned });
              state.folders = await itemsService.listFolders(config.section);
              render(container, config, state);
            },
          },
          {
            label: t("panel.delete"),
            onClick: () => deleteFolderFlow(folder.id, container, config, state, true),
          },
        ]);
      });
    }
  });

  // Крестик виден только у пустой папки — удаляет мгновенно, без подтверждения.
  bodyEl.querySelectorAll("[data-delete-folder]").forEach((btn) => {
    btn.addEventListener("click", async (event) => {
      event.stopPropagation();
      await deleteFolderFlow(btn.dataset.deleteFolder, container, config, state, false);
    });
  });

  bodyEl.addEventListener("contextmenu", (event) => {
    event.preventDefault();
    showContextMenu(event.clientX, event.clientY, [
      {
        label: t("panel.newFolder"),
        onClick: async () => {
          const name = await openPrompt({ message: t("panel.folderNamePrompt") });
          if (!name || !name.trim()) return;
          await itemsService.createFolder(config.section, name.trim());
          state.folders = await itemsService.listFolders(config.section);
          render(container, config, state);
        },
      },
    ]);
  });
}

// confirm=true — спросить подтверждение (удаление непустой папки через ПКМ);
// confirm=false — мгновенное удаление пустой папки по крестику.
async function deleteFolderFlow(folderId, container, config, state, confirm) {
  if (confirm) {
    const ok = await openConfirm({ message: t("panel.deleteFolderConfirm") });
    if (!ok) return;
  }
  await itemsService.deleteFolder(config.section, folderId);
  state.folders = await itemsService.listFolders(config.section);
  state.items = await itemsService.listItems(config.section);
  if (state.selectedFolderId === folderId) state.selectedFolderId = "all";
  render(container, config, state);
}

// Навешивает dragover/drop на папку-приёмник. Поведение зависит от того, что
// тащат (заметку или папку) и на какую цель (реальную папку / "Без папки" / "Избранное").
function wireFolderDropTarget(el, folderId, container, config, state) {
  el.addEventListener("dragover", (event) => {
    if (!dragged) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
    // Папку на папку — переупорядочивание, поэтому показываем линию сверху или
    // снизу. Заметку на папку — "положить внутрь", подсвечиваем строку целиком.
    if (dragged.kind === "folder" && isRealFolderId(folderId)) markDropSide(el, isDropAfter(el, event));
    else el.classList.add("is-drop-target");
  });
  el.addEventListener("dragleave", () => clearDropMarks(el));
  el.addEventListener("drop", async (event) => {
    event.preventDefault();
    const after = isDropAfter(el, event);
    clearDropMarks(el);
    if (!dragged) return;
    const drop = dragged;
    dragged = null;

    if (folderId === "favorites") {
      // Заметку или папку — в избранное.
      if (drop.kind === "item") await itemsService.updateItem(drop.id, { isFavorite: true });
      else await itemsService.updateFolder(drop.id, { isFavorite: true });
    } else if (folderId === "unfiled") {
      // Только заметку — вынуть из папки.
      if (drop.kind === "item") await itemsService.updateItem(drop.id, { folderId: null });
    } else if (drop.kind === "item") {
      // Заметку — в эту папку.
      await itemsService.updateItem(drop.id, { folderId });
    } else if (drop.kind === "folder" && drop.id !== folderId) {
      // Папку на папку — переупорядочить.
      await reorderFolder(drop.id, folderId, state, after);
    }

    state.folders = await itemsService.listFolders(config.section);
    state.items = await itemsService.listItems(config.section);
    render(container, config, state);
  });
}

// Переставляет папку draggedId рядом с targetId — перед ней или после неё, —
// затем переназначает order = index всем папкам и сохраняет.
async function reorderFolder(draggedId, targetId, state, after) {
  const arr = state.folders;
  const from = arr.findIndex((f) => f.id === draggedId);
  if (from < 0) return;
  const [moved] = arr.splice(from, 1);
  // Индекс цели ищем уже после удаления перетаскиваемой папки — сдвиг учтён.
  const to = arr.findIndex((f) => f.id === targetId);
  arr.splice(after ? to + 1 : to, 0, moved);
  for (let i = 0; i < arr.length; i++) {
    if (arr[i].order !== i) await itemsService.updateFolder(arr[i].id, { order: i });
  }
}

function renderList(container, config, state) {
  const bodyEl = container.querySelector('[data-role="list-body"]');
  const titleEl = container.querySelector('[data-role="list-title"]');
  const items = getFilteredItems(state);
  // В разделе "Избранное" папки не являются заметками — показываем их
  // отдельными строками-ссылками сверху, клик по ним просто переключает
  // на эту папку в обычном виде (у папки нет собственного контента).
  const favFolders = state.selectedFolderId === "favorites" ? state.folders.filter((f) => f.isFavorite) : [];
  const isEmpty = !favFolders.length && !items.length;
  // Закрепление заметок глобальное: булавка, оттенок и подъём наверх работают во
  // всех видах списка (Все / Без папки / Избранное / конкретная папка).
  const pinActive = true;

  titleEl.textContent = getListTitle(state);

  bodyEl.innerHTML = `
    <ul class="item-list">
      ${favFolders
        .map((folder) => `<li class="item-list-row" data-jump-folder-id="${folder.id}">${escapeHtml(folder.name)}</li>`)
        .join("")}
      ${items
        .map((item) => {
          const empty = isItemEmpty(item);
          return `
        <li class="item-list-row ${state.selectedItemId === item.id ? "is-active" : ""} ${pinActive && item.pinned ? "is-pinned" : ""}" data-item-id="${item.id}" draggable="true">
          <span class="item-title">${escapeHtml(item.title || t("panel.untitled"))}</span>
          ${rowBadges(item, pinActive)}
          ${empty ? `<button type="button" class="item-delete" data-delete-item="${item.id}" title="${t("panel.delete")}">✕</button>` : ""}
        </li>`;
        })
        .join("")}
      ${isEmpty ? `<li class="placeholder">${t("panel.empty")}</li>` : ""}
    </ul>
  `;

  bodyEl.querySelectorAll("[data-item-id]").forEach((el) => {
    const itemId = el.dataset.itemId;

    el.addEventListener("click", () => {
      state.selectedItemId = itemId;
      render(container, config, state);
    });

    el.addEventListener("dragstart", (event) => {
      dragged = { kind: "item", id: itemId };
      event.dataTransfer.effectAllowed = "move";
      event.dataTransfer.setData("text/plain", itemId);
    });
    el.addEventListener("dragend", () => {
      dragged = null;
    });

    // Заметка-приёмник: только переупорядочивание заметок.
    el.addEventListener("dragover", (event) => {
      if (!dragged || dragged.kind !== "item" || dragged.id === itemId) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = "move";
      markDropSide(el, isDropAfter(el, event));
    });
    el.addEventListener("dragleave", () => clearDropMarks(el));
    el.addEventListener("drop", async (event) => {
      clearDropMarks(el);
      if (!dragged || dragged.kind !== "item" || dragged.id === itemId) return;
      event.preventDefault();
      const after = isDropAfter(el, event);
      const draggedId = dragged.id;
      dragged = null;
      await reorderItem(draggedId, itemId, state, after);
      state.items = await itemsService.listItems(config.section);
      render(container, config, state);
    });

    el.addEventListener("contextmenu", (event) => {
      event.preventDefault();
      const item = state.items.find((i) => i.id === itemId);
      showContextMenu(event.clientX, event.clientY, [
        {
          label: t("panel.rename"),
          onClick: () => {
            startInlineRename(el, item.title, async (title) => {
              await itemsService.updateItem(item.id, { title });
              state.items = await itemsService.listItems(config.section);
              render(container, config, state);
            });
          },
        },
        {
          label: item.isFavorite ? t("panel.removeFromFavorites") : t("panel.addToFavorites"),
          onClick: async () => {
            await itemsService.updateItem(item.id, { isFavorite: !item.isFavorite });
            state.items = await itemsService.listItems(config.section);
            render(container, config, state);
          },
        },
        {
          label: item.pinned ? t("panel.unpin") : t("panel.pin"),
          onClick: async () => {
            await itemsService.updateItem(item.id, { pinned: !item.pinned });
            state.items = await itemsService.listItems(config.section);
            render(container, config, state);
          },
        },
        {
          label: t("panel.delete"),
          onClick: () => deleteItemFlow(item.id, container, config, state, true),
        },
      ]);
    });
  });

  // Крестик виден только у пустой заметки — удаляет мгновенно.
  bodyEl.querySelectorAll("[data-delete-item]").forEach((btn) => {
    btn.addEventListener("click", async (event) => {
      event.stopPropagation();
      await deleteItemFlow(btn.dataset.deleteItem, container, config, state, false);
    });
  });

  bodyEl.querySelectorAll("[data-jump-folder-id]").forEach((el) => {
    el.addEventListener("click", () => {
      state.selectedFolderId = el.dataset.jumpFolderId;
      state.selectedItemId = null;
      render(container, config, state);
    });
  });
}

async function deleteItemFlow(itemId, container, config, state, confirm) {
  if (confirm) {
    const ok = await openConfirm({ message: t("panel.deleteItemConfirm") });
    if (!ok) return;
  }
  await itemsService.deleteItem(itemId);
  state.items = await itemsService.listItems(config.section);
  if (state.selectedItemId === itemId) state.selectedItemId = null;
  render(container, config, state);
}

// Переставляет заметку draggedId перед targetId или после неё, переназначает
// order всем и сохраняет.
async function reorderItem(draggedId, targetId, state, after) {
  const arr = state.items;
  const from = arr.findIndex((i) => i.id === draggedId);
  if (from < 0) return;
  const [moved] = arr.splice(from, 1);
  // Индекс цели ищем уже после удаления перетаскиваемой заметки — сдвиг учтён.
  const to = arr.findIndex((i) => i.id === targetId);
  arr.splice(after ? to + 1 : to, 0, moved);
  for (let i = 0; i < arr.length; i++) {
    if (arr[i].order !== i) await itemsService.updateItem(arr[i].id, { order: i });
  }
}

function getFilteredItems(state) {
  // Закреплённые заметки поднимаются наверх в любом виде списка.
  if (state.selectedFolderId === "favorites") return sortPinnedFirst(state.items.filter((item) => item.isFavorite));
  if (state.selectedFolderId === "unfiled") return sortPinnedFirst(state.items.filter((item) => !item.folderId));
  if (state.selectedFolderId === "all") return sortPinnedFirst(state.items);
  return sortPinnedFirst(state.items.filter((item) => item.folderId === state.selectedFolderId));
}

function getListTitle(state) {
  if (state.selectedFolderId === "favorites") return t("panel.favorites");
  if (state.selectedFolderId === "all") return t("panel.all");
  if (state.selectedFolderId === "unfiled") return t("panel.unfiled");
  const folder = state.folders.find((f) => f.id === state.selectedFolderId);
  return folder ? folder.name : "";
}

function renderDetail(container, config, state) {
  const detailEl = container.querySelector('[data-role="detail"]');
  const item = state.items.find((i) => i.id === state.selectedItemId);

  if (!item) {
    detailEl.innerHTML = `<p class="placeholder">${t("panel.selectPrompt")}</p>`;
    return;
  }

  // Порядок в детали заметки: тулбар сверху -> название -> текст.
  detailEl.innerHTML = `
    <div class="item-detail">
      <div class="rte-toolbar-host" data-role="toolbar-host"></div>
      <div class="item-detail-titlebar">
        <input type="text" class="item-title-input" data-role="title-input">
        <button type="button" class="btn btn-danger btn-small" data-action="delete-item">${t("panel.delete")}</button>
      </div>
      <div data-role="content-host"></div>
    </div>
  `;

  // Debounce на сохранение — свой на каждое открытие заметки, чтобы правки
  // разных полей не перетирали друг друга и не утекали в чужую заметку при
  // быстром переключении.
  let pendingPatch = {};
  let saveTimer = null;

  function scheduleSave(patch) {
    Object.assign(item, patch);
    Object.assign(pendingPatch, patch);
    renderList(container, config, state);
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      const toSave = pendingPatch;
      pendingPatch = {};
      itemsService.updateItem(item.id, toSave);
    }, 400);
  }

  const editor = createRichTextEditor({
    content: item.content,
    buttons: config.toolbarButtons,
    pageMode: item.pageMode,
    onChange: (html) => scheduleSave({ content: html }),
    onPageModeChange: (mode) => scheduleSave({ pageMode: mode }),
    // История undo/redo привязана к id заметки и переживает выход/повторный вход.
    initialHistory: historyStore.get(item.id) || null,
    onHistoryChange: (histState) => saveNoteHistory(item.id, histState),
    // Раздел без кнопки режима в тулбаре (Заметки): переключать вид можно только
    // по ПКМ внутри открытой заметки. Пункт отдаём редактору, а не вешаем своё
    // меню — иначе поверх его меню открывалось бы второе. У строк списка слева
    // своё меню, расширенная опция туда намеренно не попадает.
    getExtraMenuItems: config.pageModeInContextMenu
      ? () => [
          {
            label: editor.getPageMode() === "paged" ? t("editor.pageModeFlow") : t("editor.pageModePaged"),
            onClick: () => editor.togglePageMode(),
          },
        ]
      : null,
  });
  const { toolbarEl, contentEl } = editor;
  detailEl.querySelector('[data-role="toolbar-host"]').appendChild(toolbarEl);
  detailEl.querySelector('[data-role="content-host"]').appendChild(contentEl);
  // Высота страниц считается по реальным размерам — только после вставки в DOM.
  editor.refreshLayout();

  // Пришли из поиска — прокручиваем к найденному и мигаем им. Цель одноразовая:
  // следующая перерисовка (правка, переключение папки) прыгать уже не должна.
  if (state.pendingMatch) {
    editor.highlightMatch(state.pendingMatch.query, state.pendingMatch.index);
    state.pendingMatch = null;
  }

  const titleInput = detailEl.querySelector('[data-role="title-input"]');
  titleInput.value = item.title;
  // Только что созданная заметка: ставим курсор в название и выделяем текст,
  // чтобы сразу печатать. Флаг одноразовый — при открытии существующей заметки
  // фокус не воруем.
  if (state.focusTitleOnCreate) {
    state.focusTitleOnCreate = false;
    titleInput.focus();
    titleInput.select();
  }
  titleInput.addEventListener("input", () => scheduleSave({ title: titleInput.value }));
  titleInput.addEventListener("keydown", (event) => {
    if (event.key !== "Enter") return;
    event.preventDefault();
    editor.focusContent();
  });

  detailEl.querySelector('[data-action="delete-item"]').addEventListener("click", async () => {
    const ok = await openConfirm({ message: t("panel.deleteItemConfirm") });
    if (!ok) return;
    clearTimeout(saveTimer);
    await itemsService.deleteItem(item.id);
    state.items = await itemsService.listItems(config.section);
    state.selectedItemId = null;
    render(container, config, state);
  });
}
