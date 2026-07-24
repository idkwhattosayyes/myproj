import { t } from "../i18n/i18n.js";
import { pushLayer } from "../utils/escapeLayers.js";
import { createRichTextEditor } from "../modules/shared/richTextEditor.js";
import * as itemsService from "../services/itemsService.js";
import { setPendingTarget } from "./searchTarget.js";

/**
 * Быстрая заметка: кнопка «+» рядом с полем поиска открывает компактную панель
 * с минимальным редактором. Enter или Esc сохраняют, «Отмена» — отбрасывает.
 * Кнопки «В Заметки»/«В Документы» переносят уже написанный текст в полноценный
 * редактор соответствующего раздела, ничего не теряя.
 */
let onNavigate = null;
let panelEl = null;
let editor = null;
let latestHtml = "";
let unregisterLayer = null;

/** @param {{onNavigate: (route: string) => void}} options */
export function mountQuickNote({ onNavigate: navigate }) {
  onNavigate = navigate;
  // Кнопка живёт в верхней строке поиска, но визуально отдельной круглой кнопкой.
  const topline = document.querySelector(".search-topline") || document.querySelector(".search-bar");
  if (!topline) return;

  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "quicknote-add";
  btn.textContent = "＋";
  btn.title = t("quicknote.add");
  btn.addEventListener("click", openQuickNote);
  topline.appendChild(btn);
}

function openQuickNote() {
  if (panelEl) return; // уже открыта
  latestHtml = "";

  editor = createRichTextEditor({
    content: "",
    buttons: ["bold", "underline", "strikethrough", "bulletList", "voice"],
    onChange: (html) => {
      latestHtml = html;
    },
  });

  panelEl = document.createElement("div");
  panelEl.className = "quicknote-panel";
  panelEl.innerHTML = `
    <div class="quicknote-toolbar-slot"></div>
    <div class="quicknote-body-slot"></div>
    <div class="quicknote-actions">
      <div class="quicknote-actions-left">
        <button type="button" class="btn btn-small" data-action="to-tasks">${t("quicknote.toNotes")}</button>
        <button type="button" class="btn btn-small" data-action="to-docs">${t("quicknote.toDocuments")}</button>
      </div>
      <div class="quicknote-actions-right">
        <button type="button" class="btn btn-small" data-action="cancel">${t("quicknote.cancel")}</button>
        <button type="button" class="btn btn-small btn-primary" data-action="accept">${t("quicknote.accept")}</button>
      </div>
    </div>
  `;
  panelEl.querySelector(".quicknote-toolbar-slot").appendChild(editor.toolbarEl);
  panelEl.querySelector(".quicknote-body-slot").appendChild(editor.contentEl);
  document.body.appendChild(panelEl);

  panelEl.querySelector('[data-action="accept"]').addEventListener("click", saveAndClose);
  panelEl.querySelector('[data-action="cancel"]').addEventListener("click", discardAndClose);
  panelEl.querySelector('[data-action="to-tasks"]').addEventListener("click", () => carryToSection("tasks"));
  panelEl.querySelector('[data-action="to-docs"]').addEventListener("click", () => carryToSection("documents"));

  // Enter без Shift сохраняет; Shift+Enter оставляем на перенос строки в тексте.
  panelEl.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      saveAndClose();
    }
  });

  // Esc сохраняет (по ТЗ): вешаем как верхний слой. Клик снаружи, наоборот,
  // отменяет — начатую мысль случайным кликом не коммитим.
  unregisterLayer = pushLayer(saveAndClose);
  setTimeout(() => document.addEventListener("mousedown", onOutsideMouseDown), 0);

  if (editor.refreshLayout) editor.refreshLayout();
  if (editor.focusContent) editor.focusContent();
}

function onOutsideMouseDown(event) {
  if (panelEl && !panelEl.contains(event.target)) discardAndClose();
}

function teardown() {
  if (!panelEl) return;
  document.removeEventListener("mousedown", onOutsideMouseDown);
  if (unregisterLayer) {
    unregisterLayer();
    unregisterLayer = null;
  }
  panelEl.remove();
  panelEl = null;
  editor = null;
}

function discardAndClose() {
  teardown();
}

async function saveAndClose() {
  const html = latestHtml;
  teardown();
  if (isBlank(html)) return; // пустую заметку не создаём
  // Сохраняем в фоне и НЕ перерисовываем текущий раздел: быстрая заметка не
  // должна закрывать открытую заметку или сбрасывать прокрутку. Новая запись
  // появится в списке при следующей отрисовке раздела.
  await itemsService.createItem("tasks", { title: deriveTitle(html), content: html, folderIds: [] });
}

async function carryToSection(section) {
  const html = latestHtml;
  teardown();
  const item = await itemsService.createItem(section, { title: deriveTitle(html), content: html, folderIds: [] });
  // Раздел откроет именно эту заметку в полном редакторе — текст продолжит жить.
  setPendingTarget({ kind: "item", id: item.id, query: "", matchIndex: 0 });
  if (onNavigate) onNavigate(section);
}

// Текст без разметки: и для проверки на пустоту, и для заголовка в списке.
function plainText(html) {
  const holder = document.createElement("div");
  holder.innerHTML = html || "";
  return holder.textContent.replace(/\s+/g, " ").trim();
}

function isBlank(html) {
  return !plainText(html) && !/<img\b/i.test(html || "");
}

function deriveTitle(html) {
  return plainText(html).slice(0, 60);
}
