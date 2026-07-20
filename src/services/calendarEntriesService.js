import { getStorage } from "../data/storageAdapter.js";
import { createCalendarEntryModel } from "../data/models.js";

const storage = getStorage();

export async function listForDate(date) {
  return storage.getCalendarEntries(date);
}

/** Все даты, у которых есть хотя бы один пункт — для точек-маркеров. */
export async function listAllDates() {
  return storage.getAllCalendarEntryDates();
}

export async function createEntry(date, title) {
  const entry = createCalendarEntryModel({ date, title });
  return storage.createCalendarEntry(entry);
}

export async function toggleDone(id, done) {
  return storage.updateCalendarEntry(id, { done });
}

export async function deleteEntry(id) {
  return storage.deleteCalendarEntry(id);
}
