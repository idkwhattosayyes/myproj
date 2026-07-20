const STORAGE_KEYS = {
  notes: "app:notes",
  folders: "app:folders",
  diaryEntries: "app:diaryEntries",
};

function readCollection(key) {
  const raw = localStorage.getItem(key);
  return raw ? JSON.parse(raw) : [];
}

function writeCollection(key, items) {
  localStorage.setItem(key, JSON.stringify(items));
}

function touch(item) {
  return { ...item, updatedAt: new Date().toISOString() };
}

export const localStorageAdapter = {
  // Notes
  async getNotes() {
    return readCollection(STORAGE_KEYS.notes);
  },
  async getNote(id) {
    return readCollection(STORAGE_KEYS.notes).find((note) => note.id === id) ?? null;
  },
  async createNote(note) {
    const notes = readCollection(STORAGE_KEYS.notes);
    notes.push(note);
    writeCollection(STORAGE_KEYS.notes, notes);
    return note;
  },
  async updateNote(id, patch) {
    const notes = readCollection(STORAGE_KEYS.notes);
    const index = notes.findIndex((note) => note.id === id);
    if (index === -1) return null;
    notes[index] = touch({ ...notes[index], ...patch });
    writeCollection(STORAGE_KEYS.notes, notes);
    return notes[index];
  },
  async deleteNote(id) {
    const notes = readCollection(STORAGE_KEYS.notes).filter((note) => note.id !== id);
    writeCollection(STORAGE_KEYS.notes, notes);
  },

  // Folders
  async getFolders() {
    return readCollection(STORAGE_KEYS.folders);
  },
  async createFolder(folder) {
    const folders = readCollection(STORAGE_KEYS.folders);
    folders.push(folder);
    writeCollection(STORAGE_KEYS.folders, folders);
    return folder;
  },
  async updateFolder(id, patch) {
    const folders = readCollection(STORAGE_KEYS.folders);
    const index = folders.findIndex((folder) => folder.id === id);
    if (index === -1) return null;
    folders[index] = { ...folders[index], ...patch };
    writeCollection(STORAGE_KEYS.folders, folders);
    return folders[index];
  },
  async deleteFolder(id) {
    const folders = readCollection(STORAGE_KEYS.folders).filter((folder) => folder.id !== id);
    writeCollection(STORAGE_KEYS.folders, folders);
  },

  // Diary entries (one per date)
  async getDiaryEntries() {
    return readCollection(STORAGE_KEYS.diaryEntries);
  },
  async getDiaryEntryByDate(date) {
    return readCollection(STORAGE_KEYS.diaryEntries).find((entry) => entry.date === date) ?? null;
  },
  async upsertDiaryEntry(date, content) {
    const entries = readCollection(STORAGE_KEYS.diaryEntries);
    const index = entries.findIndex((entry) => entry.date === date);
    if (index === -1) {
      const now = new Date().toISOString();
      const entry = { id: crypto.randomUUID(), date, content, createdAt: now, updatedAt: now };
      entries.push(entry);
      writeCollection(STORAGE_KEYS.diaryEntries, entries);
      return entry;
    }
    entries[index] = touch({ ...entries[index], content });
    writeCollection(STORAGE_KEYS.diaryEntries, entries);
    return entries[index];
  },
  async deleteDiaryEntry(id) {
    const entries = readCollection(STORAGE_KEYS.diaryEntries).filter((entry) => entry.id !== id);
    writeCollection(STORAGE_KEYS.diaryEntries, entries);
  },
};
