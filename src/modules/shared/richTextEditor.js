import { t, getLang } from "../../i18n/i18n.js";
import { openTablePrompt, openConfirm, openAlert } from "../../utils/modal.js";
import { pushLayer } from "../../utils/escapeLayers.js";
import { showContextMenu } from "./contextMenu.js";
import { fileToDataUrl, downscaleImage } from "../../utils/image.js";
import { openPhotoEditor } from "./photoEditor.js";
import { openLinkEditor } from "./linkEditor.js";
import { openLinkPicker } from "../../search/searchBar.js";
import { escapeAttr } from "../../utils/dom.js";
import * as itemsService from "../../services/itemsService.js";
import * as blockTagsService from "../../services/blockTagsService.js";
import { createBlockSync, pageLines, getBlockTagIds, ensureBlockIdFactory, getBlockLines, assignBlock, setBlockTagIds } from "./blockTags.js";
import { openAnchoredMenu } from "./anchoredMenu.js";
import { openBlockTagEditor } from "./blockTagEditor.js";
import { openBlockTagsBrowser } from "./blockTagsBrowser.js";
import { setPendingTarget, getNavigateHandler } from "../../search/searchTarget.js";
import {
  occurrenceRange,
  showSearchHighlight,
  showPhotoHighlight,
  clearSearchHighlight,
} from "../../utils/searchHighlight.js";
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

// Тулбар сменил набор видимых кнопок — значит сменил и габариты. Тому, кто держит
// его на экране (floatingToolbar.js), это надо знать: у прилипшей к краю полосы от
// числа кнопок зависит число колонок, а от него — ширина и левая координата.
// Событие, а не прямой вызов: редактор про плавающий модуль ничего не знает, и
// поток данных остаётся односторонним.
export const TOOLBAR_LAYOUT_EVENT = "rte-toolbar-layout";

function notifyToolbarLayout(toolbarEl) {
  toolbarEl.dispatchEvent(new CustomEvent(TOOLBAR_LAYOUT_EVENT));
}

function createToolbarToggle(toolbarEl) {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "rte-toolbar-toggle";
  btn.title = t("editor.toggleToolbar");

  function apply(collapsed) {
    toolbarEl.classList.toggle("is-collapsed", collapsed);
    btn.textContent = collapsed ? "▾" : "▴";
    notifyToolbarLayout(toolbarEl);
  }

  function setCollapsed(collapsed) {
    localStorage.setItem(TOOLBAR_COLLAPSED_KEY, collapsed ? "1" : "0");
    apply(collapsed);
  }

  apply(localStorage.getItem(TOOLBAR_COLLAPSED_KEY) === "1");
  // Как и у кнопок форматирования: не забираем фокус, иначе выделение в тексте
  // схлопнется ещё до клика.
  btn.addEventListener("mousedown", (event) => event.preventDefault());
  btn.addEventListener("click", () => setCollapsed(!toolbarEl.classList.contains("is-collapsed")));
  // expand отдаётся наружу: в свёрнутом виде эта кнопка превращается в тонкую
  // полоску во всю ширину тулбара, а у оторванной панели ширина считается по
  // содержимому — полоске взяться неоткуда, и развернуть панель нечем. Поэтому
  // разворот берёт на себя кнопка справа, см. createToolbarExpandToggle.
  return { el: btn, expand: () => setCollapsed(false) };
}

// Как и TOOLBAR_COLLAPSED_KEY — настройка вида, живёт в localStorage, а не
// в данных заметки, иначе разворачивалась бы обратно при каждом переключении.
const TOOLBAR_EXPANDED_KEY = "app:toolbarExpanded";

// Кнопка "+/−" справа от тулбара: показывает/прячет расширенный набор кнопок
// (помечены data-toolbar-extra, см. .rte-toolbar в editor.css), в отличие от
// createToolbarToggle выше — та прячет тулбар целиком, а не часть кнопок.
function createToolbarExpandToggle(toolbarEl, collapseToggle) {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "rte-toolbar-expand";

  // У кнопки две работы, и какая из них сейчас — видно по знаку. Плюс-минус про
  // дополнительные инструменты имеет смысл, только когда инструменты вообще видны;
  // у свёрнутой панели прятать нечего, зато её саму нужно чем-то разворачивать.
  function refresh() {
    const collapsed = toolbarEl.classList.contains("is-collapsed");
    btn.textContent = collapsed ? "▴" : toolbarEl.classList.contains("is-expanded") ? "−" : "+";
    btn.title = collapsed ? t("editor.toggleToolbar") : t("editor.toggleExtraTools");
  }

  function apply(expanded) {
    toolbarEl.classList.toggle("is-expanded", expanded);
    notifyToolbarLayout(toolbarEl);
  }

  apply(localStorage.getItem(TOOLBAR_EXPANDED_KEY) === "1");
  refresh();
  // Знак обновляется и когда панель свернули левой кнопкой, а не этой. Сам refresh
  // события не шлёт, поэтому петли не выходит.
  toolbarEl.addEventListener(TOOLBAR_LAYOUT_EVENT, refresh);
  btn.addEventListener("mousedown", (event) => event.preventDefault());
  btn.addEventListener("click", () => {
    if (toolbarEl.classList.contains("is-collapsed")) {
      collapseToggle.expand();
      return;
    }
    const expanded = !toolbarEl.classList.contains("is-expanded");
    localStorage.setItem(TOOLBAR_EXPANDED_KEY, expanded ? "1" : "0");
    apply(expanded);
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
    // H3 — единственный уровень МЕЛЬЧЕ обычного текста (см. шкалу в editor.css).
    h3: { label: "H3", title: t("editor.h3"), command: (editorEl) => applyHeading(editorEl, "H3"), isActive: (editorEl) => isHeading(editorEl, "H3") },
    alignLeft: { label: "⟸", title: t("editor.alignLeft"), command: () => document.execCommand("justifyLeft"), isActive: () => document.queryCommandState("justifyLeft") },
    alignCenter: { label: "≡", title: t("editor.alignCenter"), command: () => document.execCommand("justifyCenter"), isActive: () => document.queryCommandState("justifyCenter") },
    alignRight: { label: "⟹", title: t("editor.alignRight"), command: () => document.execCommand("justifyRight"), isActive: () => document.queryCommandState("justifyRight") },
    // Перенос выделенного на следующую страницу. Определение живёт здесь, рядом с
    // остальными, но в списки тулбаров этот ключ не попадает: инструмент
    // подставляется только в меню по ПКМ и только в постраничном режиме
    // (см. showSelectionToolbar).
    moveToNextPage: { label: "⤵", isMoveToNextPage: true, title: t("editor.moveToNextPage") },
    // Направление письма текущей строки. is-active тут значит не «режим включён»,
    // а «строка идёт справа налево» — по нему CSS и решает, какую из двух стрелок
    // на кнопке зажечь (см. .rte-dir-* в editor.css).
    textDirection: {
      isDirection: true,
      title: t("editor.textDirection"),
      isActive: (editorEl) => currentLineDirection(editorEl) === "rtl",
    },
    // Все три вида списка ведёт один движок (toggleList): браузерная команда
    // insertUnorderedList склеивала соседние списки через пустую строку и не
    // различала их вид — см. комментарий у LIST_KINDS.
    bulletList: { label: "•", title: t("editor.bulletList"), command: (editorEl) => toggleList(editorEl, "bullet"), isActive: (editorEl) => currentListKind(editorEl) === "bullet" },
    orderedList: { label: "1.", title: t("editor.orderedList"), command: (editorEl) => toggleList(editorEl, "ordered"), isActive: (editorEl) => currentListKind(editorEl) === "ordered" },
    checklist: { label: "☑", title: t("editor.checklist"), command: (editorEl) => toggleList(editorEl, "checklist"), isActive: (editorEl) => currentListKind(editorEl) === "checklist" },
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
    // Тег блока — не команда форматирования: открывает Add/Create вместо
    // прямого применения, обрабатывается отдельно в buildToolbarButton (isTag).
    // В основной тулбар не попадает — только в мини-панель на выделении, см.
    // selectionButtons в showSelectionToolbar.
    tag: { label: "#", title: t("editor.tag"), isTag: true },
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

// Ширина одного шага отступа (Tab). Ровно столько же ставил браузерный
// execCommand("indent"), которым отступ делался раньше, — поэтому старые
// заметки после upgradeLegacyIndents выглядят точно так же, как выглядели.
const INDENT_STEP_PX = 40;
// Предел вложенности: при 40px на шаг дальше строка всё равно упирается в
// правый край листа.
const MAX_INDENT = 10;

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
  h3: { selector: "span.rte-h3", create: () => createHeadingSpan("rte-h3") },
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

// Уровни размера в одном месте: они взаимоисключающие, и applyHeading снимает
// с фрагмента все, кроме выбранного.
const HEADING_LEVELS = ["h1", "h2", "h3"];

const EMPTY_WRAPPER_SELECTOR = "u,s,span.rte-h1,span.rte-h2,span.rte-h3,a.rte-link";

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
      clone.querySelectorAll(".rte-interim, .rte-photo-handles, .rte-block-dots, .rte-block-panel").forEach((node) => node.remove());
      clone.querySelectorAll(".rte-photo.is-selected").forEach((el) => el.classList.remove("is-selected"));
      stripEditingLeftovers(clone);
      return `<div class="rte-page">${clone.innerHTML}</div>`;
    })
    .join("");
}

// Следы редактирования, которым в сохранённой заметке делать нечего: якоря
// каретки и опустевшие после них теги. Пустой тег снаружи не виден, но каретка,
// попав внутрь, снова печатает оформленной — как раз та «невидимая зона», из
// которой невозможно выйти кнопкой.
function stripEditingLeftovers(page) {
  // Сначала якоря: тег с якорем внутри пустым не выглядит.
  const walker = document.createTreeWalker(page, NodeFilter.SHOW_TEXT);
  const anchored = [];
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (node.textContent.includes(CARET_ANCHOR)) anchored.push(node);
  }
  anchored.forEach((node) => {
    node.textContent = node.textContent.split(CARET_ANCHOR).join("");
    if (!node.textContent) node.remove();
  });

  // Пустой — значит без единого узла внутри: <span><br></span> это пустая строка
  // с ждущим оформлением, а не мусор. Идём с конца, чтобы вложенные обёртки
  // (<u><s></s></u>) успели опустеть раньше, чем дойдёт очередь до внешней.
  [...page.querySelectorAll("u,s,a.rte-link,span[style],span.rte-h1,span.rte-h2,span.rte-h3")]
    .reverse()
    .forEach((el) => {
      if (!el.childNodes.length) el.remove();
    });
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

/**
 * Цвет букв и заливка в точке каретки — то, чем прямо сейчас идёт печать.
 *
 * Заливку находит colorCarrier: hiliteColor кладёт её в <span style>. А вот
 * foreColor при выключенном styleWithCSS пишет <font color="…"> — АТРИБУТОМ, и
 * по el.style.color такой носитель не найти, поэтому цвет букв ищем отдельно.
 * style.color тоже принимаем: он приходит со вставкой из буфера.
 *
 * Читаем именно инлайновую разметку, а не computed-стиль: серый цвет
 * отмеченного пункта to-do задан правилом CSS (li.is-done), и computed вернул
 * бы его наравне с выбранным пользователем. Такой цвет переносить на новую
 * строку нельзя — он не выбор пользователя, а вид отметки.
 */
function caretColors(editorEl, node) {
  const carrier = colorCarrier(editorEl, node, "backgroundColor");
  let el = node && node.nodeType === Node.TEXT_NODE ? node.parentElement : node;
  let color = "";
  while (el && editorEl.contains(el) && !el.classList.contains("rte-page")) {
    if (el.style && el.style.color) {
      color = el.style.color;
      break;
    }
    if (el.tagName === "FONT" && el.getAttribute("color")) {
      color = el.getAttribute("color");
      break;
    }
    el = el.parentElement;
  }
  return { color, background: carrier ? carrier.style.backgroundColor : "" };
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
  const block = node.closest("h1,h2,h3,p,div,li,blockquote");
  return block && block !== editorEl && editorEl.contains(block) ? block : null;
}

function isHeading(editorEl, tagName) {
  const block = getBlockElement(editorEl);
  if (block && block.tagName === tagName.toUpperCase()) return true;
  return isInlineFormatActive(editorEl, FORMATS[tagName.toLowerCase()]);
}

// --- Отступ строки (Tab) ------------------------------------------------
// Уровень отступа живёт на самой строке: data-indent — источник истины,
// margin-inline-start его рисует. Свойство именно логическое, а не margin-left:
// оно отмеряется от НАЧАЛА строки, а начало зависит от направления. В ивритской
// строке Tab благодаря этому сдвигает текст от правого края, зеркально обычному,
// и отдельной ветки под RTL здесь не нужно.
// Раньше отступ делал браузерный execCommand("indent"),
// который заворачивает строки в общий <blockquote>: соседние строки попадали в
// одну обёртку, и снять отступ у одной, не задев остальные, было нельзя. Здесь
// задеть соседа физически невозможно — отступ принадлежит строке.
//
// li сюда не входит намеренно: внутри списков Tab по-прежнему делает
// вложенность средствами браузера, это другая семантика.
const LINE_SELECTOR = "h1,h2,h3,p,div";

function getIndentLevel(line) {
  return Number(line.dataset.indent) || 0;
}

function setIndentLevel(line, level) {
  const next = clamp(level, 0, MAX_INDENT);
  if (next === 0) {
    delete line.dataset.indent;
    line.style.marginInlineStart = "";
  } else {
    line.dataset.indent = String(next);
    line.style.marginInlineStart = `${next * INDENT_STEP_PX}px`;
  }
}

// Строка — прямой потомок листа: именно на этом уровне браузер держит <div>,
// между которыми делит текст. Сам .rte-page — тоже div, но это лист, а не
// строка: отступ на нём сдвинул бы всю страницу.
function getCaretLine(editorEl) {
  const selection = window.getSelection();
  if (!selection.rangeCount) return null;
  let node = selection.getRangeAt(0).startContainer;
  if (node.nodeType === Node.TEXT_NODE) node = node.parentElement;
  if (!node || !editorEl.contains(node)) return null;
  const page = node.closest(".rte-page");
  if (!page) return null;
  // Внутри списка строки нет: там отступ — вложенность пункта, и занимается ею
  // отдельная пара indentListItem/outdentListItem. Сам <ul> Chrome кладёт внутрь
  // строки-обёртки, поэтому подъём до прямого потомка листа нашёл бы эту обёртку
  // и сдвинул весь список целиком — ровно тот баг, от которого уходим.
  if (node.closest("ul,ol")) return null;
  let line = node;
  while (line && line.parentElement !== page) line = line.parentElement;
  return line && line.matches(LINE_SELECTOR) ? line : null;
}

// Блок, внутри которого стоит каретка: строка листа либо пункт списка. Пункт
// приходится искать отдельно — getCaretLine внутри списков молчит намеренно,
// строк там нет. Нужен там, где важен сам блок, а не отступ: см. clearEmptiedBlock.
function getCaretBlock(editorEl) {
  const line = getCaretLine(editorEl);
  if (line) return line;
  const selection = window.getSelection();
  if (!selection.rangeCount) return null;
  let node = selection.getRangeAt(0).startContainer;
  if (node.nodeType === Node.TEXT_NODE) node = node.parentElement;
  if (!node || !editorEl.contains(node)) return null;
  const li = node.closest("li");
  return li && editorEl.contains(li) ? li : null;
}

// Все строки, которых касается выделение: при схлопнутой каретке — ровно одна,
// при растянутом на несколько строк — все они, как это делал execCommand.
function getSelectedLines(editorEl) {
  const line = getCaretLine(editorEl);
  if (!line) return [];
  const range = getCurrentRange(editorEl);
  if (!range || range.collapsed) return [line];
  const page = line.parentElement;
  return [...page.children].filter((child) => child.matches(LINE_SELECTOR) && range.intersectsNode(child));
}

// Пункты списка, которых касается выделение: при схлопнутой каретке ровно один.
// Отдельно от getSelectedLines — там строки лежат прямыми потомками листа, а
// здесь <li> внутри <ul>/<ol>, и уровень у каждого свой.
function getSelectedListItems(editorEl) {
  const selection = window.getSelection();
  if (!selection.rangeCount) return [];
  const range = selection.getRangeAt(0);
  let node = range.startContainer;
  if (node.nodeType === Node.TEXT_NODE) node = node.parentElement;
  if (!node || !editorEl.contains(node)) return [];
  const li = node.closest("li");
  if (!li || !editorEl.contains(li)) return [];
  if (range.collapsed) return [li];

  const page = li.closest(".rte-page");
  if (!page) return [li];
  const touched = [...page.querySelectorAll("li")].filter((item) => range.intersectsNode(item));
  // Вложенный пункт уедет вместе со своим родителем — двигать его ещё и
  // отдельно значило бы сдвинуть на два уровня вместо одного.
  return touched.filter((item) => !touched.some((other) => other !== item && other.contains(item)));
}

// То, чему переключается направление: строки листа, а внутри списка — пункты.
// getCaretLine в списках намеренно отдаёт null (там своя семантика отступа), так
// что пункты приходится доставать отдельной парой.
function getDirectionTargets(editorEl) {
  const lines = getSelectedLines(editorEl);
  return lines.length ? lines : getSelectedListItems(editorEl);
}

// Направление строки под кареткой. Спрашиваем вычисленный стиль, а не атрибут:
// при dir="auto" в атрибуте так и написано «auto», а куда в итоге развернулась
// строка, знает только браузер — он разбирает текст по алгоритму bidi.
function currentLineDirection(editorEl) {
  const target = getDirectionTargets(editorEl)[0];
  return target ? getComputedStyle(target).direction : "ltr";
}

// Ручной переворот направления — на случай, когда автоопределение промахнулось:
// строка начинается с латинского слова или цифры, а по смыслу ивритская.
// Переворачиваем относительно того, что видно сейчас, и ставим направление явно —
// после этого applyLineDirection эту строку уже не трогает.
function toggleTextDirection(editorEl) {
  const targets = getDirectionTargets(editorEl);
  if (!targets.length) return false;
  const next = getComputedStyle(targets[0]).direction === "rtl" ? "ltr" : "rtl";
  targets.forEach((el) => {
    el.dir = next;
  });
  return true;
}

/**
 * Tab на пункте списка — настоящая вложенность, а не поле слева: сдвинутый пункт
 * начинает свой уровень нумерации, а внешняя нумерация идёт дальше без пропусков
 * (1. / 1. вложенная / 2.). Полем это было бы «1. / 2. со сдвигом / 3.».
 *
 * Первый пункт списка сдвинуть нельзя — его не подо что вкладывать; так же
 * ведут себя Word и Google Docs.
 *
 * Несколько выделенных пунктов обходятся по порядку документа, и этого
 * достаточно: как только первый переехал в подсписок предыдущего соседа,
 * предыдущим для следующего становится тот же сосед, и пункт попадает в тот же
 * подсписок — соседями, а не глубже.
 */
function indentListItem(li) {
  const prev = li.previousElementSibling;
  if (!prev || prev.tagName !== "LI") return false;

  const list = li.parentElement;
  let nested = prev.lastElementChild;
  if (!nested || nested.tagName !== list.tagName) {
    nested = document.createElement(list.tagName);
    // Квадратики чек-листа висят на классе списка (см. .checklist в editor.css) —
    // без него у вложенных пунктов пропали бы маркеры.
    if (list.classList.contains("checklist")) nested.classList.add("checklist");
    prev.appendChild(nested);
  }
  nested.appendChild(li);
  return true;
}

// Shift+Tab — обратно на уровень выше: пункт встаёт следующим соседом своего
// родительского <li>. Пункты, шедшие за ним, уезжают вместе с ним отдельным
// подсписком — иначе они остались бы висеть под чужим пунктом.
function outdentListItem(li) {
  const list = li.parentElement;
  const parentItem = list.parentElement;
  if (!parentItem || parentItem.tagName !== "LI") return false; // уже верхний уровень

  const following = [];
  for (let next = li.nextElementSibling; next; next = next.nextElementSibling) following.push(next);
  if (following.length) {
    const tail = document.createElement(list.tagName);
    if (list.classList.contains("checklist")) tail.classList.add("checklist");
    following.forEach((item) => tail.appendChild(item));
    li.appendChild(tail);
  }

  parentItem.after(li);
  if (!list.children.length) list.remove();
  return true;
}

// Голая строка: перенос, держащий её высоту, и больше ничего — ни тега, из
// которого пришлось бы выбираться, ни текста. Снимать с такой нечего.
function isBareLine(line) {
  const nodes = [...line.childNodes];
  return nodes.some((node) => node.nodeName === "BR")
    && nodes.every((node) => node.nodeName === "BR" || (node.nodeType === Node.TEXT_NODE && !node.textContent));
}

// Пустая строка: ни текста, ни вставленного объекта — только <br>, который
// браузер держит в каждой пустой строке, и невидимые якоря каретки.
function isLineEmpty(line) {
  if (line.querySelector("img,svg,table")) return false;
  return line.textContent.split(CARET_ANCHOR).join("").trim() === "";
}

// --- Одна строка — один блок ---------------------------------------------
// Отступ, выравнивание и якоря рисунков принадлежат блоку-строке, поэтому строки
// обязаны лежать в листе поштучно. Chrome это правило ломает: сняв список, он
// складывает все бывшие пункты в ОДИН блок и разделяет их переносами —
// <div><span>aaa</span><br><span>bbb</span></div>. Внешне это по-прежнему
// отдельные строки, но Tab на любой из них двигает весь блок разом. Здесь
// разметка возвращается к виду «одна строка — один блок».

// Что уже лежит на уровне листа само по себе. Строки и списки — содержимое,
// фото с рисунками и маркеры выделения — служебные слои: заворачивать их в
// строку нельзя, иначе объект потеряет привязку (см. anchoredObjects).
const PAGE_LEVEL_SELECTOR = `${LINE_SELECTOR},ul,ol,table,blockquote,img.rte-photo,svg.rte-drawing-layer,.rte-photo-handles`;

// Строка с текстом, а не служебный слой: маркеры выделения фото — тоже div среди
// прямых потомков листа, но резать их по переносам нечего.
function isTextLine(el) {
  return el.matches(LINE_SELECTOR) && !el.className.startsWith("rte-");
}

// Направление письма — свойство отдельной строки, а не всей заметки: в одной
// заметке спокойно соседствуют русский, английский и иврит, и каждая строка
// должна разворачиваться сама по своему первому «сильному» символу. Ровно это и
// делает dir="auto".
//
// Ставим атрибут, а не CSS unicode-bidi: plaintext, хотя тот тоже определяет
// направление абзаца по первому символу. Причина принципиальная: plaintext НЕ
// задаёт свойство direction, а от него зависят логические отступы (это ими
// сдвигает строку Tab) и сторона маркера списка. С plaintext ивритская строка
// читалась бы справа налево, но точка списка и квадратик чек-листа остались бы
// слева.
//
// Трогаем только те строки, у которых атрибута ещё нет: явный dir="rtl"/"ltr"
// ставит пользователь кнопкой направления, и перетирать его автоматом нельзя.
function applyLineDirection(editorEl) {
  editorEl.querySelectorAll(".rte-page").forEach((page) => {
    [...page.children].filter(isTextLine).forEach((line) => {
      if (!line.hasAttribute("dir")) line.dir = "auto";
    });
    // Пункт списка — такая же строка, направление у него своё.
    //
    // А вот самому <ul>/<ol> dir не ставим, хотя соблазн есть. При dir="auto"
    // направление считается по тексту элемента, но содержимое потомков, у которых
    // есть СВОЙ dir, из расчёта исключается. Проставив атрибут и списку, и его
    // пунктам, мы отняли у списка весь текст, и он всегда получался ltr — точка у
    // ивритского пункта оставалась слева. Поэтому направление держит только пункт,
    // а внутренний отступ списка перенесён на него же (см. editor.css).
    page.querySelectorAll("li").forEach((li) => {
      if (!li.hasAttribute("dir")) li.dir = "auto";
    });
  });
}

// Возвращает true, если разметку пришлось править: вызывающий код по этому
// признаку решает, восстанавливать ли каретку. Трогать её без нужды нельзя —
// после обычной команды вроде «жирный» выделение должно остаться выделением.
function normalizeLines(editorEl) {
  let changed = false;
  editorEl.querySelectorAll(".rte-page").forEach((page) => {
    // Порядок важен: сперва разбираем вложенные друг в друга блоки, и только
    // потом собираем «бездомное» — иначе wrapLooseContent завернул бы всплывшие
    // пункты в строку и получилось бы ровно то, от чего лечим.
    if (flattenNestedLines(page)) changed = true;
    if (rescueOrphanItems(page)) changed = true;
    if (wrapLooseContent(page)) changed = true;
    [...page.children].filter(isTextLine).forEach((line) => {
      if (splitLineAtBreaks(line)) changed = true;
    });
  });
  // Появление атрибута не сдвигает ни одного символа, поэтому в changed не идёт:
  // иначе каретка восстанавливалась бы после каждой команды без всякой нужды.
  applyLineDirection(editorEl);
  clearDoneOnEmptyItems(editorEl);
  return changed;
}

// Отметка «выполнено» на ПУСТОМ пункте смысла не имеет — выполнять там нечего.
// Отметка живёт классом на <li>, а Chrome по Enter клонирует строку вместе с
// классами: новая, ещё пустая задача появлялась уже отмеченной и зачёркнутой.
// Снятие класса ни одного символа не двигает, поэтому в changed тоже не идёт.
function clearDoneOnEmptyItems(editorEl) {
  editorEl.querySelectorAll("li.is-done").forEach((li) => {
    if (isLineEmpty(li)) li.classList.remove("is-done");
  });
}

// Полоску рисует CSS по data-block-start/end (см. editor.css) — здесь только
// проставляется цвет первого тега блока (--block-tag-color, читает его сам
// псевдоэлемент) и собираются точки для тегов сверх первого: их число и цвет
// динамические, чистым CSS не нарисовать. tagRegistry — Map id → {name,color},
// снятая с blockTagsService при открытии редактора (см. refreshTagRegistry).
function renderBlockVisuals(editorEl, tagRegistry) {
  editorEl.querySelectorAll(".rte-page").forEach((page) => {
    // Точки — под снос каждый раз: их немного, пересобрать дешевле, чем
    // сверять поштучно, кто добавился, а кто пропал.
    page.querySelectorAll(":scope > .rte-block-dots").forEach((el) => el.remove());
    pageLines(page).forEach((line) => {
      const ids = getBlockTagIds(line);
      if (!ids.length) {
        line.style.removeProperty("--block-tag-color");
        return;
      }
      const first = tagRegistry.get(ids[0]);
      line.style.setProperty("--block-tag-color", first ? first.color : "transparent");
      if (line.dataset.blockStart !== "true" || ids.length < 2) return;
      const dots = document.createElement("div");
      dots.className = "rte-block-dots";
      dots.contentEditable = "false";
      dots.style.top = `${line.offsetTop}px`;
      ids.slice(1).forEach((id) => {
        const dot = document.createElement("span");
        const tag = tagRegistry.get(id);
        dot.style.backgroundColor = tag ? tag.color : "transparent";
        dots.appendChild(dot);
      });
      page.appendChild(dots);
    });
  });
}

// Блоки, которым не место внутри строки: они сами — строки листа либо содержимое
// списка. Служебные слои (.rte-photo-handles и прочее с префиксом rte-) не в
// счёт, их положение осмысленно; фото и рисунки тоже не трогаем — они живут
// внутри текста намеренно.
const NESTED_BLOCK_SELECTOR = "h1,h2,h3,p,div,ul,ol,li";

function isNestedBlock(node) {
  return (
    node.nodeType === Node.ELEMENT_NODE
    && node.matches(NESTED_BLOCK_SELECTOR)
    && !node.className.startsWith("rte-")
  );
}

/**
 * Строки листа не вкладываются друг в друга. Отступ, выравнивание и якорь
 * рисунка принадлежат БЛОКУ, поэтому блок, внутри которого лежит ещё один,
 * тянет чужие строки за собой: Tab на одной из них сдвигал их все, а список,
 * попавший внутрь строки, забирал её отступ себе.
 *
 * Такую разметку оставляли и снятие списка (до правки), и старый
 * execCommand("insertUnorderedList"), который клал <ul> внутрь строки. Поэтому
 * разбор нужен не только на будущее, но и для уже сохранённых заметок — он
 * идёт при каждом открытии (normalizeLines вызывается на старте редактора).
 *
 * Разворачиваем по порядку: вложенный блок поднимается на уровень листа, а
 * куски текста между такими блоками становятся самостоятельными строками того
 * же вида, что и исходная.
 */
function flattenNestedLines(page) {
  let changed = false;
  [...page.children].forEach((line) => {
    if (!isTextLine(line) || ![...line.children].some(isNestedBlock)) return;
    changed = true;

    let anchor = line;
    let first = null;
    let inline = [];

    function place(node) {
      anchor.after(node);
      anchor = node;
      if (!first) first = node;
    }

    function flushInline() {
      // Пустышка из одних пробелов — это разделитель разметки, а не строка.
      const meaningful = inline.some(
        (node) => node.nodeType !== Node.TEXT_NODE || node.textContent.trim() !== "",
      );
      if (!meaningful) {
        inline = [];
        return;
      }
      const part = line.cloneNode(false);
      delete part.dataset.anchor;
      inline.forEach((node) => part.appendChild(node));
      inline = [];
      place(part);
    }

    [...line.childNodes].forEach((node) => {
      if (isNestedBlock(node)) {
        flushInline();
        place(node);
        return;
      }
      inline.push(node);
    });
    flushInline();

    // Якорь рисунка указывал на эту строку — передаём первому куску, иначе
    // рисунок потеряет привязку и уедет (см. syncAnchors).
    if (line.dataset.anchor && first) first.dataset.anchor = line.dataset.anchor;
    line.remove();
  });
  return changed;
}

/**
 * Пункт списка, оставшийся без списка, — след той же поломки: сам по себе <li>
 * вне <ul>/<ol> не значит ничего, маркер ему рисовать неоткуда. Подряд идущие
 * собираем обратно в один список.
 *
 * Вид угадываем по отметке «выполнено»: она бывает только в чек-листе. Без неё
 * считаем маркированным — это то, чем список выглядит по умолчанию.
 */
function rescueOrphanItems(page) {
  let changed = false;
  let group = [];

  function flush() {
    if (!group.length) return;
    const kind = group.some((li) => li.classList.contains("is-done")) ? "checklist" : "bullet";
    const list = createList(kind);
    group[0].before(list);
    group.forEach((li) => list.appendChild(li));
    group = [];
    changed = true;
  }

  [...page.children].forEach((node) => {
    if (node.tagName === "LI") group.push(node);
    else flush();
  });
  flush();
  return changed;
}

// Если список занимал страницу целиком, при снятии Chrome оставляет текст голым,
// прямо в листе. Такой текст не строка вовсе: getCaretLine его не находит, и Tab
// по нему молчит. Собираем подряд идущие «бездомные» узлы в строку.
function wrapLooseContent(page) {
  let loose = [];
  let changed = false;

  function flush() {
    if (!loose.length) return;
    const line = document.createElement("div");
    loose[0].before(line);
    loose.forEach((node) => line.appendChild(node));
    loose = [];
    changed = true;
  }

  [...page.childNodes].forEach((node) => {
    if (node.nodeType === Node.ELEMENT_NODE && node.matches(PAGE_LEVEL_SELECTOR)) {
      flush();
      return;
    }
    // Перевод строки между блоками — форматирование самой разметки, а не текст:
    // из него получилась бы пустая строка на ровном месте.
    if (!loose.length && node.nodeType === Node.TEXT_NODE && node.textContent.trim() === "") return;
    loose.push(node);
  });
  flush();
  return changed;
}

// Режем строку по переносам: каждый кусок становится самостоятельной строкой
// того же вида. Перенос в самом конце не трогаем — это заполнитель, которым
// браузер держит высоту строки, а одинокий <br> держит пустую строку.
function splitLineAtBreaks(line) {
  let current = line;
  let changed = false;
  for (let br = nextSplitBreak(current); br; br = nextSplitBreak(current)) {
    changed = true;
    const tail = document.createRange();
    tail.setStartAfter(br);
    tail.setEnd(current, current.childNodes.length);

    const next = current.cloneNode(false);
    // Якорь рисунка указывает на одну строку — у копии его быть не должно.
    delete next.dataset.anchor;
    next.appendChild(tail.extractContents());
    br.remove();
    current.after(next);
    fillEmptyLine(current);
    current = next;
  }
  fillEmptyLine(current);
  return changed;
}

// Первый перенос, после которого в строке ещё что-то есть. Соседний <br> тоже
// считается содержимым: два переноса подряд — это пустая строка между кусками.
//
// Переносы внутри вложенных блоков пропускаем: <br> держит высоту пустого пункта
// списка и пустой ячейки таблицы, и разрез по нему развалил бы сам список.
function nextSplitBreak(line) {
  return [...line.querySelectorAll("br")].find((br) => {
    if (br.closest("li,ul,ol,table,blockquote")) return false;
    const rest = document.createRange();
    rest.setStartAfter(br);
    rest.setEnd(line, line.childNodes.length);
    const content = rest.cloneContents();
    return content.textContent.trim() !== "" || !!content.querySelector("br,img,svg,table");
  }) || null;
}

/**
 * Есть ли в диапазоне хоть что-то значимое. Проверять надо ПО СОДЕРЖИМОМУ:
 * range.collapsed сравнивает границы, а не текст, и на этом ловилась пустая
 * строка перед новым блоком. selectNodeContents(line) ставит начало в
 * (line, 0) — границу-ЭЛЕМЕНТ, а Chrome выражает край выделения у начала
 * строки как (textNode, 0). Позиция та же, границы разные, поэтому collapsed
 * ложен, хотя между ними ни одного символа — разрез всё равно выполнялся и
 * порождал пустой "остаток", которому fillEmptyLine дописывал <br>.
 *
 * Тот же приём проверки, что в nextSplitBreak ниже: <br>/img/svg/table считаем
 * содержимым (пустая строка, намеренно попавшая в выделение, — часть блока),
 * а пробелы и NBSP — нет.
 */
function rangeHasContent(range) {
  const content = range.cloneContents();
  return content.textContent.trim() !== "" || !!content.querySelector("br,img,svg,table");
}

// Пустой строке нужен <br>: без него браузер схлопывает её высоту и поставить в
// неё каретку нечем.
function fillEmptyLine(line) {
  if (line.textContent.trim() === "" && !line.querySelector("br,img,svg,table")) {
    line.appendChild(document.createElement("br"));
  }
}

// Заметки, сохранённые до перехода на data-indent, держат отступ браузерным
// <blockquote>. Разворачиваем при открытии: каждая строка внутри получает свой
// уровень (вложенные blockquote суммируются), после чего blockquote в заметке
// не остаётся вовсе.
function upgradeLegacyIndents(editorEl) {
  // Голый текст внутри blockquote — тоже строка, но без элемента, на который
  // можно повесить отступ: заворачиваем в div, иначе уровень будет некуда деть.
  editorEl.querySelectorAll("blockquote").forEach((quote) => {
    [...quote.childNodes]
      .filter((child) => child.nodeType === Node.TEXT_NODE && child.textContent.trim() !== "")
      .forEach(wrapInDiv);
  });
  // Уровни раздаём до разворота, пока обёртки ещё на месте: глубина вложенности
  // blockquote над строкой — это и есть её отступ.
  editorEl.querySelectorAll("blockquote > *").forEach((line) => {
    if (!line.matches(LINE_SELECTOR)) return;
    let depth = 0;
    for (let el = line.parentElement; el && el.tagName === "BLOCKQUOTE"; el = el.parentElement) depth++;
    setIndentLevel(line, getIndentLevel(line) + depth);
  });
  // Теперь разворачиваем. Порядок документа гарантирует, что внешняя обёртка
  // обработана раньше вложенной, и к своей очереди вложенная уже поднята выше.
  editorEl.querySelectorAll("blockquote").forEach((quote) => {
    while (quote.firstChild) quote.parentElement.insertBefore(quote.firstChild, quote);
    quote.remove();
  });
}

function wrapInDiv(node) {
  const div = document.createElement("div");
  node.parentElement.insertBefore(div, node);
  div.appendChild(node);
  return div;
}

/**
 * Есть выделение — заголовок применяется ТОЛЬКО к нему: хоть одна буква, хоть
 * несколько строк. Строка при этом не разрывается, оформляется сам фрагмент.
 * Ничего не выделено — прежнее поведение: весь блок под кареткой становится
 * заголовком (и повторное нажатие снимает его).
 */
function applyHeading(editorEl, tagName) {
  const level = tagName.toLowerCase();
  const format = FORMATS[level];
  const selection = window.getSelection();
  const range = selection.rangeCount ? selection.getRangeAt(0) : null;

  if (range && !range.collapsed && editorEl.contains(range.commonAncestorContainer)) {
    // Уровни размера взаимоисключающие: снимаем с этого же фрагмента все прочие,
    // иначе они наслаивались бы и размер задавал бы вложенный.
    HEADING_LEVELS.filter((other) => other !== level).forEach((other) => {
      if (isInlineFormatActive(editorEl, FORMATS[other])) {
        unwrapSelection(editorEl, FORMATS[other], selection.getRangeAt(0));
      }
    });
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
 * @param {{content: string, buttons: string[], basicButtons?: string[], pageMode?: "flow" | "paged", onChange: (html: string) => void, onPageModeChange?: (mode: string) => void, getExtraMenuItems?: () => {label: string, onClick: () => void}[], allowInternalLinks?: boolean, showWordCount?: boolean}} options
 * @returns {{toolbarEl: HTMLElement, contentEl: HTMLElement, getPageMode: () => string, togglePageMode: () => void, refreshLayout: () => void, focusContent: () => void}}
 */
export function createRichTextEditor({ content, buttons, basicButtons = null, pageMode = "flow", onChange, onPageModeChange, getExtraMenuItems, initialHistory = null, onHistoryChange = null, allowInternalLinks = false, showWordCount = false }) {
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
  const collapseToggle = createToolbarToggle(toolbarEl);
  toolbarEl.appendChild(collapseToggle.el);

  // Сам контейнер не редактируется — редактируются страницы внутри него. Все
  // проверки форматирования смотрят на editorEl.contains(узел), поэтому им
  // по-прежнему передаётся контейнер.
  const contentEl = document.createElement("div");
  contentEl.className = "rte-content";
  parsePages(content).forEach((html) => contentEl.appendChild(createPageFrame(html)));
  upgradeLegacyChecklists(contentEl);
  upgradeLegacyIndents(contentEl);
  // Слипшиеся строки уже разошлись по сохранённым заметкам — чиним при открытии,
  // отдельной миграции для этого не нужно.
  normalizeLines(contentEl);
  // createBlockSync запоминает уже имеющиеся строки как "старые" — это должно
  // случиться один раз, сразу после normalizeLines и до первого реального
  // редактирования, иначе разграничение "новое/старое" будет отсчитываться не
  // от того момента.
  const blockSync = createBlockSync(contentEl);
  // Реестр тегов заметке не принадлежит (он общий, app:blockTags) — снимаем
  // копию при открытии, дальше держим в памяти и обновляем сами при
  // создании/редактировании тега (см. openTagAddCreateMenu). Первая отрисовка
  // идёт без цветов (реестр ещё не загружен), а как только промис разрешится —
  // перекрашивается уже с настоящими.
  let tagRegistry = new Map();
  function refreshTagRegistry() {
    return blockTagsService.listTags().then((tags) => {
      tagRegistry = new Map(tags.map((tag) => [tag.id, tag]));
      syncBlocks();
    });
  }
  refreshTagRegistry();
  function syncBlocks() {
    blockSync.sync();
    renderBlockVisuals(contentEl, tagRegistry);
  }
  // Границы блоков (data-block-start/end) не хранятся в заметке как источник
  // истины — досчитываем их сразу, до первой отрисовки.
  syncBlocks();
  // Тот же приём, что ensureAnchorId у фото: счётчик id в замыкании редактора.
  const ensureBlockId = ensureBlockIdFactory(contentEl);

  // Строка — минимальная адресуемая единица блока (см. blockTags.js), поэтому
  // для частичного выделения абзаца нужно физически разрезать первую/
  // последнюю задетую строку по границе Range — тот же extractContents-приём,
  // что splitOff ниже для инлайн-форматирования, но по границе диапазона,
  // а не узла.
  function splitLineAtRangeStart(line, container, offset) {
    const probe = document.createRange();
    probe.selectNodeContents(line);
    probe.setEnd(container, offset);
    if (!rangeHasContent(probe)) return; // уже начинается ровно с выделения — резать нечего
    const before = probe.extractContents();
    const newLine = line.cloneNode(false);
    delete newLine.dataset.anchor; // якорь рисунка — как в splitLineAtBreaks, копии не нужен
    newLine.appendChild(before);
    line.before(newLine);
    fillEmptyLine(newLine);
  }

  function splitLineAtRangeEnd(line, container, offset) {
    const probe = document.createRange();
    probe.selectNodeContents(line);
    probe.setStart(container, offset);
    if (!rangeHasContent(probe)) return; // уже кончается ровно на выделении
    const after = probe.extractContents();
    const newLine = line.cloneNode(false);
    delete newLine.dataset.anchor;
    newLine.appendChild(after);
    line.after(newLine);
    fillEmptyLine(newLine);
  }

  // Попало ли в выделение хоть что-то из начала строки: probe от начала строки
  // до границы выделения пуст — значит выделение начинается ровно со строки.
  function nothingBefore(line, container, offset) {
    const probe = document.createRange();
    probe.selectNodeContents(line);
    probe.setEnd(container, offset);
    return !rangeHasContent(probe);
  }

  // Симметрично: пуст ли остаток строки после границы выделения.
  function nothingAfter(line, container, offset) {
    const probe = document.createRange();
    probe.selectNodeContents(line);
    probe.setStart(container, offset);
    return !rangeHasContent(probe);
  }

  // Строка, которой принадлежит узел: поднимаемся до прямого потомка страницы —
  // тот же подъём, что в обработчике contextmenu ниже.
  function lineOfNode(node, page) {
    let el = node.nodeType === 1 ? node : node.parentElement;
    while (el && el.parentElement !== page) el = el.parentElement;
    return el && el.matches(LINE_SELECTOR) ? el : null;
  }

  /**
   * Строки для тегирования, если выделение накрывает абзац не целиком (ТЗ):
   * первую/последнюю задетую строку разрезаем по границе выделения — средняя
   * часть остаётся строкой для тега, исключённые куски "до"/"после" уезжают в
   * новые нетегированные строки-соседи.
   *
   * Строки НЕ берём из getSelectedLines: она отбирает по range.intersectsNode,
   * а он истинен и для строки, которую выделение лишь КАСАЕТСЯ. При протяжке
   * мышью и Shift+Down Chrome ставит конец выделения в offset 0 следующей
   * строки — она попадала в блок, хотя ни одного её символа не выделено, а
   * разрез вытаскивал всё её содержимое в новую строку и тегировал оставшуюся
   * пустую. Поэтому границы считаем сами по startContainer/endContainer и
   * отбрасываем строки, из которых в выделение не попало ничего.
   *
   * Резать можно только строки БЕЗ своего data-block-id — уже тегированную
   * строку кроить на "включённый"/"исключённый" куски нельзя: блок можно
   * только расширить, никогда не сузить (см. attachTagToLines ниже). Для такой
   * строки поведение остаётся прежним — целиком входит в объединение блоков.
   *
   * После разреза обязательно звать syncBlocks() ДО того, как среднюю часть
   * затегируют: иначе новые нетегированные строки-соседи ещё не значатся в
   * known (см. createBlockSync в blockTags.js — отличает только что
   * появившуюся строку от давно существующей и намеренно нетегированной), и
   * пропагация тут же затянет их обратно в блок вплотную к которому они
   * оказались — ровно тот эффект, который эта функция должна убрать.
   */
  function splitSelectionIntoLines(editorEl) {
    const range = getCurrentRange(editorEl);
    if (!range || range.collapsed) return getSelectedLines(editorEl);

    const caretLine = getCaretLine(editorEl);
    if (!caretLine) return [];
    const page = caretLine.parentElement;
    // Тот же фильтр, что в pageLines (blockTags.js): служебные div редактора
    // (.rte-block-dots, .rte-block-panel) — не строки текста, в блок им нельзя.
    const lines = [...page.children].filter(
      (el) => el.matches(LINE_SELECTOR) && !el.className.startsWith("rte-")
    );

    const startLine = lineOfNode(range.startContainer, page);
    const endLine = lineOfNode(range.endContainer, page);
    let firstIndex = lines.indexOf(startLine);
    let lastIndex = lines.indexOf(endLine);
    // Выделение вышло за пределы строк одной страницы — считать нечего,
    // ведём себя как раньше.
    if (firstIndex === -1 || lastIndex === -1 || lastIndex < firstIndex) return getSelectedLines(editorEl);

    // Крайняя строка, из которой не выделено ни символа, блоку не принадлежит.
    if (lastIndex > firstIndex && nothingBefore(lines[lastIndex], range.endContainer, range.endOffset)) lastIndex -= 1;
    if (firstIndex < lastIndex && nothingAfter(lines[firstIndex], range.startContainer, range.startOffset)) firstIndex += 1;

    // Конец режем раньше начала: иначе при выделении внутри одной строки
    // extractContents сдвинет offset'ы, на которые опирается второй разрез.
    const last = lines[lastIndex];
    if (!last.dataset.blockId) splitLineAtRangeEnd(last, range.endContainer, range.endOffset);

    const first = lines[firstIndex];
    if (!first.dataset.blockId) splitLineAtRangeStart(first, range.startContainer, range.startOffset);

    // Отрезанные куски "до"/"после" — НОВЫЕ элементы, и для пропагации они
    // выглядят как только что напечатанный текст: стоящий вплотную к чужому
    // блоку остаток он бы втянул в тот блок (ТЗ ч.1 п.15 про соседство). Но
    // пользователь этот текст как раз НЕ выделял. Объявляем остатки старыми до
    // синхронизации — внутри syncBlocks пропагация идёт РАНЬШЕ, чем known
    // пополняется, поэтому одного syncBlocks() здесь не хватает.
    blockSync.remember();
    syncBlocks();
    // Возвращаем сами элементы, а не повторный getSelectedLines(): после
    // extractContents живое выделение уже не описывает нужные строки (его
    // граница остаётся в обрезанном узле), и перечитывать его нельзя. Сами
    // элементы разрез не подменяет — отрезанные куски уезжают в НОВЫХ соседей,
    // а эти держат ровно выделенное.
    return lines.slice(firstIndex, lastIndex + 1);
  }

  /**
   * Привязывает тег к строкам lines. Если среди них уже есть блок — расширяет
   * его на всё новое выделение (сузить блок может только явный роспуск, не
   * повторная привязка тега). Если выделение зацепило сразу ДВА разных
   * существующих блока — решение принято заранее, ТЗ такой случай не
   * описывает: они сливаются в один, id берёт самый верхний блок. Новых
   * строк без блока вовсе — заводится новый id.
   */
  function attachTagToLines(lines, tag) {
    const page = lines[0].closest(".rte-page");
    const existingIds = [...new Set(lines.map((line) => line.dataset.blockId).filter(Boolean))];

    let blockId;
    let targetLines;
    let tagIds;
    if (!existingIds.length) {
      blockId = ensureBlockId();
      targetLines = lines;
      tagIds = [tag.id];
    } else {
      blockId = existingIds[0]; // порядок existingIds = порядок строк в lines, значит первый — самый верхний
      const merged = new Set(lines);
      const priorTagIds = new Set();
      existingIds.forEach((id) => {
        getBlockLines(page, id).forEach((line) => {
          merged.add(line);
          getBlockTagIds(line).forEach((tagId) => priorTagIds.add(tagId));
        });
      });
      priorTagIds.add(tag.id);
      targetLines = [...merged];
      tagIds = [...priorTagIds];
    }

    assignBlock(targetLines, blockId, tagIds);
    syncBlocks();
    recordHistory();
    onChange(serializeEditor(contentEl));
  }

  function openTagAddMenu(x, y, lines, onApplied = () => {}) {
    const items = [...tagRegistry.values()].map((tag) => ({
      label: tag.name,
      onClick: () => {
        attachTagToLines(lines, tag);
        focusActivePage();
        onApplied();
      },
    }));
    openAnchoredMenu(x, y, items);
  }

  async function openTagCreateEditor(lines, onApplied = () => {}) {
    // Генерируем id заранее — форма создания показывает его с первого кадра
    // (ТЗ п.3), а не только после сохранения.
    const id = crypto.randomUUID();
    await openBlockTagEditor({
      mode: "create",
      id,
      onSubmit: async ({ name, color }) => {
        const result = await blockTagsService.createTag({ id, name, color });
        if (result.error === "taken") return { ok: false, message: t("editor.tagNameTaken") };
        tagRegistry.set(result.tag.id, result.tag);
        attachTagToLines(lines, result.tag);
        return { ok: true };
      },
    });
    focusActivePage();
    onApplied();
  }

  // Общая точка входа для "#" на выделении и для "Add tag" внутри всплывающего
  // меню тегов блока (ТЗ п.12: "та же менюшка... та же механика").
  function openTagAddCreateMenu(x, y, lines, onApplied = () => {}) {
    openAnchoredMenu(x, y, [
      { label: t("editor.tagAdd"), onClick: () => openTagAddMenu(x, y, lines, onApplied) },
      { label: t("editor.tagCreate"), onClick: () => openTagCreateEditor(lines, onApplied) },
    ]);
  }

  // --- Всплывающее меню тегов блока: наведение/клик на полоску (ТЗ п.10-14) ---
  let blockTagsPanelEl = null;
  let unregisterBlockTagsPanelLayer = null;
  let blockTagsHoverTimer = null;
  const BLOCK_EDGE_BAND_PX = 6;
  const BLOCK_TAGS_HOVER_DELAY = 1000;

  function closeBlockTagsPanel() {
    clearTimeout(blockTagsHoverTimer);
    if (!blockTagsPanelEl) return;
    blockTagsPanelEl.remove();
    blockTagsPanelEl = null;
    document.removeEventListener("mousedown", onBlockTagsPanelOutside, true);
    if (unregisterBlockTagsPanelLayer) {
      unregisterBlockTagsPanelLayer();
      unregisterBlockTagsPanelLayer = null;
    }
  }

  function onBlockTagsPanelOutside(event) {
    // "Простым кликом на текстовое поле" (ТЗ п.13) закрывается сама собой:
    // mousedown где угодно вне панели попадает сюда, отдельной ветки под клик
    // по тексту заводить не нужно.
    if (!blockTagsPanelEl || blockTagsPanelEl.contains(event.target)) return;
    // Меню Add/Create и модалка создания тега открыты ИЗ панели и лежат поверх
    // неё — это её продолжение, а не "сторонняя область". Они висят в
    // document.body, то есть вне панели, поэтому без этой проверки первый же
    // mousedown в меню схлопывал бы панель под ним, и после Add показывать
    // добавленный тег было бы уже негде (ТЗ раунд 3 п.3).
    if (event.target instanceof Element && event.target.closest(".context-menu, .modal-overlay")) return;
    closeBlockTagsPanel();
  }

  // Полоска — псевдоэлемент строки, у неё нет своего hit-теста: строку на
  // грани блока ищем сравнением координаты курсора с getBoundingClientRect
  // каждой граничной строки листа — тот же приём, что у клика по квадратику
  // чек-листа (см. CHECKLIST_MARKER_WIDTH ниже).
  function blockEdgeLineAt(event) {
    const target = event.target instanceof Element ? event.target : null;
    const page = target ? target.closest(".rte-page") : null;
    if (!page) return null;
    for (const line of pageLines(page)) {
      if (line.dataset.blockStart === "true" && Math.abs(event.clientY - line.getBoundingClientRect().top) <= BLOCK_EDGE_BAND_PX) {
        return line;
      }
      if (line.dataset.blockEnd === "true" && Math.abs(event.clientY - line.getBoundingClientRect().bottom) <= BLOCK_EDGE_BAND_PX) {
        return line;
      }
    }
    return null;
  }

  function showBlockTagsPanel(line) {
    closeBlockTagsPanel();
    const page = line.closest(".rte-page");
    const blockId = line.dataset.blockId;
    const blockLines = getBlockLines(page, blockId);
    const topLine = blockLines.find((l) => l.dataset.blockStart === "true") || blockLines[0];
    const tagIds = getBlockTagIds(topLine);
    if (!tagIds.length) return;

    const panel = document.createElement("div");
    panel.className = "rte-block-panel";
    panel.dataset.blockId = blockId;
    // Не редактируемая и не выделяемая мышью область текста (ТЗ п.14) — тот же
    // приём, что у .rte-photo-handles, плюс mousedown-guard, как у кнопок тулбара.
    panel.contentEditable = "false";
    panel.addEventListener("mousedown", (event) => event.preventDefault());

    tagIds.forEach((tagId) => {
      const tag = tagRegistry.get(tagId);
      const row = document.createElement("button");
      row.type = "button";
      row.className = "rte-block-panel-tag";
      row.style.setProperty("--tag-color", tag ? tag.color : "transparent");
      row.textContent = tag ? tag.name : "?";
      // Клик по имени (не ПКМ) — открыть полноэкранный браузер всех блоков
      // этого тега по всем заметкам.
      row.addEventListener("click", () => {
        closeBlockTagsPanel();
        openBlockTagsBrowser([tagId]);
      });
      row.addEventListener("contextmenu", (event) => {
        event.preventDefault();
        // Без этого событие всплывает до contentEl — там свой contextmenu-
        // обработчик находит тот же blockId (panel — тоже <div>, LINE_SELECTOR
        // его пропускает) и тут же перекрывает это меню своим ("Dissolve
        // block"/режим страницы).
        event.stopPropagation();
        openBlockTagContextMenu(event.clientX, event.clientY, page, blockId, tagId);
      });
      panel.appendChild(row);
    });

    const addRow = document.createElement("button");
    addRow.type = "button";
    addRow.className = "rte-block-panel-add";
    addRow.textContent = `+ ${t("editor.tagAddItem")}`;
    addRow.addEventListener("click", () => {
      const rect = addRow.getBoundingClientRect();
      // Панель НЕ закрываем: после добавления тега она должна остаться открытой
      // и показать новый тег (ТЗ раунд 3 п.3). Своего частичного обновления у
      // панели нет — повторный showBlockTagsPanel и есть refresh, он сам
      // начинается с закрытия предыдущей.
      openTagAddCreateMenu(rect.left, rect.bottom, blockLines, () => showBlockTagsPanel(line));
    });
    panel.appendChild(addRow);

    page.appendChild(panel);
    panel.style.top = `${clamp(topLine.offsetTop, 0, Math.max(0, page.offsetHeight - panel.offsetHeight))}px`;

    document.addEventListener("mousedown", onBlockTagsPanelOutside, true);
    unregisterBlockTagsPanelLayer = pushLayer(closeBlockTagsPanel);
    blockTagsPanelEl = panel;
  }

  function openBlockTagContextMenu(x, y, page, blockId, tagId) {
    const tag = tagRegistry.get(tagId);
    openAnchoredMenu(x, y, [
      {
        label: t("editor.tagEditItem"),
        onClick: async () => {
          if (!tag) return;
          await openBlockTagEditor({
            mode: "edit",
            id: tag.id,
            name: tag.name,
            color: tag.color,
            onSubmit: async ({ name, color }) => {
              const result = await blockTagsService.updateTag(tag.id, { name, color });
              if (result.error === "taken") return { ok: false, message: t("editor.tagNameTaken") };
              tagRegistry.set(result.tag.id, result.tag);
              // Правка глобальна: реестр один, ссылки только по id — перекрашивает
              // сразу все блоки этой заметки, использующие тег, без единой правки
              // в самом content.
              syncBlocks();
              return { ok: true };
            },
          });
          closeBlockTagsPanel();
          focusActivePage();
        },
      },
      {
        label: t("editor.tagDeleteItem"),
        onClick: () => {
          const lines = getBlockLines(page, blockId);
          const remaining = getBlockTagIds(lines[0]).filter((id) => id !== tagId);
          setBlockTagIds(page, blockId, remaining); // пустой список сам распускает блок (ТЗ п.17)
          syncBlocks();
          recordHistory();
          onChange(serializeEditor(contentEl));
          closeBlockTagsPanel();
        },
      },
      {
        label: t("editor.tagAddItem"),
        onClick: () => {
          const lines = getBlockLines(page, blockId);
          closeBlockTagsPanel();
          openTagAddCreateMenu(x, y, lines);
        },
      },
    ]);
  }

  contentEl.addEventListener("mousemove", (event) => {
    const line = blockEdgeLineAt(event);
    clearTimeout(blockTagsHoverTimer);
    if (!line) return;
    if (blockTagsPanelEl && blockTagsPanelEl.dataset.blockId === line.dataset.blockId) return;
    blockTagsHoverTimer = setTimeout(() => showBlockTagsPanel(line), BLOCK_TAGS_HOVER_DELAY);
  });
  contentEl.addEventListener("mouseleave", () => clearTimeout(blockTagsHoverTimer));
  // Клик по полоске — открывает сразу, без ожидания (ТЗ п.11).
  contentEl.addEventListener("click", (event) => {
    const line = blockEdgeLineAt(event);
    if (!line) return;
    clearTimeout(blockTagsHoverTimer);
    showBlockTagsPanel(line);
  });
  // ---------------------------------------------------------------------

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

  // Новый лист сразу ЗА указанным, а не в конец, как addPage. Нужно инструменту
  // переноса: он работает со следующей страницей, и если её ещё нет, она должна
  // появиться именно здесь, а не последней. Фокус и сохранение оставляем
  // вызывающему — ему виднее, что делать с только что созданным листом.
  function insertPageAfter(page) {
    const frame = createPageFrame("");
    page.parentElement.after(frame);
    return frame.querySelector(".rte-page");
  }

  // Переносит выделенный текст на следующую страницу; нет её — создаёт. Живёт
  // только в меню по ПКМ и только в постраничном режиме: в сплошном «следующей
  // страницы» не существует (ТЗ).
  function moveSelectionToNextPage() {
    const range = getCurrentRange(contentEl);
    if (!range || range.collapsed) return;
    let node = range.startContainer;
    if (node.nodeType === Node.TEXT_NODE) node = node.parentElement;
    const page = node instanceof Element ? node.closest(".rte-page") : null;
    if (!page) return;

    // Следующий лист — соседняя рамка. У последней страницы соседом идёт кнопка
    // «добавить страницу», поэтому мало взять nextElementSibling — надо убедиться,
    // что это действительно рамка листа.
    const sibling = page.parentElement.nextElementSibling;
    const nextPage =
      sibling && sibling.classList.contains("rte-page-frame")
        ? sibling.querySelector(".rte-page")
        : insertPageAfter(page);

    const moved = range.extractContents();
    // Якорь привязывает рисунок к строке ЕГО страницы — уехав на другую, строка
    // утащила бы за собой чужую привязку. Тем же приёмом, что в splitLineAtBreaks.
    moved.querySelectorAll("[data-anchor]").forEach((el) => delete el.dataset.anchor);
    // Блок физически ограничен одной страницей: кусок, уехавший на другую,
    // становится обычным текстом, а то, что осталось на исходной странице,
    // просто пересчитает границы (см. syncBlocks в refreshPages).
    moved.querySelectorAll("[data-block-id]").forEach((el) => {
      delete el.dataset.blockId;
      delete el.dataset.tagIds;
      delete el.dataset.blockStart;
      delete el.dataset.blockEnd;
    });
    // В начало, а не в конец: текст пришёл выше по документу, и порядок чтения
    // так и сохраняется.
    nextPage.insertBefore(moved, nextPage.firstChild);

    // Выделение могло захватить кусок строки — на новом листе он оседает голым
    // текстом, которому нужна строка-обёртка. Заодно проставится dir.
    normalizeLines(contentEl);
    activePageEl = nextPage;
    refreshPages();
    onChange(serializeEditor(contentEl));
    focusActivePage();
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

    // В самом конце: рисунки и фото сдвигаются вслед за своими строками, а
    // строки к этому моменту уже на своих окончательных местах.
    syncAnchors();
    // refreshPages зовётся практически из всех мест, где меняется содержимое
    // страниц (ввод, кнопки списка, undo/redo, перенос между страницами) —
    // удобнее пересчитывать границы блоков здесь одним местом, чем на каждом
    // вызывающем месте по отдельности.
    syncBlocks();
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

  /**
   * Каретка на момент, когда правка ТОЛЬКО НАЧАЛАСЬ. Снимается в beforeinput —
   * там разметка ещё дописьменная, и смещение не сдвинуто тем, что сейчас
   * вставят. Живёт до ближайшего записанного снимка, который её и забирает.
   */
  let pendingCaretBefore = null;

  /**
   * Снимок помнит ДВА положения каретки, и это не прихоть.
   *
   * caret — где каретка оказалась, когда снимок записан (конец правки).
   * caretBefore — где она была, когда правка началась.
   *
   * Отмена возвращает содержимое ПРЕДЫДУЩЕГО снимка, и брать каретку оттуда
   * нельзя: предыдущий снимок помнит место, где работали шагом раньше, а щелчок
   * мышью между правками снимка не создаёт (наблюдатель следит за содержимым, не
   * за выделением). Отсюда и жалоба: правка на 4-й строке, Ctrl+Z — и каретка на
   * 2-й, где печатали до этого.
   *
   * Имя caret оставлено прежним намеренно: история хранится в заметке между
   * сессиями (historyStore в panelSection), и переименование обнулило бы каретку
   * во всех уже сохранённых снимках.
   */
  function recordHistory() {
    clearTimeout(historyTimer);
    const caret = getCaretOffset();
    const snapshot = { html: serializeEditor(contentEl), caret, caretBefore: pendingCaretBefore === null ? caret : pendingCaretBefore };
    if (history[historyIndex] && snapshot.html === history[historyIndex].html) return;
    // Обнуляем только когда снимок правда записан: если правка не изменила
    // разметку, начало следующей — всё ещё то самое место.
    pendingCaretBefore = null;
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

  function restoreSnapshot(entry, caretOffset) {
    isRestoring = true;
    // Прокрутка живёт на уровне окна (панель детали своего скролла не имеет).
    // Пересборка страниц схлопывает высоту и сбрасывает scroll к началу —
    // запоминаем позицию и возвращаем её после восстановления.
    const scrollX = window.scrollX;
    const scrollY = window.scrollY;
    getPages().forEach((page) => page.parentElement.remove());
    parsePages(entry.html).forEach((pageHtml) => contentEl.insertBefore(createPageFrame(pageHtml), addPageBtn));
    upgradeLegacyChecklists(contentEl);
    upgradeLegacyIndents(contentEl);
    activePageEl = getPages()[0] || null;
    // Курсор — туда, где выполнялось отменяемое (или повторяемое) действие, а не
    // в начало. Куда именно, решают undo/redo: у снимка два положения каретки.
    setCaretOffset(caretOffset === undefined ? entry.caret : caretOffset);
    onChange(entry.html);
    // Строки только что созданы заново из HTML снимка — для блочной
    // синхронизации они все "новые", и пропагация втянула бы в блок соседей
    // до самого края страницы. Разметка блоков в снимке уже верная, так что
    // объявляем всё содержимое старым ДО синхронизации внутри refreshPages.
    blockSync.remember();
    refreshPages();
    refreshToolbarState();
    // Undo/redo — тоже нажатие клавиши (Ctrl+Z/Ctrl+Y или кнопки тулбара), но
    // идёт мимо input-события contentEl, поэтому счётчик обновляем явно здесь.
    scheduleWordCountUpdate();
    window.scrollTo(scrollX, scrollY);
    isRestoring = false;
  }

  // Снимки старых заметок записаны, когда поле было одно. Для них начало правки
  // неизвестно — берём то единственное, что есть.
  function caretBeforeOf(entry) {
    return entry.caretBefore === undefined ? entry.caret : entry.caretBefore;
  }

  function undo() {
    recordHistory(); // зафиксировать несохранённый ввод перед шагом назад
    if (historyIndex <= 0) return;
    // Содержимое берём из предыдущего снимка, а каретку — из ОТМЕНЯЕМОГО: место,
    // где начиналось действие, которое мы сейчас откатываем.
    const undone = history[historyIndex];
    historyIndex--;
    restoreSnapshot(history[historyIndex], caretBeforeOf(undone));
    notifyHistoryChange();
  }

  function redo() {
    if (historyIndex >= history.length - 1) return;
    historyIndex++;
    // Повтор возвращает действие целиком, поэтому и каретка встаёт туда, где она
    // оказалась по его завершении.
    restoreSnapshot(history[historyIndex], history[historyIndex].caret);
    notifyHistoryChange();
  }
  // ---------------------------------------------------------------------

  // --- Привязка рисунков и фото к строкам --------------------------------
  // Рисунок и фото лежат поверх листа с абсолютными координатами, но
  // отсчитываются не от листа, а от строки, рядом с которой их поставили:
  // добавил абзац выше — текст уехал вниз, и объект обязан уехать вместе с ним.
  // Раньше он оставался на прежнем месте и уползал от своей строки.
  //
  // Строка-якорь помечена data-anchor="a3", объект хранит этот id и
  // data-anchor-top — offsetTop строки в момент привязки. Насколько строка с
  // тех пор сдвинулась, настолько же смещён объект. Смещение живёт в
  // inline-transform: так положение верно ещё до того, как отработает JS после
  // загрузки, и его можно прочитать обратно, когда строку-якорь удалили.
  // Всё это обычные атрибуты внутри содержимого заметки — отдельного поля в
  // модели, как и самому рисунку, не нужно.
  const ANCHOR_LINE_SELECTOR = "h1,h2,h3,p,div,ul,ol,table";
  let nextAnchorId = 1;

  // Якорем может быть любая строка листа. Маркеры выделения фото — тоже div
  // среди его прямых потомков, но это служебный слой, а не текст.
  function anchorLines(page) {
    return [...page.children].filter(
      (el) => el.matches(ANCHOR_LINE_SELECTOR) && !el.classList.contains("rte-photo-handles")
    );
  }

  function anchoredObjects(page) {
    return [
      ...page.querySelectorAll(":scope > svg.rte-drawing-layer > path"),
      ...page.querySelectorAll(':scope > img.rte-photo[data-layout="float"]'),
    ];
  }

  function ensureAnchorId(line) {
    if (line.dataset.anchor) return line.dataset.anchor;
    // id уникален в пределах заметки, а часть их пришла из сохранённой
    // разметки — проматываем счётчик мимо уже занятых.
    while (contentEl.querySelector(`[data-anchor="a${nextAnchorId}"]`)) nextAnchorId++;
    line.dataset.anchor = `a${nextAnchorId++}`;
    return line.dataset.anchor;
  }

  function anchorLineOf(page, el) {
    return el.dataset.anchor ? page.querySelector(`:scope > [data-anchor="${el.dataset.anchor}"]`) : null;
  }

  // Строка, на уровне которой оказался объект: та, в чью вертикальную полосу
  // попадает y, иначе ближайшая сверху — рисовать можно и ниже последней строки.
  function lineAt(lines, y) {
    let found = lines[0] || null;
    lines.forEach((line) => {
      if (line.offsetTop <= y) found = line;
    });
    return found;
  }

  // Сдвиг двухосевой: по вертикали объект едет за своей строкой, по горизонтали —
  // за шириной колонки (см. leftPercentOf). У штриха обе оси живут в transform,
  // у фото горизонталь держит style.left, и x здесь всегда ноль.
  // Масштаб штриха живёт в том же transform: собственного размера у ломаной нет,
  // растянуть её можно только через scale. У фото scale не бывает — там размер
  // задан явными width/height, и единица здесь означает «как есть».
  function readOffset(el) {
    const zoom = el.style.transform.match(/scale\(\s*([\d.]+)\s*\)/);
    const scale = zoom ? Number(zoom[1]) : 1;
    const both = el.style.transform.match(/translate\(\s*(-?[\d.]+)px\s*,\s*(-?[\d.]+)px\s*\)/);
    if (both) return { x: Number(both[1]), y: Number(both[2]), scale };
    // Заметки, сохранённые до перехода на проценты, несут одну координату.
    const legacy = el.style.transform.match(/translateY\(\s*(-?[\d.]+)px\s*\)/);
    return { x: 0, y: legacy ? Number(legacy[1]) : 0, scale };
  }

  // Округляем до сотых пикселя: доля ширины хранится с округлением, и обратный
  // пересчёт даёт хвост вроде -0.00381px. На вид это ничто, но оно оседало бы в
  // сохранённой разметке заметки при каждом проходе.
  function applyOffset(el, x, y, scale = 1) {
    const dx = Math.round(x * 100) / 100;
    const dy = Math.round(y * 100) / 100;
    const s = Math.round(scale * 1000) / 1000;
    const move = dx || dy ? `translate(${dx}px, ${dy}px)` : "";
    // Порядок важен: сначала сдвиг, потом масштаб — на нём построен пересчёт
    // координат в syncAnchors и обратный перевод точки в eraseAt.
    const zoom = s === 1 ? "" : `scale(${s})`;
    el.style.transform = [move, zoom].filter(Boolean).join(" ");
  }

  function bindAnchor(page, el, y) {
    const line = lineAt(anchorLines(page), y);
    if (!line) return;
    el.dataset.anchor = ensureAnchorId(line);
    el.dataset.anchorTop = String(line.offsetTop);
    applyOffset(el, 0, 0);
  }

  // Габариты объекта в координатах листа. У штриха собственных координат нет —
  // берём его габаритный прямоугольник; getBBox() не знает про transform самого
  // элемента, поэтому возвращает исходную геометрию независимо от уже наложенного
  // сдвига, и опорная точка не уползает от прохода к проходу.
  function objectBox(el) {
    if (el.tagName === "path") {
      const box = el.getBBox();
      return { x: box.x, y: box.y, width: box.width };
    }
    return {
      x: parseFloat(el.style.left) || 0,
      y: parseFloat(el.style.top) || 0,
      width: parseFloat(el.style.width) || el.naturalWidth || 0,
    };
  }

  // Ширина листа в его собственных координатах — тех же, в которых заданы left у
  // фото и точки в d у штриха. Именно offsetWidth: getBoundingClientRect() вернул
  // бы ширину уже после CSS-зума, которым постраничный режим ужимает рамку листа
  // (см. updatePageFit), а offsetWidth — исходные 794px, от которых и отсчитаны
  // координаты. Делить на зум вручную нельзя: --page-fit задан всегда, а
  // применяется только в постраничном режиме. || 1 — пока узел не в документе.
  function pageWidth(page) {
    return page.offsetWidth || 1;
  }

  // Масштаб, с которым лист реально выведен на экран. Измеряем, а не читаем
  // --page-fit: переменную JS выставляет всегда, а зумом её применяет только
  // постраничный режим (.rte-content.is-paged .rte-page-frame в editor.css). В
  // сплошном режиме на окне уже 794px деление на неё раздувало координаты, и
  // чернила ложились правее и ниже курсора. Отношение измеренной ширины к
  // offsetWidth врать не может: rect уже с зумом, offsetWidth ещё без него.
  function pageZoom(page, rect) {
    if (!page) return 1;
    const shown = (rect || page.getBoundingClientRect()).width;
    return shown && page.offsetWidth ? shown / page.offsetWidth : 1;
  }

  // Горизонталь хранится долей ширины листа, а не пикселями: колонка текста
  // меняет ширину вместе с окном (и с монитором), а объект в абсолютных пикселях
  // оставался на прежнем месте — отрывался от своей строки и вылезал за правый
  // край. Доля считается от той же опорной точки, что и рисуется: левого края.
  // Масштаб штриха умножает и его собственную координату, поэтому левый край на
  // экране — это box.x, умноженный на масштаб, плюс накопленный сдвиг. У фото
  // масштаба не бывает, и формула вырождается в прежнюю.
  function leftPercentOf(box, offset, width) {
    return ((box.x * offset.scale + offset.x) / width) * 100;
  }

  function storeLeftPercent(el) {
    const page = el.closest(".rte-page");
    if (!page) return;
    el.dataset.leftPct = leftPercentOf(objectBox(el), readOffset(el), pageWidth(page)).toFixed(3);
  }

  // Узкое окно и широкое фото: доля увела бы объект за правый край. Придерживаем
  // его у края — но только при отрисовке, сама доля остаётся нетронутой, поэтому
  // на возвращённой ширине объект встаёт ровно туда, где его оставили.
  function clampLeft(x, objectWidth, width) {
    return Math.max(0, Math.min(x, width - objectWidth));
  }

  // --- Размер долей ширины листа -----------------------------------------
  // Позиция уже считалась долей, а размер оставался абсолютным — и это ломало
  // картину с обеих сторон: на узком окне объекты съезжались, но не уменьшались и
  // налезали друг на друга, на широком — разъезжались, не подрастая, и теряли
  // связь с текстом. Доля лечит оба случая разом: взаимное расположение объектов
  // на любой ширине выглядит одинаково.
  const PHOTO_MIN_WIDTH = 150;
  const PHOTO_MAX_WIDTH = 800;
  // Рисунку абсолютные пределы не годятся: подчёркивание шириной в 30px раздулось
  // бы в полосу. Ему предел относительный — во сколько раз можно отойти от того
  // размера, каким он нарисован.
  const DRAW_MIN_SCALE = 0.5;
  const DRAW_MAX_SCALE = 2;

  // Границы раздвигаются под объект: тот, кто уже сейчас меньше 150px или больше
  // 800px, при переходе на доли не должен ни подпрыгнуть, ни ужаться — в момент
  // миграции на экране не меняется ничего. Дальше он масштабируется в своих.
  function photoWidthLimits(base) {
    return { min: Math.min(PHOTO_MIN_WIDTH, base), max: Math.max(PHOTO_MAX_WIDTH, base) };
  }

  // Доля размера пишется только по действию пользователя — вставка, ресайз,
  // законченный штрих. На изменении ширины окна её трогать нельзя: размер полз бы
  // от пересчёта к пересчёту, накапливая округления.
  function storeSizePercent(el) {
    const page = el.closest(".rte-page");
    if (!page) return;
    const width = pageWidth(page);

    if (el.tagName === "path") {
      // getBBox() отдаёт геометрию до применения transform, поэтому она и служит
      // базой: сколько штрих занимает на экране — это она, умноженная на уже
      // наложенный масштаб.
      const box = el.getBBox();
      if (!box.width) return;
      el.dataset.sizePct = (((box.width * readOffset(el).scale) / width) * 100).toFixed(3);
      return;
    }

    const shown = parseFloat(el.style.width) || el.naturalWidth;
    const height = parseFloat(el.style.height) || el.naturalHeight;
    if (!shown || !height) return; // картинка ещё не раскодирована — посчитаем позже
    el.dataset.sizePct = ((shown / width) * 100).toFixed(3);
    // База — размер, который пользователь только что выбрал сам. От неё считаются
    // раздвинутые границы, поэтому отпущенный уголок не отскакивает обратно.
    el.dataset.sizeBase = String(Math.round(shown));
    // Пропорции держим числом, а не берём из naturalWidth: в момент первого
    // пересчёта картинка может быть ещё не загружена, и высота ушла бы в NaN.
    el.dataset.ratio = (shown / height).toFixed(4);
  }

  // Размер фото из доли. Отдельным проходом и раньше всего остального: фото в
  // режиме обтекания стоит в потоке текста, и от его ширины зависит, где окажутся
  // строки — читать их offsetTop до этого бессмысленно.
  function applyPhotoSizes(page, width) {
    let migrated = false;

    page.querySelectorAll("img.rte-photo").forEach((img) => {
      let percent = Number(img.dataset.sizePct);
      let base = Number(img.dataset.sizeBase);
      let ratio = Number(img.dataset.ratio);

      if (!percent || !base || !ratio) {
        // Фото из старой заметки: доля берётся от его нынешнего размера, так что
        // на экране оно не шелохнётся — меняется только форма записи.
        storeSizePercent(img);
        percent = Number(img.dataset.sizePct);
        base = Number(img.dataset.sizeBase);
        ratio = Number(img.dataset.ratio);
        if (!percent || !base || !ratio) return;
        migrated = true;
      }

      const limits = photoWidthLimits(base);
      const shown = clamp((percent / 100) * width, limits.min, limits.max);
      img.style.width = `${Math.round(shown)}px`;
      img.style.height = `${Math.round(shown / ratio)}px`;
    });

    return migrated;
  }

  // --- Порядок наложения -------------------------------------------------
  // Кто создан позже, тот лежит выше — и рисунки, и фото в одной общей стопке.
  // Раньше порядок был побочным эффектом разметки: слой рисования появлялся на
  // странице один раз, при первом штрихе, а каждое новое фото уезжало в конец
  // страницы, — отчего фото почти всегда оказывалось поверх любых рисунков.
  //
  // Теперь у каждого объекта свой z-index, выданный при создании и больше
  // никогда не пересчитываемый: новый штрих поднимается только сам, а
  // нарисованные до него остаются под теми фото, что их перекрывали.
  // Фото в режиме обтекания лежит внутри строки, а не прямым потомком листа, и
  // в стопке не участвует (CSS игнорирует z-index у непозиционированного
  // элемента). Номер за ним всё равно числится — иначе его выдали бы кому-то
  // ещё, и при возврате фото в плавающий режим двое спорили бы за одно место.
  function stackObjects() {
    return [...contentEl.querySelectorAll("svg.rte-drawing-layer, img.rte-photo")];
  }

  // Максимум ищем по разметке, а не держим в переменной: часть объектов пришла
  // из сохранённой заметки со своими номерами (тот же приём, что в
  // ensureAnchorId), да и undo/redo восстанавливает HTML вместе с ними.
  function nextZIndex() {
    let max = 0;
    stackObjects().forEach((el) => {
      max = Math.max(max, Number(el.style.zIndex) || 0);
    });
    return max + 1;
  }

  // Заметка из старого формата: все штрихи страницы лежат в одном общем <svg>, а
  // номеров в стопке нет ни у кого. Разрезаем общий слой по штрихам на том же
  // месте в разметке и раздаём номера по порядку следования — сегодня порядок в
  // разметке и есть видимый порядок наложения, поэтому на экране ничего не
  // меняется. Возвращает true, если что-то поправили.
  function migrateStacking() {
    let changed = false;

    getPages().forEach((page) => {
      drawingLayers(page).forEach((svg) => {
        const paths = [...svg.querySelectorAll("path")];
        if (paths.length < 2) return;
        paths.forEach((path) => {
          const layer = document.createElementNS(SVG_NS, "svg");
          layer.setAttribute("class", "rte-drawing-layer");
          layer.setAttribute("contenteditable", "false");
          layer.appendChild(path);
          svg.before(layer);
        });
        svg.remove();
        changed = true;
      });

      // Прямые потомки в порядке разметки — в этом же порядке они сейчас и
      // рисуются, так что нумерация просто закрепляет нынешнюю картину.
      [...page.children].forEach((el) => {
        if (!el.matches("svg.rte-drawing-layer, img.rte-photo") || el.style.zIndex) return;
        el.style.zIndex = String(nextZIndex());
        changed = true;
      });
    });

    return changed;
  }
  // ---------------------------------------------------------------------

  // Пересчёт смещений. Вызывается из refreshPages: через неё проходит и ввод
  // текста, и смена режима страниц, и undo/redo, и первая отрисовка заметки.
  function syncAnchors() {
    // Узел ещё не в документе (createRichTextEditor вызывает refreshPages до
    // того, как panelSection вставит редактор) — offsetTop у всех строк нули, и
    // привязка вышла бы к последней строке с нулевым запомненным верхом. Считаем
    // после вставки: refreshLayout() вызывается там же, где updatePageFit.
    if (!contentEl.clientWidth) return;

    // Заметка могла быть сохранена до процентов и до номеров в стопке — тогда и
    // доли, и номера считаются здесь же из нынешнего вида, и новый формат нужно
    // закрепить в самой заметке, иначе пересчёт повторялся бы при каждом
    // открытии. Разрезание общего слоя — обязательно до обхода объектов ниже,
    // чтобы тот увидел уже разложенные по своим слоям штрихи.
    let migrated = migrateStacking();

    getPages().forEach((page) => {
      const lines = anchorLines(page);
      if (!lines.length) return;
      const width = pageWidth(page);

      // Строго до чтения offsetTop: обтекаемое фото стоит в потоке, и его новая
      // ширина меняет то, где лягут строки.
      if (applyPhotoSizes(page, width)) migrated = true;

      const byId = new Map();
      lines.forEach((line) => {
        const id = line.dataset.anchor;
        if (!id) return;
        // Enter копирует атрибуты строки вместе с ней. Две строки с одним id
        // означали бы, что обе претендуют на один якорь: дубликату id снимаем.
        if (byId.has(id)) delete line.dataset.anchor;
        else byId.set(id, line);
      });

      // Сначала считаем всё по каждому объекту, и только потом двигаем. Чтения
      // раскладки (offsetTop строки, габариты штриха) и записи стилей идут двумя
      // отдельными проходами: вперемешку браузер пересчитывал бы раскладку заново
      // на каждом объекте, а проход этот идёт на каждое нажатие клавиши.
      const moves = anchoredObjects(page).map((el) => {
        const box = objectBox(el);
        const offset = readOffset(el);

        // Верхний край объекта таким, как он сейчас на экране. У штриха масштаб
        // умножает и его собственную координату, поэтому одного накопленного
        // сдвига мало — иначе привязка к строке считалась бы от точки, в которой
        // отмасштабированного штриха давно нет.
        const shownTop = box.y * offset.scale + offset.y;

        let line = byId.get(el.dataset.anchor);
        if (!line) {
          // Якоря нет: объект либо старый (нарисован до этой правки), либо его
          // строку удалили. В обоих случаях цепляемся за строку, рядом с которой
          // объект сейчас находится, и оставляем его ровно на месте: удаление
          // строки не должно его дёргать, дальше он поедет уже с новой строкой.
          line = lineAt(lines, shownTop);
          el.dataset.anchor = ensureAnchorId(line);
          el.dataset.anchorTop = String(line.offsetTop - (shownTop - box.y));
          byId.set(el.dataset.anchor, line);
        }

        let percent = Number(el.dataset.leftPct);
        if (!Number.isFinite(percent)) {
          // Объект из старой заметки: доля берётся от его нынешнего места, так
          // что на экране он не шелохнётся — меняется только форма записи.
          percent = leftPercentOf(box, offset, width);
          el.dataset.leftPct = percent.toFixed(3);
          migrated = true;
        }

        // Масштаб нужен только штриху: размер фото уже разложен по width/height
        // отдельным проходом выше.
        let scale = 1;
        if (el.tagName === "path" && box.width) {
          let sizePct = Number(el.dataset.sizePct);
          if (!sizePct) {
            // Штрих из старой заметки: его нынешний размер и есть база, доля от
            // неё даёт масштаб ровно 1 — на экране ничего не меняется.
            sizePct = ((box.width * offset.scale) / width) * 100;
            el.dataset.sizePct = sizePct.toFixed(3);
            migrated = true;
          }
          scale = clamp(((sizePct / 100) * width) / box.width, DRAW_MIN_SCALE, DRAW_MAX_SCALE);
        }

        return { el, box, percent, scale, offsetY: line.offsetTop - (Number(el.dataset.anchorTop) || 0) };
      });

      moves.forEach(({ el, box, percent, scale, offsetY }) => {
        const left = clampLeft((percent / 100) * width, box.width * scale, width);
        // У штриха горизонталь ложится в тот же transform, что и вертикаль:
        // переписывать ломаную в d на каждое изменение ширины незачем. У фото
        // своя координата — style.left, transform несёт только вертикаль.
        if (el.tagName === "path") {
          // scale отсчитывается от точки (0,0) листа (transform-origin в CSS),
          // то есть умножает обе координаты ломаной. Сдвиг это учитывает: по
          // горизонтали возвращает левый край на нужное место, по вертикали —
          // компенсирует уезд верхнего края, чтобы штрих остался у своей строки.
          applyOffset(el, left - scale * box.x, box.y * (1 - scale) + offsetY, scale);
        } else {
          el.style.left = `${Math.round(left)}px`;
          applyOffset(el, 0, offsetY);
        }
      });
    });

    // Выделенное фото только что сменило и размер, и место, а рамка с уголками —
    // отдельный слой рядом с ним и сама за ним не идёт.
    syncHandles();

    if (migrated) onChange(serializeEditor(contentEl));
  }
  // ---------------------------------------------------------------------

  // --- Рисование поверх документа ---------------------------------------
  // Рисунок — <svg class="rte-drawing-layer"> с одним <path> внутри, лежащий
  // прямо внутри .rte-page: serializeEditor() берёт innerHTML страницы как есть,
  // поэтому рисунок сохраняется/загружается вместе с текстом без отдельного поля
  // в модели заметки, а MutationObserver истории (см. выше) подхватывает
  // добавление/удаление слоя автоматически — свой стек отмены не нужен.
  //
  // Именно по слою на штрих, а не один общий на страницу: z-index не действует
  // на детей <svg> — внутри него порядок рисования равен порядку в разметке, и
  // для внешнего мира весь слой один элемент. Пока все штрихи лежали в общем
  // <svg>, вклинить между ними фото было нельзя (см. stackObjects).
  const SVG_NS = "http://www.w3.org/2000/svg";
  let erasingActive = false;
  let drawState = null; // { pointerId, page, path } — path === null во время стирания

  function createStrokeLayer(page) {
    const svg = document.createElementNS(SVG_NS, "svg");
    svg.setAttribute("class", "rte-drawing-layer");
    // Нередактируемый остров внутри contenteditable-страницы: браузер не лезет
    // курсором внутрь и удаляет его целиком, а не по кусочкам.
    svg.setAttribute("contenteditable", "false");
    svg.style.zIndex = String(nextZIndex());
    page.appendChild(svg);
    return svg;
  }

  function drawingLayers(page) {
    return [...page.querySelectorAll(":scope > svg.rte-drawing-layer")];
  }

  // Координаты события → локальные координаты страницы. SVG без viewBox, значит
  // 1 единица = 1 CSS-пиксель немасштабированного слоя, а зум листа снимается
  // через pageZoom — в сплошном режиме он равен единице, и деление ничего не
  // меняет.
  function drawPoint(page, event) {
    const rect = page.getBoundingClientRect();
    const zoom = pageZoom(page, rect);
    return { x: (event.clientX - rect.left) / zoom, y: (event.clientY - rect.top) / zoom };
  }

  // Ластик трогает только узлы внутри слоя рисования — текст физически не
  // задет. isPointInStroke — нативная геометрия SVG, без ручного подсчёта
  // расстояния до ломаной.
  function eraseAt(page, event) {
    const { x, y } = drawPoint(page, event);
    drawingLayers(page).forEach((svg) => {
      const path = svg.querySelector("path");
      if (!path) return;
      // Штрих сдвинут вслед за своей строкой и за шириной колонки, да ещё и
      // отмасштабирован под неё, а его собственные координаты в d об этом не
      // знают — разворачиваем преобразование обратно, иначе ластик мажет мимо.
      // Порядок обратный тому, в каком transform применяется: сначала сдвиг, потом
      // масштаб (см. applyOffset).
      const offset = readOffset(path);
      // Уносим весь слой, а не один <path>: штрих в нём и так один, а пустой
      // <svg> остался бы висеть в разметке заметки. Уцелевшие штрихи лежат в
      // своих слоях и своё место в стопке сохраняют.
      const point = new DOMPoint((x - offset.x) / offset.scale, (y - offset.y) / offset.scale);
      if (path.isPointInStroke(point)) svg.remove();
    });
  }

  function setDrawing(on) {
    drawingActive = on;
    if (!drawingActive) erasingActive = false; // выключили кисть — выключаем и ластик
    contentEl.classList.toggle("is-drawing", drawingActive);
    refreshToolbarState();
  }

  function toggleDrawing() {
    setDrawing(!drawingActive);
  }

  function currentDrawWidth() {
    return getLastWidth(DRAW_WIDTH_KEY, DRAW_DEFAULT_WIDTH);
  }

  // ПКМ на кнопке рисования — толщина, цвет (та же палитра, что у текста) и
  // тумблер ластика. Каждый выбор мгновенно закрывает поповер — как и у цвета
  // текста/заливки, второй вложенный уровень здесь не нужен.
  //
  // Любой выбор здесь заодно включает сам инструмент: пришёл в поповер — значит
  // собрался рисовать, отдельно жать кнопку карандаша после этого незачем.
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
        setDrawing(true);
        closeColorPopovers();
        focusActivePage();
      });
      popover.appendChild(swatch);
    });

    // Цвета и ластик — один ряд взаимоисключающих режимов: в любой момент перо
    // либо красит конкретным цветом, либо стирает. Раньше ластик был отдельным
    // тумблером поверх цвета, и выбранный цвет молча не работал, пока ластик не
    // выключишь вручную. Поэтому здесь не тумблеры, а выбор одного из вариантов:
    // цвет гасит ластик, ластик гасит цвет — ровно так же, как цвета
    // переключаются между собой.
    const currentColor = getLastColor(def.storageKey, def.defaultColor);
    TEXT_COLORS.forEach((color) => {
      const swatch = document.createElement("button");
      swatch.type = "button";
      swatch.className = "rte-color-swatch";
      swatch.style.background = color;
      swatch.classList.toggle("is-active", !erasingActive && color === currentColor);
      swatch.addEventListener("mousedown", (event) => event.preventDefault());
      swatch.addEventListener("click", (event) => {
        event.stopPropagation();
        setLastColor(def.storageKey, color);
        updateSwatch(btn, def);
        erasingActive = false;
        setDrawing(true);
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
      erasingActive = true;
      setDrawing(true);
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

    const svg = createStrokeLayer(page);
    const path = document.createElementNS(SVG_NS, "path");
    path.setAttribute("fill", "none");
    path.setAttribute("stroke", getLastColor(DRAW_COLOR_KEY, DRAW_DEFAULT_COLOR));
    path.setAttribute("stroke-width", String(currentDrawWidth()));
    path.setAttribute("stroke-linecap", "round");
    path.setAttribute("stroke-linejoin", "round");
    const start = drawPoint(page, event);
    path.setAttribute("d", `M${start.x} ${start.y}`);
    svg.appendChild(path);
    // Штрих принадлежит той строке, на уровне которой начат: дальше он поедет
    // вместе с ней. Координаты в d остаются координатами листа, сдвиг живёт
    // отдельно — переписывать ломаную на каждую правку текста незачем.
    bindAnchor(page, path, start.y);
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
    // Доли ширины записываем только сейчас: на pointerdown у штриха ещё нет
    // габаритов, от которых считаются и левый край, и размер.
    if (drawState.path) {
      storeLeftPercent(drawState.path);
      storeSizePercent(drawState.path);
    }
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
    const imgRect = img.getBoundingClientRect();
    const pageRect = page.getBoundingClientRect();
    const zoom = pageZoom(page, pageRect);
    img.dataset.layout = "float";
    img.style.left = `${Math.round((imgRect.left - pageRect.left) / zoom)}px`;
    img.style.top = `${Math.round((imgRect.top - pageRect.top) / zoom)}px`;
    // Место в стопке — только при первом появлении. Дальше оно принадлежит фото
    // навсегда: и при возврате из обтекания, и после undo (номер едет в HTML).
    if (!img.style.zIndex) img.style.zIndex = String(nextZIndex());
    // Плавающее фото переезжает прямым потомком листа. Вставлено оно в каретку,
    // то есть внутрь строки, и вместе с этой строкой удалилось бы навсегда — а
    // привязка к строке должна уметь пережить её удаление. На вид ничего не
    // меняется: position:absolute и так вынул фото из потока, а
    // позиционирующим предком у него в обоих случаях лист.
    page.appendChild(img);
    rebindPhoto(img);
  }

  // После вставки, перетаскивания или ресайза фото стоит на новом месте:
  // привязываем его к строке, рядом с которой оно теперь, и вписываем
  // накопленный сдвиг в top — сдвиг снова ноль, а фото не шелохнулось.
  // Заодно это единственная точка фиксации новой горизонтали: во время самого
  // жеста left пишется пикселями, доля считается по его завершении.
  function rebindPhoto(img) {
    const page = img.closest(".rte-page");
    if (!page) return;
    const top = (parseFloat(img.style.top) || 0) + readOffset(img).y;
    img.style.top = `${Math.round(top)}px`;
    bindAnchor(page, img, top);
    storeLeftPercent(img);
    storeSizePercent(img);
  }

  function syncHandles() {
    if (!selectedPhoto || !handlesEl) return;
    const page = selectedPhoto.closest(".rte-page");
    if (!page) return; // фото уже вырезали из документа, а рамка ещё не снята
    const imgRect = selectedPhoto.getBoundingClientRect();
    const pageRect = page.getBoundingClientRect();
    const zoom = pageZoom(page, pageRect);
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
    const zoom = pageZoom(dragPhotoState.img.closest(".rte-page"));
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
    const img = dragPhotoState.img;
    dragPhotoState = null;
    if (!moved) return; // просто клик выделения — снимок истории не нужен
    rebindPhoto(img); // фото у другой строки — и ехать дальше должно с ней
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
    const zoom = pageZoom(img.closest(".rte-page"));
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
    const img = resizePhotoState.img;
    resizePhotoState = null;
    // Доля размера фиксируется по завершении жеста — как и доля горизонтали. Во
    // время самого перетаскивания размер пиксельный и ничем не ограничен: его
    // задаёт пользователь, подрезать его границами нельзя. Новая база пишется
    // тут же, поэтому отпущенный уголок не отскакивает назад.
    if (img.dataset.layout === "float") rebindPhoto(img);
    else storeSizePercent(img); // в обтекании rebindPhoto не зовём — там нет координат
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
      { label: t("editor.photoDelete"), onClick: () => deletePhoto(img) },
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
    // Единственное место, где размер меняется мимо rebindPhoto, — доля и новая
    // база пишутся здесь же.
    storeSizePercent(img);
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
      // Обтекание текстом — фото возвращается в поток, и именно в свою
      // строку-якорь: прямым потомком листа (куда его положил float) оно
      // оказалось бы в самом конце текста, а не там, где стояло.
      const line = anchorLineOf(img.closest(".rte-page"), img);
      if (line) line.appendChild(img);
      img.dataset.layout = "flow";
      img.style.left = "";
      img.style.top = "";
      applyOffset(img, 0, 0);
      delete img.dataset.anchor;
      delete img.dataset.anchorTop;
      // В обтекании горизонталь держит CSS float — доля ширины здесь ничего не
      // значит и при возврате в float будет посчитана заново.
      delete img.dataset.leftPct;
    }
    syncHandles();
    recordHistory();
    onChange(serializeEditor(contentEl));
  }

  // Снимаем маркеры выделения перед удалением — иначе они останутся висеть
  // рядом с уже вырезанным из DOM фото. childList-мутация .remove() сама
  // попадёт в историю через MutationObserver (см. комментарий у removePage),
  // но recordHistory() здесь вызываем сразу же, не дожидаясь дебаунса — так
  // удаление можно немедленно отменить по Ctrl+Z.
  function deletePhoto(img) {
    deselectPhoto();
    img.remove();
    recordHistory();
    onChange(serializeEditor(contentEl));
    refreshPages();
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
    if (def.isDirection) {
      // Обе стрелки живут в кнопке всегда, а горит та, в которую идёт строка под
      // кареткой. Значит подпись — два отдельных узла: покрасить половину одного
      // символа нельзя. Саму подсветку двигает общий механизм подсветки кнопок.
      const ltr = document.createElement("span");
      ltr.className = "rte-dir-arrow rte-dir-ltr";
      ltr.textContent = "→";
      const rtl = document.createElement("span");
      rtl.className = "rte-dir-arrow rte-dir-rtl";
      rtl.textContent = "←";
      btn.append(ltr, rtl);
    } else if (def.labelClass) {
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
    } else if (def.isMoveToNextPage) {
      btn.addEventListener("click", () => {
        // Внутри всё своё: и сохранение, и пересчёт страниц, и фокус — перенос
        // меняет разметку сильнее обычной команды форматирования.
        moveSelectionToNextPage();
        onApplied();
      });
    } else if (def.isDirection) {
      btn.addEventListener("click", () => {
        if (!toggleTextDirection(contentEl)) return; // каретки в тексте нет — переключать нечего
        focusActivePage();
        onChange(serializeEditor(contentEl));
        refreshToolbarState();
        onApplied();
      });
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
                const picked = await openLinkPicker();
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
          const picked = await openLinkPicker();
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
    } else if (def.isTag) {
      // Строки берём сейчас — к моменту клика в Add/Create фокус уйдёт из
      // редактора, и выделение схлопнется.
      btn.addEventListener("click", () => {
        const lines = splitSelectionIntoLines(contentEl);
        if (!lines.length) return;
        const rect = btn.getBoundingClientRect();
        openTagAddCreateMenu(rect.left, rect.bottom, lines, onApplied);
      });
    } else {
      btn.addEventListener("click", async () => {
        // await — командой может быть insertTable, которая асинхронно спрашивает
        // размер через модалку; для обычных execCommand-команд просто no-op.
        await def.command(contentEl);
        // Кнопки списка — главный источник слипшихся строк, но правим разметку
        // после любой команды: проход дешёвый, а на ровной разметке он ничего не
        // делает. Каретку снимаем заранее — перенос узлов сбивает выделение.
        //
        // Снимков два, и это не перестраховка. Узловой (saveCaret) точен, пока
        // узел под кареткой жив: normalizeLines строки не пересобирает, а
        // перекладывает, поэтому обычно так и есть. Но splitLineAtBreaks режет
        // строку по переносам, и узел может уехать в новую половину — тогда
        // остаётся символьное смещение. Само оно ненадёжно: на пустой строке
        // текстового узла нет, и позиция там неотличима от конца предыдущей
        // строки — ровно из-за этого каретка и уезжала выше (см. saveCaret).
        const caretNode = saveCaret();
        const caretOffset = getCaretOffset();
        if (normalizeLines(contentEl)) {
          if (caretNode && caretNode.node.isConnected) restoreCaret(caretNode);
          else setCaretOffset(caretOffset);
        }
        // Эта ветка не проходит через refreshPages (списки/выравнивание границы
        // страниц не трогают) — границы блоков пересчитываем отдельно, вдруг
        // команда что-то слила или разделила прямо на границе блока.
        syncBlocks();
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
    if (!btn) return;
    // Кнопки вне basicButtons — расширенный набор, скрытый до разворота
    // тулбара (см. createToolbarExpandToggle и .rte-toolbar в editor.css).
    if (basicButtons && !basicButtons.includes(key)) btn.dataset.toolbarExtra = "true";
    toolbarEl.appendChild(btn);
  });

  // Счётчик слов/символов — только для Notes (showWordCount передаётся
  // вызывающим кодом на основе config.section, как и allowInternalLinks).
  let wordCountEl = null;
  let wordCountFrame = null;
  if (showWordCount) {
    wordCountEl = document.createElement("span");
    wordCountEl.className = "rte-word-count";
    toolbarEl.appendChild(wordCountEl);
    updateWordCount();
  }

  // Кнопка-переключатель полного набора инструментов — только если вызывающий
  // код различает базовый и расширенный список (см. notesView.js).
  if (basicButtons) toolbarEl.appendChild(createToolbarExpandToggle(toolbarEl, collapseToggle));

  // Считаем только по страницам (getPages()), а не contentEl.textContent
  // целиком — иначе в счёт попала бы ещё и подпись служебной кнопки
  // "＋ Add page", которая лежит в contentEl рядом со страницами.
  function updateWordCount() {
    const text = getPages()
      .map((page) => page.textContent)
      .join(" ")
      .trim();
    const words = text ? text.split(/\s+/).length : 0;
    wordCountEl.textContent = `${t("editor.words")}: ${words} · ${t("editor.characters")}: ${text.length}`;
  }

  // requestAnimationFrame схлопывает несколько input-событий одного кадра
  // (быстрый ввод, автозамена, вставка текста) в один пересчёт — обновление
  // всё равно происходит в пределах кадра, визуально мгновенно.
  function scheduleWordCountUpdate() {
    if (!wordCountEl || wordCountFrame) return;
    wordCountFrame = requestAnimationFrame(() => {
      wordCountFrame = null;
      updateWordCount();
    });
  }

  /**
   * Стёртая до конца строка не должна тащить за собой невидимое форматирование.
   * Заливка, цвет, U/S переезжают на новую строку по Enter и ждут там пустыми
   * тегами. Пока в такой строке ничего не набрано, кнопка тег снимает; но стоит
   * напечатать букву и стереть — каретка оказывается уже вне опустевшего тега,
   * снимать кнопке нечего, и она включает формат заново. Печать при этом всё
   * равно шла оформленной: Chrome помнит стиль сам, помимо разметки.
   *
   * Опустела — значит чистая: сносим остатки и ставим каретку заново.
   */
  function clearEmptiedBlock() {
    const selection = window.getSelection();
    const block = selection.rangeCount ? getCaretBlock(contentEl) : null;
    if (!block || !isLineEmpty(block)) return;
    // Прибранную строку узнаём по каретке в пустом текстовом узле: строку Chrome
    // обычно чистит и сам, а вот стиль ввода в ней держит до сих пор.
    const caret = selection.getRangeAt(0).startContainer;
    if (isBareLine(block) && block.contains(caret) && caret.nodeType === Node.TEXT_NODE && !caret.textContent) return;

    // Каретку принимает пустой текстовый узел, а не сама строка: стоя на позиции
    // внутри элемента, Chrome свой стиль ввода не пересчитывает — от разметки уже
    // ничего не осталось, а печать всё равно шла бы оформленной.
    const caretHost = document.createTextNode("");
    block.replaceChildren(caretHost, document.createElement("br"));
    placeCaretAfter(caretHost, 0);
  }

  // Цвет и заливка, снятые перед разрывом строки. Одноразовое значение, как
  // pendingMatch у панели: применили на новой строке — обнулили.
  let pendingLineColors = null;

  // Снимаем ДО разрыва, а не после. К моменту input новая строка уже создана, и
  // разметку, которую Chrome на неё скопировал, тут же сносит clearEmptiedBlock —
  // спрашивать было бы уже не у кого. Здесь же каретка ещё стоит в старой строке,
  // где оформление на месте.
  contentEl.addEventListener("beforeinput", (event) => {
    // Начало правки для истории — на первое событие серии: дальше символы уже
    // сдвинут смещение, а нужна точка, с которой правка стартовала. Забирает его
    // ближайший записанный снимок (см. recordHistory).
    if (pendingCaretBefore === null) pendingCaretBefore = getCaretOffset();

    if (event.inputType !== "insertParagraph") return;
    const selection = window.getSelection();
    pendingLineColors = selection.rangeCount ? caretColors(contentEl, selection.getRangeAt(0).startContainer) : null;
  });

  /**
   * Возвращает на новую пустую строку цвет и заливку, которыми печатали до Enter:
   * clearEmptiedBlock только что снёс с неё всю разметку вместе с ними, и печать
   * продолжилась бы обычным текстом.
   *
   * Пустой span с якорем внутри — тот же приём, что у enterInlineFormat и
   * toggleColorAtCaret: каретка внутри тега, дальнейший ввод сразу оформляется.
   * stripEditingLeftovers такую обёртку намеренно оставляет при сохранении.
   *
   * Строку с текстом не трогаем: там разметку перенёс сам Chrome и она цела —
   * работаем только по пустой, то есть ровно по той, которую зачистили.
   */
  function restoreLineColors() {
    const colors = pendingLineColors;
    pendingLineColors = null;
    if (!colors || (!colors.color && !colors.background)) return;
    const block = getCaretBlock(contentEl);
    if (!block || !isLineEmpty(block)) return;

    const wrapper = document.createElement("span");
    if (colors.color) wrapper.style.color = colors.color;
    if (colors.background) wrapper.style.backgroundColor = colors.background;
    wrapper.appendChild(document.createTextNode(CARET_ANCHOR));
    block.replaceChildren(wrapper, document.createElement("br"));
    placeCaretAfter(wrapper.firstChild, wrapper.firstChild.length);
  }

  contentEl.addEventListener("input", (event) => {
    // Чистим до пересчёта, чтобы в заметку ушла уже прибранная разметка.
    if (event.inputType && event.inputType.startsWith("delete")) {
      clearEmptiedBlock();
      // Удалили строку между двумя списками одного вида — списки стали соседями
      // вплотную, а значит одним списком. Только на удалении: пока разделитель
      // на месте, склеивать нечего (см. mergeAdjacentLists).
      if (mergeAdjacentLists(contentEl)) recordHistory();
    }
    // Выход из списка по Enter — та же чистка, что и после удаления. Отметка
    // «выполнено» рисуется CSS (line-through и серый цвет на li.is-done), а
    // Chrome переносит на новую строку не разметку, а ВИД: строка после
    // отмеченного пункта получала <font><strike> и печаталась зачёркнутой.
    // Строка с текстом сюда не попадает — clearEmptiedBlock трогает только
    // пустые.
    if (event.inputType === "insertParagraph") {
      clearEmptiedBlock();
      // И новый пункт to-do не рождается выполненным: сам класс отметки Chrome
      // тоже копирует вместе со строкой (см. clearDoneOnEmptyItems).
      clearDoneOnEmptyItems(contentEl);
      // Строго после зачистки: она сносит со строки всё подряд, а цвет с заливкой
      // пережить Enter обязаны — иначе продолжать писать тем же цветом нельзя.
      restoreLineColors();
    }
    // Строки, которых не было при открытии: вставка из буфера и всё, что создал
    // сам браузер. Новую строку по Enter Chrome клонирует вместе с атрибутами,
    // так что dir у неё наследуется и без нас — а вот вставленному тексту его
    // проставить некому. Функция только дописывает недостающий атрибут, разметку
    // и каретку не трогает, поэтому на вводе она безопасна.
    applyLineDirection(contentEl);
    // Сначала пересчёт, потом сохранение: syncAnchors внутри refreshPages
    // двигает рисунки и фото вслед за строками, и в заметку должно попасть уже
    // новое положение, а не то, что было до правки.
    refreshPages();
    onChange(serializeEditor(contentEl));
    scheduleWordCountUpdate();
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
    const selectionButtons = ["bold", "underline", "strikethrough", "textColor", "highlight", "link", "tag"];
    if (allowInternalLinks) selectionButtons.push("internalLink");
    // Перенос на следующую страницу — только здесь и только в постраничном режиме.
    // В toolbarButtons/basicToolbarButtons этот ключ не значится вовсе, поэтому в
    // верхнем и плавающем тулбаре инструмента нет ни при каких настройках (ТЗ).
    if (currentPageMode === "paged") selectionButtons.push("moveToNextPage");
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
    // Роспуск блока — ПКМ на пустом месте внутри его границ (выделение уже
    // отфильтровано веткой showSelectionToolbar выше, значит сюда попадает
    // именно "пустое место", ТЗ п.16). Строку под курсором ищем так же, как
    // getCaretLine, но от event.target, а не от текущего выделения — при ПКМ
    // без выделения каретка могла остаться совсем в другом месте.
    if (page) {
      let line = event.target instanceof Element ? event.target : null;
      while (line && line.parentElement !== page) line = line.parentElement;
      const blockId = line && line.matches(LINE_SELECTOR) ? line.dataset.blockId : null;
      if (blockId) {
        items.push({
          label: t("editor.tagDissolve"),
          onClick: async () => {
            const ok = await openConfirm({ message: t("editor.tagDissolveConfirm") });
            if (!ok) return;
            setBlockTagIds(page, blockId, []);
            syncBlocks();
            recordHistory();
            onChange(serializeEditor(contentEl));
          },
        });
      }
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
    // Квадратик стоит в НАЧАЛЕ пункта, а начало зависит от направления: в
    // ивритском пункте оно справа. Меряем с той же стороны, с которой его рисует
    // inset-inline-start, иначе клик по квадратику в RTL уходил бы в текст, а
    // клик по концу строки — переключал бы «выполнено».
    const box = li.getBoundingClientRect();
    const fromStart =
      getComputedStyle(li).direction === "rtl" ? box.right - event.clientX : event.clientX - box.left;
    if (fromStart > CHECKLIST_MARKER_WIDTH) return;
    li.classList.toggle("is-done");
    onChange(serializeEditor(contentEl));
  });

  // Переход по внешней ссылке — в новой вкладке, не задевая текущую (заметка
  // не должна закрываться/перелистываться при уходе по ссылке). Открыть сразу
  // МОЖНО только одну: браузер разрешает не более одной новой вкладки на
  // клик (лимит на "user activation", общий для window.open и настоящих
  // ссылок — не обходится никаким приёмом). Поэтому при нескольких ссылках
  // клик показывает тот же поповер, что и наведение, — конкретную ссылку
  // открывает уже отдельный клик по её строке.
  contentEl.addEventListener("click", (event) => {
    const link = event.target instanceof Element ? event.target.closest('a.rte-link[data-link-type="external"]') : null;
    if (!link) return;
    event.preventDefault();
    const links = JSON.parse(link.dataset.links || "[]");
    if (!links.length) return;
    if (links.length === 1) openExternalLink(links[0]);
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
    if (navigate) navigate("notes");
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
    // Не сразу: между словом и поповером есть зазор — мгновенное скрытие тут
    // же убирало поповер, пока курсор ещё едет к нему (schedule отменяется,
    // если он всё же доехал, см. showLinkPreview).
    scheduleHideLinkPreview();
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
    const lines = getSelectedLines(contentEl);
    if (!lines.length) {
      // Каретка внутри списка: отступ здесь — вложенность пункта, а не поле
      // слева. Раньше тут стоял execCommand("indent"/"outdent"), но он двигал
      // список целиком: Tab на одной строке уводил вправо и всех её соседей.
      const items = getSelectedListItems(contentEl);
      if (!items.length) return;
      // Перенос узлов сбивает выделение — снимаем позицию каретки заранее.
      // Снимок именно узловой (saveCaret), а не символьный: пункт переезжает
      // целиком, поэтому узел под кареткой остаётся тем же самым. Символьное
      // смещение здесь врало на пустом пункте — текстового узла в нём нет,
      // счёт до каретки не доходил, и она возвращалась строкой выше.
      const caret = saveCaret();
      let moved = false;
      items.forEach((li) => {
        if (event.shiftKey ? outdentListItem(li) : indentListItem(li)) moved = true;
      });
      if (!moved) return; // первый пункт списка сдвигать некуда
      restoreCaret(caret);
      // Ctrl+Z: MutationObserver истории ловит childList, но снимок пишется с
      // задержкой — фиксируем сразу, как и в ветке обычных строк.
      recordHistory();
    } else {
      const step = event.shiftKey ? -1 : 1;
      lines.forEach((line) => setIndentLevel(line, getIndentLevel(line) + step));
      // Отступ — это атрибут строки, а MutationObserver истории слушает только
      // childList/characterData: без явного снимка Ctrl+Z не отменил бы Tab.
      recordHistory();
    }
    onChange(serializeEditor(contentEl));
  });

  /**
   * Enter на ПУСТОМ вложенном пункте — выход ровно на один уровень, как
   * Shift+Tab, и только для этой строки.
   *
   * Пустой пункт для браузера значит «список кончился», и закрыть его он
   * пытается честно, но грубо: вынимает весь подсписок из его <li> и кладёт
   * прямо во внешний <ul>. Такой вложенности в разметке не бывает (внутри
   * списка живут только <li>), и соседний пункт, которого никто не трогал,
   * теряет отступ вместе с уехавшей обёрткой — замер: пункт съезжал влево на
   * 22px, ширину поля своего бывшего родителя.
   *
   * Верхний уровень оставляем браузеру: там выход из списка он делает верно —
   * пункт становится обычной строкой, а список при этом делится надвое.
   */
  contentEl.addEventListener("keydown", (event) => {
    if (event.key !== "Enter" || event.shiftKey) return;
    const selection = window.getSelection();
    if (!selection.rangeCount || !selection.getRangeAt(0).collapsed) return;
    const li = getCaretBlock(contentEl);
    if (!li || li.tagName !== "LI" || !isLineEmpty(li)) return;

    // Каретку снимаем узлом: пункт переезжает целиком, а символьного смещения
    // в пустой строке не существует (см. saveCaret).
    const caret = saveCaret();
    if (!outdentListItem(li)) return; // уже верхний уровень — не наше дело
    event.preventDefault();
    restoreCaret(caret);
    // Перенос узлов идёт мимо MutationObserver истории не полностью, но снимок
    // пишется с задержкой — фиксируем сразу, как в обработчике Tab.
    recordHistory();
    onChange(serializeEditor(contentEl));
  });

  // Backspace на пустой строке с отступом снимает сначала отступ и только
  // следующим нажатием удаляет саму строку. Иначе поставленный Tab снять было
  // нечем: строка с отступом тянула его за собой и на все новые строки после
  // Enter. Во всех прочих случаях молчим — буквы, слияние строк и удаление
  // выделения делает браузер.
  contentEl.addEventListener("keydown", (event) => {
    if (event.key !== "Backspace") return;
    const selection = window.getSelection();
    if (!selection.rangeCount || !selection.getRangeAt(0).collapsed) return;
    const line = getCaretLine(contentEl);
    if (!line || !isLineEmpty(line) || getIndentLevel(line) === 0) return;
    event.preventDefault();
    setIndentLevel(line, getIndentLevel(line) - 1);
    // Смена атрибута мимо MutationObserver истории (он слушает только
    // childList/characterData) — снимок пишем явно, как при перетаскивании фото.
    recordHistory();
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

  // Редактор стал шире или уже — окно, сворачивание боковых панелей, зум. Текст
  // перетекает по-новому, и всё, что считается от раскладки, устаревает:
  // масштаб листа и сдвиги рисунков с фото относительно их строк.
  //
  // ResizeObserver, а не слушатель на window: он живёт ровно столько же, сколько
  // сам редактор, и умирает вместе с ним. Своей точки уничтожения у редактора
  // нет — window-слушатель копился бы с каждой перерисовкой раздела. Заодно
  // ловит и то, чего window не видит: смену ширины от сворачивания панелей.
  let lastObservedWidth = 0;
  new ResizeObserver(() => {
    // Только ширина. Высоту меняет сам refreshPages (обводка переполнения,
    // крестик удаления пустой страницы) — реакция на неё зациклила бы
    // наблюдателя. Перетекает текст всё равно от ширины.
    const width = contentEl.clientWidth;
    if (width === lastObservedWidth) return;
    lastObservedWidth = width;
    refreshPages();
  }).observe(contentEl);

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
    // Переход по блоку (из полноэкранного браузера тегов) — по id, не по тексту.
    highlightBlock: (blockId) => highlightBlock(contentEl, blockId),
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

/**
 * Подсвечивает occurrence-е вхождение query в тексте заметки и прокручивает к
 * нему. Текст заметки при этом НЕ меняется: диапазон красит CSS Custom Highlight
 * API, который рисует поверх, ничего не вставляя в DOM. Иначе подсветка попала
 * бы в contenteditable, а оттуда — в сохранённый HTML.
 */
function highlightMatch(contentEl, query, occurrence = 0, photoIndex) {
  clearSearchHighlight();
  // Фото — не текстовый узел, occurrenceRange его не найдёт, нужен отдельный
  // путь. photoIndex может быть 0, поэтому проверка именно на undefined/null,
  // а не на falsy.
  if (photoIndex !== undefined && photoIndex !== null) {
    // Тот же порядок img.rte-photo в документе, что и при индексации поиска
    // (см. extractPhotos в utils/dom.js) — не завязан на data-name, поэтому
    // находит и фото без названия.
    const img = contentEl.querySelectorAll("img.rte-photo")[photoIndex];
    if (img) showPhotoHighlight(img);
    return;
  }
  const range = findOccurrenceRange(contentEl, query, occurrence);
  if (!range) return;

  const target = range.startContainer.parentElement;
  if (target) target.scrollIntoView({ block: "center", behavior: "smooth" });
  showSearchHighlight(range);
}

/**
 * Переход по блоку (из полноэкранного браузера тегов) — в отличие от
 * highlightMatch, ищет не текст, а конкретный data-block-id: надёжнее текстового
 * совпадения (тексту ничего не мешает повториться в заметке дважды) и не требует
 * подбирать query/occurrence. Блок не пересекает страницы (гарантировано
 * геометрией в blockTags.js), поэтому первая страница, где getBlockLines вернул
 * непустой массив, и есть искомая — дальше можно не смотреть.
 */
function highlightBlock(contentEl, blockId) {
  clearSearchHighlight();
  let lines = [];
  for (const page of contentEl.querySelectorAll(".rte-page")) {
    lines = getBlockLines(page, blockId);
    if (lines.length) break;
  }
  if (!lines.length) return;

  lines[0].scrollIntoView({ block: "center", behavior: "smooth" });

  const range = document.createRange();
  range.setStart(lines[0], 0);
  const last = lines[lines.length - 1];
  range.setEnd(last, last.childNodes.length);
  showSearchHighlight(range);
}

/**
 * Вхождение в тексте заметки. Склейка страниц идёт БЕЗ разделителя — так же
 * собран поисковый индекс заметки (htmlToText в utils/dom.js), поэтому
 * порядковые номера вхождений совпадают с теми, что показал список результатов.
 */
function findOccurrenceRange(contentEl, query, occurrence) {
  return occurrenceRange([...contentEl.querySelectorAll(".rte-page")], query, occurrence, "");
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

/**
 * Снимок каретки узлом и смещением в нём — для правок, которые ПЕРЕНОСЯТ узлы
 * целиком (вложенность пункта, обёртка строки в список). Узел переезд переживает,
 * поэтому каретка возвращается ровно туда, где стояла.
 *
 * Плоский объект, а не Range: живой диапазон по спецификации DOM выталкивается
 * на позицию родителя, как только его узел вынули из этого родителя, — именно
 * поэтому перестановка пунктов и сбивает выделение.
 *
 * И тем более не символьное смещение (getCaretOffset): в пустой строке нет
 * текстового узла вовсе, каретка стоит на самом <li>, и в символах её позиция
 * неотличима от конца предыдущей строки. Из-за этого Tab на пустом пункте
 * уводил каретку строкой выше.
 */
function saveCaret() {
  const selection = window.getSelection();
  if (!selection.rangeCount) return null;
  const range = selection.getRangeAt(0);
  return { node: range.startContainer, offset: range.startOffset };
}

function restoreCaret(saved) {
  if (!saved || !saved.node.isConnected) return;
  const range = document.createRange();
  // Смещение упираем в текущий размер узла: сам узел переезд переживает, а вот
  // его содержимое между снимком и возвратом измениться могло.
  const limit = saved.node.nodeType === Node.TEXT_NODE ? saved.node.textContent.length : saved.node.childNodes.length;
  range.setStart(saved.node, Math.min(saved.offset, limit));
  range.collapse(true);
  restoreRange(range);
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

// Открывает внешнюю ссылку в фоновой вкладке — как настоящий Ctrl+клик по
// ссылке в браузере: не переключает фокус на неё и не отбирает экран у
// текущей вкладки. Через реальный <a href target="_blank"> + click(), а не
// window.open() — второй и последующие window.open() в одном клик-обработчике
// браузеры блокируют как попап (Firefox/Chrome), а клик по обычной ссылке под
// это ограничение не попадает. Собственного флага «открыть в фоне» у
// window.open() нет — это единственный кросс-браузерный способ.
function openExternalLink(url) {
  const link = document.createElement("a");
  link.href = url;
  link.target = "_blank";
  link.rel = "noopener";
  document.body.appendChild(link);
  link.click();
  link.remove();
}

// Компактный поповер со списком ссылок — по наведению на внешнюю ссылку;
// если их несколько, каждая строка кликабельна отдельно. Стиль — тот же
// скруглённый "язык", что у результатов поиска (.search-results в
// styles/search.css).
let linkPreviewEl = null;
let unregisterLinkPreviewLayer = null;
let linkPreviewHideTimer = null;

// Между словом и поповером есть зазор (позиционируем чуть ниже ссылки, см.
// ниже) — мгновенное скрытие по mouseout из contentEl срабатывало прямо в
// этом зазоре, до того как курсор успевал доехать до поповера. Отсрочка даёт
// этот запас; cancelHideLinkPreview снимает её, если курсор всё же попал на
// ссылку или сам поповер.
const LINK_PREVIEW_HIDE_DELAY = 200;

function scheduleHideLinkPreview() {
  clearTimeout(linkPreviewHideTimer);
  linkPreviewHideTimer = setTimeout(hideLinkPreview, LINK_PREVIEW_HIDE_DELAY);
}

function cancelHideLinkPreview() {
  clearTimeout(linkPreviewHideTimer);
}

function hideLinkPreview() {
  clearTimeout(linkPreviewHideTimer);
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
      row.addEventListener("click", () => {
        openExternalLink(url);
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

  // Курсор доехал до поповера (в т.ч. через зазор) — отменяем отложенное
  // скрытие, запланированное mouseout на contentEl.
  popover.addEventListener("mouseenter", cancelHideLinkPreview);

  // Курсор мог уйти со ссылки прямо на поповер (это два разных элемента) —
  // закрываем, только когда он покинул и поповер, и саму ссылку.
  popover.addEventListener("mouseleave", (event) => {
    const to = event.relatedTarget;
    if (to && to.closest && to.closest('a.rte-link[data-link-type="external"]') === anchorEl) return;
    scheduleHideLinkPreview();
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

// Вид списка под кареткой — им подсвечиваются кнопки тулбара. Раньше подсветку
// давал queryCommandState("insertUnorderedList"), а он не различает вид: внутри
// чек-листа загорались обе кнопки, и «точка» выглядела включённой.
function currentListKind(editorEl) {
  return listKind(getCurrentList(editorEl));
}

// --- Списки ---------------------------------------------------------------
// Три вида списка живут в разметке, а не в отдельном поле: «точка» — голый <ul>,
// нумерованный — <ol>, to-do — <ul class="checklist"> (квадратик рисует CSS-маркер
// ::before на <li>, а не узел в тексте: любой узел внутри contenteditable браузер
// копирует при Enter и таскает вокруг него каретку, из-за чего текст оказывался
// перед галочкой).
//
// Всё, что ниже, написано вместо document.execCommand("insertUnorderedList").
// Причина та же, по которой отступ строки уехал на data-indent (см. LINE_SELECTOR):
// команда браузера сама решает, к какому списку рядом присоединиться, и «рядом»
// для неё — предыдущая ВИДИМАЯ позиция, а не предыдущий сосед по разметке. Пустые
// строки-разделители она перешагивает, а вид списка не различает вовсе — новый
// пункт попадал в чужой <ul> и получал чужие квадратики.
const LIST_KINDS = {
  bullet: { tag: "UL", checklist: false },
  ordered: { tag: "OL", checklist: false },
  checklist: { tag: "UL", checklist: true },
};

// Вид списка — по разметке. Чек-лист узнаём через closest, а не по собственному
// классу: вложенный <ul> внутри чек-листа рисуется квадратиками по CSS
// (ul.checklist ul в editor.css), значит и считаться обязан чек-листом — иначе
// разметка разойдётся с картинкой.
function listKind(list) {
  if (!list) return null;
  if (list.tagName === "OL") return "ordered";
  return list.closest("ul.checklist") ? "checklist" : "bullet";
}

function createList(kind) {
  const spec = LIST_KINDS[kind];
  const list = document.createElement(spec.tag);
  if (spec.checklist) list.classList.add("checklist");
  return list;
}

// Список того же вида, стоящий вплотную — только с таким и сливаемся. Проверка
// именно на непосредственного соседа: между двумя списками может лежать пустая
// строка, и тогда это два РАЗНЫХ списка, сколько бы одинаковыми они ни выглядели.
function adjacentList(el, side, kind) {
  const neighbour = side === "before" ? el.previousElementSibling : el.nextElementSibling;
  return neighbour && listKind(neighbour) === kind ? neighbour : null;
}

/**
 * Единственная точка входа для всех трёх кнопок списка. Каретка внутри списка
 * того же вида — список снимается, другого вида — меняется вид, вне списка —
 * строки заворачиваются в пункты.
 *
 * Каретку держим сами: содержимое строк переезжает в <li> узлами, поэтому снимок
 * узлом (saveCaret) возвращает её ровно туда, где она стояла, — в том числе на
 * пустой строке, где символьного смещения не существует.
 */
function toggleList(editorEl, kind) {
  const caret = saveCaret();
  const selected = getSelectedListItems(editorEl);

  if (selected.length) {
    // Выделение могло растянуться на два разных списка — работаем с тем, где
    // началось: у соседнего свой вид и свои соседи, ему нужен свой разрез.
    const list = selected[0].parentElement;
    const items = selected.filter((li) => li.parentElement === list);
    if (listKind(list) === kind) unwrapListItems(list, items);
    else convertListItems(list, items, kind);
  } else {
    const lines = getSelectedLines(editorEl);
    if (!lines.length) return;
    wrapLinesInList(lines, kind);
  }

  restoreCaret(caret);
}

// Строки → пункты списка. Содержимое строки ПЕРЕНОСИТСЯ в <li>, а не копируется:
// узел под кареткой остаётся тем же самым, поэтому позиция ввода не съезжает.
function wrapLinesInList(lines, kind) {
  const first = lines[0];
  const last = lines[lines.length - 1];

  // Дописываемся в соседний список только если он стоит вплотную и он нашего
  // вида. Всё прочее — включая пустую строку-разделитель — заводит свой список.
  const before = adjacentList(first, "before", kind);
  const list = before || createList(kind);
  if (!before) first.before(list);

  lines.forEach((line) => {
    const li = document.createElement("li");
    // Направление ставит applyLineDirection, а вот явно выбранное кнопкой
    // (dir="rtl"/"ltr") принадлежит самой строке и обязано переехать с ней.
    if (line.hasAttribute("dir") && line.dir !== "auto") li.dir = line.dir;
    while (line.firstChild) li.appendChild(line.firstChild);
    list.appendChild(li);
    // Якорь рисунка указывает на прямого потомка листа (см. anchorLineOf), а им
    // после обёртки стал список — иначе рисунок потерял бы привязку.
    if (line.dataset.anchor && !list.dataset.anchor) list.dataset.anchor = line.dataset.anchor;
    line.remove();
  });

  // Список ниже, вплотную и нашего вида — это продолжение того же списка.
  const after = adjacentList(list, "after", kind);
  if (after) mergeListInto(list, after);
  return list;
}

/**
 * Пункты → обычные строки. Список разрезается: что шло выше, остаётся в исходном,
 * что ниже — уезжает в такую же копию следом. Отметки «выполнено» у соседей при
 * этом не трогаются, потому что переносятся узлы, а не разметка текстом.
 *
 * Вложенный пункт сперва поднимается на верхний уровень. Иначе получившаяся
 * строка осталась бы лежать ВНУТРИ чужого пункта, а строка внутри строки — это
 * общий на двоих блок: отступ принадлежит блоку, и Tab на одной из таких строк
 * двигал их все разом (замер: data-indent уезжал на внешний блок, вместе с ним
 * съезжали три строки). Порядок чтения при подъёме не рвётся — outdentListItem
 * уносит с собой то, что шло ниже. Обходим пункты с конца: каждый встаёт сразу
 * за родительским, и при обратном порядке они ложатся в исходной
 * последовательности.
 */
function unwrapListItems(list, items) {
  [...items].reverse().forEach((li) => {
    while (outdentListItem(li)); // до верхнего уровня своего списка
  });
  const topList = items[0].parentElement;

  const following = [];
  for (let next = items[items.length - 1].nextElementSibling; next; next = next.nextElementSibling) {
    following.push(next);
  }

  const lines = items.map((li) => {
    // Подсписок пункта в строку НЕ затягиваем: список внутри обычной строки —
    // та же беда, что и строка внутри строки. Он остаётся списком и встанет
    // отдельным блоком следом, сохранив свои пункты и их отступ.
    const nested = [...li.children].filter((child) => child.matches("ul,ol"));
    nested.forEach((sub) => sub.remove());

    const line = document.createElement("div");
    if (li.hasAttribute("dir") && li.dir !== "auto") line.dir = li.dir;
    while (li.firstChild) line.appendChild(li.firstChild);
    fillEmptyLine(line);
    return { line, nested };
  });

  let anchor = topList;
  lines.forEach(({ line, nested }) => {
    anchor.after(line);
    anchor = line;
    nested.forEach((sub) => {
      anchor.after(sub);
      anchor = sub;
    });
  });
  // Якорь рисунка живёт на одном блоке: список перестал быть тем блоком, где
  // стоит текст, — отдаём его первой получившейся строке.
  if (topList.dataset.anchor && lines.length) {
    lines[0].line.dataset.anchor = topList.dataset.anchor;
    delete topList.dataset.anchor;
  }

  if (following.length) {
    const tail = cloneEmptyList(topList);
    following.forEach((li) => tail.appendChild(li));
    anchor.after(tail);
  }
  items.forEach((li) => li.remove());
  if (!topList.children.length) topList.remove();
}

// Смена вида: пункты выносятся в собственный список нужного вида, соседи сверху и
// снизу остаются каждый в своём — со своим видом и своими галочками.
function convertListItems(list, items, kind) {
  const own = splitOutItems(list, items);
  if (!own) return;

  // Тег не меняется (☑ ⇄ • — оба <ul>) — обходимся классом. Меняется (⇄ 1.) —
  // контейнер пересобираем и переносим пункты, узлы при этом те же.
  let target = own;
  if (own.tagName !== LIST_KINDS[kind].tag) {
    target = createList(kind);
    while (own.firstChild) target.appendChild(own.firstChild);
    own.replaceWith(target);
  } else {
    target.classList.toggle("checklist", LIST_KINDS[kind].checklist);
  }

  // Сменив вид, пункт мог оказаться вплотную к списку, которому теперь ровня.
  const before = adjacentList(target, "before", kind);
  if (before) {
    mergeListInto(before, target);
    target = before;
  }
  const after = adjacentList(target, "after", kind);
  if (after) mergeListInto(target, after);
}

// Переливает пункты из source в target и убирает опустевший список. Именно
// переносом узлов: галочки (класс is-done) и вложенность переезжают сами.
function mergeListInto(target, source) {
  while (source.firstChild) target.appendChild(source.firstChild);
  source.remove();
}

/**
 * Два списка одного вида, вставшие вплотную, — это один список. Такими соседями
 * они становятся ровно в одном случае: пользователь удалил строку, которая их
 * разделяла. Пока разделитель на месте, списки остаются разными, сколько бы
 * одинаково они ни выглядели.
 *
 * Возвращает true, если что-то слилось, — вызывающий код по этому признаку
 * решает, записывать ли снимок истории.
 */
function mergeAdjacentLists(editorEl) {
  let merged = false;
  editorEl.querySelectorAll(".rte-page").forEach((page) => {
    [...page.querySelectorAll("ul,ol")].forEach((list) => {
      if (!list.isConnected) return; // уже влит в предыдущего соседа
      let next = adjacentList(list, "after", listKind(list));
      while (next) {
        mergeListInto(list, next);
        merged = true;
        next = adjacentList(list, "after", listKind(list));
      }
    });
  });
  return merged;
}

// Выносит подряд идущие пункты в собственный список того же вида. Соседи остаются
// каждый в своём: то, что шло выше, — в исходном, то, что ниже, — в такой же копии
// следом. Пункты переносятся, а не копируются, поэтому каретка внутри переезжает
// вместе с ними — как в indentListItem.
function splitOutItems(list, items) {
  if (!items.length) return null;

  const following = [];
  for (let next = items[items.length - 1].nextElementSibling; next; next = next.nextElementSibling) {
    following.push(next);
  }

  const own = cloneEmptyList(list);
  items.forEach((li) => own.appendChild(li));
  list.after(own);

  if (following.length) {
    const tail = cloneEmptyList(list);
    following.forEach((li) => tail.appendChild(li));
    own.after(tail);
  }
  if (!list.children.length) list.remove();
  return own;
}

// Пустая копия списка: тег и классы те же, а якорь рисунка — нет, он указывает на
// один блок (см. syncAnchors).
function cloneEmptyList(list) {
  const copy = list.cloneNode(false);
  delete copy.dataset.anchor;
  return copy;
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
