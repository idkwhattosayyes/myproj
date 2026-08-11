import { renderPanelSection } from "../shared/panelSection.js";

export async function renderNotesView(container) {
  await renderPanelSection(container, {
    section: "notes",
    // Курсив временно убран из тулбара; определение кнопки в richTextEditor.js
    // осталось — чтобы вернуть, достаточно снова добавить "italic" в список.
    toolbarButtons: [
      "undo", "redo",
      "bold", "underline", "strikethrough", "textColor", "highlight",
      "h1", "h2", "h3", "alignLeft", "alignCenter", "alignRight",
      "bulletList", "orderedList", "checklist", "table", "insertPhoto", "voice", "draw", "pageMode",
    ],
    // Свёрнутый тулбар (кнопка "+" справа) показывает только этот набор — бывший
    // тулбар Задач. Развёрнутый показывает toolbarButtons целиком.
    basicToolbarButtons: ["undo", "redo", "bold", "underline", "strikethrough", "textColor", "highlight", "bulletList", "checklist", "insertPhoto", "voice", "draw"],
    // Кнопки режима отображения в свёрнутом наборе нет — переключаем по ПКМ.
    pageModeInContextMenu: true,
  });
}
