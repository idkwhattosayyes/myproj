const STORAGE_KEYS = {
  folders: "app:folders",
  items: "app:items",
  diaryEntries: "app:diaryEntries",
  calendarEntries: "app:calendarEntries",
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

// Задачи и Документы теперь используют общий пул данных — различаются только
// доступными кнопками тулбара (config.toolbarButtons), а не хранением. Обе
// section-метки считаются алиасами друг друга при чтении, поэтому папка/заметка,
// созданная в одном разделе, сразу видна и в другом — без миграции уже
// сохранённых записей.
const TASK_DOC_SECTIONS = ["tasks", "documents"];

function matchesSection(entitySection, querySection) {
  if (TASK_DOC_SECTIONS.includes(querySection)) return TASK_DOC_SECTIONS.includes(entitySection);
  return entitySection === querySection;
}

export const localStorageAdapter = {
  // Folders (общая коллекция, отфильтрованная по section: "tasks" | "documents")
  async getFolders(section) {
    return readCollection(STORAGE_KEYS.folders).filter((folder) => matchesSection(folder.section, section));
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

  // Items (общая коллекция, отфильтрованная по section: "tasks" | "documents")
  async getItems(section) {
    return readCollection(STORAGE_KEYS.items).filter((item) => matchesSection(item.section, section));
  },
  async getItem(id) {
    return readCollection(STORAGE_KEYS.items).find((item) => item.id === id) ?? null;
  },
  async createItem(item) {
    const items = readCollection(STORAGE_KEYS.items);
    items.push(item);
    writeCollection(STORAGE_KEYS.items, items);
    return item;
  },
  async updateItem(id, patch) {
    const items = readCollection(STORAGE_KEYS.items);
    const index = items.findIndex((item) => item.id === id);
    if (index === -1) return null;
    items[index] = touch({ ...items[index], ...patch });
    writeCollection(STORAGE_KEYS.items, items);
    return items[index];
  },
  async deleteItem(id) {
    const items = readCollection(STORAGE_KEYS.items).filter((item) => item.id !== id);
    writeCollection(STORAGE_KEYS.items, items);
  },

  // Diary entries (один на дату) — данные не трогаем, UI на них больше не ссылается
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

  // Calendar entries — лёгкие пункты списка на конкретную дату (не rich-text)
  async getCalendarEntries(date) {
    return readCollection(STORAGE_KEYS.calendarEntries).filter((entry) => entry.date === date);
  },
  async getAllCalendarEntryDates() {
    return [...new Set(readCollection(STORAGE_KEYS.calendarEntries).map((entry) => entry.date))];
  },
  async createCalendarEntry(entry) {
    const entries = readCollection(STORAGE_KEYS.calendarEntries);
    entries.push(entry);
    writeCollection(STORAGE_KEYS.calendarEntries, entries);
    return entry;
  },
  async updateCalendarEntry(id, patch) {
    const entries = readCollection(STORAGE_KEYS.calendarEntries);
    const index = entries.findIndex((entry) => entry.id === id);
    if (index === -1) return null;
    entries[index] = { ...entries[index], ...patch };
    writeCollection(STORAGE_KEYS.calendarEntries, entries);
    return entries[index];
  },
  async deleteCalendarEntry(id) {
    const entries = readCollection(STORAGE_KEYS.calendarEntries).filter((entry) => entry.id !== id);
    writeCollection(STORAGE_KEYS.calendarEntries, entries);
  },
};
