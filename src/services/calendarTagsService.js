import { getStorage } from "../data/storageAdapter.js";
import { createCalendarTagModel } from "../data/models.js";

const storage = getStorage();

export async function listTags() {
  return storage.getCalendarTags();
}

export async function createTag({ name, color }) {
  const tag = createCalendarTagModel({ name, color });
  return storage.createCalendarTag(tag);
}

export async function deleteTag(id) {
  return storage.deleteCalendarTag(id);
}
