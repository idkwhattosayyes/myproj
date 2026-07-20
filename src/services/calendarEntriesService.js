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

export async function createEntry(date, { title, type, startTime, endTime }) {
  const entry = createCalendarEntryModel({ date, title, type, startTime, endTime });
  return storage.createCalendarEntry(entry);
}

export async function toggleDone(id, done) {
  return storage.updateCalendarEntry(id, { done });
}

export async function deleteEntry(id) {
  return storage.deleteCalendarEntry(id);
}
