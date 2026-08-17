/**
 * Канал между открытым полноэкранным меню тегов и строкой поиска: пока меню
 * открыто, поиск "в разделе" ищет не по заметкам, а по блокам, которые в этом
 * меню показаны. Тот же приём, что в searchTarget.js — модулям не нужно знать
 * друг о друге, чтобы обменяться одним значением. Отдельный файл, а не импорт
 * напрямую: searchBar.js уже импортирует blockTagsBrowser.js, и обратный
 * импорт замкнул бы их в цикл.
 *
 * @typedef {{
 *   getBlocks: () => object[],
 *   scrollToBlock: (itemId: string, blockId: string, query?: string, occurrence?: number) => void,
 *   close: () => void,
 * }} BlockSearchSource
 */
let source = null;
const listeners = new Set();

/** @param {BlockSearchSource | null} next null — меню закрыто, искать по блокам больше негде */
export function setBlockSearchSource(next) {
  source = next;
  listeners.forEach((listener) => listener(next));
}

/** @returns {BlockSearchSource | null} */
export function getBlockSearchSource() {
  return source;
}

/**
 * Строка поиска подписывается один раз при монтировании: ей нужно не только
 * значение, но и сам момент открытия/закрытия меню — она меняет охват поиска и
 * поднимается над оверлеем.
 * @param {(source: BlockSearchSource | null) => void} listener
 */
export function onBlockSearchSource(listener) {
  listeners.add(listener);
}
