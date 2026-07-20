import { t } from "../../i18n/i18n.js";

const COLORS = ["#e03131", "#f08c00", "#2f9e44", "#1971c2", "#7048e8", "#495057"];

function getButtonDefs() {
  return {
    bold: { label: t("editor.boldLabel"), title: t("editor.bold"), command: () => document.execCommand("bold") },
    italic: { label: t("editor.italicLabel"), title: t("editor.italic"), command: () => document.execCommand("italic") },
    underline: { label: t("editor.underlineLabel"), title: t("editor.underline"), command: () => document.execCommand("underline") },
    h1: { label: "H1", title: t("editor.h1"), command: () => document.execCommand("formatBlock", false, "H1") },
    h2: { label: "H2", title: t("editor.h2"), command: () => document.execCommand("formatBlock", false, "H2") },
    bulletList: { label: "•", title: t("editor.bulletList"), command: () => document.execCommand("insertUnorderedList") },
    orderedList: { label: "1.", title: t("editor.orderedList"), command: () => document.execCommand("insertOrderedList") },
    checklist: { label: "☑", title: t("editor.checklist"), command: (editorEl) => applyChecklist(editorEl) },
    textColor: { label: "A", title: t("editor.textColor"), isColor: true, apply: (color) => document.execCommand("foreColor", false, color) },
    highlight: { label: "▮", title: t("editor.highlight"), isColor: true, apply: (color) => document.execCommand("hiliteColor", false, color) },
  };
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
  contentEl.innerHTML = content || "";

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
      btn.addEventListener("click", () => toggleColorPopover(btn, def, contentEl, onChange));
    } else {
      btn.addEventListener("click", () => {
        def.command(contentEl);
        contentEl.focus();
        onChange(contentEl.innerHTML);
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

  return { toolbarEl, contentEl };
}

function toggleColorPopover(btn, def, editorEl, onChange) {
  const existing = btn.querySelector(".rte-color-popover");
  if (existing) {
    existing.remove();
    return;
  }
  closeColorPopovers(btn);

  const popover = document.createElement("div");
  popover.className = "rte-color-popover";

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
