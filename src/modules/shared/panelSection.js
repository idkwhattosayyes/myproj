import * as itemsService from "../../services/itemsService.js";
import * as photoStorageService from "../../services/photoStorageService.js";
import { createRichTextEditor } from "./richTextEditor.js";
import { attachFloatingToolbar } from "./floatingToolbar.js";
import { showContextMenu } from "./contextMenu.js";
import { openConfirm, openPrompt } from "../../utils/modal.js";
import { escapeHtml } from "../../utils/dom.js";
import { t } from "../../i18n/i18n.js";
import { consumePendingTarget } from "../../search/searchTarget.js";
import { pushLayer } from "../../utils/escapeLayers.js";
import { createFolderModel, createItemModel } from "../../data/models.js";
import { parentIdsOf, isAncestorOf } from "../../data/folderTree.js";

// ------------------------------------------------------------------
// Оптимистичный UI: любое действие красит экран СРАЗУ, сохранение уходит в
// фон не блокируя интерфейс; при сбое — откат + индикатор Saving/Saved/error
// (saveStatus.js) сам покажет ошибку, здесь только откат видимого состояния.
// ------------------------------------------------------------------

// Точечная правка ОДНОЙ сущности по id в state.items/state.folders — без
// замены всего массива, поэтому параллельное действие над ДРУГОЙ сущностью
// не пострадает при откате. Для избранного/закрепления/переименования/
// "убрать из папки".
function optimisticField(state, listKey, id, patch, persist, renderAfter) {
  const list = state[listKey];
  const index = list.findIndex((e) => e.id === id);
  if (index === -1) return;
  const previous = list[index];
  state[listKey] = list.map((e, i) => (i === index ? { ...e, ...patch } : e));
  renderAfter();
  persist().catch(() => {
    state[listKey] = state[listKey].map((e) => (e.id === id ? previous : e));
    renderAfter();
  });
}

// Структурные действия, которые трогают НЕСКОЛЬКО сущностей/массивов разом
// (корзина, вложение папки, реордер, создание) — снимаем ссылки на все три
// массива, apply() обязан ЗАМЕНЯТЬ их новыми (не мутировать существующие), а
// не просто дописывать в старые — иначе откат "верни старую ссылку" не сработает.
function optimisticBulk(state, apply, persist, renderAfter) {
  const previousItems = state.items;
  const previousFolders = state.folders;
  const previousTrash = state.trash;
  apply();
  renderAfter();
  persist().catch(() => {
    state.items = previousItems;
    state.folders = previousFolders;
    state.trash = previousTrash;
    renderAfter();
  });
}

// Ниже — чистые функции, синхронно повторяющие ровно то, что делает
// соответствующая async-функция itemsService.js на сервере/localStorage, но
// локально на state, для мгновенного apply() внутри optimisticBulk.

// Зеркало itemsService.moveFolderToTrash. deletedAt считается ОДИН раз
// вызывающим кодом и передаётся сюда же и в persist — иначе локальная и
// сохранённая версии разъедутся на пару миллисекунд (и после listTrash()
// может съехать сортировка корзины при пакетном удалении).
function localTrashFolder(state, folderId, deletedAt) {
  const folder = state.folders.find((f) => f.id === folderId);
  if (!folder) return;
  state.items = state.items.map((item) =>
    item.folderIds.includes(folderId) ? { ...item, folderIds: item.folderIds.filter((f) => f !== folderId) } : item
  );
  state.folders = state.folders.map((f) =>
    parentIdsOf(f).includes(folderId) ? { ...f, parentFolderIds: parentIdsOf(f).filter((p) => p !== folderId) } : f
  );
  const trashedFolder = { ...folder, deletedAt, isFavorite: false, pinned: false, parentFolderIds: [] };
  state.folders = state.folders.filter((f) => f.id !== folderId);
  state.trash = { ...state.trash, folders: [trashedFolder, ...state.trash.folders] };
}

// Зеркало itemsService.moveItemToTrash.
function localTrashItem(state, itemId, deletedAt) {
  const item = state.items.find((i) => i.id === itemId);
  if (!item) return;
  const trashedItem = { ...item, deletedAt, isFavorite: false, pinnedIn: [], folderIds: [] };
  state.items = state.items.filter((i) => i.id !== itemId);
  state.trash = { ...state.trash, items: [trashedItem, ...state.trash.items] };
}

function localRestoreFolder(state, folderId) {
  const folder = state.trash.folders.find((f) => f.id === folderId);
  if (!folder) return;
  state.trash = { ...state.trash, folders: state.trash.folders.filter((f) => f.id !== folderId) };
  state.folders = [...state.folders, { ...folder, deletedAt: null }];
}

function localRestoreItem(state, itemId) {
  const item = state.trash.items.find((i) => i.id === itemId);
  if (!item) return;
  state.trash = { ...state.trash, items: state.trash.items.filter((i) => i.id !== itemId) };
  state.items = [...state.items, { ...item, deletedAt: null }];
}

// Реальные версии тривиальны (каскад по parentFolderIds уже снят в момент
// trashing) — просто убрать из корзины.
function localDeleteFolderForever(state, folderId) {
  state.trash = { ...state.trash, folders: state.trash.folders.filter((f) => f.id !== folderId) };
}

function localDeleteItemForever(state, itemId) {
  state.trash = { ...state.trash, items: state.trash.items.filter((i) => i.id !== itemId) };
}

// itemsService.moveFolderInto на невалидном переносе тихо резолвится
// null/самой папкой (не бросает исключение) — значит .catch()-откат для
// такого не сработает никогда. Поэтому те же guard-проверки дублируются
// здесь и вызываются ДО optimisticBulk: если canMoveFolderInto вернула
// false, apply()/persist() не запускаются вовсе, невалидное состояние не
// показывается на экране даже на долю секунды.
function canMoveFolderInto(state, folderId, parentId) {
  if (folderId === parentId) return false;
  const folder = state.folders.find((f) => f.id === folderId);
  if (!folder) return false;
  if (parentIdsOf(folder).includes(parentId)) return false; // уже вложена — no-op
  if (isAncestorOf(state.folders, folderId, parentId)) return false; // создало бы цикл
  return true;
}

function applyMoveFolderInto(state, folderId, parentId) {
  state.folders = state.folders.map((f) =>
    f.id === folderId ? { ...f, parentFolderIds: [...parentIdsOf(f), parentId] } : f
  );
}

function localRemoveFolderFromParent(state, folderId, parentId) {
  state.folders = state.folders.map((f) =>
    f.id === folderId ? { ...f, parentFolderIds: parentIdsOf(f).filter((p) => p !== parentId) } : f
  );
}

// Ссылка на смонтированный сейчас раздел — чтобы внешние источники (быстрая
// заметка) могли попросить обновить список без перемонтирования. { container,
// config, state } или null. См. refreshActivePanelItems.
let activePanel = null;

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

// "Пустая" заметка = в теле нет ни текста, ни картинок (заголовок не считается).
// От этого зависит, показывать ли крестик мгновенного удаления в списке.
//
// Считаем по строке, а не разбором в DOM. Раньше здесь был innerHTML на всё
// содержимое — и вызывается это на КАЖДУЮ заметку при КАЖДОЙ отрисовке списка:
// на заметке с фото в base64 один такой разбор стоил 38 мс, весь список — 60 мс,
// и они целиком ложились в момент отпускания перетаскиваемой строки.
function isItemEmpty(item) {
  const content = item.content || "";
  if (/<img\b/i.test(content)) return false;
  const text = content.replace(/<[^>]*>/g, "");
  if (text.trim() === "") return true;
  // Остаться могли одни лишь сущности (&nbsp; и подобные) — их без разбора не
  // отличить от текста. Но остаток короткий, поэтому разбор ничего не стоит.
  if (text.length > 200) return false;
  const div = document.createElement("div");
  div.innerHTML = text;
  return div.textContent.trim() === "";
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

  // Тащить строку во время переименования не дадут и без отдельного флага:
  // startRowDrag отпускает mousedown, начавшийся внутри .inline-rename, —
  // иначе выделение текста мышью превращалось бы в перетаскивание.
  input.focus();
  input.select();

  let finished = false;
  function commit() {
    if (finished) return;
    finished = true;
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
  // Три волны независимы друг от друга — были последовательными await
  // (3 RTT подряд), переводим на Promise.all.
  const [folders, items, trash] = await Promise.all([
    itemsService.listFolders(config.section),
    itemsService.listItems(config.section),
    itemsService.listTrash(config.section),
  ]);
  const state = {
    folders,
    items,
    trash,
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
  [state.items, state.folders] = await Promise.all([
    itemsService.listItems(config.section),
    itemsService.listFolders(config.section),
  ]);
  renderFolders(container, config, state);
  renderList(container, config, state);
}

// Пришли по результату поиска (или по кастомному кружку главной страницы):
// открываем нужную папку или заметку. Заметку без явного target.folderId
// показываем из "Все" — она может лежать в папке, которая сейчас не выбрана.
// target.folderId (кружок главной знает, через какой раздел — обычную папку
// или Favorites/All/Unfiled — заметку открыли) используем, только если это
// один из псевдо-разделов или папка ещё существует — иначе тоже "Все".
function applySearchTarget(state) {
  const target = consumePendingTarget("item", "folder");
  if (!target) return;

  if (target.kind === "folder") {
    state.selectedFolderId = target.id;
    state.flashFolderId = target.id;
    return;
  }
  const PSEUDO_FOLDER_IDS = ["all", "favorites", "unfiled"];
  const folderIsValid = PSEUDO_FOLDER_IDS.includes(target.folderId) || state.folders.some((f) => f.id === target.folderId);
  state.selectedFolderId = folderIsValid ? target.folderId : "all";
  state.selectedItemId = target.id;
  // pendingMatch должен нести РЕАЛЬНУЮ цель (текст, найденный блок или фото), а
  // не просто маршрут "в какую заметку идти" — иначе он безусловно перехватывал
  // бы показ заметки в renderDetail (if/else if с item.openAtEnd) и глушил бы
  // прокрутку в конец даже там, где искать нечего: кружок на главном экране и
  // перенос быстрой заметки шлют пустой query без blockId/photoIndex именно за
  // тем, чтобы просто открыть заметку, — highlightMatch("", ...) на пустой
  // строке ничего не находит и не скроллит, а до openAtEnd очередь не доходила.
  const hasRealTarget = Boolean(target.blockId) || Boolean(target.query) || target.photoIndex != null;
  state.pendingMatch = hasRealTarget
    ? { query: target.query, index: target.matchIndex, photoIndex: target.photoIndex, blockId: target.blockId }
    : null;
}

/**
 * Прокрутка обеих панелей, снятая перед перерисовкой. Перерисовка идёт через
 * innerHTML, а он обнуляет scrollTop: содержимое схлопывается, браузер зажимает
 * прокрутку в 0, и вернуть её потом уже некому. Тот же приём применён в
 * calendarView.js (renderEventsPanel) и searchBar.js («Ещё совпадений»).
 *
 * Ключ — data-role, а не сам элемент: полный render() пересоздаёт панели, и
 * возвращать позицию приходится уже другим узлам.
 */
function panelScrollTops(container) {
  const tops = new Map();
  container.querySelectorAll(".panel-body").forEach((el) => tops.set(el.dataset.role, el.scrollTop));
  return tops;
}

function applyPanelScrollTops(container, tops) {
  container.querySelectorAll(".panel-body").forEach((el) => {
    const top = tops.get(el.dataset.role);
    if (top != null) el.scrollTop = top;
  });
}

/**
 * Что показано справа. Прокрутку СТРАНИЦЫ возвращаем только если после
 * перерисовки там осталось то же самое: открыли другую заметку — её текст обязан
 * показаться с начала, а не с чужой позиции.
 */
function detailKey(state) {
  const trash = state.selectedTrash ? `${state.selectedTrash.kind}:${state.selectedTrash.id}` : "";
  return `${state.selectedItemId || ""}|${trash}`;
}

/**
 * Возврат прокрутки окна после перерисовки раздела.
 *
 * Панель детали своего скролла не имеет — прокручивается само окно. Пока
 * container.innerHTML пуст, высота документа схлопывается, и браузер зажимает
 * прокрутку страницы в 0. Наш код при этом не двигает окно вообще: замер
 * владельца показал переход 1476 → 0 без единого вызова scrollTo или
 * scrollIntoView в стеке.
 *
 * Второй заход через requestAnimationFrame обязателен: высота на момент возврата
 * может быть ещё не окончательной (лист пересчитывает свой масштаб через
 * --page-fit), а scrollTo по слишком короткому документу молча зажимается.
 */
function restorePageScroll(y) {
  if (window.scrollY === y) return;
  window.scrollTo(window.scrollX, y);
  requestAnimationFrame(() => {
    if (window.scrollY !== y) window.scrollTo(window.scrollX, y);
  });
}

function render(container, config, state) {
  // Любая правка через ПКМ — избранное, закрепить, переименовать, удалить —
  // заканчивается здесь, и без снятой заранее позиции длинный список каждый раз
  // прыгал в начало. Свежесмонтированному разделу возвращать нечего: роутер
  // вычистил #app-view, старых панелей в DOM нет и карта выйдет пустой, так что
  // отдельный признак «первый это рендер или нет» не нужен.
  const scrollTops = panelScrollTops(container);
  const pageScrollY = window.scrollY;
  // Та же заметка останется открытой — значит место, где читали, надо сохранить.
  const sameDetail = state.renderedDetailKey === detailKey(state);
  // renderDetail в двух случаях уводит окно НАМЕРЕННО: к найденному из поиска и в
  // конец текста у заметки с openAtEnd. Там возвращать прежнюю позицию нельзя —
  // она отменила бы прыжок. Флаг одноразовый, как pendingMatch рядом с ним.
  state.detailScrolled = false;

  // Свёрнутый список заметок не исчезает: пока панель папок развёрнута, он
  // складывается в неё горизонтальной вкладкой.
  //
  // Когда свёрнуты обе панели, слева остаётся ровно ОДНА полоска — папок. Своей
  // полоски у списка нет намеренно: две вертикальные полоски рядом невозможно
  // различить, и порядок сворачивания менял их местами. Список из этого
  // состояния достаётся в два шага — полоска разворачивает папки, а вкладка
  // внутри них (она появится сама, listCollapsed ведь ещё true) — список.
  //
  // Условие с !foldersCollapsed обязательно: внутри 10-пиксельной полоски
  // вкладке места нет, её содержимое скрыто вместе с телом папок.
  const listAsTab = state.listCollapsed && !state.foldersCollapsed;

  const listTab = listAsTab
    ? `<button type="button" class="panel-tab" data-action="toggle-list" title="${t("panel.togglePanel")}">
         <span class="panel-tab-title">${escapeHtml(getListTitle(state))}</span>
         <span class="panel-tab-icon">›</span>
       </button>`
    : "";

  container.innerHTML = `
    <a href="#/" class="back-link">${t("nav.backHome")}</a>
    <div class="panel-layout">
      <aside class="panel panel-folders ${state.foldersCollapsed ? "is-collapsed" : ""}">
        <div class="panel-header">
          <button type="button" class="panel-toggle" data-action="toggle-folders" title="${t("panel.togglePanel")}">☰</button>
          <span class="panel-title">${folderIcon()}${t("panel.folders")}</span>
        </div>
        ${listTab}
        <div class="panel-body" data-role="folder-body"></div>
      </aside>

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
  // После renderDetail: он пересоздаёт редактор и может увести окно к концу
  // текста (scrollIntoView), а панели должны встать на место уже поверх этого.
  applyPanelScrollTops(container, scrollTops);
  state.renderedDetailKey = detailKey(state);
  if (sameDetail && !state.detailScrolled) restorePageScroll(pageScrollY);
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

  container.querySelector('[data-action="new-item"]').addEventListener("click", () => {
    const folderIds = isRealFolderId(state.selectedFolderId) ? [state.selectedFolderId] : [];
    // В «Избранном» ведём себя как в папке: новая заметка сразу попадает в него.
    const inFavorites = state.selectedFolderId === "favorites";
    // id уже готов на этом месте (createItemModel генерирует его сам) — экран
    // красим ЭТИМ ЖЕ объектом, persist ниже сохраняет его же, не строит заново.
    const item = createItemModel({ title: t("panel.untitled"), content: "", folderIds, section: config.section, isFavorite: inFavorites });
    optimisticBulk(
      state,
      () => {
        state.items = [...state.items, item];
        state.selectedItemId = item.id;
        state.selectedTrash = null;
        // Разово попросить деталь поставить курсор в поле названия — чтобы
        // печатать сразу, без клика мышкой.
        state.focusTitleOnCreate = true;
      },
      () => itemsService.createItemFromModel(item),
      () => render(container, config, state)
    );
  });
}

function isRealFolderId(id) {
  return id && id !== "all" && id !== "unfiled" && id !== "favorites" && id !== "trash";
}

function countTrash(state) {
  return state.trash.folders.length + state.trash.items.length;
}

// Общий renderAfter для optimisticBulk-действий с Корзиной (удаление в неё,
// восстановление, удаление навсегда, массовая очистка) — полный render
// (детали корзины не жалко пересоздавать, там нет открытого редактора с
// курсором). Корзина опустела, пока была открыта, — раздел исчезнет из
// списка слева, самим собой оставаться в нём было бы некуда.
function renderAfterTrashChange(container, config, state) {
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

/**
 * Перетаскивание строки панели — и папки, и заметки. Нативный HTML5 DnD в
 * проекте не используется вовсе: браузер рисует перетаскиваемую картинку с
 * острыми углами и курсором «запрещено», и убрать эти артефакты, оставаясь на
 * нативном API, не выходит. Вместо картинки за курсором едет настоящий DOM-клон
 * строки — с теми же классами, а значит и с тем же оформлением.
 *
 * Здесь всё, что у папок и заметок одинаково: порог начала переноса, клон и его
 * позиционирование, отмена по Esc, подавление клика и контекстного меню, уборка.
 * Различия — в двух колбэках.
 *
 * @param {MouseEvent} event mousedown, с которого всё началось
 * @param {object} opts
 * @param {Element} opts.sourceEl перетаскиваемая строка
 * @param {(ghost: Element) => void} [opts.prepareGhost] убрать из клона лишнее
 * @param {() => void} [opts.onBeginDrag] подсветить возможные цели
 * @param {(x: number, y: number) => ({el: Element}|null)} opts.findTarget цель под
 *   курсором: возвращает объект с полем el (его подсветку снимет уборка) либо null
 * @param {(target: object) => void} opts.onDrop что сделать с найденной целью
 * @param {() => void} [opts.onCleanup] снять свою подсветку
 */
function startRowDrag(event, { sourceEl, prepareGhost, onBeginDrag, findTarget, onDrop, onCleanup }) {
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
  let pendingPoint = null; // последняя позиция курсора, ждущая своего кадра
  let frame = 0;

  function suppressNextClick(clickEvent) {
    // Вешается на document (НЕ на sourceEl) с capture: true. Для двух слушателей
    // на ОДНОМ узле порядок — это порядок подписки, а не capture-флаг; обычный
    // click-обработчик строки подписан раньше (при отрисовке), и на самом
    // sourceEl suppressor выполнился бы ПОСЛЕ него. На предке (document)
    // capture-фаза гарантированно отрабатывает раньше, чем событие вообще дойдёт
    // до строки.
    clickEvent.stopPropagation();
    clickEvent.preventDefault();
  }

  function suppressContextMenu(menuEvent) {
    // ПКМ второй кнопкой, пока зажата левая и идёт drag, — не открываем меню
    // поверх летающего «призрака».
    menuEvent.preventDefault();
    menuEvent.stopPropagation();
  }

  function beginDrag() {
    dragging = true;
    sourceEl.classList.add("is-drag-source");

    const rect = sourceEl.getBoundingClientRect();
    ghost = sourceEl.cloneNode(true);
    ghost.classList.add("row-drag-ghost");
    // Состояния, которые к «призраку» отношения не имеют: подсветка целей,
    // выделение, вспышка поиска и метка самого источника.
    ghost.classList.remove(
      "is-drop-into-zone", "is-drop-into", "is-drop-before", "is-drop-after",
      "is-active", "is-active-nested", "is-drag-source", "is-search-flash"
    );
    if (prepareGhost) prepareGhost(ghost);
    ghost.style.position = "fixed";
    ghost.style.width = `${rect.width}px`;
    ghost.style.left = `${rect.left}px`;
    ghost.style.top = `${rect.top}px`;
    ghost.style.margin = "0";
    document.body.appendChild(ghost);
    offsetX = startX - rect.left;
    offsetY = startY - rect.top;

    document.body.classList.add("is-dragging-row");
    document.addEventListener("click", suppressNextClick, { capture: true, once: true });
    document.addEventListener("contextmenu", suppressContextMenu, true);
    if (onBeginDrag) onBeginDrag();

    // Esc отменяет drag — та же дисциплина, что у остальных оверлеев проекта
    // (см. utils/escapeLayers.js): регистрируемся, а не вешаем свой keydown.
    unregisterLayer = pushLayer(cancelDrag);
  }

  function updateTarget(clientX, clientY) {
    if (!ghost) return null;
    if (lastHighlighted) {
      clearDropMarks(lastHighlighted);
      lastHighlighted = null;
    }
    ghost.style.left = `${clientX - offsetX}px`;
    ghost.style.top = `${clientY - offsetY}px`;

    const target = findTarget(clientX, clientY);
    if (target) lastHighlighted = target.el;
    return target;
  }

  function cleanup() {
    document.removeEventListener("mousemove", onMouseMove);
    document.removeEventListener("mouseup", onMouseUp);
    window.removeEventListener("blur", onBlur);
    // Кадр, назначенный последним движением, может ещё не отработать — иначе он
    // дёрнулся бы уже после уборки, когда призрака нет.
    if (frame) {
      cancelAnimationFrame(frame);
      frame = 0;
    }
    // once:true снимает себя сам ПОСЛЕ первого клика, но если drag отменили через
    // Esc/blur (клика не было вовсе), слушатель всё ещё висит и без явного снятия
    // съел бы следующий, уже никак не связанный клик где угодно в приложении.
    document.removeEventListener("click", suppressNextClick, { capture: true });
    document.removeEventListener("contextmenu", suppressContextMenu, true);
    if (unregisterLayer) {
      unregisterLayer();
      unregisterLayer = null;
    }
    if (lastHighlighted) {
      clearDropMarks(lastHighlighted);
      lastHighlighted = null;
    }
    if (onCleanup) onCleanup();
    sourceEl.classList.remove("is-drag-source");
    if (ghost) {
      ghost.remove();
      ghost = null;
    }
    document.body.classList.remove("is-dragging-row");
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
    // Мышь шлёт события чаще, чем экран успевает перерисоваться, а каждый проход
    // сначала пишет призраку стиль, а потом сразу читает раскладку
    // (elementFromPoint, getBoundingClientRect) — на таком чередовании браузер
    // обязан пересчитывать её синхронно, по разу на событие. Считаем не чаще
    // кадра: картинка та же, работы кратно меньше.
    pendingPoint = { x: e.clientX, y: e.clientY };
    if (frame) return;
    frame = requestAnimationFrame(() => {
      frame = 0;
      updateTarget(pendingPoint.x, pendingPoint.y);
    });
  }

  function onMouseUp(e) {
    const wasDragging = dragging;
    const target = wasDragging ? updateTarget(e.clientX, e.clientY) : null;
    cleanup();
    if (wasDragging && target) onDrop(target);
  }

  function onBlur() {
    if (dragging) cancelDrag();
  }

  document.addEventListener("mousemove", onMouseMove);
  document.addEventListener("mouseup", onMouseUp);
  window.addEventListener("blur", onBlur);
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

// Значок папки — по тому же приёму, что булавка: инлайн-SVG с fill="currentColor",
// чтобы цвет задавался в CSS и наследовался от текста строки. В «Избранном» папки и
// заметки идут одним списком, и без значка их не отличить.
function folderIcon() {
  return `<span class="folder-icon" aria-hidden="true"><svg viewBox="0 0 16 16" width="12" height="12"><path fill="currentColor" d="M1.5 3.5a1 1 0 0 1 1-1h3.3a1 1 0 0 1 .7.3l1 1h6a1 1 0 0 1 1 1v7.4a1 1 0 0 1-1 1h-11a1 1 0 0 1-1-1V3.5z"/></svg></span>`;
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
// Внутри закреплённых порядок не трогаем (пришли уже order-сортированными) —
// остальные идут по недавней правке текста/заголовка, самые свежие наверху.
function sortItemsByPin(list, locationKey) {
  const pinned = list.filter((e) => isPinnedIn(e, locationKey));
  const rest = list.filter((e) => !isPinnedIn(e, locationKey));
  return [...pinned, ...sortByRecency(rest)];
}

function sortByRecency(list) {
  const time = (item) => (item.activityAt ? new Date(item.activityAt).getTime() : 0);
  return [...list].sort((a, b) => time(b) - time(a));
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
  // Панель перерисовывают и в обход render() — например при клике по папке.
  // Там узел остаётся прежним, но innerHTML всё равно сбрасывает прокрутку.
  const scrollTop = bodyEl.scrollTop;

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
  bodyEl.scrollTop = scrollTop;

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

    // Настоящие папки можно тащить; псевдо-папки — нет. Механика переноса общая
    // с заметками (см. startRowDrag) — здесь только поиск цели и само действие.
    if (isRealFolderId(folderId)) {
      el.addEventListener("mousedown", (event) => {
        startRowDrag(event, {
          sourceEl: el,
          prepareGhost: (ghost) => {
            ghost.removeAttribute("data-folder-id");
            ghost.removeAttribute("data-parent-context");
            // Крестик мгновенного удаления на "призраке" не нужен: он ничего не
            // делает (pointer-events: none), но выглядел бы рабочей кнопкой.
            const ghostDelete = ghost.querySelector(".folder-delete");
            if (ghostDelete) ghostDelete.remove();
          },
          onBeginDrag: () => {
            // Сразу показываем зону вложения у ВСЕХ папок — не только у той, что
            // окажется под курсором, — чтобы было видно, куда вообще можно "закинуть".
            bodyEl.querySelectorAll("[data-folder-id]").forEach((rowEl) => {
              const id = rowEl.dataset.folderId;
              if (isRealFolderId(id) && id !== folderId) rowEl.classList.add("is-drop-into-zone");
            });
          },
          onCleanup: () => {
            bodyEl
              .querySelectorAll(".is-drop-into-zone, .is-drop-into, .is-drop-target")
              .forEach((rowEl) => rowEl.classList.remove("is-drop-into-zone", "is-drop-into", "is-drop-target"));
          },
          findTarget: (clientX, clientY) => {
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
              return { el: hitEl, folderId: hitId, into, after };
            }
            if (hitId === "favorites" || hitId === "unfiled") {
              hitEl.classList.add("is-drop-target");
              return { el: hitEl, folderId: hitId, into: false, after: false };
            }
            return null;
          },
          onDrop: (target) => {
            if (target.folderId === "favorites") {
              optimisticField(
                state, "folders", folderId, { isFavorite: true },
                () => itemsService.updateFolder(folderId, { isFavorite: true }),
                () => renderFoldersAndList(container, config, state)
              );
            } else if (target.folderId === "unfiled") {
              optimisticField(
                state, "folders", folderId, { parentFolderIds: [] },
                () => itemsService.updateFolder(folderId, { parentFolderIds: [] }),
                () => renderFolders(container, config, state)
              );
            } else if (target.into) {
              // itemsService.moveFolderInto тихо резолвится null на невалидном
              // переносе (не бросает) — без локальной проверки .catch()-откат
              // не сработал бы вовсе, см. canMoveFolderInto.
              if (canMoveFolderInto(state, folderId, target.folderId)) {
                optimisticBulk(
                  state,
                  () => applyMoveFolderInto(state, folderId, target.folderId),
                  () => itemsService.moveFolderInto(config.section, folderId, target.folderId),
                  () => renderFolders(container, config, state)
                );
              }
            } else {
              const result = reorderedFolders(state.folders, folderId, target.folderId, target.after);
              if (result) {
                optimisticBulk(
                  state,
                  () => { state.folders = result.entries; },
                  () => itemsService.setFoldersOrder(result.orderById),
                  () => renderFolders(container, config, state)
                );
              }
            }
          },
        });
      });
    }

    // Приёмником брошенной заметки папка становится без отдельной подписки:
    // цель ищет findTarget самой заметки (см. renderList) по data-folder-id.

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
              startInlineRename(el, folder.name, (name) => {
                optimisticField(
                  state, "folders", folder.id, { name },
                  () => itemsService.updateFolder(folder.id, { name }),
                  () => renderFolders(container, config, state)
                );
              });
            },
          },
          {
            label: folder.isFavorite ? t("panel.removeFromFavorites") : t("panel.addToFavorites"),
            onClick: () => {
              optimisticField(
                state, "folders", folder.id, { isFavorite: !folder.isFavorite },
                () => itemsService.updateFolder(folder.id, { isFavorite: !folder.isFavorite }),
                () => renderFoldersAndList(container, config, state)
              );
            },
          },
          {
            label: folder.pinned ? t("panel.unpin") : t("panel.pin"),
            onClick: () => {
              optimisticField(
                state, "folders", folder.id, { pinned: !folder.pinned },
                () => itemsService.updateFolder(folder.id, { pinned: !folder.pinned }),
                () => renderFolders(container, config, state)
              );
            },
          },
          // Показана как дочерняя строка дерева под конкретным родителем — можно
          // отвязать только от НЕГО, не удаляя папку целиком (она останется в
          // общем списке и в остальных родителях, если есть).
          ...(parentContext
            ? [
                {
                  label: t("panel.removeFromFolder"),
                  onClick: () => {
                    optimisticBulk(
                      state,
                      () => localRemoveFolderFromParent(state, folder.id, parentContext),
                      () => itemsService.removeFolderFromParent(config.section, folder.id, parentContext),
                      () => renderFolders(container, config, state)
                    );
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
            onClick: () => {
              const folderIds = state.trash.folders.map((f) => f.id);
              const itemIds = state.trash.items.map((i) => i.id);
              optimisticBulk(
                state,
                () => {
                  folderIds.forEach((id) => localRestoreFolder(state, id));
                  itemIds.forEach((id) => localRestoreItem(state, id));
                },
                () => itemsService.restoreAllTrash(config.section),
                () => renderAfterTrashChange(container, config, state)
              );
            },
          },
          {
            label: t("panel.emptyTrash"),
            onClick: async () => {
              const ok = await openConfirm({ message: t("panel.emptyTrashConfirm") });
              if (!ok) return;
              const folderIds = state.trash.folders.map((f) => f.id);
              const itemIds = state.trash.items.map((i) => i.id);
              optimisticBulk(
                state,
                () => {
                  folderIds.forEach((id) => localDeleteFolderForever(state, id));
                  itemIds.forEach((id) => localDeleteItemForever(state, id));
                },
                () => itemsService.emptyTrash(config.section),
                () => renderAfterTrashChange(container, config, state)
              );
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
          const folder = createFolderModel({ name: name.trim(), section: config.section });
          optimisticBulk(
            state,
            () => { state.folders = [...state.folders, folder]; },
            () => itemsService.createFolderFromModel(folder),
            () => renderFolders(container, config, state)
          );
        },
      },
    ]);
  });
}

// Название удаляемого прямо в вопросе: промахнуться мышкой по соседней строке
// легко, а из безличного «Переместить в Корзину?» не видно, что именно уедет.
// Плейсхолдеров у t() нет, подставляем вручную — то же соглашение, что у
// search.moreMatches в searchBar.js. Экранировать не надо: openConfirm кладёт
// текст через textContent, а не в innerHTML.
function confirmDelete(key, name) {
  return openConfirm({ message: t(key).replace("{name}", name || t("panel.untitled")) });
}

// confirm=true — спросить подтверждение (удаление непустой папки через ПКМ);
// confirm=false — мгновенное удаление пустой папки по крестику.
async function deleteFolderFlow(folderId, container, config, state, confirm) {
  if (confirm) {
    const folder = state.folders.find((f) => f.id === folderId);
    const ok = await confirmDelete("panel.deleteFolderConfirm", folder?.name);
    if (!ok) return;
  }
  const deletedAt = new Date().toISOString();
  optimisticBulk(
    state,
    () => {
      localTrashFolder(state, folderId, deletedAt);
      if (state.selectedFolderId === folderId) state.selectedFolderId = "all";
    },
    () => itemsService.moveFolderToTrash(config.section, folderId, deletedAt),
    () => renderAfterTrashChange(container, config, state)
  );
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
    // Название берём из самой строки: там уже разобрано и папка/заметка, и
    // подстановка «Без названия», второй раз это считать незачем.
    const name = el.querySelector(".item-title").textContent;

    el.addEventListener("click", () => {
      state.selectedTrash = { kind, id };
      render(container, config, state);
    });

    el.addEventListener("contextmenu", (event) => {
      event.preventDefault();
      showContextMenu(event.clientX, event.clientY, [
        {
          label: t("panel.restore"),
          onClick: () => {
            optimisticBulk(
              state,
              () => {
                if (kind === "folder") localRestoreFolder(state, id);
                else localRestoreItem(state, id);
                if (state.selectedTrash && state.selectedTrash.id === id) state.selectedTrash = null;
              },
              () => (kind === "folder" ? itemsService.restoreFolder(id) : itemsService.restoreItem(id)),
              () => renderAfterTrashChange(container, config, state)
            );
          },
        },
        {
          label: t("panel.deleteForever"),
          onClick: async () => {
            const ok = await confirmDelete("panel.deleteForeverConfirm", name);
            if (!ok) return;
            optimisticBulk(
              state,
              () => {
                if (kind === "folder") localDeleteFolderForever(state, id);
                else localDeleteItemForever(state, id);
                if (state.selectedTrash && state.selectedTrash.id === id) state.selectedTrash = null;
              },
              () => (kind === "folder" ? itemsService.deleteFolderForever(id) : itemsService.deleteItemForever(id)),
              () => renderAfterTrashChange(container, config, state)
            );
          },
        },
      ]);
    });
  });
}

// Правка заметки, которая может задеть счётчики папок слева (избранное — общий
// счётчик "Избранное (N)"; folderIds — счётчик конкретной папки), но не
// трогает открытый редактор — оба уже "коллекции этого дешёвого узкого
// рендера" (в отличие от полного render(), который его бы пересоздал).
function renderFoldersAndList(container, config, state) {
  renderFolders(container, config, state);
  renderList(container, config, state);
}

function renderList(container, config, state) {
  const bodyEl = container.querySelector('[data-role="list-body"]');
  const titleEl = container.querySelector('[data-role="list-title"]');
  // Список перерисовывают и в обход render(): перестановка мышью, клик по папке
  // и — на КАЖДЫЙ введённый символ — сохранение заголовка открытой заметки.
  const scrollTop = bodyEl.scrollTop;

  if (state.selectedFolderId === "trash") {
    renderTrashList(bodyEl, titleEl, container, config, state);
    bodyEl.scrollTop = scrollTop;
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
        .map(
          (folder) =>
            `<li class="item-list-row" data-jump-folder-id="${folder.id}">${folderIcon()}<span class="item-title">${escapeHtml(folder.name)}</span></li>`
        )
        .join("")}
      ${items
        .map((item) => {
          const empty = isItemEmpty(item);
          return `
        <li class="item-list-row ${state.selectedItemId === item.id ? "is-active" : ""} ${isPinnedIn(item, locationKey) ? "is-pinned" : ""}" data-item-id="${item.id}">
          <span class="item-title">${escapeHtml(item.title || t("panel.untitled"))}</span>
          ${rowBadges(item, isPinnedIn(item, locationKey))}
          ${empty ? `<button type="button" class="item-delete" data-delete-item="${item.id}" title="${t("panel.delete")}">✕</button>` : ""}
        </li>`;
        })
        .join("")}
      ${isEmpty ? `<li class="placeholder">${t("panel.empty")}</li>` : ""}
    </ul>
  `;
  bodyEl.scrollTop = scrollTop;

  bodyEl.querySelectorAll("[data-item-id]").forEach((el) => {
    const itemId = el.dataset.itemId;

    el.addEventListener("click", () => {
      state.selectedItemId = itemId;
      state.selectedTrash = null;
      render(container, config, state);
    });

    // Перенос заметки — та же механика, что у папок (см. startRowDrag): нативный
    // HTML5 DnD убран, за курсором едет клон строки, а не браузерный скриншот.
    // Целей две: другая заметка (переупорядочивание) и папка в левой панели —
    // раньше приём заметки папкой висел отдельными нативными dragover/drop.
    el.addEventListener("mousedown", (event) => {
      startRowDrag(event, {
        sourceEl: el,
        prepareGhost: (ghost) => {
          ghost.removeAttribute("data-item-id");
          const ghostDelete = ghost.querySelector(".item-delete");
          if (ghostDelete) ghostDelete.remove();
        },
        findTarget: (clientX, clientY) => {
          const hit = document.elementFromPoint(clientX, clientY);
          const hitEl = hit ? hit.closest("[data-item-id],[data-folder-id]") : null;
          if (!hitEl) return null;

          const targetItemId = hitEl.dataset.itemId;
          if (targetItemId) {
            if (targetItemId === itemId) return null; // сам на себя
            const after = isDropAfter(hitEl, { clientY });
            markDropSide(hitEl, after);
            return { el: hitEl, kind: "item", id: targetItemId, after };
          }

          // Приёмники в панели папок: реальные папки, "Без папки" и "Избранное".
          const targetFolderId = hitEl.dataset.folderId;
          if (isRealFolderId(targetFolderId) || targetFolderId === "unfiled" || targetFolderId === "favorites") {
            hitEl.classList.add("is-drop-target");
            return { el: hitEl, kind: "folder", id: targetFolderId };
          }
          return null;
        },
        onDrop: (target) => {
          // Перестановка внутри списка считается целиком в памяти, поэтому
          // рисуем новый порядок сразу, а запись отправляем за кадр:
          // setItemsOrder переписывает всю коллекцию вместе с фото в base64, и
          // на паре мегабайт это десятки миллисекунд — ровно то залипание,
          // которое было видно в момент отпускания кнопки. У папок такой
          // развилки нет: их коллекция весит килобайты и пишется мгновенно.
          // Откат здесь пишется вручную (не через optimisticBulk) именно из-за
          // этой отложенной записи — снимаем старую ссылку до замены.
          if (target.kind === "item") {
            const result = reorderedItems(state.items, itemId, target.id, target.after);
            if (!result) return;
            const previousItems = state.items;
            state.items = result.entries;
            // Только список: полный render() пересоздал бы ещё и редактор со
            // всей открытой заметкой (и сбросил бы в нём каретку с прокруткой),
            // хотя от перестановки строк он не меняется вовсе.
            renderList(container, config, state);
            afterPaint(() => {
              itemsService.setItemsOrder(result.orderById).catch(() => {
                state.items = previousItems;
                renderList(container, config, state);
              });
            });
            return;
          }
          if (target.id === "favorites") {
            optimisticField(
              state, "items", itemId, { isFavorite: true },
              () => itemsService.updateItem(itemId, { isFavorite: true }),
              () => renderFoldersAndList(container, config, state)
            );
          } else if (target.id === "unfiled") {
            optimisticField(
              state, "items", itemId, { folderIds: [] },
              () => itemsService.updateItem(itemId, { folderIds: [] }),
              () => renderFoldersAndList(container, config, state)
            );
          } else {
            const item = state.items.find((i) => i.id === itemId);
            if (item && !item.folderIds.includes(target.id)) {
              const folderIds = [...item.folderIds, target.id];
              optimisticField(
                state, "items", itemId, { folderIds },
                () => itemsService.updateItem(itemId, { folderIds }),
                () => renderFoldersAndList(container, config, state)
              );
            }
          }
        },
      });
    });

    el.addEventListener("contextmenu", (event) => {
      event.preventDefault();
      const item = state.items.find((i) => i.id === itemId);
      showContextMenu(event.clientX, event.clientY, [
        {
          label: t("panel.rename"),
          onClick: () => {
            startInlineRename(el, item.title, (title) => {
              optimisticField(
                state, "items", item.id, { title },
                () => itemsService.updateItem(item.id, { title }),
                () => renderList(container, config, state)
              );
            });
          },
        },
        {
          label: item.isFavorite ? t("panel.removeFromFavorites") : t("panel.addToFavorites"),
          onClick: () => {
            optimisticField(
              state, "items", item.id, { isFavorite: !item.isFavorite },
              () => itemsService.updateItem(item.id, { isFavorite: !item.isFavorite }),
              () => renderFoldersAndList(container, config, state)
            );
          },
        },
        {
          // Закрепление тоглим для ТЕКУЩЕГО места показа (selectedFolderId),
          // независимо от других мест, где заметка тоже видна.
          label: isPinnedIn(item, state.selectedFolderId) ? t("panel.unpin") : t("panel.pin"),
          onClick: () => {
            const key = state.selectedFolderId;
            const pinnedIn = isPinnedIn(item, key)
              ? item.pinnedIn.filter((k) => k !== key)
              : [...(item.pinnedIn || []), key];
            optimisticField(
              state, "items", item.id, { pinnedIn },
              () => itemsService.updateItem(item.id, { pinnedIn }),
              () => renderList(container, config, state)
            );
          },
        },
        // «Убрать из этой папки» — только когда открыт вид конкретной папки и
        // заметка в ней числится. Перетаскивание в папку теперь добавляет, а не
        // перемещает, поэтому убрать из одной папки можно отсюда.
        ...(isRealFolderId(state.selectedFolderId) && item.folderIds.includes(state.selectedFolderId)
          ? [
              {
                label: t("panel.removeFromFolder"),
                onClick: () => {
                  const key = state.selectedFolderId;
                  const folderIds = item.folderIds.filter((f) => f !== key);
                  optimisticField(
                    state, "items", item.id, { folderIds },
                    () => itemsService.updateItem(item.id, { folderIds }),
                    () => renderFoldersAndList(container, config, state)
                  );
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
    const item = state.items.find((i) => i.id === itemId);
    const ok = await confirmDelete("panel.deleteItemConfirm", item?.title);
    if (!ok) return;
  }
  const deletedAt = new Date().toISOString();
  optimisticBulk(
    state,
    () => {
      localTrashItem(state, itemId, deletedAt);
      if (state.selectedItemId === itemId) state.selectedItemId = null;
    },
    () => itemsService.moveItemToTrash(itemId, deletedAt),
    () => renderAfterTrashChange(container, config, state)
  );
}

// Переставляет заметку draggedId перед targetId или после неё — на КОПИИ
// массива (не state.items напрямую), чтобы старая ссылка, снятая для отката,
// осталась нетронутой. Возвращает { entries, orderById } или null, если
// draggedId не нашёлся.
function reorderedItems(items, draggedId, targetId, after) {
  const arr = [...items];
  const from = arr.findIndex((i) => i.id === draggedId);
  if (from < 0) return null;
  const [moved] = arr.splice(from, 1);
  // Индекс цели ищем уже после удаления перетаскиваемой заметки — сдвиг учтён.
  const to = arr.findIndex((i) => i.id === targetId);
  arr.splice(after ? to + 1 : to, 0, moved);
  return assignOrderByIndex(arr);
}

// То же для папок — см. reorderedItems.
function reorderedFolders(folders, draggedId, targetId, after) {
  const arr = [...folders];
  const from = arr.findIndex((f) => f.id === draggedId);
  if (from < 0) return null;
  const [moved] = arr.splice(from, 1);
  const to = arr.findIndex((f) => f.id === targetId);
  arr.splice(after ? to + 1 : to, 0, moved);
  return assignOrderByIndex(arr);
}

// Проставляет order = index (массив уже в нужном порядке) и возвращает
// { entries, orderById } — новые объекты только для реально сдвинувшихся
// записей (остальные — те же ссылки), orderById одним объектом, потому что
// адаптер сохраняет всю перестановку одной записью. Важно НЕ мутировать
// существующие объекты на месте (как раньше) — иначе снятая для отката старая
// ссылка на массив держала бы уже изменённые объекты, и откат ничего не вернул бы.
function assignOrderByIndex(arr) {
  const orderById = {};
  const entries = arr.map((entry, index) => {
    if (entry.order === index) return entry;
    orderById[entry.id] = index;
    return { ...entry, order: index };
  });
  return { entries, orderById };
}

// Выполнить работу после того, как браузер покажет уже перерисованный экран:
// rAF срабатывает перед отрисовкой кадра, таймер внутри него — после неё.
// Второй таймер — дублёр: у скрытой вкладки rAF не вызывается вовсе, а
// сохранить перестановку всё равно надо.
function afterPaint(run) {
  let done = false;
  const once = () => {
    if (done) return;
    done = true;
    run();
  };
  requestAnimationFrame(() => setTimeout(once, 0));
  setTimeout(once, 100);
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

  function wireActions(kind, id, name) {
    detailEl.querySelector('[data-action="trash-restore"]').addEventListener("click", () => {
      optimisticBulk(
        state,
        () => {
          if (kind === "folder") localRestoreFolder(state, id);
          else localRestoreItem(state, id);
          state.selectedTrash = null;
        },
        () => (kind === "folder" ? itemsService.restoreFolder(id) : itemsService.restoreItem(id)),
        () => renderAfterTrashChange(container, config, state)
      );
    });
    detailEl.querySelector('[data-action="trash-delete-forever"]').addEventListener("click", async () => {
      const ok = await confirmDelete("panel.deleteForeverConfirm", name);
      if (!ok) return;
      optimisticBulk(
        state,
        () => {
          if (kind === "folder") localDeleteFolderForever(state, id);
          else localDeleteItemForever(state, id);
          state.selectedTrash = null;
        },
        () => (kind === "folder" ? itemsService.deleteFolderForever(id) : itemsService.deleteItemForever(id)),
        () => renderAfterTrashChange(container, config, state)
      );
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
    wireActions("folder", folder.id, folder.name);
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
  wireActions("item", item.id, item.title);

  // Content хранит протухающую signed-ссылку, не постоянный путь — без этого
  // резолва (он есть в richTextEditor.js, но предпросмотр корзины строится
  // мимо редактора) фото заметки, пролежавшей в корзине больше часа TTL,
  // показалось бы битым, хотя файл в Storage цел и restore всё вернёт как надо.
  const pendingPhotos = [...detailEl.querySelectorAll("img.rte-photo[data-storage-path]")];
  if (pendingPhotos.length) {
    photoStorageService
      .resolvePhotoSources(pendingPhotos.map((img) => img.dataset.storagePath))
      .then((urlByPath) => {
        pendingPhotos.forEach((img) => {
          const url = urlByPath.get(img.dataset.storagePath);
          if (url) img.src = url;
        });
      })
      .catch(() => {});
  }
}

// Отцепка плавающего тулбара от предыдущей заметки. Деталь перерисовывается на
// каждую навигацию, а модуль вешает слушатели на window — без этого они копились бы.
let detachFloatingToolbar = null;

function renderDetail(container, config, state) {
  const detailEl = container.querySelector('[data-role="detail"]');

  if (detachFloatingToolbar) {
    detachFloatingToolbar();
    detachFloatingToolbar = null;
  }

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
    // itemsService.updateItem проставит activityAt и persist'нет его сам, но
    // только через 400мс дебаунса ниже — а список нужно пересортировать сразу.
    if ("content" in patch || "title" in patch) item.activityAt = new Date().toISOString();
    Object.assign(pendingPatch, patch);
    renderList(container, config, state);
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      const toSave = pendingPatch;
      pendingPatch = {};
      // Сознательно НЕ откатываем текст в открытом редакторе при сбое — это
      // живой DOM, который печатает человек, а не производная от item.content
      // при каждом рендере; вырывать у него только что напечатанное не станет
      // делать ни один текстовый редактор. .catch здесь только гасит
      // необработанный reject — сам факт ошибки увидит индикатор сохранения.
      itemsService.updateItem(item.id, toSave).catch(() => {});
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
    // Безусловно — гость получает no-op изнутри photoStorageService.js (гейт
    // по сессии там), редактору здесь не нужно знать, залогинен пользователь
    // или нет.
    uploadPhoto: (blob) => photoStorageService.uploadPhoto(item.id, blob),
    resolvePhotoSources: (paths) => photoStorageService.resolvePhotoSources(paths),
    removePhotoFromStorage: (path) => photoStorageService.removePhoto(path),
    // Раздел без кнопки режима в тулбаре (Заметки): переключать вид можно только
    // по ПКМ внутри открытой заметки. Пункт отдаём редактору, а не вешаем своё
    // меню — иначе поверх его меню открывалось бы второе. У строк списка слева
    // своё меню, расширенная опция туда намеренно не попадает.
    getExtraMenuItems: config.pageModeInContextMenu
      ? () => {
          // Оба пункта — расширенные инструменты, как и кнопки с
          // data-toolbar-extra: показываем их только когда тулбар развёрнут
          // кнопкой "+". Свёрнутость самого тулбара стрелкой на это не влияет —
          // классы is-expanded и is-collapsed независимы (см.
          // createToolbarToggle/createToolbarExpandToggle в richTextEditor.js).
          if (!editor.toolbarEl.classList.contains("is-expanded")) return [];
          return [
            {
              label: editor.getPageMode() === "paged" ? t("editor.pageModeFlow") : t("editor.pageModePaged"),
              onClick: () => editor.togglePageMode(),
            },
            {
              // Длинную заметку, которую всё время дописывают снизу, удобно открывать
              // сразу в конце. Настройка живёт в самой заметке (как pageMode), поэтому
              // у каждой она своя и переживает экспорт/импорт.
              label: item.openAtEnd ? t("editor.openAtTop") : t("editor.openAtEnd"),
              onClick: () => {
                item.openAtEnd = !item.openAtEnd;
                scheduleSave({ openAtEnd: item.openAtEnd });
              },
            },
          ];
        }
      : null,
  });
  const { toolbarEl, contentEl } = editor;
  const toolbarHostEl = detailEl.querySelector('[data-role="toolbar-host"]');
  toolbarHostEl.appendChild(toolbarEl);
  detailEl.querySelector('[data-role="content-host"]').appendChild(contentEl);
  // Высота страниц считается по реальным размерам — только после вставки в DOM.
  editor.refreshLayout();
  // boundsEl — белая рамка редактора: по ней считаются границы перетаскивания и
  // порог прилипания к краю (ТЗ: «текстовое поле»). Подключаемся только теперь,
  // когда рамка уже в DOM и посчитана: модуль при подключении поднимает
  // сохранённую позицию, а она хранится как смещение от левого края рамки. Пока
  // рамка висела вне документа, её край читался нулём, и панель после
  // перезагрузки уезжала к началу поля вместо своего места.
  detachFloatingToolbar = attachFloatingToolbar({ hostEl: toolbarHostEl, toolbarEl, boundsEl: contentEl });

  // Пришли из поиска — прокручиваем к найденному и мигаем им. Цель одноразовая:
  // следующая перерисовка (правка, переключение папки) прыгать уже не должна.
  if (state.pendingMatch) {
    // Переход по блоку (браузер тегов) — по id, надёжнее текстового совпадения;
    // остальные переходы (обычный поиск) — как раньше, по query/occurrence.
    if (state.pendingMatch.blockId) editor.highlightBlock(state.pendingMatch.blockId);
    else editor.highlightMatch(state.pendingMatch.query, state.pendingMatch.index, state.pendingMatch.photoIndex);
    state.pendingMatch = null;
    state.detailScrolled = true;
  } else if (item.openAtEnd) {
    // Прокручивается само окно (внутреннего скролл-контейнера у редактора нет),
    // поэтому показываем нижний край текста. Только после refreshLayout: до него
    // высоты страниц ещё не посчитаны и прыжок пришёлся бы не туда. Переход из
    // поиска важнее — там прыгаем к найденному, а не в конец.
    contentEl.scrollIntoView({ block: "end" });
    state.detailScrolled = true;
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
    // Заголовок берём из поля, а не из item.title: правка сохраняется с задержкой
    // (scheduleSave), и у только что переименованной заметки item.title отстаёт.
    const ok = await confirmDelete("panel.deleteItemConfirm", titleInput.value);
    if (!ok) return;
    clearTimeout(saveTimer);
    const deletedAt = new Date().toISOString();
    optimisticBulk(
      state,
      () => {
        localTrashItem(state, item.id, deletedAt);
        state.selectedItemId = null;
      },
      () => itemsService.moveItemToTrash(item.id, deletedAt),
      () => renderAfterTrashChange(container, config, state)
    );
  });
}
