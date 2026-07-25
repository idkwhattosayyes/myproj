import { t, getLang } from "../../i18n/i18n.js";
import { openTablePrompt, openConfirm, openAlert } from "../../utils/modal.js";
import { pushLayer } from "../../utils/escapeLayers.js";
import { showContextMenu } from "./contextMenu.js";
import { fileToDataUrl, downscaleImage } from "../../utils/image.js";
import { openPhotoEditor } from "./photoEditor.js";
import { openLinkEditor } from "./linkEditor.js";
import { openInternalLinkPicker } from "./internalLinkPicker.js";
import { escapeAttr } from "../../utils/dom.js";
import * as itemsService from "../../services/itemsService.js";
import { setPendingTarget, getNavigateHandler } from "../../search/searchTarget.js";
import {
  TEXT_COLORS,
  HIGHLIGHT_COLORS,
  DRAW_COLOR_KEY,
  DRAW_WIDTH_KEY,
  DRAW_DEFAULT_COLOR,
  DRAW_DEFAULT_WIDTH,
  DRAW_WIDTHS,
  getLastColor,
  setLastColor,
  getLastWidth,
  setLastWidth,
} from "../../utils/colorPrefs.js";

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
    // Ссылка на внешний URL для выделенного слова/фразы — не команда форматирования
    // (нужны модалка ввода и меню Delete/Change), обрабатывается отдельно в
    // buildToolbarButton (см. isLink).
    link: { label: "🔗", title: t("editor.setLink"), isLink: true },
    // Ссылка на другую заметку/документ — доступна только в Документах (см.
    // allowInternalLinks в createRichTextEditor), обрабатывается отдельно в
    // buildToolbarButton (isInternalLink), по той же схеме, что и isLink.
    internalLink: { label: "📄", title: t("editor.setInternalLink"), isInternalLink: true },
    // Вставка фото: ЛКМ открывает выбор файла. Само чтение/ужатие/вставка —
    // отдельной веткой в createRichTextEditor (см. isPhoto), потому что нужен
    // доступ к сохранённому диапазону и serializeEditor.
    insertPhoto: { label: "🖼", title: t("editor.insertPhoto"), isPhoto: true },
    // Рисование поверх документа — не команда форматирования, а переключатель
    // режима, как pageMode/voice. Обрабатывается отдельно в createRichTextEditor.
    // storageKey/defaultColor — только для индикатора цвета на самой кнопке
    // (тот же приём, что у textColor/highlight, см. updateSwatch).
    draw: { label: "✏", title: t("editor.draw"), isDraw: true, storageKey: DRAW_COLOR_KEY, defaultColor: DRAW_DEFAULT_COLOR },
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
  linkExternal: {
    selector: 'a.rte-link[data-link-type="external"]',
    create: () => {
      const a = document.createElement("a");
      a.className = "rte-link";
      a.dataset.linkType = "external";
      return a;
    },
  },
  linkInternal: {
    selector: 'a.rte-link[data-link-type="internal"]',
    create: () => {
      const a = document.createElement("a");
      a.className = "rte-link";
      a.dataset.linkType = "internal";
      return a;
    },
  },
};

const EMPTY_WRAPPER_SELECTOR = "u,s,span.rte-h1,span.rte-h2,a.rte-link";

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
      // span.rte-interim — в сохраняемый HTML он попадать не должен. Маркеры
      // выделения фото (.rte-photo-handles) и класс подсветки выделения — тоже
      // временный UI, не часть содержимого заметки.
      const clone = page.cloneNode(true);
      clone.querySelectorAll(".rte-interim, .rte-photo-handles").forEach((node) => node.remove());
      clone.querySelectorAll(".rte-photo.is-selected").forEach((el) => el.classList.remove("is-selected"));
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

// Уникальные обёртки-предки для набора текстовых узлов, в порядке появления —
// одно выделение может распасться на несколько <a> при пересечении с другим
// форматом (см. wrapSelection), но данные ссылки (URL, id заметки) должны быть
// одинаковыми на всех фрагментах разом.
function uniqueAncestors(editorEl, nodes, format) {
  const seen = new Set();
  const result = [];
  nodes.forEach((node) => {
    const el = getFormatAncestor(editorEl, format, node);
    if (el && !seen.has(el)) {
      seen.add(el);
      result.push(el);
    }
  });
  return result;
}

// Бейдж-значок ссылки (см. .rte-link[data-link-start] в styles/editor.css)
// рисуется только у ПЕРВОГО фрагмента распавшейся ссылки — иначе при пересечении
// с другим форматом он задваивался бы.
function markLinkStart(elements) {
  elements.forEach((el, index) => {
    if (index === 0) el.dataset.linkStart = "";
    else delete el.dataset.linkStart;
  });
}

// Проставляет данные внутренней ссылки на все обёртки сразу и нативный title
// с заголовком целевой заметки — для превью при наведении (кастомный поповер
// тут не нужен, ТЗ требует его только для внешних ссылок).
async function applyInternalLink(editorEl, nodes, picked) {
  const wrappers = uniqueAncestors(editorEl, nodes, FORMATS.linkInternal);
  const item = await itemsService.getItem(picked.itemId);
  const title = item ? t("editor.internalLinkHint").replace("{title}", item.title || t("panel.untitled")) : "";
  wrappers.forEach((el) => {
    el.dataset.itemId = picked.itemId;
    el.dataset.anchorQuery = picked.query;
    el.dataset.anchorIndex = String(picked.matchIndex);
    el.title = title;
  });
  markLinkStart(wrappers);
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
  if (!nodes.length) return nodes;

  nodes.forEach((node) => {
    if (getFormatAncestor(editorEl, format, node)) return; // уже оформлен
    const wrapper = format.create();
    node.replaceWith(wrapper);
    wrapper.appendChild(node);
  });

  selectNodes(nodes);
  return nodes;
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
 * @param {{content: string, buttons: string[], pageMode?: "flow" | "paged", onChange: (html: string) => void, onPageModeChange?: (mode: string) => void, getExtraMenuItems?: () => {label: string, onClick: () => void}[], allowInternalLinks?: boolean}} options
 * @returns {{toolbarEl: HTMLElement, contentEl: HTMLElement, getPageMode: () => string, togglePageMode: () => void, refreshLayout: () => void, focusContent: () => void}}
 */
export function createRichTextEditor({ content, buttons, pageMode = "flow", onChange, onPageModeChange, getExtraMenuItems, initialHistory = null, onHistoryChange = null, allowInternalLinks = false }) {
  const buttonDefs = getButtonDefs();
  // Просим браузер размечать команды тегами (<b>), а не инлайновым CSS: со
  // стилями Chrome складывает разные оформления в одно свойство и они
  // затирают друг друга.
  document.execCommand("styleWithCSS", false, false);
  // Иначе поверх наших угловых маркеров фото (см. блок «Выделение и
  // перетаскивание фото» ниже) всплывут ещё и родные ручки ресайза Chrome.
  document.execCommand("enableObjectResizing", false, false);

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

  // Включённость инструмента рисования — как и pageMode, это переключатель
  // режима, а не состояние текста под кареткой.
  let drawingActive = false;
  buttonDefs.draw.isActive = () => drawingActive;

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
    // drawState непустой всё время, пока штрих/стирание в процессе (см. ниже) —
    // снимок посреди штриха не нужен, иначе долгий штрих мог бы разрезаться
    // debounce-таймером на две отменяемые по отдельности половины. Один снимок на
    // весь жест пишется явно в pointerup.
    if (isRestoring || drawState) return;
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

  // --- Рисование поверх документа ---------------------------------------
  // Рисунок — <svg class="rte-drawing-layer"> с <path> на каждый штрих, лежащий
  // прямо внутри .rte-page: serializeEditor() берёт innerHTML страницы как есть,
  // поэтому рисунок сохраняется/загружается вместе с текстом без отдельного поля
  // в модели заметки, а MutationObserver истории (см. выше) подхватывает
  // добавление/удаление <path> автоматически — свой стек отмены не нужен.
  const SVG_NS = "http://www.w3.org/2000/svg";
  let erasingActive = false;
  let drawState = null; // { pointerId, page, path } — path === null во время стирания

  function getDrawingLayer(page, create) {
    let svg = page.querySelector(":scope > svg.rte-drawing-layer");
    if (!svg && create) {
      svg = document.createElementNS(SVG_NS, "svg");
      svg.setAttribute("class", "rte-drawing-layer");
      // Неедактируемый остров внутри contenteditable-страницы: браузер не лезет
      // курсором внутрь и удаляет его целиком, а не по кусочкам.
      svg.setAttribute("contenteditable", "false");
      page.appendChild(svg);
    }
    return svg;
  }

  // Координаты события → локальные координаты страницы. SVG без viewBox, значит
  // 1 единица = 1 CSS-пиксель немасштабированного слоя; --page-fit — тот же зум,
  // каким постраничный режим уменьшает страницу целиком (см. updatePageFit). В
  // сплошном режиме переменная не задана, и деление на 1 ничего не меняет.
  function drawPoint(page, event) {
    const rect = page.getBoundingClientRect();
    const zoom = parseFloat(getComputedStyle(contentEl).getPropertyValue("--page-fit")) || 1;
    return { x: (event.clientX - rect.left) / zoom, y: (event.clientY - rect.top) / zoom };
  }

  // Ластик трогает только узлы внутри слоя рисования — текст физически не
  // задет. isPointInStroke — нативная геометрия SVG, без ручного подсчёта
  // расстояния до ломаной.
  function eraseAt(page, event) {
    const svg = getDrawingLayer(page, false);
    if (!svg) return;
    const { x, y } = drawPoint(page, event);
    const point = new DOMPoint(x, y);
    svg.querySelectorAll("path").forEach((path) => {
      if (path.isPointInStroke(point)) path.remove();
    });
  }

  function toggleDrawing() {
    drawingActive = !drawingActive;
    if (!drawingActive) erasingActive = false; // выключили кисть — выключаем и ластик
    contentEl.classList.toggle("is-drawing", drawingActive);
    refreshToolbarState();
  }

  function currentDrawWidth() {
    return getLastWidth(DRAW_WIDTH_KEY, DRAW_DEFAULT_WIDTH);
  }

  // ПКМ на кнопке рисования — толщина, цвет (та же палитра, что у текста) и
  // тумблер ластика. Каждый выбор мгновенно закрывает поповер — как и у цвета
  // текста/заливки, второй вложенный уровень здесь не нужен.
  function toggleDrawPopover(btn, def) {
    const existing = btn.querySelector(".rte-color-popover");
    closeColorPopovers();
    if (existing) return;

    const popover = document.createElement("div");
    popover.className = "rte-color-popover rte-draw-popover";

    DRAW_WIDTHS.forEach((width) => {
      const swatch = document.createElement("button");
      swatch.type = "button";
      swatch.className = "rte-draw-width-swatch";
      swatch.style.setProperty("--dot", `${width * 2}px`);
      swatch.title = String(width);
      swatch.addEventListener("mousedown", (event) => event.preventDefault());
      swatch.addEventListener("click", (event) => {
        event.stopPropagation();
        setLastWidth(DRAW_WIDTH_KEY, width);
        closeColorPopovers();
        focusActivePage();
      });
      popover.appendChild(swatch);
    });

    TEXT_COLORS.forEach((color) => {
      const swatch = document.createElement("button");
      swatch.type = "button";
      swatch.className = "rte-color-swatch";
      swatch.style.background = color;
      swatch.addEventListener("mousedown", (event) => event.preventDefault());
      swatch.addEventListener("click", (event) => {
        event.stopPropagation();
        setLastColor(def.storageKey, color);
        updateSwatch(btn, def);
        closeColorPopovers();
        focusActivePage();
      });
      popover.appendChild(swatch);
    });

    const eraserBtn = document.createElement("button");
    eraserBtn.type = "button";
    eraserBtn.className = "rte-color-swatch rte-draw-eraser";
    eraserBtn.title = t("editor.eraser");
    eraserBtn.textContent = "⌫";
    eraserBtn.classList.toggle("is-active", erasingActive);
    eraserBtn.addEventListener("mousedown", (event) => event.preventDefault());
    eraserBtn.addEventListener("click", (event) => {
      event.stopPropagation();
      erasingActive = !erasingActive;
      closeColorPopovers();
      focusActivePage();
    });
    popover.appendChild(eraserBtn);

    btn.appendChild(popover);
    unregisterPopoverLayer = pushLayer(closeColorPopovers);
    setTimeout(() => document.addEventListener("click", closeColorPopovers, { once: true }), 0);
  }

  // Слушатели висят всегда, но выходят сразу, если инструмент выключен — не
  // мешают обычному выделению и клику по тексту.
  contentEl.addEventListener("pointerdown", (event) => {
    if (!drawingActive) return;
    const page = event.target instanceof Element ? event.target.closest(".rte-page") : null;
    if (!page) return;
    event.preventDefault(); // не ставить каретку и не начинать выделение текста
    contentEl.setPointerCapture(event.pointerId);

    if (erasingActive) {
      eraseAt(page, event);
      drawState = { pointerId: event.pointerId, page, path: null };
      return;
    }

    const svg = getDrawingLayer(page, true);
    const path = document.createElementNS(SVG_NS, "path");
    path.setAttribute("fill", "none");
    path.setAttribute("stroke", getLastColor(DRAW_COLOR_KEY, DRAW_DEFAULT_COLOR));
    path.setAttribute("stroke-width", String(currentDrawWidth()));
    path.setAttribute("stroke-linecap", "round");
    path.setAttribute("stroke-linejoin", "round");
    const start = drawPoint(page, event);
    path.setAttribute("d", `M${start.x} ${start.y}`);
    svg.appendChild(path);
    drawState = { pointerId: event.pointerId, page, path };
  });

  contentEl.addEventListener("pointermove", (event) => {
    if (!drawState || event.pointerId !== drawState.pointerId) return;
    if (!drawState.path) {
      eraseAt(drawState.page, event);
      return;
    }
    const { x, y } = drawPoint(drawState.page, event);
    drawState.path.setAttribute("d", `${drawState.path.getAttribute("d")} L${x} ${y}`);
  });

  contentEl.addEventListener("pointerup", (event) => {
    if (!drawState || event.pointerId !== drawState.pointerId) return;
    contentEl.releasePointerCapture(event.pointerId);
    drawState = null;
    // Снимок всего штриха/стирания одним шагом — записываем явно, только когда
    // жест завершён (пока drawState не пуст, scheduleHistory ничего не пишет).
    recordHistory();
    onChange(serializeEditor(contentEl));
  });
  // ---------------------------------------------------------------------

  // --- Вставка фото -----------------------------------------------------
  // Открывает выбор файла и вставляет выбранное изображение в сохранённый
  // диапазон. savedRange нужен, потому что фокус на время диалога уходит из
  // редактора.
  function openPhotoPicker(savedRange) {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = "image/*";
    input.addEventListener("change", () => {
      if (input.files && input.files[0]) insertImageFile(input.files[0], savedRange);
    });
    input.click();
  }

  // Читает файл-картинку, ужимает и открывает окно предпросмотра. Само фото
  // вставляется только после подтверждения — уже с выбранным размером, названием
  // и вжатым (если рисовали) карандашом.
  async function insertImageFile(file, savedRange) {
    if (!file || !file.type.startsWith("image/")) return;
    const { dataUrl } = await downscaleImage(await fileToDataUrl(file));
    const result = await openPhotoEditor(dataUrl);
    if (!result) return; // отмена
    insertPhotoElement(result, savedRange);
  }

  // Вставляет готовое фото как <img> в место каретки. contenteditable=false —
  // фото ведёт себя как цельный островок, а не набор редактируемых символов;
  // data-name несёт название (в поиске и «сведениях»), размер — inline-стилем.
  // Свободное перетаскивание/ресайз и режим интеграции с текстом появятся в
  // следующих шагах — здесь фото ещё обычный инлайновый элемент.
  function insertPhotoElement({ dataUrl, width, height, name }, savedRange) {
    focusActivePage();
    restoreRange(savedRange);
    // Временный id — единственный способ достать именно только что вставленный
    // узел: execCommand("insertHTML") не возвращает на него ссылку.
    const marker = `rte-photo-insert-${Date.now()}`;
    const nameAttr = name ? ` data-name="${escapeAttr(name)}"` : "";
    const html = `<img id="${marker}" class="rte-photo" contenteditable="false" draggable="false" style="width:${width}px;height:${height}px"${nameAttr} src="${dataUrl}">`;
    document.execCommand("insertHTML", false, html);
    const img = contentEl.querySelector(`#${marker}`);
    // Сразу плавающее — по умолчанию фото можно таскать, не дожидаясь первого
    // клика (ensureFloatPosition иначе сработала бы только при выделении).
    if (img) {
      img.removeAttribute("id");
      ensureFloatPosition(img);
    }
    onChange(serializeEditor(contentEl));
    refreshPages();
  }
  // ------------------------------------------------------------------------

  // --- Выделение и перетаскивание фото -----------------------------------
  // Плавающее фото — position:absolute внутри .rte-page (та же позиционирующая
  // страница, что и у слоя рисования). Маркеры выделения — отдельный div-сосед
  // (не потомок img — у него не может быть детей), синхронизируется с фото по
  // координатам через getBoundingClientRect(). data-layout="float" — фото можно
  // свободно таскать; "flow" (появится в шаге с ПКМ-меню) — обтекание текстом,
  // без перетаскивания.
  let selectedPhoto = null;
  let handlesEl = null;
  let unregisterPhotoLayer = null;
  let dragPhotoState = null; // { img, startX, startY, startLeft, startTop, moved }
  let resizePhotoState = null; // { img, corner, startX, startY, startW, startH, startLeft, startTop, ratio }

  // Тот же зум-фактор постраничного режима, что использует drawPoint() у слоя
  // рисования — координаты фото считаются в тех же локальных единицах страницы.
  function currentZoom() {
    return parseFloat(getComputedStyle(contentEl).getPropertyValue("--page-fit")) || 1;
  }

  // Фото, вставленное как обычный элемент (или унаследованное из старой
  // заметки), становится плавающим при первом выделении — координаты берём из
  // текущего положения на экране, чтобы оно не прыгнуло. Уже переключённое
  // (float или flow) не трогаем — это осознанный выбор пользователя.
  function ensureFloatPosition(img, force = false) {
    // Без force — только для «нетронутого» фото (без data-layout вообще): его
    // координаты ещё не заданы, и это единственный случай, когда left/top
    // безопасно посчитать один раз при первом выделении/вставке. С force —
    // пересчёт нужен и при явном переключении flow → float (togglePhotoLayout),
    // иначе левая/верхняя граница останется пустой после сброса в flow-режиме.
    if (img.dataset.layout && !force) return;
    const page = img.closest(".rte-page");
    if (!img.style.width) img.style.width = `${img.naturalWidth}px`;
    if (!img.style.height) img.style.height = `${img.naturalHeight}px`;
    const zoom = currentZoom();
    const imgRect = img.getBoundingClientRect();
    const pageRect = page.getBoundingClientRect();
    img.dataset.layout = "float";
    img.style.left = `${Math.round((imgRect.left - pageRect.left) / zoom)}px`;
    img.style.top = `${Math.round((imgRect.top - pageRect.top) / zoom)}px`;
  }

  function syncHandles() {
    if (!selectedPhoto || !handlesEl) return;
    const page = selectedPhoto.closest(".rte-page");
    const zoom = currentZoom();
    const imgRect = selectedPhoto.getBoundingClientRect();
    const pageRect = page.getBoundingClientRect();
    handlesEl.style.left = `${(imgRect.left - pageRect.left) / zoom}px`;
    handlesEl.style.top = `${(imgRect.top - pageRect.top) / zoom}px`;
    handlesEl.style.width = `${imgRect.width / zoom}px`;
    handlesEl.style.height = `${imgRect.height / zoom}px`;
  }

  function selectPhoto(img) {
    if (selectedPhoto === img) return;
    deselectPhoto();
    ensureFloatPosition(img);
    selectedPhoto = img;
    img.classList.add("is-selected");
    handlesEl = document.createElement("div");
    handlesEl.className = "rte-photo-handles";
    handlesEl.contentEditable = "false";
    ["nw", "ne", "sw", "se"].forEach((corner) => {
      const handle = document.createElement("span");
      handle.className = `rte-photo-handle rte-photo-handle--${corner}`;
      handle.dataset.corner = corner;
      handlesEl.appendChild(handle);
    });
    // Обработчик один раз на весь блок маркеров (пересоздаётся вместе с ним при
    // каждом selectPhoto) — проще, чем вешать по одному на каждый handle.
    handlesEl.addEventListener("pointerdown", (event) => {
      const handle = event.target instanceof Element ? event.target.closest(".rte-photo-handle") : null;
      if (!handle || !selectedPhoto) return;
      event.preventDefault();
      event.stopPropagation(); // не даём этому же нажатию всплыть как клик по фото
      const target = selectedPhoto;
      resizePhotoState = {
        img: target,
        corner: handle.dataset.corner,
        startX: event.clientX,
        startY: event.clientY,
        startW: parseFloat(target.style.width) || target.naturalWidth,
        startH: parseFloat(target.style.height) || target.naturalHeight,
        startLeft: parseFloat(target.style.left) || 0,
        startTop: parseFloat(target.style.top) || 0,
        ratio: target.naturalWidth / target.naturalHeight,
      };
      contentEl.setPointerCapture(event.pointerId);
    });
    img.after(handlesEl);
    syncHandles();
    unregisterPhotoLayer = pushLayer(deselectPhoto);
  }

  function deselectPhoto() {
    if (!selectedPhoto) return;
    selectedPhoto.classList.remove("is-selected");
    selectedPhoto = null;
    if (handlesEl) {
      handlesEl.remove();
      handlesEl = null;
    }
    if (unregisterPhotoLayer) {
      unregisterPhotoLayer();
      unregisterPhotoLayer = null;
    }
  }

  // Клик вне фото/маркеров снимает выделение — тот же приём, что у поповеров.
  contentEl.addEventListener("mousedown", (event) => {
    const target = event.target instanceof Element ? event.target : null;
    if (!target || target.closest(".rte-photo") || target.closest(".rte-photo-handles")) return;
    deselectPhoto();
  });

  contentEl.addEventListener("pointerdown", (event) => {
    const img = event.target instanceof Element ? event.target.closest(".rte-photo") : null;
    // Включённый карандаш имеет приоритет: оба инструмента слушают pointerdown
    // на contentEl, и без этой проверки клик по фото поверх рисования запускал
    // бы одновременно и штрих, и перетаскивание.
    if (!img || event.button !== 0 || drawingActive) return;
    event.preventDefault(); // не ставить каретку, не начинать выделение текста
    selectPhoto(img);
    if (img.dataset.layout !== "float") return; // во flow-режиме drag выключен
    dragPhotoState = {
      img,
      startX: event.clientX,
      startY: event.clientY,
      startLeft: parseFloat(img.style.left) || 0,
      startTop: parseFloat(img.style.top) || 0,
      moved: false,
    };
    contentEl.setPointerCapture(event.pointerId);
  });

  contentEl.addEventListener("pointermove", (event) => {
    if (!dragPhotoState) return;
    const zoom = currentZoom();
    const dx = (event.clientX - dragPhotoState.startX) / zoom;
    const dy = (event.clientY - dragPhotoState.startY) / zoom;
    // Порог в 3px — иначе обычный клик выделения (без намерения тащить) уже
    // считался бы перетаскиванием из-за дрожания курсора между down и up.
    if (!dragPhotoState.moved && Math.hypot(dx, dy) < 3) return;
    dragPhotoState.moved = true;
    dragPhotoState.img.style.left = `${Math.round(dragPhotoState.startLeft + dx)}px`;
    dragPhotoState.img.style.top = `${Math.round(dragPhotoState.startTop + dy)}px`;
    syncHandles();
  });

  contentEl.addEventListener("pointerup", (event) => {
    if (!dragPhotoState) return;
    contentEl.releasePointerCapture(event.pointerId);
    const moved = dragPhotoState.moved;
    dragPhotoState = null;
    if (!moved) return; // просто клик выделения — снимок истории не нужен
    // MutationObserver истории не слушает атрибуты (только childList/characterData),
    // поэтому смену style.left/top снимком не ловит — пишем явно.
    recordHistory();
    onChange(serializeEditor(contentEl));
  });

  // Resize за угловые маркеры. Тянем всегда по горизонтали, высоту считаем из
  // соотношения сторон исходного кадра — свободный перекос не нужен: точный
  // произвольный размер и так доступен в окне редактирования (поля Ш/В).
  contentEl.addEventListener("pointermove", (event) => {
    if (!resizePhotoState) return;
    const { img, corner, startX, startW, startH, startLeft, startTop, ratio } = resizePhotoState;
    const zoom = currentZoom();
    const dx = (event.clientX - startX) / zoom;
    const sign = corner === "nw" || corner === "sw" ? -1 : 1;
    const width = Math.max(24, startW + sign * dx);
    const height = width / ratio;
    img.style.width = `${Math.round(width)}px`;
    img.style.height = `${Math.round(height)}px`;
    // left/top двигаем только у плавающего фото — во flow-режиме верх-лево
    // держит CSS float, псевдо-абсолютные координаты там ничего не значат.
    if (img.dataset.layout === "float") {
      if (corner === "nw" || corner === "sw") img.style.left = `${Math.round(startLeft + (startW - width))}px`;
      if (corner === "nw" || corner === "ne") img.style.top = `${Math.round(startTop + (startH - height))}px`;
    }
    syncHandles();
  });

  contentEl.addEventListener("pointerup", (event) => {
    if (!resizePhotoState) return;
    contentEl.releasePointerCapture(event.pointerId);
    resizePhotoState = null;
    recordHistory();
    onChange(serializeEditor(contentEl));
  });

  // ПКМ на уже размещённом фото: повторное редактирование (то же окно, что и
  // при вставке — карандаш/размер/название) или переключение плавающий/
  // обтекание текстом.
  function showPhotoContextMenu(event, img) {
    const isFlow = img.dataset.layout === "flow";
    showContextMenu(event.clientX, event.clientY, [
      { label: t("editor.photoEditItem"), onClick: () => reopenPhotoEditor(img) },
      {
        label: isFlow ? t("editor.photoMakeFloat") : t("editor.photoIntegrateText"),
        onClick: () => togglePhotoLayout(img),
      },
    ]);
  }

  // Окно уже содержит поле «Название» — отдельного просмотра «сведений» нет,
  // это и есть способ увидеть/поменять название у размещённого фото.
  async function reopenPhotoEditor(img) {
    const result = await openPhotoEditor(img.src, {
      width: parseFloat(img.style.width) || img.naturalWidth,
      height: parseFloat(img.style.height) || img.naturalHeight,
      name: img.dataset.name || "",
    });
    if (!result) return; // отмена
    img.src = result.dataUrl;
    img.style.width = `${result.width}px`;
    img.style.height = `${result.height}px`;
    if (result.name) img.dataset.name = result.name;
    else delete img.dataset.name;
    syncHandles();
    recordHistory();
    onChange(serializeEditor(contentEl));
  }

  // float → flow: фото уходит из абсолютного позиционирования, left/top больше
  // не нужны — их держит CSS float (см. .rte-photo[data-layout="flow"]).
  // flow → float: возвращаем координаты через ensureFloatPosition, чтобы фото
  // не прыгнуло с текущего места на экране.
  function togglePhotoLayout(img) {
    if (img.dataset.layout === "flow") {
      ensureFloatPosition(img, true);
      img.dataset.layout = "float";
    } else {
      img.dataset.layout = "flow";
      img.style.left = "";
      img.style.top = "";
    }
    syncHandles();
    recordHistory();
    onChange(serializeEditor(contentEl));
  }
  // ------------------------------------------------------------------------

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

  // Сборка одной кнопки тулбара вынесена в helper — этот же код собирает и
  // кнопки основного тулбара, и кнопки мини-панели форматирования при ПКМ на
  // выделении (см. showSelectionToolbar ниже): поведение обязано совпадать.
  // onApplied вызывается после применения формата — основной тулбар передаёт
  // no-op, мини-панель — своё закрытие.
  function buildToolbarButton(key, onApplied = () => {}) {
    const def = buttonDefs[key];
    if (!def) return null;

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
        onApplied();
      });
      btn.addEventListener("contextmenu", (event) => {
        event.preventDefault();
        toggleColorPopover(btn, def, contentEl, onChange, refreshToolbarState, focusActivePage, onApplied);
      });
    } else if (def.isHistory) {
      btn.addEventListener("click", () => {
        if (def.isHistory === "undo") undo();
        else redo();
        focusActivePage();
        onApplied();
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
          onApplied();
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
        onApplied();
      });
    } else if (def.isDraw) {
      updateSwatch(btn, def); // полоска снизу — как у textColor, текущий цвет пера
      btn.addEventListener("click", () => {
        toggleDrawing();
        focusActivePage();
        onApplied();
      });
      btn.addEventListener("contextmenu", (event) => {
        event.preventDefault();
        toggleDrawPopover(btn, def);
      });
    } else if (def.isPhoto) {
      btn.addEventListener("click", () => {
        // Диапазон запоминаем сейчас: пока открыт системный диалог выбора файла,
        // выделение/каретка в редакторе теряются.
        openPhotoPicker(getCurrentRange(contentEl));
      });
    } else if (def.isLink) {
      // Диапазон запоминаем сейчас — на время модалки/подменю фокус уходит из
      // редактора и выделение иначе схлопнулось бы.
      btn.addEventListener("click", async () => {
        const range = getCurrentRange(contentEl);
        if (!range) return;

        if (isInlineFormatActive(contentEl, FORMATS.linkExternal)) {
          const wrappers = uniqueAncestors(contentEl, collectTextNodes(range), FORMATS.linkExternal);
          const currentLinks = wrappers.length ? JSON.parse(wrappers[0].dataset.links || "[]") : [];
          const rect = btn.getBoundingClientRect();
          showContextMenu(rect.left, rect.bottom, [
            {
              label: t("editor.linkDelete"),
              onClick: () => {
                unwrapSelection(contentEl, FORMATS.linkExternal, range);
                recordHistory();
                onChange(serializeEditor(contentEl));
                onApplied();
              },
            },
            {
              label: t("editor.linkChange"),
              onClick: async () => {
                const links = await openLinkEditor(currentLinks);
                if (links) {
                  if (!links.length) {
                    unwrapSelection(contentEl, FORMATS.linkExternal, range);
                  } else {
                    const targets = uniqueAncestors(contentEl, collectTextNodes(range), FORMATS.linkExternal);
                    targets.forEach((el) => {
                      el.dataset.links = JSON.stringify(links);
                      el.title = links.join("\n");
                    });
                    markLinkStart(targets);
                  }
                  recordHistory();
                  onChange(serializeEditor(contentEl));
                }
                onApplied();
              },
            },
          ]);
        } else {
          const links = await openLinkEditor([]);
          if (links && links.length) {
            const wrappers = uniqueAncestors(contentEl, wrapSelection(contentEl, FORMATS.linkExternal, range), FORMATS.linkExternal);
            wrappers.forEach((el) => {
              el.dataset.links = JSON.stringify(links);
              el.title = links.join("\n");
            });
            markLinkStart(wrappers);
            focusActivePage();
            recordHistory();
            onChange(serializeEditor(contentEl));
          }
          onApplied();
        }
      });
    } else if (def.isInternalLink) {
      // Та же схема, что у isLink: выделение уже внутри ссылки — меню
      // Delete/"set new link", иначе — поиск заметки и выбор слова в ней.
      btn.addEventListener("click", async () => {
        const range = getCurrentRange(contentEl);
        if (!range) return;

        if (isInlineFormatActive(contentEl, FORMATS.linkInternal)) {
          const rect = btn.getBoundingClientRect();
          showContextMenu(rect.left, rect.bottom, [
            {
              label: t("editor.linkDelete"),
              onClick: () => {
                unwrapSelection(contentEl, FORMATS.linkInternal, range);
                recordHistory();
                onChange(serializeEditor(contentEl));
                onApplied();
              },
            },
            {
              label: t("editor.internalLinkChange"),
              onClick: async () => {
                const picked = await openInternalLinkPicker();
                if (picked) {
                  await applyInternalLink(contentEl, collectTextNodes(range), picked);
                  recordHistory();
                  onChange(serializeEditor(contentEl));
                }
                onApplied();
              },
            },
          ]);
        } else {
          const picked = await openInternalLinkPicker();
          if (picked) {
            const nodes = wrapSelection(contentEl, FORMATS.linkInternal, range);
            await applyInternalLink(contentEl, nodes, picked);
            focusActivePage();
            recordHistory();
            onChange(serializeEditor(contentEl));
          }
          onApplied();
        }
      });
    } else {
      btn.addEventListener("click", async () => {
        // await — командой может быть insertTable, которая асинхронно спрашивает
        // размер через модалку; для обычных execCommand-команд просто no-op.
        await def.command(contentEl);
        focusActivePage();
        onChange(serializeEditor(contentEl));
        refreshToolbarState();
        onApplied();
      });
    }

    return btn;
  }

  buttons.forEach((key) => {
    const btn = buildToolbarButton(key);
    if (btn) toolbarEl.appendChild(btn);
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

  // Мини-панель форматирования выделенного текста при ПКМ — те же самые
  // кнопки, что и в основном тулбаре (buildToolbarButton), просто в
  // уменьшенном плавающем блоке: одинаковый вид, активное состояние и
  // ЛКМ/ПКМ-логика цветовых кнопок. Клик по любой из них закрывает панель.
  let selectionToolbarEl = null;
  let unregisterSelectionLayer = null;

  function onSelectionToolbarOutside(event) {
    if (selectionToolbarEl && !selectionToolbarEl.contains(event.target)) closeSelectionToolbar();
  }

  function closeSelectionToolbar() {
    if (!selectionToolbarEl) return;
    closeColorPopovers(); // палитра внутри панели закрывается вместе с ней
    document.removeEventListener("mousedown", onSelectionToolbarOutside, true);
    selectionToolbarEl.remove();
    selectionToolbarEl = null;
    if (unregisterSelectionLayer) {
      unregisterSelectionLayer();
      unregisterSelectionLayer = null;
    }
  }

  function showSelectionToolbar(x, y) {
    closeSelectionToolbar();
    const bar = document.createElement("div");
    bar.className = "rte-selection-toolbar";
    const selectionButtons = ["underline", "strikethrough", "textColor", "highlight", "link"];
    if (allowInternalLinks) selectionButtons.push("internalLink");
    selectionButtons.forEach((key) => {
      const btn = buildToolbarButton(key, closeSelectionToolbar);
      if (btn) bar.appendChild(btn);
    });
    document.body.appendChild(bar);
    // Клампинг по краям вьюпорта — позиция у панели фиксированная.
    const rect = bar.getBoundingClientRect();
    bar.style.left = `${clamp(x, 8, window.innerWidth - rect.width - 8)}px`;
    bar.style.top = `${clamp(y, 8, window.innerHeight - rect.height - 8)}px`;
    selectionToolbarEl = bar;
    unregisterSelectionLayer = pushLayer(closeSelectionToolbar);
    // Закрытие по клику вне — на mousedown (соглашение проекта): зажатие внутри
    // панели с отпусканием снаружи не должно её схлопывать.
    document.addEventListener("mousedown", onSelectionToolbarOutside, true);
  }

  // Единственное контекстное меню редактора: сюда же попадают пункты раздела
  // (в Заметках — переключение режима отображения) и мини-меню форматирования на
  // выделении. Два независимых обработчика открывали бы два меню одно поверх
  // другого.
  contentEl.addEventListener("contextmenu", (event) => {
    // Фото — своё меню (редактировать / переключить режим), проверяем раньше
    // текстового выделения: у размещённого фото выделения текста не бывает.
    const photoTarget = event.target instanceof Element ? event.target.closest(".rte-photo") : null;
    if (photoTarget) {
      event.preventDefault();
      selectPhoto(photoTarget);
      showPhotoContextMenu(event, photoTarget);
      return;
    }

    const selection = window.getSelection();
    const hasTextSelection = selection.rangeCount && !selection.isCollapsed
      && contentEl.contains(selection.getRangeAt(0).commonAncestorContainer);
    if (hasTextSelection) {
      event.preventDefault();
      showSelectionToolbar(event.clientX, event.clientY);
      return;
    }

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

  // Переход по внешней ссылке — обычный клик, всегда (как у ссылки в браузере),
  // Ctrl/Cmd-клик или средняя кнопка — в новой вкладке. Несколько ссылок сразу —
  // клик показывает тот же поповер, что и наведение, но кликабельный: неясно,
  // какую из них открывать.
  contentEl.addEventListener("click", (event) => {
    const link = event.target instanceof Element ? event.target.closest('a.rte-link[data-link-type="external"]') : null;
    if (!link) return;
    event.preventDefault();
    const links = JSON.parse(link.dataset.links || "[]");
    if (!links.length) return;
    if (links.length === 1) openExternalLink(links[0], event);
    else showLinkPreview(link, links, { clickable: true });
  });

  // Переход по внутренней ссылке на другую заметку — обычный клик, всегда
  // (модификатор тут не даёт отдельного эффекта: приложение — SPA без
  // отдельного URL на заметку, роутер осознанно не кладёт id в hash).
  contentEl.addEventListener("click", (event) => {
    const link = event.target instanceof Element ? event.target.closest('a.rte-link[data-link-type="internal"]') : null;
    if (!link) return;
    event.preventDefault();
    openInternalLink(link);
  });

  async function openInternalLink(link) {
    const item = await itemsService.getItem(link.dataset.itemId);
    if (!item || item.deletedAt) {
      openAlert({ message: t("editor.internalLinkTargetMissing") });
      return;
    }
    setPendingTarget({
      kind: "item",
      id: item.id,
      query: link.dataset.anchorQuery,
      matchIndex: Number(link.dataset.anchorIndex),
    });
    const navigate = getNavigateHandler();
    if (navigate) navigate(item.section === "tasks" ? "tasks" : "documents");
  }

  // Превью ссылок при наведении — mouseover/mouseout вместо mouseenter/mouseleave:
  // те не всплывают, а слушатель один на contentEl (ссылки создаются динамически).
  contentEl.addEventListener("mouseover", (event) => {
    const link = event.target instanceof Element ? event.target.closest('a.rte-link[data-link-type="external"]') : null;
    if (!link || link.contains(event.relatedTarget)) return;
    const links = JSON.parse(link.dataset.links || "[]");
    if (links.length) showLinkPreview(link, links, { clickable: links.length > 1 });
  });
  contentEl.addEventListener("mouseout", (event) => {
    const link = event.target instanceof Element ? event.target.closest('a.rte-link[data-link-type="external"]') : null;
    if (!link) return;
    // Не гасим, если курсор перешёл на сам поповер (иначе по кликабельному
    // списку нельзя было бы кликнуть) или остался внутри той же ссылки.
    const to = event.relatedTarget;
    if (link.contains(to) || (linkPreviewEl && linkPreviewEl.contains(to))) return;
    hideLinkPreview();
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

  // Вставка фото из буфера обмена (Ctrl+V со скриншотом/картинкой). Текстовую
  // вставку не трогаем — только когда в буфере есть изображение.
  contentEl.addEventListener("paste", (event) => {
    const items = event.clipboardData ? event.clipboardData.items : null;
    if (!items) return;
    for (const item of items) {
      if (item.type.startsWith("image/")) {
        event.preventDefault();
        insertImageFile(item.getAsFile(), getCurrentRange(contentEl));
        return;
      }
    }
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
    highlightMatch: (query, occurrence, photoName) => highlightMatch(contentEl, query, occurrence, photoName),
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
function highlightMatch(contentEl, query, occurrence = 0, photoName) {
  clearSearchHighlight();
  // Название фото лежит в атрибуте, а не в текстовом узле — findOccurrenceRange
  // его не найдёт, нужен отдельный путь (см. highlightPhoto).
  if (photoName) {
    highlightPhoto(contentEl, photoName);
    return;
  }
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
  document.querySelectorAll(".rte-photo.is-search-hit").forEach((el) => el.classList.remove("is-search-hit"));
}

// CSS Custom Highlight API красит только текстовые Range — для <img> нужен
// отдельный путь: находим сам узел по data-name и мигаем классом с обводкой.
function highlightPhoto(contentEl, name) {
  const img = [...contentEl.querySelectorAll("img.rte-photo[data-name]")].find((el) => el.dataset.name === name);
  if (!img) return;
  img.scrollIntoView({ block: "center", behavior: "smooth" });
  img.classList.add("is-search-hit");
  searchHighlightTimer = setTimeout(() => img.classList.remove("is-search-hit"), SEARCH_HIGHLIGHT_MS);
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

function toggleColorPopover(btn, def, editorEl, onChange, refreshToolbarState, focusEditor, onApplied = () => {}) {
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
    onApplied();
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
      onApplied();
    });
    popover.appendChild(swatch);
  });

  btn.appendChild(popover);
  unregisterPopoverLayer = pushLayer(closeColorPopovers);
  setTimeout(() => document.addEventListener("click", closeColorPopovers, { once: true }), 0);
}

// Открывает внешнюю ссылку с учётом модификатора — как обычная ссылка в
// браузере: ЛКМ переходит в текущей вкладке, Ctrl/Cmd-клик или средняя кнопка —
// в новой.
function openExternalLink(url, event) {
  const newTab = event.ctrlKey || event.metaKey || event.button === 1;
  if (newTab) window.open(url, "_blank", "noopener");
  else window.location.href = url;
}

// Компактный поповер со списком ссылок — по наведению на внешнюю ссылку и (если
// их несколько) по клику вместо прямого перехода: неясно, какую открывать.
// Стиль — тот же скруглённый "язык", что у результатов поиска (.search-results
// в styles/search.css).
let linkPreviewEl = null;
let unregisterLinkPreviewLayer = null;

function hideLinkPreview() {
  if (!linkPreviewEl) return;
  linkPreviewEl.remove();
  linkPreviewEl = null;
  if (unregisterLinkPreviewLayer) {
    unregisterLinkPreviewLayer();
    unregisterLinkPreviewLayer = null;
  }
}

function showLinkPreview(anchorEl, links, { clickable = false } = {}) {
  hideLinkPreview();
  const popover = document.createElement("div");
  popover.className = "rte-link-preview";

  links.forEach((url) => {
    const row = document.createElement(clickable ? "button" : "div");
    if (clickable) row.type = "button";
    row.className = "rte-link-preview-row";
    row.textContent = url;
    if (clickable) {
      row.addEventListener("click", (event) => {
        openExternalLink(url, event);
        hideLinkPreview();
      });
    }
    popover.appendChild(row);
  });

  document.body.appendChild(popover);
  const anchorRect = anchorEl.getBoundingClientRect();
  const box = popover.getBoundingClientRect();
  popover.style.left = `${clamp(anchorRect.left, 8, window.innerWidth - box.width - 8)}px`;
  popover.style.top = `${clamp(anchorRect.bottom + 4, 8, window.innerHeight - box.height - 8)}px`;

  // Курсор мог уйти со ссылки прямо на поповер (это два разных элемента) —
  // закрываем, только когда он покинул и поповер, и саму ссылку.
  popover.addEventListener("mouseleave", (event) => {
    const to = event.relatedTarget;
    if (to && to.closest && to.closest('a.rte-link[data-link-type="external"]') === anchorEl) return;
    hideLinkPreview();
  });

  linkPreviewEl = popover;
  unregisterLinkPreviewLayer = pushLayer(hideLinkPreview);
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
