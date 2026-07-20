import { escapeHtml } from "../../utils/dom.js";
import { renderContentHtml } from "../../services/linksService.js";

export function renderNoteReader(container, note, { onHighlight, onRemoveHighlight, onOpenLink, notesById, backlinks }) {
  container.innerHTML = `
    <div class="note-reader">
      <h2 class="note-reader-title">${escapeHtml(note.title)}</h2>
      <div class="note-reader-content" data-role="content"></div>
      <p class="note-reader-hint">Выделите текст мышью, чтобы подчеркнуть его. Клик по подчёркнутому — убрать.</p>
      ${backlinks && backlinks.length ? renderBacklinks(backlinks) : ""}
    </div>
  `;

  const contentEl = container.querySelector('[data-role="content"]');
  contentEl.innerHTML = renderContentHtml(note.content, note.highlights || [], notesById);

  contentEl.querySelectorAll(".wiki-link").forEach((linkEl) => {
    linkEl.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      onOpenLink(linkEl.dataset.noteId);
    });
  });

  contentEl.querySelectorAll("mark[data-highlight-id]").forEach((markEl) => {
    markEl.addEventListener("click", () => {
      if (confirm("Убрать выделение?")) onRemoveHighlight(markEl.dataset.highlightId);
    });
  });

  contentEl.addEventListener("mouseup", () => {
    const offsets = getSelectionOffsets(contentEl);
    if (!offsets || !offsets.text.trim()) return;
    onHighlight({
      id: crypto.randomUUID(),
      text: offsets.text,
      startOffset: offsets.start,
      endOffset: offsets.end,
    });
    window.getSelection().removeAllRanges();
  });

  container.querySelectorAll("[data-backlink-id]").forEach((el) => {
    el.addEventListener("click", () => onOpenLink(el.dataset.backlinkId));
  });
}

function renderBacklinks(backlinks) {
  return `
    <div class="note-backlinks">
      <h3>Ссылаются на эту заметку</h3>
      <ul>
        ${backlinks
          .map((note) => `<li data-backlink-id="${note.id}">${escapeHtml(note.title || "Без названия")}</li>`)
          .join("")}
      </ul>
    </div>
  `;
}

function getSelectionOffsets(container) {
  const selection = window.getSelection();
  if (!selection || selection.rangeCount === 0) return null;

  const range = selection.getRangeAt(0);
  if (range.collapsed || !container.contains(range.commonAncestorContainer)) return null;

  const preRange = document.createRange();
  preRange.selectNodeContents(container);
  preRange.setEnd(range.startContainer, range.startOffset);

  const start = preRange.toString().length;
  const text = range.toString();
  return { start, end: start + text.length, text };
}
