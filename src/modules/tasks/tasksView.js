import { renderPanelSection } from "../shared/panelSection.js";

export async function renderTasksView(container) {
  await renderPanelSection(container, {
    section: "tasks",
    toolbarButtons: ["bold", "underline", "textColor", "highlight", "bulletList", "checklist"],
    // Кнопки режима отображения в тулбаре здесь нет — только ПКМ внутри заметки.
    pageModeInContextMenu: true,
  });
}
