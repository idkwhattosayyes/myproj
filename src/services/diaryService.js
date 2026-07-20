import { getStorage } from "../data/storageAdapter.js";

const storage = getStorage();

export async function getEntryByDate(date) {
  return storage.getDiaryEntryByDate(date);
}

export async function saveEntry(date, content) {
  return storage.upsertDiaryEntry(date, content);
}

export async function listEntries() {
  return storage.getDiaryEntries();
}
