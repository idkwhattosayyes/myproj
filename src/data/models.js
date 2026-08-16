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
    deletedAt: null, // время попадания в Корзину; null = папка на своём месте
    parentFolderIds: [], // id родительских папок, в которые вложена эта папка
  };
}

export function createItemModel({ title = "", content = "", folderIds = [], section, isFavorite = false }) {
  const now = new Date().toISOString();
  return {
    id: generateId(),
    title,
    content,
    // Папки, в которых числится заметка (может быть сразу в нескольких).
    // Пустой массив = «Без папки». Заметка всегда видна и в «Все».
    folderIds,
    section,
    isFavorite,
    // Места, где заметка закреплена (наверху списка): "all" / "favorites" /
    // "unfiled" / id папки. Закрепление независимо для каждого места показа.
    pinnedIn: [],
    pageMode: "flow", // вид редактора: "flow" — сплошной лист, "paged" — постранично
    // Открывать заметку сразу прокрученной в конец текста. Для длинных заметок,
    // которые всё время дописывают снизу. Настройка своя у каждой заметки.
    openAtEnd: false,
    order: Date.now(), // порядок сортировки; переназначается при drag-and-drop
    createdAt: now,
    updatedAt: now,
    deletedAt: null, // время попадания в Корзину; null = заметка на своём месте
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

// id — необязательный параметр (единственная модель, которой он нужен снаружи):
// форма создания тега блока показывает read-only ID ещё до сохранения, поэтому
// id генерируется при открытии формы, а не здесь неявно.
// nameKey — имя в нижнем регистре, единственное поле для проверки на дубли:
// теги регистронезависимы (#yes = #Yes), а показывается всегда первый вариант.
export function createBlockTagModel({ name = "", color = "#33507e", id = generateId() }) {
  const trimmed = name.trim();
  return {
    id,
    name: trimmed,
    nameKey: trimmed.toLowerCase(),
    color,
  };
}
