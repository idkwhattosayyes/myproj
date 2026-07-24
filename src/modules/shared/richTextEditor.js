import { t, getLang } from "../../i18n/i18n.js";
import { openTablePrompt, openConfirm } from "../../utils/modal.js";
import { pushLayer } from "../../utils/escapeLayers.js";
import { showContextMenu } from "./contextMenu.js";

const TEXT_COLORS = ["#e03131", "#f08c00", "#2f9e44", "#1971c2", "#7048e8", "#495057"];
// Заливка идёт под текст, поэтому палитра своя — светлая, иначе текст не читается.
const HIGHLIGHT_COLORS = ["#fff3a3", "#ffd8a8", "#b2f2bb", "#a5d8ff", "#d0bfff", "#ffc9c9"];

// Последний выбранный цвет запоминается: ЛКМ по кнопке красит именно им.
function getLastColor(storageKey, fallback) {
  return localStorage.getItem(storageKey) || fallback;
}

function setLastColor(storageKey, color) {
  localStorage.setItem(storageKey, color);
}

// Индикатор на кнопке (полоска у цвета текста, обводка у заливки) должен
// показывать выбранный цвет, а не зашитый в стилях. Цвет отдаём в CSS
// переменной — см. --swatch в styles/editor.css.
function updateSwatch(btn, def) {
  btn.style.setProperty("--swatch", getLastColor(def.storageKey, def.defaultColor));
}

// Свёрнутость тулбара — настройка вида, а не данные заметки, поэтому живёт
// в localStorage рядом с последними выбранными цветами. Без сохранения тулбар
// разворачивался бы обратно при каждом переключении заметки: renderDetail()
// создаёт редактор заново.
const TOOLBAR_COLLAPSED_KEY = "app:toolbarCollapsed";

function createToolbarToggle(toolbarEl) {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "rte-toolbar-toggle";
  btn.title = t("editor.toggleToolbar");

  function apply(collapsed) {
    toolbarEl.classList.toggle("is-collapsed", collapsed);
    btn.textContent = collapsed ? "▾" : "▴";
  }

  apply(localStorage.getItem(TOOLBAR_COLLAPSED_KEY) === "1");
  // Как и у кнопок форматирования: не забираем фокус, иначе выделение в тексте
  // схлопнется ещё до клика.
  btn.addEventListener("mousedown", (event) => event.preventDefault());
  btn.addEventListener("click", () => {
    const collapsed = !toolbarEl.classList.contains("is-collapsed");
    localStorage.setItem(TOOLBAR_COLLAPSED_KEY, collapsed ? "1" : "0");
    apply(collapsed);
  });
  return btn;
}

function getButtonDefs() {
  return {
    bold: { label: t("editor.boldLabel"), title: t("editor.bold"), command: () => document.execCommand("bold"), isActive: () => document.queryCommandState("bold") },
    italic: { label: t("editor.italicLabel"), title: t("editor.italic"), command: () => document.execCommand("italic"), isActive: () => document.queryCommandState("italic") },
    // U с линией снизу и S с линией посередине рисуются CSS-классом (см.
    // .rte-ico-* в styles/editor.css): по кнопке сразу видно, что она делает.
    underline: { label: "U", labelClass: "rte-ico-underline", title: t("editor.underline"), command: (editorEl) => toggleInlineFormat(editorEl, FORMATS.u), isActive: (editorEl) => isInlineFormatActive(editorEl, FORMATS.u) },
    strikethrough: { label: "S", labelClass: "rte-ico-strike", title: t("editor.strikethrough"), command: (editorEl) => toggleInlineFormat(editorEl, FORMATS.s), isActive: (editorEl) => isInlineFormatActive(editorEl, FORMATS.s) },
    h1: { label: "H1", title: t("editor.h1"), command: (editorEl) => applyHeading(editorEl, "H1"), isActive: (editorEl) => isHeading(editorEl, "H1") },
    h2: { label: "H2", title: t("editor.h2"), command: (editorEl) => applyHeading(editorEl, "H2"), isActive: (editorEl) => isHeading(editorEl, "H2") },
    alignLeft: { label: "⟸", title: t("editor.alignLeft"), command: () => document.execCommand("justifyLeft"), isActive: () => document.queryCommandState("justifyLeft") },
    alignCenter: { label: "≡", title: t("editor.alignCenter"), command: () => document.execCommand("justifyCenter"), isActive: () => document.queryCommandState("justifyCenter") },
    alignRight: { label: "⟹", title: t("editor.alignRight"), command: () => document.execCommand("justifyRight"), isActive: () => document.queryCommandState("justifyRight") },
    bulletList: { label: "•", title: t("editor.bulletList"), command: () => document.execCommand("insertUnorderedList"), isActive: () => document.queryCommandState("insertUnorderedList") },
    orderedList: { label: "1.", title: t("editor.orderedList"), command: () => document.execCommand("insertOrderedList"), isActive: () => document.queryCommandState("insertOrderedList") },
    checklist: { label: "☑", title: t("editor.checklist"), command: (editorEl) => applyChecklist(editorEl), isActive: (editorEl) => isInsideChecklist(editorEl) },
    textColor: {
      label: "A",
      title: t("editor.textColorHint"),
      isColor: true,
      colors: TEXT_COLORS,
      storageKey: "app:lastTextColor",
      defaultColor: TEXT_COLORS[0],
      apply: (color) => document.execCommand("foreColor", false, color),
      // Сбрасывает цвет текста обратно к обычному — иначе применённый foreColor
      // ничем не убрать после закрытия поповера.
      reset: () => document.execCommand("foreColor", false, "#1f2328"),
      isActive: (editorEl) => isColorActive(editorEl, "color"),
    },
    highlight: {
      label: "▮",
      title: t("editor.highlightHint"),
      isColor: true,
      colors: HIGHLIGHT_COLORS,
      storageKey: "app:lastHighlightColor",
      defaultColor: HIGHLIGHT_COLORS[0],
      apply: (color) => document.execCommand("hiliteColor", false, color),
      reset: () => document.execCommand("hiliteColor", false, "transparent"),
      isActive: (editorEl) => isColorActive(editorEl, "backgroundColor"),
      // Заливка = <span style="background-color">. При схлопнутой каретке
      // включаем/выключаем её через DOM-тумблер (см. toggleColorAtCaret), иначе
      // нативный hiliteColor не снимается по ходу печати.
      caretStyleProp: "backgroundColor",
    },
    table: { label: "▦", title: t("editor.table"), command: (editorEl) => insertTable(editorEl) },
    // Отмена/повтор — свой стек снимков (нативный execCommand("undo") не
    // откатывает наши <u>/<s> и заголовки-span). Обрабатываются в createRichTextEditor.
    undo: { label: "↶", title: t("editor.undo"), isHistory: "undo" },
    redo: { label: "↷", title: t("editor.redo"), isHistory: "redo" },
    // Голосовой ввод: ЛКМ — старт/стоп записи, ПКМ — выбор языка распознавания.
    // Обрабатывается отдельно в createRichTextEditor (см. isVoice).
    voice: { label: "🎤", title: t("editor.voice"), isVoice: true },
    // Не команда форматирования, а переключатель вида — обрабатывается отдельно
    // в createRichTextEditor (см. isPageMode).
    pageMode: { label: "▤", title: t("editor.pageMode"), isPageMode: true },
  };
}

// Языки распознавания речи. Подписи — на самих языках (имена собственные), через
// t() не гоняем. Выбранный код хранится в localStorage под VOICE_LANG_KEY.
const VOICE_LANG_KEY = "app:voiceLang";
const VOICE_LANGS = [
  { code: "ru-RU", label: "Русский" },
  { code: "en-US", label: "English" },
  { code: "he-IL", label: "עברית" },
];

// Web Speech API — единственный способ распознавания без сторонних зависимостей.
// В части браузеров его нет вовсе; тогда кнопку показываем неактивной.
const SpeechRecognitionCtor = window.SpeechRecognition || window.webkitSpeechRecognition;

function currentVoiceLang() {
  return localStorage.getItem(VOICE_LANG_KEY) || (getLang() === "ru" ? "ru-RU" : "en-US");
}

// Высота листа A4 при 96 dpi. То же значение стоит в min-height у .rte-page
// (styles/editor.css) — меняем в обоих местах, иначе обводка «страница выросла»
// начнёт появляться раньше или позже, чем текст реально вылез за лист.
const A4_HEIGHT = 1123;

// Ширина листа A4 при тех же 96 dpi — вместе с рамкой вокруг страницы (2px
// границы + 1px отступа с каждой стороны). То же значение стоит у .rte-page
// в styles/editor.css.
const PAGE_WIDTH = 794;
const PAGE_FRAME_WIDTH = PAGE_WIDTH + 6;

// Невидимый якорь: держит каретку внутри только что созданного (или только что
// покинутого) форматирующего тега, пока в него ничего не набрано. В сохраняемый
// HTML не попадает — см. serializeEditor.
const CARET_ANCHOR = "\u200B";

// \u0418\u043D\u043B\u0430\u0439\u043D\u043E\u0432\u044B\u0435 \u0444\u043E\u0440\u043C\u0430\u0442\u044B: \u0447\u0435\u043C \u0443\u0437\u043D\u0430\u0442\u044C (selector) \u0438 \u0447\u0435\u043C \u043E\u0431\u0435\u0440\u043D\u0443\u0442\u044C (create). \u0417\u0430\u0433\u043E\u043B\u043E\u0432\u043A\u0438
// \u0442\u043E\u0436\u0435 \u0438\u043D\u043B\u0430\u0439\u043D\u043E\u0432\u044B\u0435 \u2014 H1/H2 \u043F\u0440\u0438\u043C\u0435\u043D\u044F\u044E\u0442\u0441\u044F \u043A \u0432\u044B\u0434\u0435\u043B\u0435\u043D\u043D\u043E\u043C\u0443 \u043A\u0443\u0441\u043A\u0443 \u0441\u0442\u0440\u043E\u043A\u0438, \u0430 \u043D\u0435 \u043A \u0431\u043B\u043E\u043A\u0443,
// \u043F\u043E\u044D\u0442\u043E\u043C\u0443 \u044D\u0442\u043E span \u0441 \u043A\u043B\u0430\u0441\u0441\u043E\u043C, \u0430 \u043D\u0435 \u0441\u0430\u043C \u0442\u0435\u0433 <h1>.
const FORMATS = {
  u: { selector: "u", create: () => document.createElement("u") },
  s: { selector: "s", create: () => document.createElement("s") },
  h1: { selector: "span.rte-h1", create: () => createHeadingSpan("rte-h1") },
  h2: { selector: "span.rte-h2", create: () => createHeadingSpan("rte-h2") },
};

const EMPTY_WRAPPER_SELECTOR = "u,s,span.rte-h1,span.rte-h2";

function createHeadingSpan(className) {
  const span = document.createElement("span");
  span.className = className;
  return span;
}

/**
 * Заметка хранится как последовательность страниц: `<div class="rte-page">…</div>`.
 * В сплошном режиме страница обычно одна, поэтому снаружи это по-прежнему просто
 * текст. Рамки, крестики и кнопка «добавить страницу» в разметку не попадают —
 * собираем только сами страницы.
 */
function serializeEditor(editorEl) {
  return [...editorEl.querySelectorAll(".rte-page")]
    .map((page) => {
      // Промежуточный (ещё не финализированный) текст диктовки лежит во временном
      // span.rte-interim — в сохраняемый HTML он попадать не должен.
      const clone = page.cloneNode(true);
      clone.querySelectorAll(".rte-interim").forEach((node) => node.remove());
      return `<div class="rte-page">${clone.innerHTML}</div>`;
    })
    .join("")
    .split(CARET_ANCHOR)
    .join("")
    .replace(/<(u|s)><\/\1>/g, "");
}

// Заметки, сохранённые до появления страниц, лежат одним куском HTML — такой
// текст становится единственной страницей (ср. upgradeLegacyChecklists).
function parsePages(html) {
  const holder = document.createElement("div");
  holder.innerHTML = html || "";
  const pages = [...holder.querySelectorAll(":scope > .rte-page")];
  if (!pages.length) return [holder.innerHTML];
  return pages.map((page) => page.innerHTML);
}

/**
 * Страница — самостоятельная область ввода: текст с одной страницы никуда не
 * перетекает, и правка одной не задевает соседние. Рамка вокруг неё нужна, чтобы
 * было куда повесить обводку переполнения и крестик удаления.
 */
function createPageFrame(html) {
  const frame = document.createElement("div");
  frame.className = "rte-page-frame";

  const page = document.createElement("div");
  page.className = "rte-page";
  page.contentEditable = "true";
  page.spellcheck = false;
  // Пустой title у потомка гасит подсказку, унаследованную от рамки: над текстом
  // она всплывать не должна — только над самой обводкой.
  page.title = "";
  page.innerHTML = html || "<div><br></div>";

  frame.appendChild(page);
  return frame;
}

/**
 * Подчёркивание и зачёркивание в обход execCommand. Chrome кладёт обе команды в
 * одно свойство text-decoration, из-за чего они затирали друг друга, не
 * снимались в середине слова и strikeThrough вставлял лишний символ. Свои
 * <u>/<s> вкладываются независимо и снимаются в любой точке.
 */
function toggleInlineFormat(editorEl, format) {
  const selection = window.getSelection();
  if (!selection.rangeCount) return;
  const range = selection.getRangeAt(0);
  if (!editorEl.contains(range.commonAncestorContainer)) return;

  if (!range.collapsed) {
    if (isInlineFormatActive(editorEl, format)) unwrapSelection(editorEl, format, range);
    else wrapSelection(editorEl, format, range);
    return;
  }

  const active = getFormatAncestor(editorEl, format, range.startContainer);
  if (active) exitInlineFormat(active, range);
  else enterInlineFormat(format, range);
}

// Активна, если ВЕСЬ выделенный текст уже в этом теге (для схлопнутой каретки —
// если в нём находится сама каретка). Иначе кнопка должна включать формат.
function isInlineFormatActive(editorEl, format) {
  const selection = window.getSelection();
  if (!selection.rangeCount) return false;
  const range = selection.getRangeAt(0);
  if (!editorEl.contains(range.commonAncestorContainer)) return false;

  if (range.collapsed) return !!getFormatAncestor(editorEl, format, range.startContainer);

  const nodes = collectTextNodes(range);
  return nodes.length > 0 && nodes.every((node) => getFormatAncestor(editorEl, format, node));
}

function getFormatAncestor(editorEl, format, node) {
  let el = node && node.nodeType === Node.TEXT_NODE ? node.parentElement : node;
  if (!el || !editorEl.contains(el)) return null;
  const found = el.closest(format.selector);
  return found && editorEl.contains(found) ? found : null;
}

// Непустые текстовые узлы, которые пересекает выделение.
function collectTextNodes(range) {
  const root = range.commonAncestorContainer;
  if (root.nodeType === Node.TEXT_NODE) return range.toString() ? [root] : [];

  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const nodes = [];
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (node.textContent.length && range.intersectsNode(node)) nodes.push(node);
  }
  return nodes;
}

function wrapSelection(editorEl, format, range) {
  // Режем крайние текстовые узлы по границам выделения (конец раньше начала —
  // иначе сдвинулись бы смещения), чтобы дальше оборачивать узлы целиком.
  const { endContainer, endOffset, startContainer, startOffset } = range;
  if (endContainer.nodeType === Node.TEXT_NODE && endOffset < endContainer.length) {
    endContainer.splitText(endOffset);
  }
  if (startContainer.nodeType === Node.TEXT_NODE && startOffset > 0) {
    range.setStart(startContainer.splitText(startOffset), 0);
  }

  const nodes = collectTextNodes(range);
  if (!nodes.length) return;

  nodes.forEach((node) => {
    if (getFormatAncestor(editorEl, format, node)) return; // уже оформлен
    const wrapper = format.create();
    node.replaceWith(wrapper);
    wrapper.appendChild(node);
  });

  selectNodes(nodes);
}

function unwrapSelection(editorEl, format, range) {
  const { endContainer, endOffset, startContainer, startOffset } = range;
  if (endContainer.nodeType === Node.TEXT_NODE && endOffset < endContainer.length) {
    endContainer.splitText(endOffset);
  }
  if (startContainer.nodeType === Node.TEXT_NODE && startOffset > 0) {
    range.setStart(startContainer.splitText(startOffset), 0);
  }

  const nodes = collectTextNodes(range);
  nodes.forEach((node) => {
    const wrapper = getFormatAncestor(editorEl, format, node);
    if (!wrapper) return;
    // Выносим узел из тега, отрезая всё, что было до и после него.
    splitOff(wrapper, node, "after");
    splitOff(wrapper, node, "before");
    wrapper.replaceWith(...wrapper.childNodes);
  });

  removeEmptyFormatWrappers(editorEl);
  selectNodes(nodes);
}

// После разрезания на границах выделения остаются пустые обёртки вроде
// <u><s></s></u> — невидимые, но копящиеся в разметке. Убираем сразу.
// Тег с якорем каретки не пустой (в нём ZWSP), поэтому он переживёт чистку.
function removeEmptyFormatWrappers(editorEl) {
  editorEl.querySelectorAll(EMPTY_WRAPPER_SELECTOR).forEach((el) => {
    if (el.textContent === "") el.remove();
  });
}

// Переносит часть содержимого el (до или после node) в такой же соседний тег.
// Промежуточные обёртки внутри el сохраняются — extractContents клонирует их.
function splitOff(el, node, side) {
  const range = document.createRange();
  range.selectNodeContents(el);
  if (side === "after") range.setStartAfter(node);
  else range.setEndBefore(node);

  const part = range.extractContents();
  if (!part.childNodes.length) return;

  const clone = el.cloneNode(false);
  clone.appendChild(part);
  if (side === "after") el.after(clone);
  else el.before(clone);
}

function selectNodes(nodes) {
  if (!nodes.length) return;
  const range = document.createRange();
  range.setStartBefore(nodes[0]);
  range.setEndAfter(nodes[nodes.length - 1]);
  const selection = window.getSelection();
  selection.removeAllRanges();
  selection.addRange(range);
}

// Включение без выделения: пустой тег с невидимым якорем, каретка внутри —
// дальнейший ввод сразу оформляется.
function enterInlineFormat(format, range) {
  const wrapper = format.create();
  wrapper.appendChild(document.createTextNode(CARET_ANCHOR));
  range.insertNode(wrapper);
  placeCaretAfter(wrapper.firstChild, wrapper.firstChild.length);
}

// Выключение без выделения: разрезаем тег в точке каретки и ставим её МЕЖДУ
// половинами — снаружи тега. Работает и в середине слова, и в конце: пробел
// для выхода из форматирования больше не нужен.
function exitInlineFormat(wrapper, range) {
  const tailRange = document.createRange();
  tailRange.selectNodeContents(wrapper);
  tailRange.setStart(range.startContainer, range.startOffset);

  const tail = tailRange.extractContents();
  if (tail.childNodes.length) {
    const clone = wrapper.cloneNode(false);
    clone.appendChild(tail);
    wrapper.after(clone);
  }

  const anchor = document.createTextNode(CARET_ANCHOR);
  wrapper.after(anchor);
  if (wrapper.textContent === "") wrapper.remove(); // каретка стояла в самом начале тега
  placeCaretAfter(anchor, anchor.length);
}

function placeCaretAfter(node, offset) {
  const range = document.createRange();
  range.setStart(node, offset);
  range.collapse(true);
  const selection = window.getSelection();
  selection.removeAllRanges();
  selection.addRange(range);
}

// Носитель цвета: ближайший предок каретки (в пределах страницы), чей инлайн-стиль
// задаёт нужное свойство. hiliteColor при styleWithCSS=false кладёт заливку в
// <span style="background-color:…"> — его и ловим по el.style[styleProp].
function colorCarrier(editorEl, node, styleProp) {
  let el = node && node.nodeType === Node.TEXT_NODE ? node.parentElement : node;
  while (el && editorEl.contains(el) && !el.classList.contains("rte-page")) {
    if (el.style && el.style[styleProp]) return el;
    el = el.parentElement;
  }
  return null;
}

// Тумблер цвета при СХЛОПНУТОЙ каретке. Нативный execCommand в этом случае не
// разрывает залитый span и не выводит каретку наружу — печать продолжается с
// заливкой, пока не кликнешь мышью в другое место. Поэтому здесь та же механика,
// что у <u>/<s>: внутри залитого span — разрезать его и увести каретку в
// ZWSP-якорь снаружи (exitInlineFormat); вне заливки — вставить пустой залитый
// span с якорем и поставить каретку внутрь.
function toggleColorAtCaret(editorEl, styleProp, color) {
  const selection = window.getSelection();
  if (!selection.rangeCount) return;
  const range = selection.getRangeAt(0);
  if (!editorEl.contains(range.commonAncestorContainer)) return;

  const carrier = colorCarrier(editorEl, range.startContainer, styleProp);
  if (carrier) {
    exitInlineFormat(carrier, range);
  } else {
    const wrapper = document.createElement("span");
    wrapper.style[styleProp] = color;
    wrapper.appendChild(document.createTextNode(CARET_ANCHOR));
    range.insertNode(wrapper);
    placeCaretAfter(wrapper.firstChild, wrapper.firstChild.length);
  }
}

// Ближайший блочный элемент, содержащий каретку (внутри редактора, но не сам
// редактор). Используется для заголовков: сравниваем именно ближайший блок, а
// не любого предка — иначе node.closest("h1") ловил бы обёртку и подсвечивал
// обе кнопки H1/H2 одновременно.
function getBlockElement(editorEl) {
  const selection = window.getSelection();
  if (!selection.rangeCount) return null;
  let node = selection.getRangeAt(0).startContainer;
  if (node.nodeType === Node.TEXT_NODE) node = node.parentElement;
  if (!node || !editorEl.contains(node)) return null;
  const block = node.closest("h1,h2,p,div,li,blockquote");
  return block && block !== editorEl && editorEl.contains(block) ? block : null;
}

function isHeading(editorEl, tagName) {
  const block = getBlockElement(editorEl);
  if (block && block.tagName === tagName.toUpperCase()) return true;
  return isInlineFormatActive(editorEl, FORMATS[tagName.toLowerCase()]);
}

/**
 * Есть выделение — заголовок применяется ТОЛЬКО к нему: хоть одна буква, хоть
 * несколько строк. Строка при этом не разрывается, оформляется сам фрагмент.
 * Ничего не выделено — прежнее поведение: весь блок под кареткой становится
 * заголовком (и повторное нажатие снимает его).
 */
function applyHeading(editorEl, tagName) {
  const format = FORMATS[tagName.toLowerCase()];
  const other = FORMATS[tagName.toLowerCase() === "h1" ? "h2" : "h1"];
  const selection = window.getSelection();
  const range = selection.rangeCount ? selection.getRangeAt(0) : null;

  if (range && !range.collapsed && editorEl.contains(range.commonAncestorContainer)) {
    // H1 и H2 взаимоисключающие: снимаем соседний уровень с этого же фрагмента.
    if (isInlineFormatActive(editorEl, other)) {
      unwrapSelection(editorEl, other, selection.getRangeAt(0));
    }
    toggleInlineFormat(editorEl, format);
    return;
  }

  const block = getBlockElement(editorEl);
  if (block && block.tagName === tagName.toUpperCase()) {
    document.execCommand("formatBlock", false, "div");
  } else {
    document.execCommand("formatBlock", false, tagName);
  }
}

// Активность textColor/highlight определяем по computed-стилю в точке курсора,
// т.к. queryCommandState не поддерживает произвольные значения foreColor/hiliteColor.
function isColorActive(editorEl, cssProp) {
  const selection = window.getSelection();
  if (!selection.rangeCount) return false;
  let node = selection.getRangeAt(0).startContainer;
  if (node.nodeType === Node.TEXT_NODE) node = node.parentElement;
  if (!node || !editorEl.contains(node)) return false;

  const value = window.getComputedStyle(node)[cssProp];
  if (cssProp === "backgroundColor") {
    return !!value && value !== "rgba(0, 0, 0, 0)" && value !== "transparent";
  }
  return value !== window.getComputedStyle(editorEl).color;
}

/**
 * Собирает тулбар и contenteditable-область как отдельные DOM-узлы, не
 * привязываясь к порядку в разметке — вызывающий код (panelSection.js)
 * сам решает, куда их поставить (тулбар сверху, название, затем текст).
 *
 * @param {{content: string, buttons: string[], pageMode?: "flow" | "paged", onChange: (html: string) => void, onPageModeChange?: (mode: string) => void, getExtraMenuItems?: () => {label: string, onClick: () => void}[]}} options
 * @returns {{toolbarEl: HTMLElement, contentEl: HTMLElement, getPageMode: () => string, togglePageMode: () => void, refreshLayout: () => void, focusContent: () => void}}
 */
export function createRichTextEditor({ content, buttons, pageMode = "flow", onChange, onPageModeChange, getExtraMenuItems, initialHistory = null, onHistoryChange = null }) {
  const buttonDefs = getButtonDefs();
  // Просим браузер размечать команды тегами (<b>), а не инлайновым CSS: со
  // стилями Chrome складывает разные оформления в одно свойство и они
  // затирают друг друга.
  document.execCommand("styleWithCSS", false, false);

  const toolbarEl = document.createElement("div");
  toolbarEl.className = "rte-toolbar";
  toolbarEl.setAttribute("role", "toolbar");
  toolbarEl.appendChild(createToolbarToggle(toolbarEl));

  // Сам контейнер не редактируется — редактируются страницы внутри него. Все
  // проверки форматирования смотрят на editorEl.contains(узел), поэтому им
  // по-прежнему передаётся контейнер.
  const contentEl = document.createElement("div");
  contentEl.className = "rte-content";
  parsePages(content).forEach((html) => contentEl.appendChild(createPageFrame(html)));
  upgradeLegacyChecklists(contentEl);

  // Новая страница появляется только по явному действию — текст сам по себе на
  // следующую страницу не перетекает.
  const addPageBtn = document.createElement("button");
  addPageBtn.type = "button";
  addPageBtn.className = "rte-add-page";
  addPageBtn.textContent = `＋ ${t("editor.addPage")}`;
  addPageBtn.addEventListener("click", addPage);
  contentEl.appendChild(addPageBtn);

  // "flow" — один сплошной лист, "paged" — отдельные листы A4.
  let currentPageMode = pageMode === "paged" ? "paged" : "flow";
  buttonDefs.pageMode.isActive = () => currentPageMode === "paged";

  // Страница, в которой последний раз стояла каретка: именно её возвращаем в
  // фокус после нажатия кнопки тулбара.
  let activePageEl = getPages()[0] || null;

  function getPages() {
    return [...contentEl.querySelectorAll(".rte-page")];
  }

  function focusActivePage() {
    const pages = getPages();
    if (!activePageEl || !contentEl.contains(activePageEl)) activePageEl = pages[0] || null;
    // preventScroll — та же причина, что и в applyRange: фокус не двигает вьюпорт.
    if (activePageEl) activePageEl.focus({ preventScroll: true });
  }

  function addPage() {
    const frame = createPageFrame("");
    contentEl.insertBefore(frame, addPageBtn);
    activePageEl = frame.querySelector(".rte-page");
    activePageEl.focus();
    onChange(serializeEditor(contentEl));
    refreshPages();
  }

  function removePage(page) {
    if (getPages().length < 2) return;
    page.parentElement.remove();
    activePageEl = null;
    onChange(serializeEditor(contentEl));
    refreshPages();
    focusActivePage();
  }

  // Лист шире колонки (узкое окно, развёрнутые обратно панели, зум) — уменьшаем
  // его целиком, сохраняя пропорции A4. Увеличивать сверх 100% не нужно: при
  // браузерном зуме лист и так растёт вместе со всей страницей.
  function updatePageFit() {
    const available = contentEl.clientWidth;
    if (!available) return; // узел ещё не в документе — посчитаем после вставки
    contentEl.style.setProperty("--page-fit", String(Math.min(1, available / PAGE_FRAME_WIDTH)));
  }

  // Пересчитывает всё, что зависит от наполнения страниц: обводку переполнения и
  // крестик удаления. Вызывается на ввод и на смену режима — перерисовывать
  // редактор целиком ради этого не нужно.
  function refreshPages() {
    const pages = getPages();
    const paged = currentPageMode === "paged";
    addPageBtn.hidden = !paged;
    updatePageFit();

    pages.forEach((page) => {
      const frame = page.parentElement;
      const isOverflowing = paged && page.offsetHeight > A4_HEIGHT;
      frame.classList.toggle("is-overflow", isOverflowing);
      if (isOverflowing) frame.title = t("editor.pageOverflow");
      else frame.removeAttribute("title");

      // Крестик — только у пустой страницы, ровно как у пустой заметки в списке.
      // Непустую удаляют через ПКМ, с подтверждением.
      const removable = paged && pages.length > 1 && page.textContent.trim() === "";
      const existing = frame.querySelector(".rte-page-delete");
      if (removable && !existing) frame.appendChild(createPageDeleteButton(page));
      else if (!removable && existing) existing.remove();
    });
  }

  function createPageDeleteButton(page) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "rte-page-delete";
    btn.title = t("editor.deletePage");
    btn.textContent = "✕";
    btn.addEventListener("mousedown", (event) => event.preventDefault());
    btn.addEventListener("click", () => removePage(page));
    return btn;
  }

  function applyPageMode() {
    contentEl.classList.toggle("is-paged", currentPageMode === "paged");
    refreshPages();
    refreshToolbarState();
  }

  function togglePageMode() {
    currentPageMode = currentPageMode === "paged" ? "flow" : "paged";
    applyPageMode();
    if (onPageModeChange) onPageModeChange(currentPageMode);
  }

  // Подсвечивает кнопки, чьё форматирование активно в текущем выделении/позиции
  // курсора (bold в жирном тексте, highlight на закрашенном фрагменте и т.д.).
  function refreshToolbarState() {
    toolbarEl.querySelectorAll(".rte-btn").forEach((btn) => {
      const btnDef = buttonDefs[btn.dataset.command];
      if (!btnDef || !btnDef.isActive) return;
      btn.classList.toggle("is-active", !!btnDef.isActive(contentEl));
    });
  }

  // --- История отмены/повтора ------------------------------------------
  // Снимок — объект { html, caret }: html это serializeEditor() (тот же, что
  // уходит в хранилище — восстановление точно повторяет форматирование), а caret
  // — позиция каретки в символах, чтобы после отмены курсор остался на месте, а
  // не прыгал в начало. Записываем через MutationObserver — так в историю
  // попадает всё (ввод, кнопки, диктовка, чек-листы) без ручных вызовов. Быстрый
  // набор коалесится таймером в один шаг.
  //
  // История может прийти извне (initialHistory) и отдаваться наружу
  // (onHistoryChange) — так panelSection хранит её отдельно для каждой заметки и
  // возвращает при повторном заходе. Внутри работаем со своей копией массива.
  const HISTORY_LIMIT = 100;
  let history =
    initialHistory && Array.isArray(initialHistory.history) && initialHistory.history.length
      ? initialHistory.history.slice()
      : [{ html: serializeEditor(contentEl), caret: -1 }];
  let historyIndex =
    initialHistory && Number.isInteger(initialHistory.historyIndex)
      ? Math.max(0, Math.min(initialHistory.historyIndex, history.length - 1))
      : history.length - 1;
  let historyTimer = null;
  let isRestoring = false;

  function notifyHistoryChange() {
    if (onHistoryChange) onHistoryChange({ history, historyIndex });
  }

  // Символьное смещение каретки в тексте всех страниц (по порядку). Промежуточный
  // текст диктовки (.rte-interim) не считаем — его нет в сохраняемом html, иначе
  // смещение разъехалось бы с восстанавливаемым содержимым. -1 = каретки нет.
  function getCaretOffset() {
    const sel = window.getSelection();
    if (!sel.rangeCount) return -1;
    const { focusNode, focusOffset } = sel;
    if (!focusNode || !contentEl.contains(focusNode)) return -1;
    let offset = 0;
    for (const page of getPages()) {
      const walker = document.createTreeWalker(page, NodeFilter.SHOW_TEXT, {
        acceptNode: (node) =>
          node.parentElement && node.parentElement.closest(".rte-interim")
            ? NodeFilter.FILTER_REJECT
            : NodeFilter.FILTER_ACCEPT,
      });
      let node;
      while ((node = walker.nextNode())) {
        if (node === focusNode) return offset + focusOffset;
        offset += node.textContent.length;
      }
      // Каретка стоит на самом элементе страницы (пустая строка) — прибавлять
      // нечего, вернём накопленное.
      if (focusNode === page) return offset;
    }
    return offset;
  }

  // Ставит каретку на символьное смещение offset, обходя текстовые узлы страниц.
  // За концом текста — в конец последней страницы. Обновляет активную страницу и
  // фокус, чтобы последующий focusActivePage() не сбил позицию.
  function setCaretOffset(offset) {
    const pages = getPages();
    if (!pages.length) return;
    if (offset < 0) {
      activePageEl = pages[0];
      focusActivePage();
      return;
    }
    let remaining = offset;
    let lastPage = pages[0];
    let lastNode = null;
    for (const page of pages) {
      lastPage = page;
      const walker = document.createTreeWalker(page, NodeFilter.SHOW_TEXT, null);
      let node;
      while ((node = walker.nextNode())) {
        lastNode = node;
        const len = node.textContent.length;
        if (remaining <= len) {
          placeCaret(page, node, remaining);
          return;
        }
        remaining -= len;
      }
    }
    // Смещение вышло за конец текста — встаём в конец последнего текстового узла
    // (или самой последней страницы, если текста нет).
    if (lastNode) placeCaret(lastPage, lastNode, lastNode.textContent.length);
    else {
      activePageEl = lastPage;
      const range = document.createRange();
      range.selectNodeContents(lastPage);
      range.collapse(false);
      applyRange(range);
    }
  }

  function placeCaret(page, node, pos) {
    activePageEl = page;
    const range = document.createRange();
    range.setStart(node, Math.min(pos, node.textContent.length));
    range.collapse(true);
    applyRange(range);
  }

  function applyRange(range) {
    // preventScroll: возврат каретки не должен дёргать прокрутку окна — иначе при
    // undo/redo экран прыгает к каретке (на свежесобранном DOM — к началу).
    if (activePageEl) activePageEl.focus({ preventScroll: true });
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
  }

  function recordHistory() {
    clearTimeout(historyTimer);
    const snapshot = { html: serializeEditor(contentEl), caret: getCaretOffset() };
    if (history[historyIndex] && snapshot.html === history[historyIndex].html) return;
    // Обрезаем «хвост» повтора: после новой правки вперёд идти уже некуда.
    history = history.slice(0, historyIndex + 1);
    history.push(snapshot);
    historyIndex = history.length - 1;
    if (history.length > HISTORY_LIMIT) {
      history.shift();
      historyIndex--;
    }
    notifyHistoryChange();
  }

  function scheduleHistory() {
    if (isRestoring) return;
    clearTimeout(historyTimer);
    historyTimer = setTimeout(recordHistory, 400);
  }

  // Любое изменение содержимого страниц откладывает запись снимка. Классы/титулы
  // рамок и промежуточный текст диктовки на serialize не влияют, поэтому такие
  // мутации в итоге дают тот же снимок и просто игнорируются.
  new MutationObserver(scheduleHistory).observe(contentEl, {
    subtree: true,
    childList: true,
    characterData: true,
  });

  function restoreSnapshot(entry) {
    isRestoring = true;
    // Прокрутка живёт на уровне окна (панель детали своего скролла не имеет).
    // Пересборка страниц схлопывает высоту и сбрасывает scroll к началу —
    // запоминаем позицию и возвращаем её после восстановления.
    const scrollX = window.scrollX;
    const scrollY = window.scrollY;
    getPages().forEach((page) => page.parentElement.remove());
    parsePages(entry.html).forEach((pageHtml) => contentEl.insertBefore(createPageFrame(pageHtml), addPageBtn));
    upgradeLegacyChecklists(contentEl);
    activePageEl = getPages()[0] || null;
    // Курсор возвращаем туда, где он был при записи снимка, а не в начало.
    setCaretOffset(entry.caret);
    onChange(entry.html);
    refreshPages();
    refreshToolbarState();
    window.scrollTo(scrollX, scrollY);
    isRestoring = false;
  }

  function undo() {
    recordHistory(); // зафиксировать несохранённый ввод перед шагом назад
    if (historyIndex <= 0) return;
    historyIndex--;
    restoreSnapshot(history[historyIndex]);
    notifyHistoryChange();
  }

  function redo() {
    if (historyIndex >= history.length - 1) return;
    historyIndex++;
    restoreSnapshot(history[historyIndex]);
    notifyHistoryChange();
  }
  // ---------------------------------------------------------------------

  // --- Голосовой ввод (диктовка) ---------------------------------------
  // Финальные фрагменты вставляются в текст навсегда, промежуточные показываются
  // во временном span.rte-interim у каретки и заменяются по мере уточнения — так
  // слова появляются потоково, а не одним блоком в конце.
  let recognition = null;
  let recording = false;
  let voiceBtn = null;
  let interimSpan = null;

  // Каретка внутри редактора, иначе — конец активной страницы: диктовать можно
  // и не поставив курсор вручную.
  function ensureEditorCaret() {
    const sel = window.getSelection();
    if (sel.rangeCount && contentEl.contains(sel.anchorNode)) return;
    const page = activePageEl && contentEl.contains(activePageEl) ? activePageEl : getPages()[0];
    if (!page) return;
    const range = document.createRange();
    range.selectNodeContents(page);
    range.collapse(false);
    sel.removeAllRanges();
    sel.addRange(range);
  }

  // Временный span промежуточного текста всегда стоит на месте каретки; финальный
  // текст вставляем перед ним, поэтому каретка «едет» вслед за надиктованным.
  function ensureInterimSpan() {
    if (interimSpan && contentEl.contains(interimSpan)) return;
    ensureEditorCaret();
    const sel = window.getSelection();
    if (!sel.rangeCount) return;
    interimSpan = document.createElement("span");
    interimSpan.className = "rte-interim";
    const range = sel.getRangeAt(0);
    range.collapse(false);
    range.insertNode(interimSpan);
  }

  function showInterim(text) {
    if (!text) {
      if (interimSpan) { interimSpan.remove(); interimSpan = null; }
      return;
    }
    ensureInterimSpan();
    if (interimSpan) interimSpan.textContent = text;
  }

  function commitFinal(text) {
    ensureInterimSpan();
    if (!interimSpan) return;
    const node = document.createTextNode(text);
    interimSpan.parentNode.insertBefore(node, interimSpan);
    const sel = window.getSelection();
    const range = document.createRange();
    range.setStartAfter(node);
    range.collapse(true);
    sel.removeAllRanges();
    sel.addRange(range);
  }

  function onVoiceResult(event) {
    let interim = "";
    let finalText = "";
    for (let i = event.resultIndex; i < event.results.length; i++) {
      const seg = event.results[i];
      if (seg.isFinal) finalText += seg[0].transcript;
      else interim += seg[0].transcript;
    }
    if (finalText) commitFinal(finalText);
    showInterim(interim);
    onChange(serializeEditor(contentEl));
    refreshPages();
  }

  function startVoice() {
    if (!SpeechRecognitionCtor || recording) return;
    recognition = new SpeechRecognitionCtor();
    recognition.lang = currentVoiceLang();
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.onresult = onVoiceResult;
    recognition.onend = stopVoice;
    recognition.onerror = stopVoice;
    focusActivePage();
    ensureEditorCaret();
    recording = true;
    if (voiceBtn) voiceBtn.classList.add("is-recording");
    recognition.start();
  }

  function stopVoice() {
    if (!recording) return;
    recording = false;
    if (voiceBtn) voiceBtn.classList.remove("is-recording");
    showInterim(""); // снять недописанный промежуточный текст
    if (recognition) {
      try { recognition.stop(); } catch { /* уже остановлено */ }
      recognition = null;
    }
    onChange(serializeEditor(contentEl));
  }

  function openVoiceLangMenu(event) {
    const cur = currentVoiceLang();
    showContextMenu(
      event.clientX,
      event.clientY,
      VOICE_LANGS.map((lang) => ({
        label: (lang.code === cur ? "✓ " : "") + lang.label,
        onClick: () => {
          localStorage.setItem(VOICE_LANG_KEY, lang.code);
          // На ходу сменить язык у запущенного распознавания нельзя — перезапускаем.
          if (recording) { stopVoice(); startVoice(); }
        },
      })),
    );
  }
  // ---------------------------------------------------------------------

  buttons.forEach((key) => {
    const def = buttonDefs[key];
    if (!def) return;

    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "rte-btn";
    btn.dataset.command = key;
    btn.title = def.title;
    if (def.labelClass) {
      // Линия рисуется вокруг буквы, поэтому подпись нужна отдельным узлом.
      const icon = document.createElement("span");
      icon.className = `rte-ico ${def.labelClass}`;
      icon.textContent = def.label;
      btn.appendChild(icon);
    } else {
      btn.textContent = def.label;
    }
    // Не даём кнопке забрать фокус — иначе выделение в редакторе схлопнется до клика.
    btn.addEventListener("mousedown", (event) => event.preventDefault());

    if (def.isColor) {
      updateSwatch(btn, def);
      // ЛКМ — быстрый переключатель последним выбранным цветом, ПКМ — палитра.
      btn.addEventListener("click", () => {
        const selection = window.getSelection();
        const collapsed = selection.rangeCount && selection.getRangeAt(0).collapsed;
        // Схлопнутая каретка + стиль, который умеем тумблить через DOM (заливка):
        // разрезаем/оборачиваем span сами, иначе нативная команда не снимается при
        // печати. С реальным выделением execCommand корректно оборачивает диапазон.
        if (def.caretStyleProp && collapsed) {
          toggleColorAtCaret(contentEl, def.caretStyleProp, getLastColor(def.storageKey, def.defaultColor));
        } else if (def.isActive(contentEl)) {
          def.reset();
        } else {
          def.apply(getLastColor(def.storageKey, def.defaultColor));
        }
        focusActivePage();
        onChange(serializeEditor(contentEl));
        refreshToolbarState();
      });
      btn.addEventListener("contextmenu", (event) => {
        event.preventDefault();
        toggleColorPopover(btn, def, contentEl, onChange, refreshToolbarState, focusActivePage);
      });
    } else if (def.isHistory) {
      btn.addEventListener("click", () => {
        if (def.isHistory === "undo") undo();
        else redo();
        focusActivePage();
      });
    } else if (def.isVoice) {
      voiceBtn = btn;
      if (!SpeechRecognitionCtor) {
        btn.disabled = true;
        btn.title = t("editor.voiceUnsupported");
      } else {
        btn.addEventListener("click", () => {
          if (recording) stopVoice();
          else startVoice();
        });
        btn.addEventListener("contextmenu", (event) => {
          event.preventDefault();
          openVoiceLangMenu(event);
        });
      }
    } else if (def.isPageMode) {
      btn.addEventListener("click", () => {
        togglePageMode();
        focusActivePage();
      });
    } else {
      btn.addEventListener("click", async () => {
        // await — командой может быть insertTable, которая асинхронно спрашивает
        // размер через модалку; для обычных execCommand-команд просто no-op.
        await def.command(contentEl);
        focusActivePage();
        onChange(serializeEditor(contentEl));
        refreshToolbarState();
      });
    }

    toolbarEl.appendChild(btn);
  });

  contentEl.addEventListener("input", () => {
    onChange(serializeEditor(contentEl));
    refreshPages();
  });

  // Колонка меняет ширину и без ввода: свернули панель, потянули окно, сменили
  // зум. refreshPages() такие случаи не ловит, поэтому ещё и наблюдаем размер.
  new ResizeObserver(updatePageFit).observe(contentEl);

  // Какая страница сейчас редактируется — нужно, чтобы после нажатия кнопки
  // тулбара фокус вернулся именно в неё, а не в первую попавшуюся.
  contentEl.addEventListener("focusin", (event) => {
    const page = event.target instanceof Element ? event.target.closest(".rte-page") : null;
    if (page) activePageEl = page;
  });

  // Единственное контекстное меню редактора: сюда же попадают пункты раздела
  // (в Заметках — переключение режима отображения). Два независимых обработчика
  // открывали бы два меню одно поверх другого.
  contentEl.addEventListener("contextmenu", (event) => {
    const items = getExtraMenuItems ? [...getExtraMenuItems()] : [];
    const page = event.target instanceof Element ? event.target.closest(".rte-page") : null;
    if (page && currentPageMode === "paged" && getPages().length > 1) {
      items.push({
        label: t("editor.deletePage"),
        onClick: async () => {
          if (page.textContent.trim()) {
            const ok = await openConfirm({ message: t("editor.deletePageConfirm") });
            if (!ok) return;
          }
          removePage(page);
        },
      });
    }
    if (!items.length) return;
    event.preventDefault();
    showContextMenu(event.clientX, event.clientY, items);
  });

  // Отметка "выполнено" — клик по квадратику слева от текста. Сам квадратик
  // рисуется через ::before в левом отступе пункта, поэтому целью клика будет
  // сам <li>, а не текстовый узел внутри него.
  contentEl.addEventListener("click", (event) => {
    const li = event.target instanceof Element ? event.target.closest("li") : null;
    if (!li || !li.closest("ul.checklist") || event.target !== li) return;
    if (event.clientX - li.getBoundingClientRect().left > CHECKLIST_MARKER_WIDTH) return;
    li.classList.toggle("is-done");
    onChange(serializeEditor(contentEl));
  });

  // Отмена/повтор с клавиатуры. Перехватываем сами: нативный undo не знает про
  // наш стек снимков и откатывал бы <u>/<s>/заголовки некорректно.
  contentEl.addEventListener("keydown", (event) => {
    if (!(event.ctrlKey || event.metaKey)) return;
    const key = event.key.toLowerCase();
    if (key === "z" && !event.shiftKey) {
      event.preventDefault();
      undo();
    } else if (key === "y" || (key === "z" && event.shiftKey)) {
      event.preventDefault();
      redo();
    }
  });

  contentEl.addEventListener("keydown", (event) => {
    if (event.key !== "Tab") return;
    // Tab в списках — вложенность (как в маркированном списке), а не переход
    // фокуса на следующий элемент страницы.
    event.preventDefault();
    document.execCommand(event.shiftKey ? "outdent" : "indent");
    onChange(serializeEditor(contentEl));
  });

  // Курсор/выделение двигаются кликом мыши или клавиатурой без гарантии
  // "input"-события — обновляем состояние кнопок по обоим путям и на фокус.
  contentEl.addEventListener("mouseup", refreshToolbarState);
  contentEl.addEventListener("keyup", refreshToolbarState);
  contentEl.addEventListener("focusin", refreshToolbarState);

  applyPageMode();

  return {
    toolbarEl,
    contentEl,
    getPageMode: () => currentPageMode,
    togglePageMode,
    // Высоту страницы можно измерить только когда узел уже в документе, поэтому
    // вызывающий код дёргает это после вставки в DOM.
    refreshLayout: refreshPages,
    // Переход по результату поиска: прокрутить к нужному вхождению и мигнуть им.
    highlightMatch: (query, occurrence) => highlightMatch(contentEl, query, occurrence),
    // Переход из поля названия в текст: каретка встаёт в начало первой страницы.
    focusContent: () => {
      const first = getPages()[0];
      if (!first) return;
      activePageEl = first;
      first.focus();
      const range = document.createRange();
      range.selectNodeContents(first);
      range.collapse(true);
      const selection = window.getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
    },
  };
}

// Имя подсветки, под которым диапазон регистрируется в CSS.highlights;
// цвет задан в styles/editor.css через ::highlight(search-hit).
const SEARCH_HIGHLIGHT = "search-hit";
const SEARCH_HIGHLIGHT_MS = 2500;
let searchHighlightTimer = null;

/**
 * Подсвечивает occurrence-е вхождение query в тексте заметки и прокручивает к
 * нему. Текст заметки при этом НЕ меняется: диапазон красит CSS Custom Highlight
 * API, который рисует поверх, ничего не вставляя в DOM. Иначе подсветка попала
 * бы в contenteditable, а оттуда — в сохранённый HTML.
 */
function highlightMatch(contentEl, query, occurrence = 0) {
  clearSearchHighlight();
  const range = findOccurrenceRange(contentEl, query, occurrence);
  if (!range) return;

  const target = range.startContainer.parentElement;
  if (target) target.scrollIntoView({ block: "center", behavior: "smooth" });

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

function clearSearchHighlight() {
  clearTimeout(searchHighlightTimer);
  if (CSS.highlights) CSS.highlights.delete(SEARCH_HIGHLIGHT);
}

/**
 * Ищет вхождение по всем текстовым узлам страниц подряд, поэтому находит и то,
 * что разорвано форматированием (жирное слово внутри предложения). Считаем
 * именно порядковый номер вхождения — по нему список результатов и различает
 * несколько совпадений в одной заметке.
 */
function findOccurrenceRange(contentEl, query, occurrence) {
  const needle = (query || "").toLowerCase();
  if (!needle) return null;

  const nodes = [];
  let text = "";
  contentEl.querySelectorAll(".rte-page").forEach((page) => {
    const walker = document.createTreeWalker(page, NodeFilter.SHOW_TEXT);
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

  const range = document.createRange();
  const startPoint = pointAt(nodes, from);
  const endPoint = pointAt(nodes, from + needle.length);
  if (!startPoint || !endPoint) return null;
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

// Prompt — асинхронная модалка, за время её открытия редактор теряет фокус
// и текущее выделение. Сохраняем позицию курсора заранее и восстанавливаем
// перед вставкой таблицы.
async function insertTable(editorEl) {
  const savedRange = getCurrentRange(editorEl);

  const result = await openTablePrompt({
    colsLabel: t("editor.tableCols"),
    rowsLabel: t("editor.tableRows"),
  });
  if (result === null) return;

  const cols = clamp(result.cols || 3, 1, 20);
  const rows = clamp(result.rows || 3, 1, 20);

  editorEl.focus();
  restoreRange(savedRange);

  const rowHtml = `<tr>${"<td>&nbsp;</td>".repeat(cols)}</tr>`;
  const tableHtml = `<table class="rte-table">${rowHtml.repeat(rows)}</table><p><br></p>`;
  document.execCommand("insertHTML", false, tableHtml);
}

function getCurrentRange(editorEl) {
  const selection = window.getSelection();
  if (selection.rangeCount && editorEl.contains(selection.getRangeAt(0).commonAncestorContainer)) {
    return selection.getRangeAt(0).cloneRange();
  }
  return null;
}

function restoreRange(range) {
  if (!range) return;
  const selection = window.getSelection();
  selection.removeAllRanges();
  selection.addRange(range);
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function toggleColorPopover(btn, def, editorEl, onChange, refreshToolbarState, focusEditor) {
  const existing = btn.querySelector(".rte-color-popover");
  closeColorPopovers();
  if (existing) return;

  const popover = document.createElement("div");
  popover.className = "rte-color-popover";

  // Отдельная опция сброса — без неё применённый цвет/заливку нечем убрать.
  const resetSwatch = document.createElement("button");
  resetSwatch.type = "button";
  resetSwatch.className = "rte-color-swatch rte-color-swatch--reset";
  resetSwatch.title = t("editor.removeColor");
  resetSwatch.textContent = "✕";
  resetSwatch.addEventListener("mousedown", (event) => event.preventDefault());
  resetSwatch.addEventListener("click", (event) => {
    event.stopPropagation();
    def.reset();
    closeColorPopovers();
    focusEditor();
    onChange(serializeEditor(editorEl));
    refreshToolbarState();
  });
  popover.appendChild(resetSwatch);

  def.colors.forEach((color) => {
    const swatch = document.createElement("button");
    swatch.type = "button";
    swatch.className = "rte-color-swatch";
    swatch.style.background = color;
    swatch.addEventListener("mousedown", (event) => event.preventDefault());
    swatch.addEventListener("click", (event) => {
      event.stopPropagation();
      def.apply(color);
      // Выбранный здесь цвет становится тем, которым красит ЛКМ по кнопке, —
      // и тем, что показывает индикатор на самой кнопке.
      setLastColor(def.storageKey, color);
      updateSwatch(btn, def);
      closeColorPopovers();
      focusEditor();
      onChange(serializeEditor(editorEl));
      refreshToolbarState();
    });
    popover.appendChild(swatch);
  });

  btn.appendChild(popover);
  unregisterPopoverLayer = pushLayer(closeColorPopovers);
  setTimeout(() => document.addEventListener("click", closeColorPopovers, { once: true }), 0);
}

// Поповер цвета — такой же "слой", как меню и модалки: закрывается кликом вне
// и по Esc. Регистрация в стеке слоёв снимается здесь, где бы его ни закрыли.
let unregisterPopoverLayer = null;

function closeColorPopovers() {
  document.querySelectorAll(".rte-color-popover").forEach((popover) => popover.remove());
  if (unregisterPopoverLayer) {
    unregisterPopoverLayer();
    unregisterPopoverLayer = null;
  }
}

// Ширина зоны маркера слева от текста пункта (см. --checklist-marker в
// styles/editor.css): клик левее этой границы переключает "выполнено",
// правее — обычная установка курсора в текст.
const CHECKLIST_MARKER_WIDTH = 22;

// Ближайший список вокруг каретки: по нему решаем, создавать список,
// пометить существующий как чек-лист или снять пометку.
function getCurrentList(editorEl) {
  const selection = window.getSelection();
  if (!selection.rangeCount) return null;
  let node = selection.getRangeAt(0).commonAncestorContainer;
  if (node.nodeType === Node.TEXT_NODE) node = node.parentElement;
  if (!node || !editorEl.contains(node)) return null;
  const list = node.closest("ul,ol");
  return list && editorEl.contains(list) ? list : null;
}

function isInsideChecklist(editorEl) {
  const list = getCurrentList(editorEl);
  return !!list && !!list.closest("ul.checklist");
}

// Кнопка ☑ работает ровно как кнопка маркированного списка: строка становится
// пунктом с квадратиком, повторное нажатие возвращает обычный текст. Сам
// квадратик — CSS-маркер (::before) на <li>, а не элемент в тексте: любой узел
// внутри contenteditable браузер копирует при Enter и таскает вокруг него
// каретку, из-за чего текст оказывался перед галочкой.
function applyChecklist(editorEl) {
  const list = getCurrentList(editorEl);

  if (list && list.closest("ul.checklist")) {
    const checklist = list.closest("ul.checklist");
    checklist.classList.remove("checklist");
    checklist.querySelectorAll("li.is-done").forEach((li) => li.classList.remove("is-done"));
    document.execCommand("insertUnorderedList"); // развернуть список обратно в текст
    return;
  }

  // Списка нет — создаём; нумерованный execCommand превратит в маркированный.
  // Обычный <ul> помечаем на месте, не пересоздавая.
  if (!list || list.tagName === "OL") document.execCommand("insertUnorderedList");

  const target = getCurrentList(editorEl);
  if (target) target.classList.add("checklist");
}

// Заметки, сохранённые до перехода на CSS-маркер, содержат немые чекбоксы
// внутри пунктов. Убираем их при открытии, перенося отметку в класс is-done.
function upgradeLegacyChecklists(editorEl) {
  editorEl.querySelectorAll("ul.checklist input[type='checkbox']").forEach((checkbox) => {
    const li = checkbox.closest("li");
    if (li && checkbox.hasAttribute("checked")) li.classList.add("is-done");
    checkbox.remove();
  });
  // Вложенные списки чек-листа помечать классом больше не нужно — стили
  // наследуются по вложенности; снимаем, чтобы разметка была однородной.
  editorEl.querySelectorAll("ul.checklist ul.checklist").forEach((nested) => nested.classList.remove("checklist"));
}
