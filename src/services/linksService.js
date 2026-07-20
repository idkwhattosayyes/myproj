import { escapeHtml } from "../utils/dom.js";

const LINK_PATTERN = /\[\[([0-9a-f-]{36})(?:\|([^\]]+))?\]\]/gi;

/** Разбивает контент на текстовые и ссылочные токены. Индексы считаются по видимому тексту. */
function tokenize(content, notesById) {
  const tokens = [];
  const re = new RegExp(LINK_PATTERN);
  let lastIndex = 0;
  let match;

  while ((match = re.exec(content))) {
    if (match.index > lastIndex) {
      tokens.push({ type: "text", text: content.slice(lastIndex, match.index) });
    }
    const noteId = match[1];
    const displayText = match[2] || notesById.get(noteId)?.title || "заметка";
    tokens.push({ type: "link", text: displayText, noteId });
    lastIndex = match.index + match[0].length;
  }
  if (lastIndex < content.length) {
    tokens.push({ type: "text", text: content.slice(lastIndex) });
  }
  return tokens;
}

/** id заметок, на которые ссылается content — используется для backlinks. */
export function parseLinkedNoteIds(content) {
  const ids = new Set();
  const re = new RegExp(LINK_PATTERN);
  let match;
  while ((match = re.exec(content))) {
    ids.add(match[1]);
  }
  return [...ids];
}

/** Заметки, которые ссылаются на noteId. */
export function getBacklinks(noteId, allNotes) {
  return allNotes.filter((note) => note.id !== noteId && parseLinkedNoteIds(note.content).includes(noteId));
}

/**
 * HTML для режима чтения: ссылки [[id|текст]] -> кликабельные <a>,
 * выделения (highlights, offsets в видимом тексте) -> <mark>.
 */
export function renderContentHtml(content, highlights, notesById) {
  const tokens = tokenize(content, notesById);

  let cursor = 0;
  const withOffsets = tokens.map((token) => {
    const start = cursor;
    cursor += token.text.length;
    return { ...token, start, end: cursor };
  });

  const validHighlights = (highlights || [])
    .filter((h) => h.startOffset < h.endOffset)
    .sort((a, b) => a.startOffset - b.startOffset);

  return withOffsets.map((token) => renderToken(token, validHighlights)).join("");
}

function renderToken(token, highlights) {
  const overlapping = highlights.filter((h) => h.startOffset < token.end && h.endOffset > token.start);

  if (token.type === "link") {
    const linkHtml = `<a href="#" class="wiki-link" data-note-id="${token.noteId}">${escapeHtml(token.text)}</a>`;
    const fullCover = overlapping.find((h) => h.startOffset <= token.start && h.endOffset >= token.end);
    return fullCover ? `<mark data-highlight-id="${fullCover.id}">${linkHtml}</mark>` : linkHtml;
  }

  const pieces = overlapping
    .map((h) => ({ id: h.id, start: Math.max(h.startOffset, token.start), end: Math.min(h.endOffset, token.end) }))
    .filter((h) => h.start < h.end)
    .sort((a, b) => a.start - b.start);

  let html = "";
  let pos = token.start;
  for (const piece of pieces) {
    if (piece.start > pos) html += escapeHtml(token.text.slice(pos - token.start, piece.start - token.start));
    html += `<mark data-highlight-id="${piece.id}">${escapeHtml(
      token.text.slice(piece.start - token.start, piece.end - token.start)
    )}</mark>`;
    pos = piece.end;
  }
  html += escapeHtml(token.text.slice(pos - token.start));
  return html;
}
