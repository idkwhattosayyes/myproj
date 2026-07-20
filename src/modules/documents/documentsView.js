import { renderPanelSection } from "../shared/panelSection.js";

export async function renderDocumentsView(container) {
  await renderPanelSection(container, {
    section: "documents",
    toolbarButtons: [
      "bold", "italic", "underline", "strikethrough", "textColor", "highlight",
      "h1", "h2", "alignLeft", "alignCenter", "alignRight", "bulletList", "orderedList", "table",
    ],
  });
}
