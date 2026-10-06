/**
 * Подсветка найденного по поиску и поиск N-го вхождения в тексте. Общее место
 * для двух поверхностей: текста заметки в редакторе (richTextEditor.js) и
 * карточки блока в полноэкранном меню тегов (blockTagsBrowser.js). Реестр
 * CSS.highlights один на документ, поэтому и слот подсветки здесь один —
 * держать его в двух модулях с двумя таймерами значило бы, что они гасят
 * подсветку друг друга вслепую.
 */

import { scrollContainerOf } from "./dom.js";

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

// Теги, которые htmlToSearchText (utils/dom.js) выбрасывает бесследно:
// «hel<b>lo</b>» в индексе — одно слово «hello».
const INLINE_TAGS = new Set(["A", "B", "I", "U", "S", "EM", "STRONG", "SPAN", "FONT", "MARK", "SUB", "SUP", "CODE"]);
// Строки редактора: в индексе на месте их конца стоит перевод строки.
const LINE_TAGS = new Set(["DIV", "P", "LI", "H1", "H2", "H3", "H4", "H5", "H6", "TR"]);
// Начало списка/таблицы, <br> и разделитель — тоже перевод строки.
const BREAK_ON_OPEN_TAGS = new Set(["UL", "OL", "TABLE", "BR", "HR"]);

/**
 * Диапазон occurrence-го вхождения query в тексте заметки — с той же нумерацией,
 * что в списке результатов. Номер там посчитан по htmlToSearchText (у гостя) или
 * по его зеркалу note_search_text на сервере (у залогиненного), а в этом тексте
 * пробелы и &nbsp; схлопнуты в один пробел, а строки разделены переводом строки.
 *
 * Сырые текстовые узлы (как в occurrenceRange) так не выглядят: &nbsp; там —
 * отдельный символ, и фраза «два&nbsp;слова» по запросу «два слова» не
 * находилась вовсе; а строки склеены без разделителя, и конец одной строки с
 * началом следующей давал лишнее «вхождение», от которого съезжал номер. Поэтому
 * текст здесь собирается по тем же правилам, что индекс, а каждый символ помнит,
 * из какого узла он взят, — по этим ссылкам и строится Range.
 *
 * @param {Element[]} pages страницы редактора (.rte-page)
 * @param {string} query
 * @param {number} occurrence
 * @param {string} skipSelector служебные узлы редактора, которых нет в сохранённой заметке
 * @returns {Range | null}
 */
export function noteOccurrenceRange(pages, query, occurrence, skipSelector) {
  const needle = (query || "").toLowerCase();
  if (!needle) return null;

  const chars = [];
  // Для каждого символа в chars — {node, offset}, у вставленного разделителя — null.
  const points = [];
  // Разделитель не пишем сразу: подряд идущие пробелы и переводы строки индекс
  // схлопывает в один, а перевод строки «сильнее» пробела рядом с ним.
  let pendingBreak = "";

  function addBreak(kind) {
    if (kind === "\n" || !pendingBreak) pendingBreak = kind;
  }

  function addChar(char, node, offset) {
    // По краям текста индекс разделители обрезает — в начале их не ставим.
    if (pendingBreak && chars.length) {
      chars.push(pendingBreak);
      points.push(null);
    }
    pendingBreak = "";
    // toLowerCase изредка удлиняет символ (турецкая «İ» → две единицы) — все
    // получившиеся единицы ведут в одно и то же место узла.
    const lower = char.toLowerCase();
    for (let i = 0; i < lower.length; i++) {
      chars.push(lower[i]);
      points.push({ node, offset });
    }
  }

  function walk(node) {
    if (node.nodeType === Node.TEXT_NODE) {
      const text = node.textContent;
      for (let i = 0; i < text.length; i++) {
        // \s в JS ловит и неразрывный пробел — как [^\S\n] в htmlToSearchText.
        if (/\s/.test(text[i])) addBreak(" ");
        else addChar(text[i], node, i);
      }
      return;
    }
    if (node.nodeType !== Node.ELEMENT_NODE || node.matches(skipSelector)) return;

    // У рисунка (svg) имена тегов строчные — приводим к одному виду.
    const tag = node.tagName.toUpperCase();
    const isInline = INLINE_TAGS.has(tag);
    // Любой другой тег индекс заменяет пробелом — и открывающий, и закрывающий.
    if (BREAK_ON_OPEN_TAGS.has(tag)) addBreak("\n");
    else if (!isInline) addBreak(" ");
    node.childNodes.forEach(walk);
    if (LINE_TAGS.has(tag)) addBreak("\n");
    else if (!isInline) addBreak(" ");
  }

  pages.forEach((page) => {
    page.childNodes.forEach(walk);
    addBreak("\n");
  });

  const haystack = chars.join("");
  let from = haystack.indexOf(needle);
  for (let i = 0; i < occurrence && from !== -1; i++) {
    from = haystack.indexOf(needle, from + needle.length);
  }
  if (from === -1) return null;

  // Запрос обрезан по краям (searchBar.js), поэтому первый и последний его
  // символы — настоящие, у них ссылка на узел есть всегда.
  const first = points[from];
  const last = points[from + needle.length - 1];
  if (!first || !last) return null;
  const range = document.createRange();
  range.setStart(first.node, first.offset);
  range.setEnd(last.node, last.offset + 1);
  return range;
}

/**
 * Ставит найденное по центру того, что прокручивает заметку (поле детали или
 * окно). Мерим сам диапазон, а не его родителя: родитель — это вся строка, а
 * у длинного абзаца её центр бывает на экран ниже слова, и слово уезжало за
 * край. Прыжок мгновенный: плавную прокрутку обрывает любая следующая
 * перестройка раздела, и переход то срабатывал, то нет.
 * @param {Range} range
 */
export function scrollRangeToCenter(range) {
  const rect = range.getBoundingClientRect();
  const scroller = scrollContainerOf(range.startContainer.parentElement);
  const isWindow = scroller === document.scrollingElement;
  const viewTop = isWindow ? 0 : scroller.getBoundingClientRect().top;
  const viewHeight = isWindow ? window.innerHeight : scroller.clientHeight;
  scroller.scrollTop += rect.top - viewTop - (viewHeight - rect.height) / 2;
}

// Позиция в склеенном тексте → узел и смещение внутри него.
function pointAt(nodes, position) {
  for (const entry of nodes) {
    const length = entry.node.textContent.length;
    if (position <= entry.start + length) return { node: entry.node, offset: position - entry.start };
  }
  return null;
}
