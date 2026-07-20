import { getStorage } from "../data/storageAdapter.js";
import { formatDate } from "../utils/date.js";

const storage = getStorage();

/**
 * @param {string} query
 * @param {{type: "all"} | {type: "folder", folderId: string} | {type: "note", noteId: string}} scope
 */
export async function search(query, scope) {
  const q = query.trim().toLowerCase();
  if (!q) return [];

  if (scope.type === "note") {
    const note = await storage.getNote(scope.noteId);
    return note && matchesNote(note, q) ? [toNoteResult(note, q)] : [];
  }

  const notes = await storage.getNotes();
  const scopedNotes = scope.type === "folder" ? notes.filter((note) => note.folderId === scope.folderId) : notes;
  const results = scopedNotes.filter((note) => matchesNote(note, q)).map((note) => toNoteResult(note, q));

  if (scope.type === "all") {
    const entries = await storage.getDiaryEntries();
    entries
      .filter((entry) => entry.content.toLowerCase().includes(q))
      .forEach((entry) => results.push(toDiaryResult(entry, q)));
  }

  return results;
}

function matchesNote(note, q) {
  return note.title.toLowerCase().includes(q) || note.content.toLowerCase().includes(q);
}

function toNoteResult(note, q) {
  return {
    type: "note",
    id: note.id,
    title: note.title || "Без названия",
    snippet: buildSnippet(note.content || note.title, q),
  };
}

function toDiaryResult(entry, q) {
  return {
    type: "diary",
    id: entry.id,
    date: entry.date,
    title: formatDate(entry.date),
    snippet: buildSnippet(entry.content, q),
  };
}

function buildSnippet(text, q) {
  const lower = text.toLowerCase();
  const idx = lower.indexOf(q);
  if (idx === -1) return text.slice(0, 80);
  const start = Math.max(0, idx - 30);
  const end = Math.min(text.length, idx + q.length + 30);
  return (start > 0 ? "…" : "") + text.slice(start, end) + (end < text.length ? "…" : "");
}
