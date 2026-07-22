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

/** Все записи разом — для сквозного списка событий рядом с календарём. */
export async function listAll() {
  return storage.getAllCalendarEntries();
}

export async function createEntry(date, { title, type, startTime, endTime, tagId }) {
  const entry = createCalendarEntryModel({ date, title, type, startTime, endTime, tagId });
  return storage.createCalendarEntry(entry);
}

/**
 * Сводка по датам для маркеров на кружках дней: у каждой даты — количество
 * записей и цвета их тегов. Цвет тега подставляется из переданного списка тегов.
 * @returns {Promise<Map<string, {count: number, colors: string[]}>>}
 */
export async function listDateSummaries(tags) {
  const tagColor = new Map(tags.map((tag) => [tag.id, tag.color]));
  const entries = await storage.getAllCalendarEntries();
  const summaries = new Map();
  for (const entry of entries) {
    const summary = summaries.get(entry.date) || { count: 0, colors: [] };
    summary.count += 1;
    if (entry.tagId && tagColor.has(entry.tagId)) summary.colors.push(tagColor.get(entry.tagId));
    summaries.set(entry.date, summary);
  }
  return summaries;
}

export async function toggleDone(id, done) {
  return storage.updateCalendarEntry(id, { done });
}

export async function updateEntry(id, patch) {
  return storage.updateCalendarEntry(id, patch);
}

export async function deleteEntry(id) {
  return storage.deleteCalendarEntry(id);
}
