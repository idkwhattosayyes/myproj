const STORAGE_KEYS = {
  folders: "app:folders",
  items: "app:items",
  diaryEntries: "app:diaryEntries",
  calendarEntries: "app:calendarEntries",
  calendarTags: "app:calendarTags",
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

// Сортировка по полю order (задаётся drag-and-drop). Старые записи без order
// считаем как 0 — при стабильной сортировке они сохраняют порядок вставки.
function byOrder(a, b) {
  return (a.order ?? 0) - (b.order ?? 0);
}

// Приводим заметку к новой форме на чтении, чтобы код выше по стеку всегда видел
// массивы, а старые записи не требовали разовой миграции:
//   folderId (скаляр) → folderIds (массив; заметка может быть сразу в нескольких папках)
//   pinned (булев)    → pinnedIn (места закрепления: "all"/"favorites"/"unfiled"/id папки)
// Идемпотентно: если новые поля уже есть, берём их; legacy-скаляры игнорируем.
function normalizeItem(item) {
  const folderIds = Array.isArray(item.folderIds) ? item.folderIds : item.folderId ? [item.folderId] : [];
  const pinnedIn = Array.isArray(item.pinnedIn) ? item.pinnedIn : item.pinned ? ["all"] : [];
  return { ...item, folderIds, pinnedIn };
}

export const localStorageAdapter = {
  // Folders (общая коллекция, отфильтрованная по section: "tasks" | "documents")
  async getFolders(section) {
    return readCollection(STORAGE_KEYS.folders)
      .filter((folder) => matchesSection(folder.section, section))
      .sort(byOrder);
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
    return readCollection(STORAGE_KEYS.items)
      .filter((item) => matchesSection(item.section, section))
      .map(normalizeItem)
      .sort(byOrder);
  },
  async getItem(id) {
    const item = readCollection(STORAGE_KEYS.items).find((item) => item.id === id);
    return item ? normalizeItem(item) : null;
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
  async getAllCalendarEntries() {
    return readCollection(STORAGE_KEYS.calendarEntries);
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

  // Полный сброс пользовательских данных. Настройки (язык, обводка) живут под
  // своими ключами и намеренно переживают очистку — это не данные, а вид приложения.
  async clearAll() {
    Object.values(STORAGE_KEYS).forEach((key) => localStorage.removeItem(key));
  },

  // Calendar tags — пользовательские метки {id, name, color}, привязываются к записям
  async getCalendarTags() {
    return readCollection(STORAGE_KEYS.calendarTags);
  },
  async createCalendarTag(tag) {
    const tags = readCollection(STORAGE_KEYS.calendarTags);
    tags.push(tag);
    writeCollection(STORAGE_KEYS.calendarTags, tags);
    return tag;
  },
  async deleteCalendarTag(id) {
    const tags = readCollection(STORAGE_KEYS.calendarTags).filter((tag) => tag.id !== id);
    writeCollection(STORAGE_KEYS.calendarTags, tags);
  },
};
