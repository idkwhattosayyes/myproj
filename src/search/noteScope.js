/**
 * Канал между открытой заметкой и строкой поиска: охват «в разделе» на странице
 * Notes ищет внутри открытой сейчас заметки. Тот же приём, что в blockScope.js —
 * панель заметок и строка поиска обмениваются одним значением, не импортируя
 * друг друга (searchBar.js и так косвенно зависит от panelSection.js, обратный
 * импорт замкнул бы их в цикл).
 *
 * @typedef {{
 *   contentEl: HTMLElement,
 *   getTitle: () => string,
 *   getText: () => string,
 *   highlight: (query: string, occurrence: number) => void,
 * }} NoteSearchSource
 */
let source = null;
const listeners = new Set();

/** @param {NoteSearchSource | null} next null — открытой заметки нет (корзина, пусто, загрузка) */
export function setNoteSearchSource(next) {
  source = next;
  listeners.forEach((listener) => listener(next));
}

/** @returns {NoteSearchSource | null} */
export function getNoteSearchSource() {
  return source;
}

/**
 * Строка поиска подписывается один раз: подпись охвата («В заметке» / «Везде»)
 * зависит от того, открыта ли сейчас заметка.
 * @param {(source: NoteSearchSource | null) => void} listener
 */
export function onNoteSearchSource(listener) {
  listeners.add(listener);
}
