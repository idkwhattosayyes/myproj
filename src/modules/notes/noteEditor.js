export function renderNoteEditor(container, note, { onSave, onCancel }) {
  container.innerHTML = `
    <div class="note-editor">
      <input type="text" class="note-editor-title" placeholder="Заголовок">
      <textarea class="note-editor-content" placeholder="Текст заметки..."></textarea>
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

  container.querySelector('[data-action="save"]').addEventListener("click", () => {
    onSave({
      title: titleInput.value.trim() || "Без названия",
      content: contentInput.value,
    });
  });

  container.querySelector('[data-action="cancel"]').addEventListener("click", onCancel);
}
