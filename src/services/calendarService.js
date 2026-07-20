import { getStorage } from "../data/storageAdapter.js";

const storage = getStorage();

/** Множество дат ('YYYY-MM-DD'), на которые есть запись в дневнике. */
export async function getMarkedDates() {
  const entries = await storage.getDiaryEntries();
  return new Set(entries.map((entry) => entry.date));
}
