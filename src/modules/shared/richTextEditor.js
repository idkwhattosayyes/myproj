import { t } from "../../i18n/i18n.js";
import { openTablePrompt } from "../../utils/modal.js";

const COLORS = ["#e03131", "#f08c00", "#2f9e44", "#1971c2", "#7048e8", "#495057"];

function getButtonDefs() {
  return {
    bold: { label: t("editor.boldLabel"), title: t("editor.bold"), command: () => document.execCommand("bold"), isActive: () => document.queryCommandState("bold") },
    italic: { label: t("editor.italicLabel"), title: t("editor.italic"), command: () => document.execCommand("italic"), isActive: () => document.queryCommandState("italic") },
    underline: { label: t("editor.underlineLabel"), title: t("editor.underline"), command: () => document.execCommand("underline"), isActive: () => document.queryCommandState("underline") },
    strikethrough: { label: "S", title: t("editor.strikethrough"), command: () => document.execCommand("strikeThrough"), isActive: () => document.queryCommandState("strikeThrough") },
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
      title: t("editor.textColor"),
      isColor: true,
      apply: (color) => document.execCommand("foreColor", false, color),
      // Сбрасывает цвет текста обратно к обычному — иначе применённый foreColor
      // ничем не убрать после закрытия поповера.
      reset: () => document.execCommand("foreColor", false, "#1f2328"),
      isActive: (editorEl) => isColorActive(editorEl, "color"),
    },
    highlight: {
      label: "▮",
      title: t("editor.highlight"),
      isColor: true,
      apply: (color) => document.execCommand("hiliteColor", false, color),
      reset: () => document.execCommand("hiliteColor", false, "transparent"),
      isActive: (editorEl) => isColorActive(editorEl, "backgroundColor"),
    },
    table: { label: "▦", title: t("editor.table"), command: (editorEl) => insertTable(editorEl) },
  };
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

  const toolbarEl = document.createElement("div");
  toolbarEl.className = "rte-toolbar";
  toolbarEl.setAttribute("role", "toolbar");

  const contentEl = document.createElement("div");
  contentEl.className = "rte-content";
  contentEl.contentEditable = "true";
  contentEl.spellcheck = false;
  contentEl.innerHTML = content || "";

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
      btn.addEventListener("click", () => toggleColorPopover(btn, def, contentEl, onChange, refreshToolbarState));
    } else {
      btn.addEventListener("click", async () => {
        // await — командой может быть insertTable, которая асинхронно спрашивает
        // размер через модалку; для обычных execCommand-команд просто no-op.
        await def.command(contentEl);
        contentEl.focus();
        onChange(contentEl.innerHTML);
        refreshToolbarState();
      });
    }

    toolbarEl.appendChild(btn);
  });

  contentEl.addEventListener("input", () => {
    contentEl.querySelectorAll("ul.checklist").forEach(ensureCheckboxes);
    onChange(contentEl.innerHTML);
  });

  contentEl.addEventListener("click", (event) => {
    if (event.target.matches("li > input[type='checkbox']")) {
      const checkbox = event.target;
      // innerHTML сериализует checked-АТРИБУТ, а не DOM-свойство — без этого
      // отметка визуально теряется после сохранения/перезагрузки.
      checkbox.toggleAttribute("checked", checkbox.checked);
      checkbox.closest("li").classList.toggle("is-done", checkbox.checked);
      onChange(contentEl.innerHTML);
    }
  });

  contentEl.addEventListener("keydown", (event) => {
    if (event.key === "Tab") {
      event.preventDefault();
      handleTabIndent(contentEl, event.shiftKey);
      onChange(contentEl.innerHTML);
      return;
    }
    if (event.key === "Enter" && isInsideChecklist(contentEl)) {
      // Не полагаемся на реактивный ensureCheckboxes из "input" — к моменту,
      // когда он срабатывает, курсор браузера уже "устаканился" не там, где
      // нужно. Вставляем чекбокс синхронно, сразу после разбиения строки.
      event.preventDefault();
      handleChecklistEnter(contentEl);
      onChange(contentEl.innerHTML);
    }
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
  if (existing) {
    existing.remove();
    return;
  }
  closeColorPopovers(btn);

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
    popover.remove();
    editorEl.focus();
    onChange(editorEl.innerHTML);
    refreshToolbarState();
  });
  popover.appendChild(resetSwatch);

  COLORS.forEach((color) => {
    const swatch = document.createElement("button");
    swatch.type = "button";
    swatch.className = "rte-color-swatch";
    swatch.style.background = color;
    swatch.addEventListener("mousedown", (event) => event.preventDefault());
    swatch.addEventListener("click", (event) => {
      event.stopPropagation();
      def.apply(color);
      popover.remove();
      editorEl.focus();
      onChange(editorEl.innerHTML);
      refreshToolbarState();
    });
    popover.appendChild(swatch);
  });

  btn.appendChild(popover);
  setTimeout(() => document.addEventListener("click", () => popover.remove(), { once: true }), 0);
}

function closeColorPopovers(exceptBtn) {
  document.querySelectorAll(".rte-color-popover").forEach((popover) => {
    if (!exceptBtn || !exceptBtn.contains(popover)) popover.remove();
  });
}

// Tab/Shift+Tab — стандартный indent/outdent; для чек-листа донаращиваем
// чекбоксы во вложенном <ul>, который execCommand создаёт без класса.
function handleTabIndent(editorEl, shiftKey) {
  const wasChecklist = isInsideChecklist(editorEl);
  document.execCommand(shiftKey ? "outdent" : "indent");

  if (wasChecklist) {
    editorEl.querySelectorAll("li ul:not(.checklist)").forEach((ul) => {
      if (ul.closest(".checklist")) ul.classList.add("checklist");
    });
    editorEl.querySelectorAll("ul.checklist").forEach(ensureCheckboxes);
  }
}

function isInsideChecklist(editorEl) {
  const selection = window.getSelection();
  if (!selection.rangeCount) return false;
  let node = selection.getRangeAt(0).commonAncestorContainer;
  if (node.nodeType === Node.TEXT_NODE) node = node.parentElement;
  return !!(node && node.closest && node.closest("ul.checklist"));
}

// execCommand не умеет чек-листы — оборачиваем выделение в обычный <ul>,
// затем добавляем немую (contenteditable=false) галочку в каждый пункт.
function applyChecklist(editorEl) {
  document.execCommand("insertUnorderedList");

  const selection = window.getSelection();
  if (!selection.rangeCount) return;

  let node = selection.getRangeAt(0).commonAncestorContainer;
  if (node.nodeType === Node.TEXT_NODE) node = node.parentElement;

  const list = node ? node.closest("ul") : null;
  if (!list || !editorEl.contains(list)) return;

  list.classList.add("checklist");
  ensureCheckboxes(list);
}

// Enter внутри чек-листа: даём браузеру разбить строку как обычно, затем
// синхронно (без ожидания следующего "input") вставляем чекбокс в новый
// пустой <li> и ставим курсор в конец — реагировать на "input" постфактум
// ненадёжно, браузер к этому моменту уже зафиксировал курсор перед чекбоксом.
function handleChecklistEnter(editorEl) {
  document.execCommand("insertParagraph");

  const selection = window.getSelection();
  if (!selection.rangeCount) return;

  let node = selection.getRangeAt(0).commonAncestorContainer;
  if (node.nodeType === Node.TEXT_NODE) node = node.parentElement;
  const li = node ? node.closest("li") : null;
  if (!li || !editorEl.contains(li) || li.querySelector(":scope > input[type='checkbox']")) return;

  const checkbox = document.createElement("input");
  checkbox.type = "checkbox";
  checkbox.setAttribute("contenteditable", "false");
  li.prepend(checkbox);

  const range = document.createRange();
  range.selectNodeContents(li);
  range.collapse(false);
  selection.removeAllRanges();
  selection.addRange(range);
}

function ensureCheckboxes(list) {
  list.querySelectorAll(":scope > li").forEach((li) => {
    if (li.querySelector(":scope > input[type='checkbox']")) return;
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.setAttribute("contenteditable", "false");
    li.prepend(checkbox);
  });
}
