import { getStorage } from "../data/storageAdapter.js";
import { createNoteModel, createFolderModel } from "../data/models.js";

const storage = getStorage();

export async function listNotes() {
  return storage.getNotes();
}

export async function listFolders() {
  return storage.getFolders();
}

export async function listTags() {
  const notes = await storage.getNotes();
  const tagSet = new Set();
  notes.forEach((note) => (note.tags || []).forEach((tag) => tagSet.add(tag)));
  return [...tagSet].sort((a, b) => a.localeCompare(b));
}

export async function createNote({ title, content, folderId, tags }) {
  const note = createNoteModel({ title, content, folderId, tags });
  return storage.createNote(note);
}

export async function updateNote(id, patch) {
  return storage.updateNote(id, patch);
}

export async function deleteNote(id) {
  return storage.deleteNote(id);
}

export async function createFolder({ name, parentId }) {
  const folder = createFolderModel({ name, parentId });
  return storage.createFolder(folder);
}

export async function deleteFolder(id) {
  const notes = await storage.getNotes();
  const affected = notes.filter((note) => note.folderId === id);
  await Promise.all(affected.map((note) => storage.updateNote(note.id, { folderId: null })));
  return storage.deleteFolder(id);
}

export async function addHighlight(noteId, highlight) {
  const note = await storage.getNote(noteId);
  if (!note) return null;
  const highlights = [...(note.highlights || []), highlight];
  return storage.updateNote(noteId, { highlights });
}

export async function removeHighlight(noteId, highlightId) {
  const note = await storage.getNote(noteId);
  if (!note) return null;
  const highlights = (note.highlights || []).filter((h) => h.id !== highlightId);
  return storage.updateNote(noteId, { highlights });
}
