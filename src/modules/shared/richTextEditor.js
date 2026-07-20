const BUTTONS = {
  bold: { label: "Ж", title: "Жирный" },
  italic: { label: "К", title: "Курсив" },
  underline: { label: "П", title: "Подчёркнутый" },
  h1: { label: "H1", title: "Заголовок 1" },
  h2: { label: "H2", title: "Заголовок 2" },
  bulletList: { label: "•", title: "Маркированный список" },
  orderedList: { label: "1.", title: "Нумерованный список" },
  checklist: { label: "☑", title: "Чек-лист" },
};

/**
 * @param {HTMLElement} container
 * @param {{content: string, buttons: string[], onChange: (html: string) => void}} options
 */
export function renderRichTextEditor(container, { content, buttons, onChange }) {
  container.innerHTML = `
    <div class="rte">
      <div class="rte-toolbar" role="toolbar"></div>
      <div class="rte-content" contenteditable="true"></div>
    </div>
  `;

  const toolbarEl = container.querySelector(".rte-toolbar");
  const editorEl = container.querySelector(".rte-content");
  editorEl.innerHTML = content || "";

  toolbarEl.innerHTML = buttons
    .map((key) => `<button type="button" class="rte-btn" data-command="${key}" title="${BUTTONS[key].title}">${BUTTONS[key].label}</button>`)
    .join("");

  toolbarEl.querySelectorAll("[data-command]").forEach((btn) => {
    // Не даём кнопке забрать фокус — иначе выделение в редакторе схлопнется до клика.
    btn.addEventListener("mousedown", (event) => event.preventDefault());
    btn.addEventListener("click", () => {
      runCommand(btn.dataset.command, editorEl);
      editorEl.focus();
      onChange(editorEl.innerHTML);
    });
  });

  editorEl.addEventListener("input", () => {
    editorEl.querySelectorAll("ul.checklist").forEach(ensureCheckboxes);
    onChange(editorEl.innerHTML);
  });

  editorEl.addEventListener("click", (event) => {
    if (event.target.matches("li > input[type='checkbox']")) {
      const checkbox = event.target;
      // innerHTML сериализует checked-АТРИБУТ, а не DOM-свойство — без этого
      // отметка визуально теряется после сохранения/перезагрузки.
      checkbox.toggleAttribute("checked", checkbox.checked);
      checkbox.closest("li").classList.toggle("is-done", checkbox.checked);
      onChange(editorEl.innerHTML);
    }
  });
}

function runCommand(key, editorEl) {
  switch (key) {
    case "bold":
      document.execCommand("bold");
      break;
    case "italic":
      document.execCommand("italic");
      break;
    case "underline":
      document.execCommand("underline");
      break;
    case "h1":
      document.execCommand("formatBlock", false, "H1");
      break;
    case "h2":
      document.execCommand("formatBlock", false, "H2");
      break;
    case "bulletList":
      document.execCommand("insertUnorderedList");
      break;
    case "orderedList":
      document.execCommand("insertOrderedList");
      break;
    case "checklist":
      applyChecklist(editorEl);
      break;
  }
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

function ensureCheckboxes(list) {
  list.querySelectorAll(":scope > li").forEach((li) => {
    if (li.querySelector(":scope > input[type='checkbox']")) return;
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.setAttribute("contenteditable", "false");
    li.prepend(checkbox);
  });
}
