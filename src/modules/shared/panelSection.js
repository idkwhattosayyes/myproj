import * as itemsService from "../../services/itemsService.js";
import { createRichTextEditor } from "./richTextEditor.js";
import { showContextMenu } from "./contextMenu.js";
import { openConfirm, openPrompt } from "../../utils/modal.js";
import { escapeHtml, escapeAttr } from "../../utils/dom.js";
import { t } from "../../i18n/i18n.js";
import { consumePendingTarget } from "../../search/searchTarget.js";
import { pushLayer } from "../../utils/escapeLayers.js";

// Что сейчас перетаскивается (id + вид) — используется только заметками.
// Перетаскивание папок полностью кастомное (mousedown/mousemove/mouseup в
// renderFolders) и ведёт собственное состояние внутри замыкания, эту
// переменную не трогает. Модульная переменная, т.к. dragstart и drop заметок
// навешиваются на разные элементы, пересоздаваемые при каждом render.
let dragged = null; // { kind: "item", id } | null

// Ссылка на смонтированный сейчас раздел — чтобы внешние источники (быстрая
// заметка) могли попросить обновить список без перемонтирования. { container,
// config, state } или null. См. refreshActivePanelItems.
let activePanel = null;

// Подчищает курсор "запрещено" везде, куда бы курсор ни попал во время
// внутреннего drag (над редактором, шапкой, фоном страницы) — локальные
// dragover в панелях папок/списка (см. wireHeaderActions) покрывают только
// сами панели, это подстраховка на случай, когда курсор оказывается вне них.
document.addEventListener("dragover", (event) => {
  if (!dragged) return;
  event.preventDefault();
  event.dataTransfer.dropEffect = "move";
});
document.addEventListener("drop", (event) => {
  if (!dragged) return;
  event.preventDefault();
});

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
  return div.textContent.trim() === "" && !div.querySelector("img");
}

// Сколько всего внутри папки — заметки и вложенные папки вместе. Тот же
// счётчик используется и как условие показа кнопки мгновенного удаления
// (пустой считается только папка без заметок и без вложенных папок).
function countFolderContents(state, folderId) {
  return state.items.filter((i) => i.folderIds.includes(folderId)).length + childFoldersOf(state, folderId).length;
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
 * используется разделом Notes (config.section всегда "notes").
 *
 * @param {HTMLElement} container
 * @param {{section: string, toolbarButtons: string[], basicToolbarButtons?: string[], pageModeInContextMenu?: boolean}} config
 */
export async function renderPanelSection(container, config) {
  const state = {
    folders: await itemsService.listFolders(config.section),
    items: await itemsService.listItems(config.section),
    trash: await itemsService.listTrash(config.section),
    selectedFolderId: "all", // "all" | "unfiled" | "trash" | id папки
    selectedItemId: null,
    // Что показано в детали справа, если это удалённый элемент — { kind, id }.
    // Приоритетнее selectedItemId (см. renderDetail), сбрасывается при выборе
    // обычной заметки. Раздел "Корзина" в списке слева можно просто открыть, не
    // трогая деталь — как и обычные папки; конкретную строку внутри выбирают отдельно.
    selectedTrash: null,
    foldersCollapsed: false,
    listCollapsed: false,
    pendingMatch: null, // {query, index} — куда прокрутить открытую заметку
    flashFolderId: null, // папка, найденная поиском, — мигнуть ею один раз
    expandedFolderIds: new Set(), // какие папки сейчас раскрыты деревом дочерних
  };

  applySearchTarget(state);
  activePanel = { container, config, state };
  render(container, config, state);
}

// Просьба извне (быстрая заметка) обновить список открытого раздела, не трогая
// открытую справа заметку. Если раздел Notes сейчас не смонтирован
// (открыта главная/календарь) — тихо ничего не делаем (guard по наличию списка в
// DOM), заметка просто останется сохранённой в фоне.
export async function refreshActivePanelItems() {
  if (!activePanel) return;
  const { container, config, state } = activePanel;
  if (!container.querySelector('[data-role="list-body"]')) return;
  state.items = await itemsService.listItems(config.section);
  state.folders = await itemsService.listFolders(config.section);
  renderFolders(container, config, state);
  renderList(container, config, state);
}

// Пришли по результату поиска (или по кастомному кружку главной страницы):
// открываем нужную папку или заметку. Заметку без явного target.folderId
// показываем из "Все" — она может лежать в папке, которая сейчас не выбрана.
// target.folderId (кружок главной знает, через какую папку заметку открыли)
// используем, только если папка ещё существует — иначе тоже откатываемся к "Все".
function applySearchTarget(state) {
  const target = consumePendingTarget("item", "folder");
  if (!target) return;

  if (target.kind === "folder") {
    state.selectedFolderId = target.id;
    state.flashFolderId = target.id;
    return;
  }
  const folderIsValid = target.folderId === "unfiled" || state.folders.some((f) => f.id === target.folderId);
  state.selectedFolderId = folderIsValid ? target.folderId : "all";
  state.selectedItemId = target.id;
  state.pendingMatch = { query: target.query, index: target.matchIndex, photoIndex: target.photoIndex };
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
    const folderIds = isRealFolderId(state.selectedFolderId) ? [state.selectedFolderId] : [];
    // В «Избранном» ведём себя как в папке: новая заметка сразу попадает в него.
    const inFavorites = state.selectedFolderId === "favorites";
    const item = await itemsService.createItem(config.section, {
      title: t("panel.untitled"),
      content: "",
      folderIds,
      isFavorite: inFavorites,
    });
    state.items = await itemsService.listItems(config.section);
    state.selectedItemId = item.id;
    state.selectedTrash = null;
    // Разово попросить деталь поставить курсор в поле названия — чтобы печатать
    // сразу, без клика мышкой.
    state.focusTitleOnCreate = true;
    render(container, config, state);
  });
}

function isRealFolderId(id) {
  return id && id !== "all" && id !== "unfiled" && id !== "favorites" && id !== "trash";
}

function countTrash(state) {
  return state.trash.folders.length + state.trash.items.length;
}

// Перечитывает папки/заметки/корзину и делает полный render. Общая точка после
// любой операции с Корзиной (удаление в неё, восстановление, удаление навсегда,
// очистка) — счётчик и видимость раздела "Корзина" должны обновиться сразу.
async function refreshTrashState(container, config, state) {
  state.trash = await itemsService.listTrash(config.section);
  state.folders = await itemsService.listFolders(config.section);
  state.items = await itemsService.listItems(config.section);
  // Корзина опустела, пока была открыта, — раздел исчезнет из списка слева,
  // самим собой оставаться в нём было бы некуда.
  if (state.selectedFolderId === "trash" && countTrash(state) === 0) {
    state.selectedFolderId = "all";
  }
  render(container, config, state);
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
  el.classList.remove("is-drop-target", "is-drop-before", "is-drop-after", "is-drop-into");
}

// Правые 20% ширины строки — зона «вложить папку в папку». Левее — обычная
// логика «до/после» для переупорядочивания.
function isDropInto(el, event) {
  const rect = el.getBoundingClientRect();
  return event.clientX >= rect.right - rect.width * 0.2;
}

// Значки у строки: сердечко избранного и булавка закрепления. showPin — показывать
// ли булавку в текущем контексте: у папок закрепление глобальное (folder.pinned), у
// заметок — своё для каждого места показа (см. isPinnedIn).
function rowBadges(entity, showPin) {
  const heart = entity.isFavorite ? `<span class="fav-heart" title="${t("panel.favorites")}">♥</span>` : "";
  // Булавка — инлайн-SVG с fill="currentColor": цвет задаём в CSS (#C2D1C9), как у
  // сердечка. Эмодзи 📌 не красится, поэтому именно SVG.
  const pin = showPin
    ? `<span class="pin-badge" title="${t("panel.pinned")}"><svg viewBox="0 0 16 16" width="11" height="11" aria-hidden="true"><path fill="currentColor" d="M8 1c-2.5 0-4.5 2-4.5 4.5 0 3.4 4.5 9 4.5 9s4.5-5.6 4.5-9C12.5 3 10.5 1 8 1zm0 6.2a1.7 1.7 0 1 1 0-3.4 1.7 1.7 0 0 1 0 3.4z"/></svg></span>`
    : "";
  return heart + pin;
}

// Закреплена ли заметка в конкретном месте показа (ключ: "all"/"favorites"/
// "unfiled"/id папки). Закрепление независимо для каждого места.
function isPinnedIn(item, locationKey) {
  return Array.isArray(item.pinnedIn) && item.pinnedIn.includes(locationKey);
}

// Закреплённые — наверх, остальные ниже. Стабильно: массив приходит уже
// отсортированным по order, а фильтры сохраняют порядок, поэтому внутри каждой
// группы относительный порядок (в т.ч. порядок среди закреплённых) не рушится.
// Для папок закрепление глобальное (folder.pinned).
function sortPinnedFirst(list) {
  return [...list.filter((e) => e.pinned), ...list.filter((e) => !e.pinned)];
}

// То же для заметок, но закрепление берётся для конкретного места показа.
function sortItemsByPin(list, locationKey) {
  return [...list.filter((e) => isPinnedIn(e, locationKey)), ...list.filter((e) => !isPinnedIn(e, locationKey))];
}

// Прямые дети parentId, отсортированные по общему order (отдельного
// per-parent порядка не заводим — DnD-реордер внутри дерева не нужен, только
// вложение и сворачивание/разворачивание).
function childFoldersOf(state, parentId) {
  return state.folders
    .filter((f) => (f.parentFolderIds || []).includes(parentId))
    .sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
}

// Каждый следующий уровень вложенности добавляет МЕНЬШЕ пикселей, чем
// предыдущий — иначе глубокая вложенность съедала бы всю ширину узкой панели.
const INDENT_STEPS = [18, 13, 9, 6, 4]; // px; после исчерпания — фиксированный шаг 4px
function indentForDepth(depth) {
  let total = 0;
  for (let i = 0; i < depth; i++) total += INDENT_STEPS[Math.min(i, INDENT_STEPS.length - 1)];
  return total;
}

// Строка папки + (если раскрыта) рекурсивно отрисованные дети сразу под ней, в
// том же плоском <ul> — существующий querySelectorAll("[data-folder-id]")
// после рендера продолжает находить все строки одним проходом. parentContext —
// id родителя, ПОД которым сейчас показана эта строка (для строк дерева), null
// для строки из обычного плоского списка. chain — цепочка предков текущей
// ветки рендера, защита от бесконечной рекурсии при данных, испорченных в
// обход itemsService (например, вручную через localStorage).
function renderFolderRow(folder, state, depth, parentContext, chain) {
  const count = countFolderContents(state, folder.id);
  const isExpanded = state.expandedFolderIds.has(folder.id);
  // Одна и та же папка может отрендериться несколько раз (в общем списке и в
  // поддеревьях разных родителей) — в поддереве подсветка выбора должна быть
  // заметно мягче, иначе непонятно, где основной раздел, а где подраздел.
  const isSelected = state.selectedFolderId === folder.id;
  const activeClass = isSelected ? (parentContext ? "is-active-nested" : "is-active") : "";
  const row = `
    <li class="folder-item is-draggable ${activeClass} ${folder.pinned ? "is-pinned" : ""}"
        data-folder-id="${folder.id}"
        ${parentContext ? `data-parent-context="${parentContext}"` : ""}
        style="padding-left: ${indentForDepth(depth)}px">
      <span class="folder-name">${escapeHtml(folder.name)}</span>
      ${rowBadges(folder, folder.pinned)}
      <span class="folder-count">(${count})</span>
      ${count === 0 ? `<button type="button" class="folder-delete" data-delete-folder="${folder.id}" title="${t("panel.deleteFolder")}">✕</button>` : ""}
    </li>`;
  const childrenHtml = isExpanded
    ? childFoldersOf(state, folder.id)
        .filter((child) => !chain.includes(child.id))
        .map((child) => renderFolderRow(child, state, depth + 1, folder.id, [...chain, folder.id]))
        .join("")
    : "";
  return row + childrenHtml;
}

function renderFolders(container, config, state) {
  const bodyEl = container.querySelector('[data-role="folder-body"]');

  const trashCount = countTrash(state);

  bodyEl.innerHTML = `
    <ul class="folder-list">
      ${trashCount > 0
        ? `<li class="folder-item ${state.selectedFolderId === "trash" ? "is-active" : ""}" data-folder-id="trash">
        <span class="folder-name">${t("panel.trash")}</span>
        <span class="folder-count">(${trashCount})</span>
      </li>`
        : ""}
      <li class="folder-item ${state.selectedFolderId === "favorites" ? "is-active" : ""}" data-folder-id="favorites">
        <span class="folder-name">${t("panel.favorites")}</span>
        <span class="folder-count">(${countFavorites(state)})</span>
      </li>
      <li class="folder-item ${state.selectedFolderId === "all" ? "is-active" : ""}" data-folder-id="all">${t("panel.all")}</li>
      <li class="folder-item ${state.selectedFolderId === "unfiled" ? "is-active" : ""}" data-folder-id="unfiled">${t("panel.unfiled")}</li>
      ${sortPinnedFirst(state.folders)
        .map((folder) => renderFolderRow(folder, state, 0, null, [folder.id]))
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
      // Клик по папке меняет только список заметок; открытую справа заметку не
      // закрываем. Перерисовываем лишь панели папок и списка — полный render()
      // пересоздал бы редактор и сбросил каретку/прокрутку.
      const folderChanged = state.selectedFolderId !== folderId;
      state.selectedFolderId = folderId;
      // Если у папки есть дети — тот же клик тоглит раскрытие её поддерева
      // (отдельной кнопки-шеврона нет, выбор и раскрытие совмещены).
      const hasChildren = isRealFolderId(folderId) && childFoldersOf(state, folderId).length > 0;
      if (hasChildren) {
        if (state.expandedFolderIds.has(folderId)) state.expandedFolderIds.delete(folderId);
        else state.expandedFolderIds.add(folderId);
      }
      renderFolders(container, config, state);
      // Раскрытие/сворачивание не должно трогать notes/documents и открытый
      // редактор — список справа перерисовываем только если реально сменилась
      // выбранная папка, а не просто её раскрытое состояние (повторный клик).
      if (folderChanged) renderList(container, config, state);
    });

    // Настоящие папки можно тащить; псевдо-папки — нет. Кастомный drag на
    // mousedown/mousemove/mouseup: нативный HTML5 DnD для папок убран — браузер
    // рисовал перетаскиваемую картинку с острыми углами и курсор "запрещено", и
    // убрать эти артефакты, оставаясь на нативном API, не получалось. Заметки
    // по-прежнему перетаскиваются нативно — там это не мешало и трогать не просили.
    if (isRealFolderId(folderId)) {
      el.addEventListener("mousedown", (event) => {
        if (event.button !== 0) return;
        // Идёт переименование прямо в строке (см. startInlineRename) — не мешаем
        // выделять текст в поле мышью.
        if (event.target.closest(".inline-rename")) return;
        event.preventDefault();

        const startX = event.clientX;
        const startY = event.clientY;
        const DRAG_THRESHOLD = 4; // px — как порог нативного DnD

        let dragging = false;
        let ghost = null;
        let offsetX = 0;
        let offsetY = 0;
        let unregisterLayer = null;
        let lastHighlighted = null; // строка, у которой сейчас висят is-drop-* классы

        function suppressNextClick(clickEvent) {
          // Вешается на document (НЕ на el) с capture: true. Для двух слушателей
          // на ОДНОМ узле порядок — это порядок подписки, а не capture-флаг;
          // обычный click-обработчик строки подписан раньше (при renderFolders),
          // и на самом el suppressor выполнился бы ПОСЛЕ него. На предке
          // (document) capture-фаза гарантированно отрабатывает раньше, чем
          // событие вообще дойдёт до el.
          clickEvent.stopPropagation();
          clickEvent.preventDefault();
        }

        function suppressContextMenu(menuEvent) {
          // ПКМ второй кнопкой, пока зажата левая и идёт drag, — не открываем
          // меню поверх летающего "призрака".
          menuEvent.preventDefault();
          menuEvent.stopPropagation();
        }

        function beginDrag() {
          dragging = true;
          el.classList.add("is-drag-source");

          const rect = el.getBoundingClientRect();
          ghost = el.cloneNode(true);
          ghost.removeAttribute("data-folder-id");
          ghost.removeAttribute("data-parent-context");
          ghost.classList.add("folder-drag-ghost");
          ghost.classList.remove(
            "is-drop-into-zone", "is-drop-into", "is-drop-before", "is-drop-after",
            "is-active", "is-active-nested", "is-drag-source", "is-search-flash"
          );
          // Крестик мгновенного удаления на "призраке" не нужен: он ничего не
          // делает (pointer-events: none), но выглядел бы рабочей кнопкой.
          const ghostDelete = ghost.querySelector(".folder-delete");
          if (ghostDelete) ghostDelete.remove();
          ghost.style.position = "fixed";
          ghost.style.width = `${rect.width}px`;
          ghost.style.left = `${rect.left}px`;
          ghost.style.top = `${rect.top}px`;
          ghost.style.margin = "0";
          document.body.appendChild(ghost);
          offsetX = startX - rect.left;
          offsetY = startY - rect.top;

          // Сразу показываем зону вложения у ВСЕХ папок — не только у той, что
          // окажется под курсором, — чтобы было видно, куда вообще можно "закинуть".
          bodyEl.querySelectorAll("[data-folder-id]").forEach((rowEl) => {
            const id = rowEl.dataset.folderId;
            if (isRealFolderId(id) && id !== folderId) rowEl.classList.add("is-drop-into-zone");
          });

          document.body.classList.add("is-dragging-folder");
          document.addEventListener("click", suppressNextClick, { capture: true, once: true });
          document.addEventListener("contextmenu", suppressContextMenu, true);

          // Esc отменяет drag — та же дисциплина, что у остальных оверлеев
          // проекта (см. utils/escapeLayers.js): регистрируемся, а не вешаем
          // свой keydown.
          unregisterLayer = pushLayer(cancelDrag);
        }

        function updateHighlight(clientX, clientY) {
          if (lastHighlighted) {
            clearDropMarks(lastHighlighted);
            lastHighlighted = null;
          }
          ghost.style.left = `${clientX - offsetX}px`;
          ghost.style.top = `${clientY - offsetY}px`;

          const hit = document.elementFromPoint(clientX, clientY);
          const hitEl = hit ? hit.closest("[data-folder-id]") : null;
          if (!hitEl) return null;
          const hitId = hitEl.dataset.folderId;
          if (hitId === folderId) return null; // сам на себя

          if (isRealFolderId(hitId)) {
            const into = isDropInto(hitEl, { clientX });
            const after = isDropAfter(hitEl, { clientY });
            if (into) hitEl.classList.add("is-drop-into");
            else markDropSide(hitEl, after);
            lastHighlighted = hitEl;
            return { folderId: hitId, into, after };
          }
          if (hitId === "favorites" || hitId === "unfiled") {
            hitEl.classList.add("is-drop-target");
            lastHighlighted = hitEl;
            return { folderId: hitId, into: false, after: false };
          }
          return null;
        }

        function cleanup() {
          document.removeEventListener("mousemove", onMouseMove);
          document.removeEventListener("mouseup", onMouseUp);
          window.removeEventListener("blur", onBlur);
          // once:true снимает себя сам ПОСЛЕ первого клика, но если drag
          // отменили через Esc/blur (клика не было вовсе), слушатель всё ещё
          // висит и без явного снятия съел бы следующий, уже никак не
          // связанный клик где угодно в приложении.
          document.removeEventListener("click", suppressNextClick, { capture: true });
          document.removeEventListener("contextmenu", suppressContextMenu, true);
          if (unregisterLayer) {
            unregisterLayer();
            unregisterLayer = null;
          }
          if (lastHighlighted) clearDropMarks(lastHighlighted);
          bodyEl
            .querySelectorAll(".is-drop-into-zone, .is-drop-into, .is-drop-target")
            .forEach((rowEl) => rowEl.classList.remove("is-drop-into-zone", "is-drop-into", "is-drop-target"));
          el.classList.remove("is-drag-source");
          if (ghost) {
            ghost.remove();
            ghost = null;
          }
          document.body.classList.remove("is-dragging-folder");
        }

        async function finishDrop(target) {
          if (!target) return;
          if (target.folderId === "favorites") {
            await itemsService.updateFolder(folderId, { isFavorite: true });
          } else if (target.folderId === "unfiled") {
            await itemsService.updateFolder(folderId, { parentFolderIds: [] });
          } else if (target.into) {
            await itemsService.moveFolderInto(config.section, folderId, target.folderId);
          } else {
            await reorderFolder(folderId, target.folderId, state, target.after);
          }
          state.folders = await itemsService.listFolders(config.section);
          state.items = await itemsService.listItems(config.section);
          render(container, config, state);
        }

        function cancelDrag() {
          cleanup();
        }

        function onMouseMove(e) {
          if (!dragging) {
            const dx = e.clientX - startX;
            const dy = e.clientY - startY;
            if (Math.hypot(dx, dy) < DRAG_THRESHOLD) return;
            beginDrag();
          }
          updateHighlight(e.clientX, e.clientY);
        }

        function onMouseUp(e) {
          const wasDragging = dragging;
          const target = wasDragging ? updateHighlight(e.clientX, e.clientY) : null;
          cleanup();
          if (wasDragging) finishDrop(target);
        }

        function onBlur() {
          if (dragging) cancelDrag();
        }

        document.addEventListener("mousemove", onMouseMove);
        document.addEventListener("mouseup", onMouseUp);
        window.addEventListener("blur", onBlur);
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
        const parentContext = el.dataset.parentContext || null;
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
          // Показана как дочерняя строка дерева под конкретным родителем — можно
          // отвязать только от НЕГО, не удаляя папку целиком (она останется в
          // общем списке и в остальных родителях, если есть).
          ...(parentContext
            ? [
                {
                  label: t("panel.removeFromFolder"),
                  onClick: async () => {
                    await itemsService.removeFolderFromParent(config.section, folder.id, parentContext);
                    state.folders = await itemsService.listFolders(config.section);
                    render(container, config, state);
                  },
                },
              ]
            : []),
          {
            label: t("panel.delete"),
            onClick: () => deleteFolderFlow(folder.id, container, config, state, true),
          },
        ]);
      });
    }

    // ПКМ на самом разделе "Корзина" (не на элементе внутри неё) — массовые операции.
    if (folderId === "trash") {
      el.addEventListener("contextmenu", (event) => {
        event.preventDefault();
        event.stopPropagation();
        showContextMenu(event.clientX, event.clientY, [
          {
            label: t("panel.restoreAll"),
            onClick: async () => {
              await itemsService.restoreAllTrash(config.section);
              await refreshTrashState(container, config, state);
            },
          },
          {
            label: t("panel.emptyTrash"),
            onClick: async () => {
              const ok = await openConfirm({ message: t("panel.emptyTrashConfirm") });
              if (!ok) return;
              await itemsService.emptyTrash(config.section);
              await refreshTrashState(container, config, state);
            },
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
  await itemsService.moveFolderToTrash(config.section, folderId);
  state.folders = await itemsService.listFolders(config.section);
  state.items = await itemsService.listItems(config.section);
  state.trash = await itemsService.listTrash(config.section);
  if (state.selectedFolderId === folderId) state.selectedFolderId = "all";
  render(container, config, state);
}

// Навешивает dragover/drop на папку-приёмник ДЛЯ ЗАМЕТОК (нативный HTML5 DnD).
// Папки сюда больше не попадают — их перетаскивание полностью кастомное, см.
// mousedown-обработчик в renderFolders. Регистрируется по-прежнему и на
// реальных папках, и на "Без папки"/"Избранном" — эти псевдо-папки остаются
// приёмниками для заметок.
function wireFolderDropTarget(el, folderId, container, config, state) {
  el.addEventListener("dragover", (event) => {
    if (!dragged || dragged.kind !== "item") return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
    el.classList.add("is-drop-target");
  });
  el.addEventListener("dragleave", () => clearDropMarks(el));
  el.addEventListener("drop", async (event) => {
    event.preventDefault();
    clearDropMarks(el);
    if (!dragged || dragged.kind !== "item") return;
    const itemId = dragged.id;
    dragged = null;

    if (folderId === "favorites") {
      await itemsService.updateItem(itemId, { isFavorite: true });
    } else if (folderId === "unfiled") {
      await itemsService.updateItem(itemId, { folderIds: [] });
    } else {
      const item = state.items.find((i) => i.id === itemId);
      if (item && !item.folderIds.includes(folderId)) {
        await itemsService.updateItem(itemId, { folderIds: [...item.folderIds, folderId] });
      }
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

// Все удалённые папки и заметки одним списком — недавно удалённое сверху,
// вперемешку по типу, как в обычной корзине файловой системы.
function getTrashRows(state) {
  return [
    ...state.trash.folders.map((f) => ({ ...f, kind: "folder" })),
    ...state.trash.items.map((i) => ({ ...i, kind: "item" })),
  ].sort((a, b) => new Date(b.deletedAt) - new Date(a.deletedAt));
}

// Содержимое Корзины — тот же визуальный стиль строки, что у обычного списка
// заметок (.item-list-row/.item-title), но без перетаскивания и с другим
// контекстным меню (Восстановить / Удалить навсегда вместо обычных пунктов).
function renderTrashList(bodyEl, titleEl, container, config, state) {
  const rows = getTrashRows(state);
  titleEl.textContent = getListTitle(state);

  bodyEl.innerHTML = `
    <ul class="item-list">
      ${rows
        .map((row) => {
          const title = row.kind === "folder" ? row.name : row.title || t("panel.untitled");
          const active = state.selectedTrash && state.selectedTrash.kind === row.kind && state.selectedTrash.id === row.id;
          return `
        <li class="item-list-row ${active ? "is-active" : ""}" data-trash-kind="${row.kind}" data-trash-id="${row.id}">
          <span class="item-title">${escapeHtml(title)}</span>
        </li>`;
        })
        .join("")}
      ${!rows.length ? `<li class="placeholder">${t("panel.empty")}</li>` : ""}
    </ul>
  `;

  bodyEl.querySelectorAll("[data-trash-id]").forEach((el) => {
    const id = el.dataset.trashId;
    const kind = el.dataset.trashKind;

    el.addEventListener("click", () => {
      state.selectedTrash = { kind, id };
      render(container, config, state);
    });

    el.addEventListener("contextmenu", (event) => {
      event.preventDefault();
      showContextMenu(event.clientX, event.clientY, [
        {
          label: t("panel.restore"),
          onClick: async () => {
            if (kind === "folder") await itemsService.restoreFolder(id);
            else await itemsService.restoreItem(id);
            if (state.selectedTrash && state.selectedTrash.id === id) state.selectedTrash = null;
            await refreshTrashState(container, config, state);
          },
        },
        {
          label: t("panel.deleteForever"),
          onClick: async () => {
            const ok = await openConfirm({ message: t("panel.deleteForeverConfirm") });
            if (!ok) return;
            if (kind === "folder") await itemsService.deleteFolderForever(id);
            else await itemsService.deleteItemForever(id);
            if (state.selectedTrash && state.selectedTrash.id === id) state.selectedTrash = null;
            await refreshTrashState(container, config, state);
          },
        },
      ]);
    });
  });
}

function renderList(container, config, state) {
  const bodyEl = container.querySelector('[data-role="list-body"]');
  const titleEl = container.querySelector('[data-role="list-title"]');

  if (state.selectedFolderId === "trash") {
    renderTrashList(bodyEl, titleEl, container, config, state);
    return;
  }

  const items = getFilteredItems(state);
  // В разделе "Избранное" папки не являются заметками — показываем их
  // отдельными строками-ссылками сверху, клик по ним просто переключает
  // на эту папку в обычном виде (у папки нет собственного контента).
  const favFolders = state.selectedFolderId === "favorites" ? state.folders.filter((f) => f.isFavorite) : [];
  const isEmpty = !favFolders.length && !items.length;
  // Закрепление заметок независимо для каждого места показа. Текущее место —
  // это selectedFolderId ("all"/"favorites"/"unfiled"/id папки): булавку, оттенок и
  // подъём наверх показываем только для заметок, закреплённых именно здесь.
  const locationKey = state.selectedFolderId;

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
        <li class="item-list-row ${state.selectedItemId === item.id ? "is-active" : ""} ${isPinnedIn(item, locationKey) ? "is-pinned" : ""}" data-item-id="${item.id}" draggable="true">
          <span class="item-title">${escapeHtml(item.title || t("panel.untitled"))}</span>
          ${rowBadges(item, isPinnedIn(item, locationKey))}
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
      state.selectedTrash = null;
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
          // Закрепление тоглим для ТЕКУЩЕГО места показа (selectedFolderId),
          // независимо от других мест, где заметка тоже видна.
          label: isPinnedIn(item, state.selectedFolderId) ? t("panel.unpin") : t("panel.pin"),
          onClick: async () => {
            const key = state.selectedFolderId;
            const pinnedIn = isPinnedIn(item, key)
              ? item.pinnedIn.filter((k) => k !== key)
              : [...(item.pinnedIn || []), key];
            await itemsService.updateItem(item.id, { pinnedIn });
            state.items = await itemsService.listItems(config.section);
            render(container, config, state);
          },
        },
        // «Убрать из этой папки» — только когда открыт вид конкретной папки и
        // заметка в ней числится. Перетаскивание в папку теперь добавляет, а не
        // перемещает, поэтому убрать из одной папки можно отсюда.
        ...(isRealFolderId(state.selectedFolderId) && item.folderIds.includes(state.selectedFolderId)
          ? [
              {
                label: t("panel.removeFromFolder"),
                onClick: async () => {
                  const key = state.selectedFolderId;
                  await itemsService.updateItem(item.id, { folderIds: item.folderIds.filter((f) => f !== key) });
                  state.items = await itemsService.listItems(config.section);
                  render(container, config, state);
                },
              },
            ]
          : []),
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
      // Как и обычный клик по папке — открытую заметку не сбрасываем.
      state.selectedFolderId = el.dataset.jumpFolderId;
      renderFolders(container, config, state);
      renderList(container, config, state);
    });
  });
}

async function deleteItemFlow(itemId, container, config, state, confirm) {
  if (confirm) {
    const ok = await openConfirm({ message: t("panel.deleteItemConfirm") });
    if (!ok) return;
  }
  await itemsService.moveItemToTrash(itemId);
  state.items = await itemsService.listItems(config.section);
  state.trash = await itemsService.listTrash(config.section);
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
  // Закреплённые наверх — но отдельно для каждого места показа (ключ = вид списка).
  const key = state.selectedFolderId;
  if (key === "favorites") return sortItemsByPin(state.items.filter((item) => item.isFavorite), key);
  if (key === "unfiled") return sortItemsByPin(state.items.filter((item) => item.folderIds.length === 0), key);
  if (key === "all") return sortItemsByPin(state.items, key);
  return sortItemsByPin(state.items.filter((item) => item.folderIds.includes(key)), key);
}

function getListTitle(state) {
  if (state.selectedFolderId === "trash") return t("panel.trash");
  if (state.selectedFolderId === "favorites") return t("panel.favorites");
  if (state.selectedFolderId === "all") return t("panel.all");
  if (state.selectedFolderId === "unfiled") return t("panel.unfiled");
  const folder = state.folders.find((f) => f.id === state.selectedFolderId);
  return folder ? folder.name : "";
}

// Просмотр удалённого — упрощённая read-only карточка, не полноценный редактор
// (истории/тулбара для удалённого не нужно). item.content вставляется как есть,
// тем же приёмом, что и превью в transferPicker.js — это собственный прошлый
// HTML заметки, не чужой ввод.
function renderTrashDetail(detailEl, container, config, state) {
  const sel = state.selectedTrash;
  if (!sel) {
    detailEl.innerHTML = `<p class="placeholder">${t("panel.selectPrompt")}</p>`;
    return;
  }

  function wireActions(kind, id) {
    detailEl.querySelector('[data-action="trash-restore"]').addEventListener("click", async () => {
      if (kind === "folder") await itemsService.restoreFolder(id);
      else await itemsService.restoreItem(id);
      state.selectedTrash = null;
      await refreshTrashState(container, config, state);
    });
    detailEl.querySelector('[data-action="trash-delete-forever"]').addEventListener("click", async () => {
      const ok = await openConfirm({ message: t("panel.deleteForeverConfirm") });
      if (!ok) return;
      if (kind === "folder") await itemsService.deleteFolderForever(id);
      else await itemsService.deleteItemForever(id);
      state.selectedTrash = null;
      await refreshTrashState(container, config, state);
    });
  }

  if (sel.kind === "folder") {
    const folder = state.trash.folders.find((f) => f.id === sel.id);
    if (!folder) {
      detailEl.innerHTML = `<p class="placeholder">${t("panel.selectPrompt")}</p>`;
      return;
    }
    detailEl.innerHTML = `
      <div class="trash-detail">
        <h2 class="trash-detail-title">${escapeHtml(folder.name)}</h2>
        <p class="trash-detail-hint">${t("panel.trashFolderHint")}</p>
        <div class="trash-detail-actions">
          <button type="button" class="btn btn-small" data-action="trash-restore">${t("panel.restore")}</button>
          <button type="button" class="btn btn-danger btn-small" data-action="trash-delete-forever">${t("panel.deleteForever")}</button>
        </div>
      </div>
    `;
    wireActions("folder", folder.id);
    return;
  }

  const item = state.trash.items.find((i) => i.id === sel.id);
  if (!item) {
    detailEl.innerHTML = `<p class="placeholder">${t("panel.selectPrompt")}</p>`;
    return;
  }
  detailEl.innerHTML = `
    <div class="trash-detail">
      <h2 class="trash-detail-title">${escapeHtml(item.title || t("panel.untitled"))}</h2>
      <div class="trash-detail-actions">
        <button type="button" class="btn btn-small" data-action="trash-restore">${t("panel.restore")}</button>
        <button type="button" class="btn btn-danger btn-small" data-action="trash-delete-forever">${t("panel.deleteForever")}</button>
      </div>
      <div class="rte-content trash-detail-content">${item.content}</div>
    </div>
  `;
  wireActions("item", item.id);
}

function renderDetail(container, config, state) {
  const detailEl = container.querySelector('[data-role="detail"]');

  if (state.selectedTrash) {
    renderTrashDetail(detailEl, container, config, state);
    return;
  }

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
    basicButtons: config.basicToolbarButtons,
    pageMode: item.pageMode,
    // Ссылка на другую заметку — инструмент раздела Notes (ТЗ).
    allowInternalLinks: config.section === "notes",
    // Счётчик слов/символов — тоже раздела Notes (ТЗ).
    showWordCount: config.section === "notes",
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
    editor.highlightMatch(state.pendingMatch.query, state.pendingMatch.index, state.pendingMatch.photoIndex);
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
    await itemsService.moveItemToTrash(item.id);
    state.items = await itemsService.listItems(config.section);
    state.trash = await itemsService.listTrash(config.section);
    state.selectedItemId = null;
    render(container, config, state);
  });
}
