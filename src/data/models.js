function generateId() {
  return crypto.randomUUID();
}

export function createFolderModel({ name = "", section }) {
  return {
    id: generateId(),
    name,
    section,
    isFavorite: false,
    pinned: false, // закреплена наверху списка папок (глобально)
    order: Date.now(), // порядок сортировки; переназначается при drag-and-drop
  };
}

export function createItemModel({ title = "", content = "", folderId = null, section, isFavorite = false }) {
  const now = new Date().toISOString();
  return {
    id: generateId(),
    title,
    content,
    folderId,
    section,
    isFavorite,
    pinned: false, // закреплена наверху внутри своей папки
    pageMode: "flow", // вид редактора: "flow" — сплошной лист, "paged" — постранично
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
