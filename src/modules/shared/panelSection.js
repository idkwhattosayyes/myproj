import * as itemsService from "../../services/itemsService.js";
import * as photoStorageService from "../../services/photoStorageService.js";
import { createRichTextEditor } from "./richTextEditor.js";
import { attachFloatingToolbar } from "./floatingToolbar.js";
import { showContextMenu } from "./contextMenu.js";
import { openConfirm, openPrompt } from "../../utils/modal.js";
import { escapeHtml, htmlToSearchText, isScrollContainer } from "../../utils/dom.js";
import { toCssPx, toScrollPx } from "../../utils/uiScale.js";
import { t } from "../../i18n/i18n.js";
import { consumePendingTarget } from "../../search/searchTarget.js";
import { setNoteSearchSource } from "../../search/noteScope.js";
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
  // Список отдаёт заметки без content, пока их не открыли в этой сессии
  // (см. supabaseAdapter.getItems). Без content нельзя ДОКАЗАТЬ пустоту —
  // считаем "не подтверждено", обычный флоу удаления с подтверждением, а не
  // мгновенный крестик.
  if (item.content === undefined) return false;
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
 * Память панели Workspace между перемонтированиями раздела ВНУТРИ него самого.
 * Переход по результату поиска при уже открытом #/notes заново вызывает
 * renderPanelSection с новым state — без этой памяти выбранный раздел и
 * раскрытые папки сбрасывались бы на каждый такой переход. Из другого раздела
 * (главная, календарь) входим всегда с чистого листа: по ТЗ выбран Notes.
 */
const panelMemory = {
  section: "all",
  selectedFolderId: null,
  selectedFolderContext: null,
  expandedFolderIds: new Set(),
  collapsed: false,
};

function rememberPanel(state) {
  panelMemory.section = state.section;
  panelMemory.selectedFolderId = state.selectedFolderId;
  panelMemory.selectedFolderContext = state.selectedFolderContext;
  panelMemory.expandedFolderIds = state.expandedFolderIds;
  panelMemory.collapsed = state.panelCollapsed;
}

/**
 * Раздел заметок: панель Workspace слева + редактор справа. Используется
 * разделом Notes (config.section всегда "notes").
 *
 * @param {HTMLElement} container
 * @param {{section: string, toolbarButtons: string[], basicToolbarButtons?: string[], pageModeInContextMenu?: boolean}} config
 */
export async function renderPanelSection(container, config) {
  // Роутер не чистит #app-view до готовности нового раздела, поэтому старая
  // панель ещё на месте, если перемонтируемся изнутри Notes. Проверяем ДО
  // await: после него разметку уже может заменить кто-то другой.
  const remounting = Boolean(container.querySelector('[data-role="workspace-body"]'));
  const memory = remounting ? panelMemory : null;

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
    // Уровень 1 — фиксированный раздел: "trash" | "favorites" | "all" | "folders" | "unfiled".
    // Раздел Notes внутри называется "all": под этим ключом в данных уже лежат
    // закрепления заметок (pinnedIn) и кружки главной, менять его — значит
    // мигрировать данные ради одного слова.
    section: memory ? memory.section : "all",
    // Уровень 2 — выбранная папка. Одна папка может показываться несколькими
    // строками (у неё бывает несколько родителей), поэтому помним ещё и контекст
    // строки, по которой кликнули: "root" или id родителя. null — подходит любая.
    selectedFolderId: memory ? memory.selectedFolderId : null,
    selectedFolderContext: memory ? memory.selectedFolderContext : null,
    // Уровень 3 — открытая заметка и контекст её строки (id папки, внутри
    // которой кликнули). null — заметку открыли из плоского списка или из поиска.
    selectedItemId: null,
    selectedItemContext: null,
    // Что показано в детали справа, если это удалённый элемент — { kind, id }.
    // Приоритетнее selectedItemId (см. renderDetail), сбрасывается при выборе
    // обычной заметки.
    selectedTrash: null,
    panelCollapsed: memory ? memory.collapsed : false,
    pendingMatch: null, // {query, index} — куда прокрутить открытую заметку
    flashFolderId: null, // папка, найденная поиском, — мигнуть ею один раз
    revealSelection: false, // пришли из поиска — прокрутить панель к выбранной строке
    expandedFolderIds: memory ? memory.expandedFolderIds : new Set(), // раскрытые папки
    // Выделение, которое сейчас нарисовано на экране (см. syncSelection).
    shownSelection: null,
  };

  // Корзину могли опустошить, пока нас не было, — раздела больше нет.
  if (state.section === "trash" && countTrash(state) === 0) state.section = "all";

  applySearchTarget(state);
  activePanel = { container, config, state };
  render(container, config, state);
}

// Просьба извне (быстрая заметка) обновить список открытого раздела, не трогая
// открытую справа заметку. Если раздел Notes сейчас не смонтирован
// (открыта главная/календарь) — тихо ничего не делаем (guard по наличию панели в
// DOM), заметка просто останется сохранённой в фоне.
export async function refreshActivePanelItems() {
  if (!activePanel) return;
  const { container, config, state } = activePanel;
  if (!container.querySelector('[data-role="workspace-body"]')) return;
  [state.items, state.folders] = await Promise.all([
    itemsService.listItems(config.section),
    itemsService.listFolders(config.section),
  ]);
  renderPanel(container, config, state);
  // Первая заметка появилась у пустого аккаунта — кнопка «Create note» в детали
  // должна смениться обычной подсказкой.
  renderDetailIfIdle(container, config, state);
}

// Раскрыть цепочку родителей папки, чтобы она стала видна в дереве Folders. У
// папки может быть несколько родителей — идём по первому существующему, этого
// достаточно, чтобы строка появилась на экране. visited — защита от цикла в
// данных, испорченных в обход itemsService.
function expandAncestors(state, folderId) {
  const visited = new Set();
  let currentId = folderId;
  while (currentId && !visited.has(currentId)) {
    visited.add(currentId);
    const folder = state.folders.find((f) => f.id === currentId);
    if (!folder) return;
    const parentId = parentIdsOf(folder).find((id) => state.folders.some((f) => f.id === id));
    if (!parentId) return;
    state.expandedFolderIds.add(parentId);
    currentId = parentId;
  }
}

// Пришли по результату поиска (или по кастомному кружку главной страницы):
// открываем нужную папку или заметку. target.folderId (кружок главной знает,
// через какое место — обычную папку или Favorites/Notes/Unfiled — заметку
// открыли) превращаем в раздел панели; без него или с исчезнувшей папкой —
// раздел Notes, там видна любая заметка.
function applySearchTarget(state) {
  const target = consumePendingTarget("item", "folder");
  if (!target) return;
  state.revealSelection = true;

  if (target.kind === "folder") {
    state.section = "folders";
    state.selectedFolderId = target.id;
    state.selectedFolderContext = null;
    state.flashFolderId = target.id;
    // Показываем саму папку вместе с содержимым: за ней и пришли.
    expandAncestors(state, target.id);
    state.expandedFolderIds.add(target.id);
    return;
  }

  const PSEUDO_SECTIONS = ["all", "favorites", "unfiled"];
  if (PSEUDO_SECTIONS.includes(target.folderId)) {
    state.section = target.folderId;
    state.selectedItemContext = null;
  } else if (state.folders.some((f) => f.id === target.folderId)) {
    state.section = "folders";
    expandAncestors(state, target.folderId);
    state.expandedFolderIds.add(target.folderId);
    state.selectedItemContext = target.folderId;
  } else {
    state.section = "all";
    state.selectedItemContext = null;
  }
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
 * Что прокручивает заметку. На широком экране — само поле детали: окно на
 * странице заметок неподвижно (html.is-notes-route в panels.css). В узком окне
 * панель и заметка стоят друг под другом, и прокручивается, как раньше, окно.
 */
function detailScroller(container) {
  const detailEl = container.querySelector('[data-role="detail"]');
  if (detailEl && isScrollContainer(detailEl)) return detailEl;
  return document.scrollingElement;
}

/**
 * Возврат прокрутки заметки после перерисовки раздела.
 *
 * render() пересоздаёт поле детали заново, и у нового прокрутка в нуле. Окно
 * (узкий экран) теряет её так же: пока container.innerHTML пуст, высота
 * документа схлопывается, и браузер зажимает прокрутку в 0 — замер владельца
 * показал переход 1476 → 0 без единого вызова scrollTo в стеке.
 *
 * Второй заход через requestAnimationFrame обязателен: высота на момент возврата
 * может быть ещё не окончательной (лист пересчитывает свой масштаб через
 * --page-fit), а прокрутка по слишком короткому содержимому молча зажимается.
 */
function restoreDetailScroll(container, y) {
  const scroller = detailScroller(container);
  if (scroller.scrollTop === y) return;
  scroller.scrollTop = y;
  requestAnimationFrame(() => {
    if (scroller.scrollTop !== y) scroller.scrollTop = y;
  });
}

function render(container, config, state) {
  // Любая правка через ПКМ — избранное, закрепить, переименовать, удалить —
  // заканчивается здесь, и без снятой заранее позиции длинный список каждый раз
  // прыгал в начало. Свежесмонтированному разделу возвращать нечего: роутер
  // вычистил #app-view, старых панелей в DOM нет и карта выйдет пустой, так что
  // отдельный признак «первый это рендер или нет» не нужен.
  const scrollTops = panelScrollTops(container);
  const detailScrollTop = detailScroller(container).scrollTop;
  // Та же заметка останется открытой — значит место, где читали, надо сохранить.
  const sameDetail = state.renderedDetailKey === detailKey(state);
  // renderDetail в двух случаях уводит окно НАМЕРЕННО: к найденному из поиска и в
  // конец текста у заметки с openAtEnd. Там возвращать прежнюю позицию нельзя —
  // она отменила бы прыжок. Флаг одноразовый, как pendingMatch рядом с ним.
  state.detailScrolled = false;

  container.innerHTML = `
    <a href="#/" class="back-link"><i class="ph ph-arrow-left"></i>${t("nav.backHome")}</a>
    <div class="panel-layout">
      <aside class="panel panel-workspace ${state.panelCollapsed ? "is-collapsed" : ""}">
        <div class="panel-header">
          <button type="button" class="panel-toggle" data-action="toggle-panel" title="${t("panel.togglePanel")}"><i class="ph ph-list"></i></button>
          <span class="panel-title">${t("panel.workspace")}</span>
          <button type="button" class="btn btn-small panel-header-add" data-action="new-entry"><i class="ph ph-plus"></i></button>
        </div>
        <ul class="workspace-sections" data-role="workspace-sections"></ul>
        <div class="panel-body" data-role="workspace-body"></div>
      </aside>

      <section class="panel-detail" data-role="detail"></section>
    </div>
  `;

  // Строки панели только что созданы заново — анимировать выделение не от чего,
  // оно сразу рисуется на месте (см. syncSelection).
  state.shownSelection = null;
  renderPanel(container, config, state);
  renderDetail(container, config, state);
  wireHeaderActions(container, config, state);
  wireBodyMenu(container, config, state);
  wireBodyBlankClick(container, state);
  // После renderDetail: он пересоздаёт редактор и может увести окно к концу
  // текста (scrollIntoView), а панели должны встать на место уже поверх этого.
  applyPanelScrollTops(container, scrollTops);
  revealSelectedRow(container, state);
  state.renderedDetailKey = detailKey(state);
  if (sameDetail && !state.detailScrolled) restoreDetailScroll(container, detailScrollTop);
}

// Пришли из поиска или с кружка главной — выбранная строка может оказаться
// ниже видимой части панели. Прокручиваем только саму панель: scrollIntoView
// двигал бы ещё и окно, а окно принадлежит открытой заметке.
function revealSelectedRow(container, state) {
  if (!state.revealSelection) return;
  state.revealSelection = false;
  const bodyEl = container.querySelector('[data-role="workspace-body"]');
  const rowEl = bodyEl.querySelector(".is-selected");
  if (!rowEl) return;
  const bodyRect = bodyEl.getBoundingClientRect();
  const rowRect = rowEl.getBoundingClientRect();
  if (rowRect.top < bodyRect.top || rowRect.bottom > bodyRect.bottom) {
    // Ректы — в пикселях экрана, прокрутка панели — в её собственных (zoom).
    bodyEl.scrollTop += toScrollPx(bodyEl, rowRect.top - bodyRect.top - bodyRect.height / 3);
  }
}

// Общая логика создания папки — переиспользуется и кнопкой "+" в шапке
// (в разделе Folders), и пунктом "New folder" контекстного меню панели.
function createFolderFlow(container, config, state) {
  return async () => {
    const name = await openPrompt({ message: t("panel.folderNamePrompt") });
    if (!name || !name.trim()) return;
    const folder = createFolderModel({ name: name.trim(), section: config.section });
    optimisticBulk(
      state,
      () => {
        state.folders = [...state.folders, folder];
        // Новая папка видна только в разделе Folders — уводим туда, иначе
        // создание выглядело бы так, будто ничего не произошло.
        state.section = "folders";
      },
      () => itemsService.createFolderFromModel(folder),
      () => renderPanel(container, config, state)
    );
  };
}

/**
 * Новая заметка: кнопка "+" (во всех разделах, кроме Folders), пункт
 * "New note" в меню папки и панели, кнопка "Create note" пустого аккаунта.
 * folderId — создать сразу внутри этой папки.
 */
function createNoteFlow(container, config, state, folderId = null) {
  const folderIds = folderId ? [folderId] : [];
  // В «Избранном» ведём себя как в папке: новая заметка сразу попадает в него.
  const isFavorite = !folderId && state.section === "favorites";
  // id уже готов на этом месте (createItemModel генерирует его сам) — экран
  // красим ЭТИМ ЖЕ объектом, persist ниже сохраняет его же, не строит заново.
  const item = createItemModel({ title: t("panel.untitled"), content: "", folderIds, section: config.section, isFavorite });
  optimisticBulk(
    state,
    () => {
      state.items = [...state.items, item];
      state.selectedItemId = item.id;
      state.selectedItemContext = folderId;
      state.selectedTrash = null;
      // Заметку должно быть видно в панели сразу: папку раскрываем, из Корзины
      // (где новой заметке не место) уходим в Notes.
      if (folderId) state.expandedFolderIds.add(folderId);
      if (state.section === "trash") state.section = "all";
      // Разово попросить деталь поставить курсор в поле названия — чтобы
      // печатать сразу, без клика мышкой.
      state.focusTitleOnCreate = true;
    },
    () => itemsService.createItemFromModel(item),
    () => render(container, config, state)
  );
}

function wireHeaderActions(container, config, state) {
  // Панель сворачивается в тонкую полоску у левого края. Перерисовывать ничего не
  // нужно — содержимое просто прячется стилями.
  container.querySelector('[data-action="toggle-panel"]').addEventListener("click", () => {
    state.panelCollapsed = !state.panelCollapsed;
    container.querySelector(".panel-workspace").classList.toggle("is-collapsed", state.panelCollapsed);
    rememberPanel(state);
  });

  // Одна кнопка "+" на всю панель: в разделе Folders создаёт папку, в остальных —
  // заметку (решение владельца, две кнопки в узкой шапке не помещаются).
  container.querySelector('[data-action="new-entry"]').addEventListener("click", () => {
    if (state.section === "folders") createFolderFlow(container, config, state)();
    else createNoteFlow(container, config, state);
  });
}

// ПКМ по пустому месту панели — создать папку или заметку. Вешаем один раз на
// каждую отрисовку каркаса: тело панели живёт до следующего render(), и подписка
// внутри renderPanel копилась бы с каждой перерисовкой списка.
function wireBodyMenu(container, config, state) {
  const bodyEl = container.querySelector('[data-role="workspace-body"]');
  bodyEl.addEventListener("contextmenu", (event) => {
    event.preventDefault();
    showContextMenu(event.clientX, event.clientY, [
      { label: t("panel.newFolder"), onClick: createFolderFlow(container, config, state) },
      { label: t("panel.newItem"), onClick: () => createNoteFlow(container, config, state) },
    ]);
  });
}

// Клик по пустому месту списка снимает выделение с папки — иначе снять его было
// нечем, и оно выглядело залипшим. Открытая заметка и раздел остаются выбранными:
// заметка всё ещё в редакторе, а раздел выбран всегда. Вешаем один раз на
// отрисовку каркаса — по той же причине, что и меню пустого места выше.
function wireBodyBlankClick(container, state) {
  const bodyEl = container.querySelector('[data-role="workspace-body"]');
  bodyEl.addEventListener("click", (event) => {
    if (event.target.closest("li")) return; // клик по строке — у неё свой обработчик
    if (state.selectedFolderId === null) return;
    state.selectedFolderId = null;
    state.selectedFolderContext = null;
    syncSelection(container, state);
    rememberPanel(state);
  });
}

// id настоящей папки, а не одного из служебных ключей: разделов панели и
// контекстов строк ("root" — строка папки на верхнем уровне дерева).
function isRealFolderId(id) {
  return Boolean(id) && !["all", "unfiled", "favorites", "trash", "folders", "root"].includes(id);
}

function countTrash(state) {
  return state.trash.folders.length + state.trash.items.length;
}

// Общий renderAfter для optimisticBulk-действий с Корзиной (удаление в неё,
// восстановление, удаление навсегда, массовая очистка) — полный render
// (детали корзины не жалко пересоздавать, там нет открытого редактора с
// курсором). Корзина опустела, пока была открыта, — раздел исчезнет из
// панели, самим собой оставаться в нём было бы некуда.
function renderAfterTrashChange(container, config, state) {
  if (state.section === "trash" && countTrash(state) === 0) {
    state.section = "all";
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
      "is-active", "is-selected", "is-drag-source", "is-search-flash"
    );
    if (prepareGhost) prepareGhost(ghost);
    ghost.style.position = "fixed";
    // Рект и мышь — в пикселях экрана, «призрак» лежит в body под масштабом
    // сайта: без перевода он отставал бы от курсора тем сильнее, чем дальше от
    // левого верхнего угла.
    ghost.style.width = `${toCssPx(rect.width)}px`;
    ghost.style.left = `${toCssPx(rect.left)}px`;
    ghost.style.top = `${toCssPx(rect.top)}px`;
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
    ghost.style.left = `${toCssPx(clientX - offsetX)}px`;
    ghost.style.top = `${toCssPx(clientY - offsetY)}px`;

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
  const heart = entity.isFavorite ? `<span class="fav-heart" title="${t("panel.favorites")}"><i class="ph ph-heart"></i></span>` : "";
  // Булавка — инлайн-SVG с fill="currentColor": цвет задаём в CSS (#C2D1C9), как у
  // сердечка. Эмодзи 📌 не красится, поэтому именно SVG.
  const pin = showPin
    ? `<span class="pin-badge" title="${t("panel.pinned")}"><i class="ph ph-push-pin-simple"></i></span>`
    : "";
  return heart + pin;
}

// Значок папки — по тому же приёму, что булавка: инлайн-SVG с fill="currentColor",
// чтобы цвет задавался в CSS и наследовался от текста строки. В «Избранном» папки и
// заметки идут одним списком, и без значка их не отличить.
function folderIcon() {
  return `<span class="folder-icon" aria-hidden="true"><i class="ph ph-folder-simple"></i></span>`;
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

// Каждый следующий уровень вложенности добавляет не больше пикселей, чем
// предыдущий — иначе глубокая вложенность съедала бы всю ширину узкой панели.
// Но и не меньше 12px: в этом зазоре слева от строки идёт линия иерархии (см.
// treeGuidesHtml), и на шаге уже прежних 9/6/4px она налезала бы на саму строку.
const INDENT_STEPS = [18, 16, 14, 12]; // px; после исчерпания — фиксированный шаг 12px
function indentForDepth(depth) {
  let total = 0;
  for (let i = 0; i < depth; i++) total += INDENT_STEPS[Math.min(i, INDENT_STEPS.length - 1)];
  return total;
}

// Где у строки центр значка папки, от её левого края: внутренний отступ строки
// (0.35em ≈ 4px) плюс половина значка (≈ 6px). Под этой точкой и идёт
// вертикальная линия к детям.
const TREE_GUIDE_OFFSET = 9;

/**
 * Вертикальные линии иерархии, как в прототипе: у каждой раскрытой папки одна
 * линия под её значком — от верха первого вложенного элемента до низа
 * последнего. Вложенные строки сдвинуты вправо внешним отступом (--indent в
 * panels.css), и линия идёт в этом зазоре, а не поверх строк.
 *
 * Линии — отдельный слой под строками, а не часть самих строк. Выбранная
 * строка увеличивается (transform: scale), и всё, что лежит внутри неё, ехало
 * бы вместе с ней. Координаты берём из раскладки (offsetTop/offsetLeft): на них
 * transform не влияет, поэтому при смене выбора линии стоят на месте.
 *
 * Перерисовывать нужно после каждой отрисовки списка: раскрыли папку, добавили
 * заметку — строки и их места уже другие.
 * @param {HTMLElement} listEl список строк (.workspace-list)
 */
function drawTreeGuides(listEl) {
  listEl.querySelector(":scope > .tree-guides")?.remove();
  const rows = [...listEl.querySelectorAll(":scope > [data-depth]")];
  const layer = document.createElement("div");
  layer.className = "tree-guides";
  layer.setAttribute("aria-hidden", "true");

  rows.forEach((row, index) => {
    if (!row.classList.contains("is-expanded")) return;
    const depth = Number(row.dataset.depth);
    // Потомки папки — все строки сразу под ней, пока глубина больше её глубины.
    let last = null;
    for (let i = index + 1; i < rows.length && Number(rows[i].dataset.depth) > depth; i++) last = rows[i];
    if (!last) return; // папка раскрыта, но пустая — линии не к чему идти

    const first = rows[index + 1];
    const line = document.createElement("span");
    line.className = "tree-guide";
    line.style.left = `${row.offsetLeft + TREE_GUIDE_OFFSET}px`;
    line.style.top = `${first.offsetTop}px`;
    line.style.height = `${last.offsetTop + last.offsetHeight - first.offsetTop}px`;
    layer.appendChild(line);
  });

  // Первым ребёнком — то есть ПОД строками: подсветка строки, даже увеличенная,
  // ложится поверх линии, а не наоборот.
  listEl.prepend(layer);
}
// ------------------------------------------------------------------
// Панель Workspace: фиксированные разделы сверху, под разделителем — содержимое
// выбранного раздела.
// ------------------------------------------------------------------

// Порядок разделов сверху вниз — по ТЗ. Корзина показывается, только когда в ней
// что-то есть.
const SECTIONS = [
  { key: "trash", labelKey: "panel.trash" },
  { key: "favorites", labelKey: "panel.favorites" },
  { key: "all", labelKey: "panel.all" },
  { key: "folders", labelKey: "panel.folders" },
  { key: "unfiled", labelKey: "panel.unfiled" },
];

// Сколько ждать над целью, пока перетаскивание само откроет раздел Folders или
// раскроет свёрнутую папку (см. createSpringLoader).
const SPRING_DELAY = 600;

// Что сейчас перетаскивают — { kind: "folder" | "item", id } или null. Нужно
// отрисовке: пружинка перерисовывает панель посреди переноса, и новые строки
// должны получить ту же подсветку, что успели получить старые.
let activeDrag = null;

// Корневые папки — без родителя, который всё ещё существует. Папка, у которой
// единственный родитель удалён или потерян, иначе пропала бы из дерева совсем.
function rootFolders(state) {
  return state.folders.filter((folder) =>
    parentIdsOf(folder).every((parentId) => !state.folders.some((f) => f.id === parentId))
  );
}

/**
 * Что показать в теле панели — плоский список описаний строк, без разметки.
 * Отдельно от отрисовки, потому что тот же список нужен для сравнения «что-то
 * поменялось или нет» при наборе текста (см. refreshPanelAfterEdit).
 *
 * Строка заметки несёт context — место показа: "all" / "unfiled" / "favorites"
 * для плоских списков, id папки — для заметки внутри раскрытой папки. От него
 * зависят закрепление (у каждого места своё) и пункт «Убрать из папки».
 */
function buildBodyRows(state) {
  const rows = [];
  if (state.section === "trash") {
    getTrashRows(state).forEach((entry) => rows.push({ kind: "trash", entry }));
  } else if (state.section === "all") {
    pushNoteRows(rows, state.items, "all", 0, true);
  } else if (state.section === "unfiled") {
    pushNoteRows(rows, state.items.filter((item) => item.folderIds.length === 0), "unfiled", 0, true);
  } else if (state.section === "favorites") {
    sortPinnedFirst(state.folders.filter((f) => f.isFavorite)).forEach((folder) =>
      pushFolderRows(rows, state, folder, 0, "root", [folder.id])
    );
    pushNoteRows(rows, state.items.filter((item) => item.isFavorite), "favorites", 0, true);
  } else if (state.section === "folders") {
    sortPinnedFirst(rootFolders(state)).forEach((folder) => pushFolderRows(rows, state, folder, 0, "root", [folder.id]));
  }
  return rows;
}

function pushNoteRows(rows, list, context, depth, flat) {
  sortItemsByPin(list, context).forEach((item) => {
    rows.push({ kind: "note", item, context, depth, flat, pinned: isPinnedIn(item, context), empty: isItemEmpty(item) });
  });
}

// Строка папки и — если она раскрыта — её содержимое сразу под ней: сначала
// дочерние папки, потом заметки, на шаг глубже. chain — папки текущей ветки,
// защита от бесконечной рекурсии при данных, испорченных в обход itemsService
// (например, вручную через localStorage).
function pushFolderRows(rows, state, folder, depth, context, chain) {
  const expanded = state.expandedFolderIds.has(folder.id);
  rows.push({ kind: "folder", folder, depth, context, expanded, count: countFolderContents(state, folder.id) });
  if (!expanded) return;
  childFoldersOf(state, folder.id)
    .filter((child) => !chain.includes(child.id))
    .forEach((child) => pushFolderRows(rows, state, child, depth + 1, folder.id, [...chain, child.id]));
  pushNoteRows(rows, state.items.filter((item) => item.folderIds.includes(folder.id)), folder.id, depth + 1, false);
}

// «Отпечаток» тела панели: порядок строк и всё, что меняет их разметку, кроме
// названия заметки — его при наборе правим прямо в строке.
function bodySignature(rows) {
  return rows
    .map((row) => {
      if (row.kind === "trash") return `t:${row.entry.kind}:${row.entry.id}`;
      if (row.kind === "folder") {
        const f = row.folder;
        return `f:${f.id}:${row.context}:${row.expanded}:${row.count}:${f.name}:${f.isFavorite}:${f.pinned}`;
      }
      return `n:${row.item.id}:${row.context}:${row.empty}:${row.pinned}:${row.item.isFavorite}`;
    })
    .join("|");
}

function isDragSource(kind, id) {
  return activeDrag !== null && activeDrag.kind === kind && activeDrag.id === id;
}

function folderRowHtml(row) {
  const { folder, depth, context, count } = row;
  // Пока тащат другую папку, у каждой папки видна зона «вложить» (правые 20%).
  const zone = activeDrag && activeDrag.kind === "folder" && activeDrag.id !== folder.id ? "is-drop-into-zone" : "";
  const source = isDragSource("folder", folder.id) ? "is-drag-source" : "";
  return `
    <li class="folder-item is-draggable ${row.expanded ? "is-expanded" : ""} ${folder.pinned ? "is-pinned" : ""} ${zone} ${source}"
        data-folder-id="${folder.id}" data-context="${context}" data-depth="${depth}"
        style="--indent: ${indentForDepth(depth)}px">
      ${folderIcon()}
      <span class="folder-name">${escapeHtml(folder.name)}</span>
      ${rowBadges(folder, folder.pinned)}
      <span class="folder-count">(${count})</span>
      ${count === 0 ? `<button type="button" class="folder-delete" data-delete-folder="${folder.id}" title="${t("panel.deleteFolder")}"><i class="ph ph-x"></i></button>` : ""}
    </li>`;
}

function noteRowHtml(row) {
  const { item, depth, context } = row;
  const source = isDragSource("item", item.id) ? "is-drag-source" : "";
  // Отступ — только у заметок внутри папок, и внешний (--indent → margin в
  // panels.css): слева от строки остаётся зазор под линию иерархии.
  const indent = depth > 0 ? `style="--indent: ${indentForDepth(depth)}px"` : "";
  return `
    <li class="item-list-row ${row.flat ? "" : "is-nested"} ${row.pinned ? "is-pinned" : ""} ${source}"
        data-item-id="${item.id}" data-context="${context}" data-depth="${depth}" ${row.flat ? 'data-flat="1"' : ""} ${indent}>
      <span class="item-title">${escapeHtml(item.title || t("panel.untitled"))}</span>
      ${rowBadges(item, row.pinned)}
      ${row.empty ? `<button type="button" class="item-delete" data-delete-item="${item.id}" title="${t("panel.delete")}"><i class="ph ph-x"></i></button>` : ""}
    </li>`;
}

// Содержимое Корзины — тот же визуальный стиль строки, что у заметок, но без
// перетаскивания и с другим контекстным меню (Восстановить / Удалить навсегда).
function trashRowHtml(row) {
  const { entry } = row;
  const title = entry.kind === "folder" ? entry.name : entry.title || t("panel.untitled");
  return `
    <li class="item-list-row" data-trash-kind="${entry.kind}" data-trash-id="${entry.id}">
      ${entry.kind === "folder" ? folderIcon() : ""}
      <span class="item-title">${escapeHtml(title)}</span>
    </li>`;
}

function bodyRowHtml(row) {
  if (row.kind === "trash") return trashRowHtml(row);
  if (row.kind === "folder") return folderRowHtml(row);
  return noteRowHtml(row);
}

/**
 * Перерисовать панель целиком: разделы, тело, подпись кнопки "+" и выделение.
 * Редактор справа не трогается — для этого есть render().
 * @param {{resetScroll?: boolean}} [options] resetScroll — сменился раздел, его
 *   содержимое показываем с начала, а не с позиции прежнего.
 */
function renderPanel(container, config, state, options = {}) {
  if (!container.querySelector('[data-role="workspace-body"]')) return;
  renderSections(container, config, state);
  renderWorkspaceBody(container, config, state, options.resetScroll);
  const addBtn = container.querySelector('[data-action="new-entry"]');
  addBtn.title = state.section === "folders" ? t("panel.newFolder") : t("panel.newItem");
  syncSelection(container, state);
  rememberPanel(state);
}

// Значки разделов — те же, что у навигации в прототипе редизайна.
const SECTION_ICONS = {
  trash: "ph-trash-simple",
  favorites: "ph-heart",
  all: "ph-note-blank",
  folders: "ph-folder-simple",
  unfiled: "ph-file-dashed",
};

function renderSections(container, config, state) {
  const listEl = container.querySelector('[data-role="workspace-sections"]');
  const trashCount = countTrash(state);
  const counts = { trash: trashCount, favorites: countFavorites(state) };

  listEl.innerHTML = SECTIONS.filter((section) => section.key !== "trash" || trashCount > 0)
    .map(
      (section) => `
      <li class="folder-item workspace-section" data-section="${section.key}">
        <i class="ph ${SECTION_ICONS[section.key]} section-icon" aria-hidden="true"></i>
        <span class="folder-name">${t(section.labelKey)}</span>
        ${section.key in counts ? `<span class="folder-count">(${counts[section.key]})</span>` : ""}
      </li>`
    )
    .join("");

  listEl.querySelectorAll("[data-section]").forEach((el) => {
    const key = el.dataset.section;
    el.addEventListener("click", () => selectSection(container, config, state, key));
  });

  // ПКМ на самом разделе "Корзина" (не на элементе внутри неё) — массовые операции.
  const trashEl = listEl.querySelector('[data-section="trash"]');
  if (trashEl) {
    trashEl.addEventListener("contextmenu", (event) => {
      event.preventDefault();
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
                state.selectedTrash = null;
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
                state.selectedTrash = null;
              },
              () => itemsService.emptyTrash(config.section),
              () => renderAfterTrashChange(container, config, state)
            );
          },
        },
      ]);
    });
  }
}

function renderWorkspaceBody(container, config, state, resetScroll) {
  const bodyEl = container.querySelector('[data-role="workspace-body"]');
  // Тело перерисовывают и в обход render() — при клике по папке, при наборе
  // названия. Узел остаётся прежним, но innerHTML всё равно сбрасывает прокрутку.
  const scrollTop = resetScroll ? 0 : bodyEl.scrollTop;

  const rows = buildBodyRows(state);
  state.bodySignature = bodySignature(rows);
  bodyEl.innerHTML = `
    <ul class="folder-list workspace-list">
      ${rows.map(bodyRowHtml).join("")}
      ${!rows.length ? `<li class="placeholder">${t("panel.empty")}</li>` : ""}
    </ul>
  `;
  bodyEl.scrollTop = scrollTop;

  // Линии иерархии — по готовой раскладке. Шрифты могут догрузиться позже и
  // поменять высоту строк, тогда перерисовываем, если список ещё на экране.
  const listEl = bodyEl.querySelector(".workspace-list");
  drawTreeGuides(listEl);
  document.fonts.ready.then(() => {
    if (listEl.isConnected) drawTreeGuides(listEl);
  });

  // Пришли из поиска: показываем, какая именно папка нашлась. Метка одноразовая.
  if (state.flashFolderId) {
    const found = bodyEl.querySelector(`[data-folder-id="${state.flashFolderId}"]`);
    if (found) found.classList.add("is-search-flash");
    state.flashFolderId = null;
  }

  bodyEl.querySelectorAll("[data-folder-id]").forEach((el) => wireFolderRow(el, container, config, state));
  bodyEl.querySelectorAll("[data-item-id]").forEach((el) => wireNoteRow(el, container, config, state));
  bodyEl.querySelectorAll("[data-trash-id]").forEach((el) => wireTrashRow(el, container, config, state));

  // Крестик виден только у пустой папки/заметки — удаляет мгновенно, без подтверждения.
  bodyEl.querySelectorAll("[data-delete-folder]").forEach((btn) => {
    btn.addEventListener("click", async (event) => {
      event.stopPropagation();
      await deleteFolderFlow(btn.dataset.deleteFolder, container, config, state, false);
    });
  });
  bodyEl.querySelectorAll("[data-delete-item]").forEach((btn) => {
    btn.addEventListener("click", async (event) => {
      event.stopPropagation();
      await deleteItemFlow(btn.dataset.deleteItem, container, config, state, false);
    });
  });
}

// ------------------------------------------------------------------
// Выделение. Три уровня — раздел, папка, заметка — живут независимо: выбор
// заметки не снимает выделение с её папки, а то — с раздела. Выбранная строка
// крупнее соседей на 10% (класс is-selected, см. panels.css), и смена выбора
// анимируется CSS-переходом.
// ------------------------------------------------------------------

function currentSelection(state) {
  return {
    section: state.section,
    folderId: state.selectedFolderId,
    folderContext: state.selectedFolderContext,
    itemId: state.selectedItemId,
    itemContext: state.selectedItemContext,
    trash: state.selectedTrash ? `${state.selectedTrash.kind}:${state.selectedTrash.id}` : null,
  };
}

function sameSelection(a, b) {
  return (
    a.section === b.section &&
    a.folderId === b.folderId &&
    a.folderContext === b.folderContext &&
    a.itemId === b.itemId &&
    a.itemContext === b.itemContext &&
    a.trash === b.trash
  );
}

// Одна и та же папка или заметка может стоять в панели несколькими строками
// (несколько родителей, несколько папок). Выделяем ту, по которой кликнули, —
// контекст строки должен совпасть. Контекст null (открыли из плоского списка
// или из поиска) подходит к любой строке. В плоских списках сущность встречается
// один раз, там контекст не сверяем.
function rowIsSelected(el, sel) {
  const data = el.dataset;
  if (data.section) return data.section === sel.section;
  if (data.trashId) return sel.trash === `${data.trashKind}:${data.trashId}`;
  if (data.folderId) {
    if (data.folderId !== sel.folderId) return false;
    return sel.folderContext === null || sel.folderContext === data.context;
  }
  if (data.itemId) {
    if (data.itemId !== sel.itemId) return false;
    if (data.flat) return true;
    return sel.itemContext === null || sel.itemContext === data.context;
  }
  return false;
}

function paintSelection(panelEl, sel) {
  panelEl.querySelectorAll("[data-section], [data-folder-id], [data-item-id], [data-trash-id]").forEach((el) => {
    el.classList.toggle("is-selected", rowIsSelected(el, sel));
  });
}

/**
 * Привести выделение на экране к state — с анимацией, если оно поменялось.
 *
 * CSS-переход играет, только если браузер успел увидеть элемент в СТАРОМ
 * состоянии. Строки, только что созданные через innerHTML, браузер ещё не видел:
 * поставь им сразу новый класс — и они просто появятся уже увеличенными. Поэтому
 * сначала рисуем прежнее выделение, затем заставляем браузер посчитать раскладку
 * (чтение offsetHeight) — тем самым он «запоминает» старые размеры, — и только
 * потом ставим новое. requestAnimationFrame здесь не помог бы: его колбэк
 * выполняется ДО того, как браузер считает стили кадра.
 */
function syncSelection(container, state) {
  const panelEl = container.querySelector(".panel-workspace");
  if (!panelEl) return;
  const next = currentSelection(state);
  const previous = state.shownSelection;
  if (previous && !sameSelection(previous, next)) {
    paintSelection(panelEl, previous);
    void panelEl.offsetHeight;
  }
  paintSelection(panelEl, next);
  state.shownSelection = next;
}

function selectSection(container, config, state, key) {
  if (state.section === key) return;
  state.section = key;
  renderPanel(container, config, state, { resetScroll: true });
  // Пустой аккаунт: кнопка «Create note» живёт только в разделе Notes.
  renderDetailIfIdle(container, config, state);
}

// Открыть заметку: перерисовываем только деталь, строки панели остаются теми же
// узлами — поэтому увеличение выбранной строки анимируется.
function selectNote(container, config, state, itemId, context) {
  state.selectedItemId = itemId;
  state.selectedItemContext = context;
  state.selectedTrash = null;
  syncSelection(container, state);
  showDetailFromTop(container, config, state);
}

function selectTrashEntry(container, config, state, kind, id) {
  state.selectedTrash = { kind, id };
  syncSelection(container, state);
  showDetailFromTop(container, config, state);
}

// Поле детали при смене заметки остаётся тем же узлом, и его прокрутка
// досталась бы новой заметке от старой. Другую заметку показываем с начала —
// кроме случая, когда renderDetail сам увёл к нужному месту (openAtEnd).
function showDetailFromTop(container, config, state) {
  const changed = state.renderedDetailKey !== detailKey(state);
  state.detailScrolled = false;
  renderDetail(container, config, state);
  if (changed && !state.detailScrolled) detailScroller(container).scrollTop = 0;
  state.renderedDetailKey = detailKey(state);
}

// Деталь показывает подсказку или кнопку «Create note» (ничего не открыто) —
// после смены раздела или числа заметок она могла устареть. Открытый редактор
// не трогаем: его пересоздание сбило бы каретку.
function renderDetailIfIdle(container, config, state) {
  if (state.selectedTrash) return;
  if (state.items.some((item) => item.id === state.selectedItemId)) return;
  renderDetail(container, config, state);
}

/**
 * Перетаскивание само открывает то, что скрыто: заметка, задержанная над
 * разделом Folders, переключает панель на него (в Notes и Unfiled папок не
 * видно, класть заметку некуда), а над свёрнутой папкой — раскрывает её (иначе
 * до вложенных папок не дотянуться).
 *
 * hover(key, action) зовётся на каждом кадре движения; таймер заводится, только
 * когда цель сменилась, и срабатывает один раз, пока курсор на ней.
 */
function createSpringLoader() {
  let currentKey = null;
  let timer = 0;
  return {
    hover(key, action) {
      if (key === currentKey) return;
      clearTimeout(timer);
      timer = 0;
      currentKey = key;
      if (key && action) {
        timer = setTimeout(() => {
          timer = 0;
          action();
        }, SPRING_DELAY);
      }
    },
    cancel() {
      clearTimeout(timer);
      timer = 0;
      currentKey = null;
    },
  };
}

// Действия пружинки. Перерисовываем только панель — редактор с открытой
// заметкой посреди переноса пересоздавать незачем.
function springToSection(container, config, state, key) {
  state.section = key;
  renderPanel(container, config, state, { resetScroll: true });
}

function springExpandFolder(container, config, state, folderId) {
  state.expandedFolderIds.add(folderId);
  renderPanel(container, config, state);
}

function wireFolderRow(el, container, config, state) {
  const folderId = el.dataset.folderId;
  const context = el.dataset.context;

  // Клик выбирает папку и раскрывает/сворачивает её содержимое. Открытую справа
  // заметку не трогаем — перерисовываем только панель.
  el.addEventListener("click", () => {
    state.selectedFolderId = folderId;
    state.selectedFolderContext = context;
    if (state.expandedFolderIds.has(folderId)) state.expandedFolderIds.delete(folderId);
    else state.expandedFolderIds.add(folderId);
    renderPanel(container, config, state);
  });

  // Механика переноса общая с заметками (см. startRowDrag) — здесь только поиск
  // цели и само действие.
  el.addEventListener("mousedown", (event) => {
    const spring = createSpringLoader();
    startRowDrag(event, {
      sourceEl: el,
      prepareGhost: (ghost) => {
        ghost.removeAttribute("data-folder-id");
        ghost.removeAttribute("data-context");
        // Крестик мгновенного удаления на "призраке" не нужен: он ничего не
        // делает (pointer-events: none), но выглядел бы рабочей кнопкой.
        const ghostDelete = ghost.querySelector(".folder-delete");
        if (ghostDelete) ghostDelete.remove();
      },
      onBeginDrag: () => {
        activeDrag = { kind: "folder", id: folderId };
        // Сразу показываем зону вложения у ВСЕХ папок — не только у той, что
        // окажется под курсором, — чтобы было видно, куда вообще можно "закинуть".
        // Строки, которые нарисует пружинка, получат её из folderRowHtml.
        container.querySelectorAll(".panel-workspace [data-folder-id]").forEach((rowEl) => {
          if (rowEl.dataset.folderId !== folderId) rowEl.classList.add("is-drop-into-zone");
        });
      },
      onCleanup: () => {
        activeDrag = null;
        spring.cancel();
        container
          .querySelectorAll(".panel-workspace .is-drop-into-zone, .panel-workspace .is-drop-into, .panel-workspace .is-drop-target, .panel-workspace .is-drag-source")
          .forEach((rowEl) => rowEl.classList.remove("is-drop-into-zone", "is-drop-into", "is-drop-target", "is-drag-source"));
      },
      findTarget: (clientX, clientY) => {
        const hit = document.elementFromPoint(clientX, clientY);
        const hitEl = hit ? hit.closest("[data-item-id], [data-folder-id], [data-section]") : null;
        if (!hitEl || hitEl.dataset.itemId) {
          spring.hover(null);
          return null;
        }

        const sectionKey = hitEl.dataset.section;
        if (sectionKey) {
          if (sectionKey === "favorites" || sectionKey === "unfiled") {
            spring.hover(null);
            hitEl.classList.add("is-drop-target");
            return { el: hitEl, folderId: sectionKey, into: false, after: false };
          }
          // Папку тащат из Избранного — над разделом Folders панель переключится
          // на него, и папку можно будет вложить в любую другую.
          if (sectionKey === "folders" && state.section !== "folders") {
            spring.hover("section:folders", () => springToSection(container, config, state, "folders"));
            hitEl.classList.add("is-drop-target");
            return { el: hitEl, folderId: null };
          }
          spring.hover(null);
          return null;
        }

        const hitId = hitEl.dataset.folderId;
        if (hitId === folderId) {
          spring.hover(null);
          return null; // сам на себя
        }
        const into = isDropInto(hitEl, { clientX });
        const after = isDropAfter(hitEl, { clientY });
        // Раскрываем только когда курсор в зоне «вложить»: при обычной
        // перестановке раскрывшаяся папка сдвигала бы строки из-под курсора.
        const canSpring = into && !state.expandedFolderIds.has(hitId);
        spring.hover(canSpring ? `folder:${hitId}` : null, () => springExpandFolder(container, config, state, hitId));
        if (into) hitEl.classList.add("is-drop-into");
        else markDropSide(hitEl, after);
        return { el: hitEl, folderId: hitId, into, after };
      },
      onDrop: (target) => {
        if (!target.folderId) return; // раздел Folders — только пружинка, не цель
        if (target.folderId === "favorites") {
          optimisticField(
            state, "folders", folderId, { isFavorite: true },
            () => itemsService.updateFolder(folderId, { isFavorite: true }),
            () => renderPanel(container, config, state)
          );
        } else if (target.folderId === "unfiled") {
          optimisticField(
            state, "folders", folderId, { parentFolderIds: [] },
            () => itemsService.updateFolder(folderId, { parentFolderIds: [] }),
            () => renderPanel(container, config, state)
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
              () => renderPanel(container, config, state)
            );
          }
        } else {
          const result = reorderedFolders(state.folders, folderId, target.folderId, target.after);
          if (result) {
            optimisticBulk(
              state,
              () => { state.folders = result.entries; },
              () => itemsService.setFoldersOrder(result.orderById),
              () => renderPanel(container, config, state)
            );
          }
        }
      },
    });
  });

  // ПКМ по папке: переименовать, избранное, закрепить, убрать из родителя,
  // новая заметка внутри, удаление (для непустых — единственный способ).
  el.addEventListener("contextmenu", (event) => {
    event.preventDefault();
    event.stopPropagation();
    const folder = state.folders.find((f) => f.id === folderId);
    // Строка показана внутри конкретного родителя — от НЕГО можно отвязать, не
    // удаляя папку (она останется у остальных родителей или станет корневой).
    const parentId = isRealFolderId(context) ? context : null;
    showContextMenu(event.clientX, event.clientY, [
      {
        label: t("panel.rename"),
        onClick: () => {
          startInlineRename(el, folder.name, (name) => {
            optimisticField(
              state, "folders", folder.id, { name },
              () => itemsService.updateFolder(folder.id, { name }),
              () => renderPanel(container, config, state)
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
            () => renderPanel(container, config, state)
          );
        },
      },
      {
        label: folder.pinned ? t("panel.unpin") : t("panel.pin"),
        onClick: () => {
          optimisticField(
            state, "folders", folder.id, { pinned: !folder.pinned },
            () => itemsService.updateFolder(folder.id, { pinned: !folder.pinned }),
            () => renderPanel(container, config, state)
          );
        },
      },
      ...(parentId
        ? [
            {
              label: t("panel.removeFromFolder"),
              onClick: () => {
                optimisticBulk(
                  state,
                  () => localRemoveFolderFromParent(state, folder.id, parentId),
                  () => itemsService.removeFolderFromParent(config.section, folder.id, parentId),
                  () => renderPanel(container, config, state)
                );
              },
            },
          ]
        : []),
      {
        label: t("panel.newItem"),
        onClick: () => createNoteFlow(container, config, state, folder.id),
      },
      {
        label: t("panel.delete"),
        onClick: () => deleteFolderFlow(folder.id, container, config, state, true),
      },
    ]);
  });
}

function wireNoteRow(el, container, config, state) {
  const itemId = el.dataset.itemId;
  const context = el.dataset.context;
  const isFlat = Boolean(el.dataset.flat);

  el.addEventListener("click", () => {
    selectNote(container, config, state, itemId, isFlat ? null : context);
  });

  // Перенос заметки — та же механика, что у папок (см. startRowDrag): за
  // курсором едет клон строки. Цели: другая заметка (перестановка), папка
  // (добавить в неё), разделы Favorites/Unfiled; над разделом Folders и над
  // свёрнутой папкой срабатывает пружинка.
  el.addEventListener("mousedown", (event) => {
    const spring = createSpringLoader();
    startRowDrag(event, {
      sourceEl: el,
      prepareGhost: (ghost) => {
        ghost.removeAttribute("data-item-id");
        ghost.removeAttribute("data-context");
        const ghostDelete = ghost.querySelector(".item-delete");
        if (ghostDelete) ghostDelete.remove();
      },
      onBeginDrag: () => {
        activeDrag = { kind: "item", id: itemId };
      },
      onCleanup: () => {
        activeDrag = null;
        spring.cancel();
        container
          .querySelectorAll(".panel-workspace .is-drop-target, .panel-workspace .is-drag-source")
          .forEach((rowEl) => rowEl.classList.remove("is-drop-target", "is-drag-source"));
      },
      findTarget: (clientX, clientY) => {
        const hit = document.elementFromPoint(clientX, clientY);
        const hitEl = hit ? hit.closest("[data-item-id], [data-folder-id], [data-section]") : null;
        if (!hitEl) {
          spring.hover(null);
          return null;
        }

        const sectionKey = hitEl.dataset.section;
        if (sectionKey) {
          if (sectionKey === "favorites" || sectionKey === "unfiled") {
            spring.hover(null);
            hitEl.classList.add("is-drop-target");
            return { el: hitEl, kind: "section", id: sectionKey };
          }
          if (sectionKey === "folders" && state.section !== "folders") {
            spring.hover("section:folders", () => springToSection(container, config, state, "folders"));
            hitEl.classList.add("is-drop-target");
            return { el: hitEl, kind: "none" };
          }
          spring.hover(null);
          return null;
        }

        const targetFolderId = hitEl.dataset.folderId;
        if (targetFolderId) {
          const collapsed = !state.expandedFolderIds.has(targetFolderId);
          spring.hover(collapsed ? `folder:${targetFolderId}` : null, () =>
            springExpandFolder(container, config, state, targetFolderId)
          );
          hitEl.classList.add("is-drop-target");
          return { el: hitEl, kind: "folder", id: targetFolderId };
        }

        spring.hover(null);
        const targetItemId = hitEl.dataset.itemId;
        if (targetItemId === itemId) return null; // сам на себя
        // Строка внутри папки, где этой заметки ещё нет, — бросок туда значит
        // «положить в эту папку», а не переставить: в одной панели папка и её
        // заметки стоят вперемешку с остальными строками, и целиться точно в
        // строку папки было бы неудобно.
        const targetContext = hitEl.dataset.context;
        const dragged = state.items.find((i) => i.id === itemId);
        if (!hitEl.dataset.flat && isRealFolderId(targetContext) && dragged && !dragged.folderIds.includes(targetContext)) {
          hitEl.classList.add("is-drop-target");
          return { el: hitEl, kind: "folder", id: targetContext };
        }
        const after = isDropAfter(hitEl, { clientY });
        markDropSide(hitEl, after);
        return { el: hitEl, kind: "item", id: targetItemId, after };
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
        if (target.kind === "none") return;
        if (target.kind === "item") {
          const result = reorderedItems(state.items, itemId, target.id, target.after);
          if (!result) return;
          const previousItems = state.items;
          state.items = result.entries;
          // Только панель: редактор от перестановки строк не меняется.
          renderPanel(container, config, state);
          afterPaint(() => {
            itemsService.setItemsOrder(result.orderById).catch(() => {
              state.items = previousItems;
              renderPanel(container, config, state);
            });
          });
          return;
        }
        if (target.id === "favorites") {
          optimisticField(
            state, "items", itemId, { isFavorite: true },
            () => itemsService.updateItem(itemId, { isFavorite: true }),
            () => renderPanel(container, config, state)
          );
        } else if (target.id === "unfiled") {
          optimisticField(
            state, "items", itemId, { folderIds: [] },
            () => itemsService.updateItem(itemId, { folderIds: [] }),
            () => renderPanel(container, config, state)
          );
        } else {
          const item = state.items.find((i) => i.id === itemId);
          if (item && !item.folderIds.includes(target.id)) {
            const folderIds = [...item.folderIds, target.id];
            optimisticField(
              state, "items", itemId, { folderIds },
              () => itemsService.updateItem(itemId, { folderIds }),
              () => renderPanel(container, config, state)
            );
          }
        }
      },
    });
  });

  el.addEventListener("contextmenu", (event) => {
    event.preventDefault();
    // Без этого событие всплыло бы до меню пустого места панели, и оно тут же
    // заменило бы меню заметки.
    event.stopPropagation();
    const item = state.items.find((i) => i.id === itemId);
    showContextMenu(event.clientX, event.clientY, [
      {
        label: t("panel.rename"),
        onClick: () => {
          startInlineRename(el, item.title, (title) => {
            optimisticField(
              state, "items", item.id, { title },
              () => itemsService.updateItem(item.id, { title }),
              () => renderPanel(container, config, state)
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
            () => renderPanel(container, config, state)
          );
        },
      },
      {
        // Закрепление тоглим для места, где показана ЭТА строка (её context),
        // независимо от других мест, где заметка тоже видна.
        label: isPinnedIn(item, context) ? t("panel.unpin") : t("panel.pin"),
        onClick: () => {
          const pinnedIn = isPinnedIn(item, context)
            ? item.pinnedIn.filter((k) => k !== context)
            : [...(item.pinnedIn || []), context];
          optimisticField(
            state, "items", item.id, { pinnedIn },
            () => itemsService.updateItem(item.id, { pinnedIn }),
            () => renderPanel(container, config, state)
          );
        },
      },
      // «Убрать из этой папки» — только у строки внутри папки. Перетаскивание в
      // папку добавляет, а не перемещает, поэтому убрать из одной папки можно отсюда.
      ...(isRealFolderId(context) && item.folderIds.includes(context)
        ? [
            {
              label: t("panel.removeFromFolder"),
              onClick: () => {
                const folderIds = item.folderIds.filter((f) => f !== context);
                optimisticField(
                  state, "items", item.id, { folderIds },
                  () => itemsService.updateItem(item.id, { folderIds }),
                  () => renderPanel(container, config, state)
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
}

function wireTrashRow(el, container, config, state) {
  const id = el.dataset.trashId;
  const kind = el.dataset.trashKind;
  // Название берём из самой строки: там уже разобрано и папка/заметка, и
  // подстановка «Без названия», второй раз это считать незачем.
  const name = el.querySelector(".item-title").textContent;

  el.addEventListener("click", () => selectTrashEntry(container, config, state, kind, id));

  el.addEventListener("contextmenu", (event) => {
    event.preventDefault();
    event.stopPropagation();
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
}

/**
 * Панель после правки открытой заметки. Редактор зовёт сохранение на каждую
 * букву, а перестраивать дерево на каждую букву — дорого и сбивает прокрутку с
 * анимациями. Поэтому не чаще кадра, и тело перестраивается, только если от
 * правки поменялся состав или порядок строк (заметка поднялась наверх по
 * свежести, перестала быть пустой). Новое название вписываем прямо в строку.
 */
let editRefreshFrame = 0;

function refreshPanelAfterEdit(container, config, state) {
  if (editRefreshFrame) return;
  editRefreshFrame = requestAnimationFrame(() => {
    editRefreshFrame = 0;
    const bodyEl = container.querySelector('[data-role="workspace-body"]');
    if (!bodyEl) return;
    if (bodySignature(buildBodyRows(state)) !== state.bodySignature) {
      renderPanel(container, config, state);
      return;
    }
    const item = state.items.find((i) => i.id === state.selectedItemId);
    if (!item) return;
    bodyEl.querySelectorAll(`[data-item-id="${item.id}"] .item-title`).forEach((titleEl) => {
      titleEl.textContent = item.title || t("panel.untitled");
    });
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
      if (state.selectedFolderId === folderId) {
        state.selectedFolderId = null;
        state.selectedFolderContext = null;
      }
      state.expandedFolderIds.delete(folderId);
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
  // Искать «в заметке» можно, только пока открыт редактор. Ниже каждый ранний
  // выход (корзина, пусто, заметка ещё грузится) так и оставит канал пустым,
  // а обычная заметка зарегистрирует себя сама после создания редактора.
  setNoteSearchSource(null);

  if (state.selectedTrash) {
    renderTrashDetail(detailEl, container, config, state);
    return;
  }

  const item = state.items.find((i) => i.id === state.selectedItemId);

  if (!item) {
    // У пользователя нет ни одной заметки (новый аккаунт или всё удалено) —
    // вместо подсказки «выберите слева», где выбирать нечего, сразу кнопка.
    if (state.items.length === 0 && state.section === "all") {
      detailEl.innerHTML = `
        <div class="empty-create">
          <button type="button" class="empty-create-btn" data-action="create-first-note">
            <span class="empty-create-plus" aria-hidden="true"><i class="ph ph-plus"></i></span>
            <span>${t("panel.createNote")}</span>
          </button>
        </div>`;
      detailEl
        .querySelector('[data-action="create-first-note"]')
        .addEventListener("click", () => createNoteFlow(container, config, state));
      return;
    }
    detailEl.innerHTML = `<p class="placeholder">${t("panel.selectPrompt")}</p>`;
    return;
  }

  // Список отдал урезанный объект без content — первое открытие этой заметки
  // за сессию (см. supabaseAdapter.getItems). Пока грузится один запрос —
  // плейсхолдер вместо редактора: пересоздать редактор на полпути, когда
  // content долетит, сложнее и рискованнее короткой паузы (createRichTextEditor
  // не умеет подменить content на живой, уже отрисованной инстанции).
  if (item.content === undefined) {
    detailEl.innerHTML = `
      <div class="item-detail">
        <h2 class="trash-detail-title">${escapeHtml(item.title || t("panel.untitled"))}</h2>
        <p class="placeholder">${t("panel.loadingItem")}</p>
      </div>`;
    const requestedId = item.id;
    itemsService.getItemContent(requestedId).then((content) => {
      // Ищем заметку в state.items ЗАНОВО, а не полагаемся на захваченную
      // ссылку item — optimisticField/optimisticBulk (rename/favorite/pin
      // на любой заметке) заменяют весь массив новыми объектами через spread,
      // и мутация старой ссылки тогда осталась бы не видна нигде.
      const current = state.items.find((i) => i.id === requestedId);
      if (current) current.content = content;
      // Гонка: пока грузилось, могли открыть другую заметку/корзину. Тогда не
      // трогаем экран — полный рендер пересоздал бы чужой уже открытый
      // редактор и вырвал бы курсор/прокрутку у заметки, которую сейчас
      // реально читают или печатают.
      if (state.selectedTrash || state.selectedItemId !== requestedId) return;
      renderDetail(container, config, state);
    });
    return;
  }

  // Порядок в детали заметки: тулбар сверху -> название -> текст.
  detailEl.innerHTML = `
    <div class="item-detail">
      <div class="rte-toolbar-host" data-role="toolbar-host"></div>
      <div class="item-detail-titlebar">
        <input type="text" class="item-title-input" data-role="title-input">
        <button type="button" class="btn btn-danger btn-small" data-action="delete-item"><i class="ph ph-trash-simple"></i>${t("panel.delete")}</button>
      </div>
      <div data-role="content-host"></div>
    </div>
  `;

  // Debounce на сохранение — свой на каждое открытие заметки, чтобы правки
  // разных полей не перетирали друг друга и не утекали в чужую заметку при
  // быстром переключении.
  let pendingPatch = {};
  let saveTimer = null;

  // Избранное/закрепление через ПКМ (optimisticField) заменяет объект открытой
  // заметки в state.items копией, а захваченный здесь item остаётся старым. Если
  // писать правки в него, список слева продолжал бы показывать прежнее название —
  // поэтому каждый раз берём актуальный объект по id.
  function openItem() {
    return state.items.find((i) => i.id === item.id) || item;
  }

  function scheduleSave(patch) {
    const current = openItem();
    Object.assign(current, patch);
    // itemsService.updateItem проставит activityAt и persist'нет его сам, но
    // только через 400мс дебаунса ниже — а список нужно пересортировать сразу.
    if ("content" in patch || "title" in patch) current.activityAt = new Date().toISOString();
    Object.assign(pendingPatch, patch);
    refreshPanelAfterEdit(container, config, state);
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
    // Название заметки нужно кнопке печати/выгрузки: оно уходит и на лист, и в
    // имя файла. Сам редактор его не знает и знать не должен — отдаём геттером,
    // как и пункты меню ниже.
    getNoteTitle: () => openItem().title,
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
              label: openItem().openAtEnd ? t("editor.openAtTop") : t("editor.openAtEnd"),
              onClick: () => {
                scheduleSave({ openAtEnd: !openItem().openAtEnd });
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
  detachFloatingToolbar = attachFloatingToolbar({ hostEl: toolbarHostEl, toolbarEl, boundsEl: contentEl, scrollEl: detailEl });

  // Строка поиска ищет по открытой заметке. Текст берём из item.content — туда
  // каждое нажатие клавиши попадает сразу (scheduleSave), раньше, чем уйдёт в
  // хранилище, поэтому находится и только что напечатанное. Номер вхождения в
  // этом тексте совпадает с тем, что считает highlightMatch в самом редакторе.
  setNoteSearchSource({
    contentEl,
    getTitle: () => openItem().title,
    getText: () => htmlToSearchText(openItem().content || ""),
    highlight: (query, occurrence) => editor.highlightMatch(query, occurrence),
  });

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
