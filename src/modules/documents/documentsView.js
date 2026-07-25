import { renderPanelSection } from "../shared/panelSection.js";

export async function renderDocumentsView(container) {
  await renderPanelSection(container, {
    section: "documents",
    // Курсив временно убран из тулбара; определение кнопки в richTextEditor.js
    // осталось — чтобы вернуть, достаточно снова добавить "italic" в список.
    toolbarButtons: [
      "undo", "redo",
      "bold", "underline", "strikethrough", "textColor", "highlight",
      "h1", "h2", "alignLeft", "alignCenter", "alignRight",
      "bulletList", "orderedList", "checklist", "table", "insertPhoto", "voice", "draw", "pageMode",
    ],
  });
}
