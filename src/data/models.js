function generateId() {
  return crypto.randomUUID();
}

export function createFolderModel({ name = "", section }) {
  return {
    id: generateId(),
    name,
    section,
    isFavorite: false,
    order: Date.now(), // порядок сортировки; переназначается при drag-and-drop
  };
}

export function createItemModel({ title = "", content = "", folderId = null, section }) {
  const now = new Date().toISOString();
  return {
    id: generateId(),
    title,
    content,
    folderId,
    section,
    isFavorite: false,
    order: Date.now(), // порядок сортировки; переназначается при drag-and-drop
    createdAt: now,
    updatedAt: now,
  };
}

export function createCalendarEntryModel({ date, title = "", type = "todo", startTime = "", endTime = "" }) {
  return {
    id: generateId(),
    date,
    title,
    type, // "note" | "todo"
    startTime,
    endTime,
    done: false,
    createdAt: new Date().toISOString(),
  };
}
