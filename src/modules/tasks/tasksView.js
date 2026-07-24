import { renderPanelSection } from "../shared/panelSection.js";

export async function renderTasksView(container) {
  await renderPanelSection(container, {
    section: "tasks",
    toolbarButtons: ["undo", "redo", "bold", "underline", "strikethrough", "textColor", "highlight", "bulletList", "checklist", "voice", "draw"],
    // Кнопки режима отображения в тулбаре здесь нет — только ПКМ внутри заметки.
    pageModeInContextMenu: true,
  });
}
