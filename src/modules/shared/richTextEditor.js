import { t } from "../../i18n/i18n.js";
import { openTablePrompt } from "../../utils/modal.js";
import { pushLayer } from "../../utils/escapeLayers.js";

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

function getButtonDefs() {
  return {
    bold: { label: t("editor.boldLabel"), title: t("editor.bold"), command: () => document.execCommand("bold"), isActive: () => document.queryCommandState("bold") },
    italic: { label: t("editor.italicLabel"), title: t("editor.italic"), command: () => document.execCommand("italic"), isActive: () => document.queryCommandState("italic") },
    underline: { label: t("editor.underlineLabel"), title: t("editor.underline"), command: (editorEl) => toggleInlineFormat(editorEl, "u"), isActive: (editorEl) => isInlineFormatActive(editorEl, "u") },
    strikethrough: { label: "S", title: t("editor.strikethrough"), command: (editorEl) => toggleInlineFormat(editorEl, "s"), isActive: (editorEl) => isInlineFormatActive(editorEl, "s") },
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
    },
    table: { label: "▦", title: t("editor.table"), command: (editorEl) => insertTable(editorEl) },
  };
}

// Невидимый якорь: держит каретку внутри только что созданного (или только что
// покинутого) форматирующего тега, пока в него ничего не набрано. В сохраняемый
// HTML не попадает — см. serializeEditor.
const CARET_ANCHOR = "\u200B";

function serializeEditor(editorEl) {
  return editorEl.innerHTML.split(CARET_ANCHOR).join("").replace(/<(u|s)><\/\1>/g, "");
}

/**
 * Подчёркивание и зачёркивание в обход execCommand. Chrome кладёт обе команды в
 * одно свойство text-decoration, из-за чего они затирали друг друга, не
 * снимались в середине слова и strikeThrough вставлял лишний символ. Свои
 * <u>/<s> вкладываются независимо и снимаются в любой точке.
 */
function toggleInlineFormat(editorEl, tagName) {
  const selection = window.getSelection();
  if (!selection.rangeCount) return;
  const range = selection.getRangeAt(0);
  if (!editorEl.contains(range.commonAncestorContainer)) return;

  if (!range.collapsed) {
    if (isInlineFormatActive(editorEl, tagName)) unwrapSelection(editorEl, tagName, range);
    else wrapSelection(editorEl, tagName, range);
    return;
  }

  const active = getFormatAncestor(editorEl, tagName, range.startContainer);
  if (active) exitInlineFormat(active, range);
  else enterInlineFormat(tagName, range);
}

// Активна, если ВЕСЬ выделенный текст уже в этом теге (для схлопнутой каретки —
// если в нём находится сама каретка). Иначе кнопка должна включать формат.
function isInlineFormatActive(editorEl, tagName) {
  const selection = window.getSelection();
  if (!selection.rangeCount) return false;
  const range = selection.getRangeAt(0);
  if (!editorEl.contains(range.commonAncestorContainer)) return false;

  if (range.collapsed) return !!getFormatAncestor(editorEl, tagName, range.startContainer);

  const nodes = collectTextNodes(range);
  return nodes.length > 0 && nodes.every((node) => getFormatAncestor(editorEl, tagName, node));
}

function getFormatAncestor(editorEl, tagName, node) {
  let el = node && node.nodeType === Node.TEXT_NODE ? node.parentElement : node;
  if (!el || !editorEl.contains(el)) return null;
  const found = el.closest(tagName);
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

function wrapSelection(editorEl, tagName, range) {
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
    if (getFormatAncestor(editorEl, tagName, node)) return; // уже оформлен
    const wrapper = document.createElement(tagName);
    node.replaceWith(wrapper);
    wrapper.appendChild(node);
  });

  selectNodes(nodes);
}

function unwrapSelection(editorEl, tagName, range) {
  const { endContainer, endOffset, startContainer, startOffset } = range;
  if (endContainer.nodeType === Node.TEXT_NODE && endOffset < endContainer.length) {
    endContainer.splitText(endOffset);
  }
  if (startContainer.nodeType === Node.TEXT_NODE && startOffset > 0) {
    range.setStart(startContainer.splitText(startOffset), 0);
  }

  const nodes = collectTextNodes(range);
  nodes.forEach((node) => {
    const wrapper = getFormatAncestor(editorEl, tagName, node);
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
  editorEl.querySelectorAll("u,s").forEach((el) => {
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
function enterInlineFormat(tagName, range) {
  const wrapper = document.createElement(tagName);
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
  return !!block && block.tagName === tagName.toUpperCase();
}

// Взаимоисключающий переключатель заголовка: если текущий блок уже этого
// уровня — снимаем (в обычный div); иначе применяем нужный уровень. formatBlock
// заменяет блок целиком, поэтому H1↔H2 не вкладываются друг в друга.
function applyHeading(editorEl, tagName) {
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
 * @param {{content: string, buttons: string[], onChange: (html: string) => void}} options
 * @returns {{toolbarEl: HTMLElement, contentEl: HTMLElement}}
 */
export function createRichTextEditor({ content, buttons, onChange }) {
  const buttonDefs = getButtonDefs();
  // Просим браузер размечать команды тегами (<b>), а не инлайновым CSS: со
  // стилями Chrome складывает разные оформления в одно свойство и они
  // затирают друг друга.
  document.execCommand("styleWithCSS", false, false);

  const toolbarEl = document.createElement("div");
  toolbarEl.className = "rte-toolbar";
  toolbarEl.setAttribute("role", "toolbar");

  const contentEl = document.createElement("div");
  contentEl.className = "rte-content";
  contentEl.contentEditable = "true";
  contentEl.spellcheck = false;
  contentEl.innerHTML = content || "";
  upgradeLegacyChecklists(contentEl);

  // Подсвечивает кнопки, чьё форматирование активно в текущем выделении/позиции
  // курсора (bold в жирном тексте, highlight на закрашенном фрагменте и т.д.).
  function refreshToolbarState() {
    toolbarEl.querySelectorAll(".rte-btn").forEach((btn) => {
      const btnDef = buttonDefs[btn.dataset.command];
      if (!btnDef || !btnDef.isActive) return;
      btn.classList.toggle("is-active", !!btnDef.isActive(contentEl));
    });
  }

  buttons.forEach((key) => {
    const def = buttonDefs[key];
    if (!def) return;

    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "rte-btn";
    btn.dataset.command = key;
    btn.title = def.title;
    btn.textContent = def.label;
    // Не даём кнопке забрать фокус — иначе выделение в редакторе схлопнется до клика.
    btn.addEventListener("mousedown", (event) => event.preventDefault());

    if (def.isColor) {
      // ЛКМ — быстрый переключатель последним выбранным цветом, ПКМ — палитра.
      btn.addEventListener("click", () => {
        if (def.isActive(contentEl)) def.reset();
        else def.apply(getLastColor(def.storageKey, def.defaultColor));
        contentEl.focus();
        onChange(serializeEditor(contentEl));
        refreshToolbarState();
      });
      btn.addEventListener("contextmenu", (event) => {
        event.preventDefault();
        toggleColorPopover(btn, def, contentEl, onChange, refreshToolbarState);
      });
    } else {
      btn.addEventListener("click", async () => {
        // await — командой может быть insertTable, которая асинхронно спрашивает
        // размер через модалку; для обычных execCommand-команд просто no-op.
        await def.command(contentEl);
        contentEl.focus();
        onChange(serializeEditor(contentEl));
        refreshToolbarState();
      });
    }

    toolbarEl.appendChild(btn);
  });

  contentEl.addEventListener("input", () => onChange(serializeEditor(contentEl)));

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
  contentEl.addEventListener("focus", refreshToolbarState);

  return { toolbarEl, contentEl };
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

function toggleColorPopover(btn, def, editorEl, onChange, refreshToolbarState) {
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
    editorEl.focus();
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
      // Выбранный здесь цвет становится тем, которым красит ЛКМ по кнопке.
      setLastColor(def.storageKey, color);
      closeColorPopovers();
      editorEl.focus();
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
