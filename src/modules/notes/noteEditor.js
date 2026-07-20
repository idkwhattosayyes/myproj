import { escapeHtml } from "../../utils/dom.js";
import { openAlert } from "../../utils/modal.js";

export function renderNoteEditor(container, note, { onSave, onCancel, allNotes }) {
  container.innerHTML = `
    <div class="note-editor">
      <input type="text" class="note-editor-title" placeholder="Заголовок">
      <div class="note-editor-toolbar">
        <button type="button" class="btn btn-small" data-action="insert-link">🔗 Ссылка на заметку</button>
      </div>
      <textarea class="note-editor-content" placeholder="Текст заметки..."></textarea>
      <div class="link-picker" data-role="link-picker" hidden>
        <input type="text" class="link-picker-input" placeholder="Начните вводить название заметки..." data-role="link-picker-input">
        <ul class="link-picker-results" data-role="link-picker-results"></ul>
        <button type="button" class="btn btn-small" data-action="cancel-link">Отмена</button>
      </div>
      <div class="note-editor-actions">
        <button type="button" class="btn btn-primary" data-action="save">Сохранить</button>
        <button type="button" class="btn" data-action="cancel">Отмена</button>
      </div>
    </div>
  `;

  const titleInput = container.querySelector(".note-editor-title");
  const contentInput = container.querySelector(".note-editor-content");
  titleInput.value = note.title;
  contentInput.value = note.content;

  const pickerEl = container.querySelector('[data-role="link-picker"]');
  const pickerInput = container.querySelector('[data-role="link-picker-input"]');
  const pickerResults = container.querySelector('[data-role="link-picker-results"]');
  let pendingSelection = null;

  container.querySelector('[data-action="insert-link"]').addEventListener("click", async () => {
    const start = contentInput.selectionStart;
    const end = contentInput.selectionEnd;
    if (start === end) {
      await openAlert({ message: "Сначала выделите текст в заметке, который станет ссылкой." });
      return;
    }
    pendingSelection = { start, end, text: contentInput.value.slice(start, end) };
    pickerEl.hidden = false;
    pickerInput.value = "";
    pickerInput.focus();
    renderPickerResults("");
  });

  function renderPickerResults(query) {
    const q = query.trim().toLowerCase();
    const matches = (allNotes || [])
      .filter((n) => n.id !== note.id)
      .filter((n) => !q || (n.title || "").toLowerCase().includes(q))
      .slice(0, 20);

    pickerResults.innerHTML = matches.length
      ? matches.map((n) => `<li data-note-id="${n.id}">${escapeHtml(n.title || "Без названия")}</li>`).join("")
      : `<li class="placeholder">Совпадений нет</li>`;

    pickerResults.querySelectorAll("[data-note-id]").forEach((li) => {
      li.addEventListener("click", () => applyLink(li.dataset.noteId));
    });
  }

  function applyLink(targetNoteId) {
    if (!pendingSelection) return;
    const { start, end, text } = pendingSelection;
    const markup = `[[${targetNoteId}|${text}]]`;
    contentInput.value = contentInput.value.slice(0, start) + markup + contentInput.value.slice(end);
    pickerEl.hidden = true;
    pendingSelection = null;
  }

  pickerInput.addEventListener("input", () => renderPickerResults(pickerInput.value));

  container.querySelector('[data-action="cancel-link"]').addEventListener("click", () => {
    pickerEl.hidden = true;
    pendingSelection = null;
  });

  container.querySelector('[data-action="save"]').addEventListener("click", () => {
    onSave({
      title: titleInput.value.trim() || "Без названия",
      content: contentInput.value,
    });
  });

  container.querySelector('[data-action="cancel"]').addEventListener("click", onCancel);
}
