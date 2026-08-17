/**
 * Куда перейти по выбранному результату поиска. Цель живёт между сменой
 * маршрута и отрисовкой раздела: полоска поиска её кладёт, раздел забирает при
 * первой отрисовке и сразу очищает — повторный рендер не должен снова прыгать
 * к тому же месту.
 *
 * Через хеш это не тащим: маршруты засорились бы идентификаторами, а ссылка на
 * конкретное совпадение никому не нужна.
 *
 * @typedef {{kind: "folder" | "item" | "calendar", id: string, query: string, matchIndex: number, photoIndex?: number, date?: string, folderId?: string, blockId?: string}} SearchTarget
 */
let pending = null;

/** @param {SearchTarget} target */
export function setPendingTarget(target) {
  pending = target;
}

/**
 * @param {...("folder" | "item" | "calendar")} kinds какие цели умеет открыть раздел
 * @returns {SearchTarget | null}
 */
export function consumePendingTarget(...kinds) {
  if (!pending || !kinds.includes(pending.kind)) return null;
  const target = pending;
  pending = null;
  return target;
}

// Переход к разделу (см. navigate в app.js) — нужен внутренним ссылкам в
// richTextEditor.js, у которого нет доступа к роутеру напрямую (циклический
// импорт: app.js → documentsView.js → panelSection.js → richTextEditor.js).
let navigateHandler = null;

/** @param {(route: string) => void} fn */
export function setNavigateHandler(fn) {
  navigateHandler = fn;
}

export function getNavigateHandler() {
  return navigateHandler;
}
