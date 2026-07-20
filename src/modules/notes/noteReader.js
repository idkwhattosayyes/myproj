import { escapeHtml } from "../../utils/dom.js";

export function renderNoteReader(container, note, { onHighlight, onRemoveHighlight }) {
  container.innerHTML = `
    <div class="note-reader">
      <h2 class="note-reader-title">${escapeHtml(note.title)}</h2>
      <div class="note-reader-content" data-role="content"></div>
      <p class="note-reader-hint">Выделите текст мышью, чтобы подчеркнуть его. Клик по подчёркнутому — убрать.</p>
    </div>
  `;

  const contentEl = container.querySelector('[data-role="content"]');
  contentEl.innerHTML = renderHighlightedContent(note.content, note.highlights || []);

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
}

function renderHighlightedContent(content, highlights) {
  if (!highlights.length) return escapeHtml(content);

  const valid = highlights
    .filter((h) => h.startOffset >= 0 && h.endOffset <= content.length && h.startOffset < h.endOffset)
    .sort((a, b) => a.startOffset - b.startOffset);

  let html = "";
  let cursor = 0;
  for (const highlight of valid) {
    if (highlight.startOffset < cursor) continue; // пропускаем пересекающиеся диапазоны
    html += escapeHtml(content.slice(cursor, highlight.startOffset));
    html += `<mark data-highlight-id="${highlight.id}">${escapeHtml(
      content.slice(highlight.startOffset, highlight.endOffset)
    )}</mark>`;
    cursor = highlight.endOffset;
  }
  html += escapeHtml(content.slice(cursor));
  return html;
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
