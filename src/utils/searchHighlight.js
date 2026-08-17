/**
 * Подсветка найденного по поиску и поиск N-го вхождения в тексте. Общее место
 * для двух поверхностей: текста заметки в редакторе (richTextEditor.js) и
 * карточки блока в полноэкранном меню тегов (blockTagsBrowser.js). Реестр
 * CSS.highlights один на документ, поэтому и слот подсветки здесь один —
 * держать его в двух модулях с двумя таймерами значило бы, что они гасят
 * подсветку друг друга вслепую.
 */

// Имя, под которым диапазон регистрируется в CSS.highlights; цвет задан в
// styles/editor.css через ::highlight(search-hit) — правило глобальное, без
// предка-селектора, поэтому красит в любой части документа.
const SEARCH_HIGHLIGHT = "search-hit";
export const SEARCH_HIGHLIGHT_MS = 2500;
let searchHighlightTimer = null;

/**
 * Красит диапазон, ничего не вставляя в DOM: CSS Custom Highlight API рисует
 * поверх текста. Для contenteditable это принципиально — иначе подсветка попала
 * бы в разметку заметки, а оттуда в сохранённый HTML.
 * @param {Range} range
 */
export function showSearchHighlight(range) {
  if (typeof Highlight === "undefined" || !CSS.highlights) {
    // Старый браузер без Custom Highlight API — показываем найденное обычным
    // выделением. Оно тоже ничего не вставляет в текст.
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
    return;
  }
  CSS.highlights.set(SEARCH_HIGHLIGHT, new Highlight(range));
  searchHighlightTimer = setTimeout(clearSearchHighlight, SEARCH_HIGHLIGHT_MS);
}

export function clearSearchHighlight() {
  clearTimeout(searchHighlightTimer);
  if (CSS.highlights) CSS.highlights.delete(SEARCH_HIGHLIGHT);
  document.querySelectorAll(".rte-photo.is-search-hit").forEach((el) => el.classList.remove("is-search-hit"));
}

/**
 * Фото мигает классом с обводкой: Custom Highlight API умеет красить только
 * текстовые Range. Живёт здесь, а не у вызывающего, чтобы таймер гашения был
 * тем же самым — иначе clearSearchHighlight не смог бы его отменить.
 * @param {Element} img
 */
export function showPhotoHighlight(img) {
  img.scrollIntoView({ block: "center", behavior: "smooth" });
  img.classList.add("is-search-hit");
  searchHighlightTimer = setTimeout(() => img.classList.remove("is-search-hit"), SEARCH_HIGHLIGHT_MS);
}

/**
 * Диапазон occurrence-го вхождения query в тексте контейнеров. Ищет по всем
 * текстовым узлам подряд, поэтому находит и то, что разорвано форматированием
 * (жирное слово внутри предложения). Считаем именно порядковый номер вхождения —
 * по нему список результатов и различает несколько совпадений в одном месте.
 *
 * separator — чем склеены тексты контейнеров в той строке, по которой считались
 * номера вхождений. Это не косметика: у заметки индекс собран без разделителя,
 * а у блока (block.text в blockTags.js) строки склеены через пробел. Склей здесь
 * иначе — и номера разъедутся: запрос с пробелом на стыке строк либо не
 * найдётся, либо найдётся там, где в исходной строке его не было.
 *
 * @param {Element[]} containers
 * @param {string} query
 * @param {number} occurrence
 * @param {string} separator
 * @returns {Range | null}
 */
export function occurrenceRange(containers, query, occurrence, separator) {
  const needle = (query || "").toLowerCase();
  if (!needle) return null;

  const nodes = [];
  let text = "";
  containers.forEach((container, index) => {
    // Позиция разделителя своего узла не имеет: pointAt отдаст ближайший
    // реальный, этого достаточно — попасть на неё можно только запросом,
    // который сам содержит стык.
    if (index > 0) text += separator;
    const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      nodes.push({ node, start: text.length });
      text += node.textContent;
    }
  });

  const haystack = text.toLowerCase();
  let from = haystack.indexOf(needle);
  for (let i = 0; i < occurrence && from !== -1; i++) {
    from = haystack.indexOf(needle, from + needle.length);
  }
  if (from === -1) return null;

  const startPoint = pointAt(nodes, from);
  const endPoint = pointAt(nodes, from + needle.length);
  if (!startPoint || !endPoint) return null;
  const range = document.createRange();
  range.setStart(startPoint.node, startPoint.offset);
  range.setEnd(endPoint.node, endPoint.offset);
  return range;
}

// Позиция в склеенном тексте → узел и смещение внутри него.
function pointAt(nodes, position) {
  for (const entry of nodes) {
    const length = entry.node.textContent.length;
    if (position <= entry.start + length) return { node: entry.node, offset: position - entry.start };
  }
  return null;
}
