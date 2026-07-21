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

export function createCalendarEntryModel({ date, title = "", type = "todo", startTime = "", endTime = "", tagId = null }) {
  return {
    id: generateId(),
    date,
    title,
    type, // "note" | "todo"
    startTime,
    endTime,
    tagId, // id тега из app:calendarTags или null
    done: false,
    createdAt: new Date().toISOString(),
  };
}

export function createCalendarTagModel({ name = "", color = "#33507e" }) {
  return {
    id: generateId(),
    name,
    color,
  };
}
