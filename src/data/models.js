function generateId() {
  return crypto.randomUUID();
}

export function createFolderModel({ name = "", section }) {
  return {
    id: generateId(),
    name,
    section,
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
    createdAt: now,
    updatedAt: now,
  };
}

export function createCalendarEntryModel({ date, title = "" }) {
  return {
    id: generateId(),
    date,
    title,
    done: false,
    createdAt: new Date().toISOString(),
  };
}
