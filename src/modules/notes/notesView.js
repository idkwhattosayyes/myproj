import { renderPanelSection } from "../shared/panelSection.js";

export async function renderNotesView(container) {
  await renderPanelSection(container, {
    section: "notes",
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
