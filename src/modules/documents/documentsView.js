import { renderPanelSection } from "../shared/panelSection.js";

export async function renderDocumentsView(container) {
  await renderPanelSection(container, {
    section: "documents",
    toolbarButtons: ["bold", "italic", "underline", "h1", "h2", "bulletList", "orderedList"],
  });
}
