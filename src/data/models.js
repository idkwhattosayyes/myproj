function generateId() {
  return crypto.randomUUID();
}

export function createNoteModel({ title = "", content = "", folderId = null, tags = [] } = {}) {
  const now = new Date().toISOString();
  return {
    id: generateId(),
    title,
    content,
    folderId,
    tags,
    highlights: [],
    createdAt: now,
    updatedAt: now,
  };
}

export function createFolderModel({ name = "", parentId = null } = {}) {
  return {
    id: generateId(),
    name,
    parentId,
  };
}

export function createDiaryEntryModel({ date, content = "" } = {}) {
  const now = new Date().toISOString();
  return {
    id: generateId(),
    date,
    content,
    createdAt: now,
    updatedAt: now,
  };
}
