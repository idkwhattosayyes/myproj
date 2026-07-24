import { getStorage } from "../data/storageAdapter.js";

// Экспорт/импорт заметок и папок одним JSON-файлом. Форматирование хранится
// прямо в item.content (HTML), поэтому выгрузка моделей сохраняет жирность,
// цвета, ссылки и вставленные фото как есть — импорт восстанавливает точь-в-точь.
const EXPORT_VERSION = 1;

// Экспорт из выбранного набора (дерево с галочками). Набор папок/заметок приходит
// уже согласованным: дерево добавляет папки-владельцев выбранных заметок само.
export function buildExportFrom(folders, items) {
  return {
    app: "myproj",
    version: EXPORT_VERSION,
    exportedAt: new Date().toISOString(),
    scope: "custom",
    folders,
    items,
  };
}

export function downloadJson(data, filename) {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

// Открывает диалог выбора файла и возвращает разобранный JSON (или null, если
// пользователь ничего не выбрал). Бросает, если файл — не валидный JSON.
export function readJsonFile() {
  return new Promise((resolve, reject) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = "application/json,.json";
    input.addEventListener("change", () => {
      const file = input.files && input.files[0];
      if (!file) {
        resolve(null);
        return;
      }
      const reader = new FileReader();
      reader.onload = () => {
        try {
          resolve(JSON.parse(String(reader.result)));
        } catch {
          reject(new Error("bad-json"));
        }
      };
      reader.onerror = () => reject(new Error("read-failed"));
      reader.readAsText(file);
    });
    input.click();
  });
}

export function isValidExport(data) {
  return !!data && data.app === "myproj" && Array.isArray(data.items);
}

// Создаёт новые записи, не затирая существующие. Старые id папок перемаппливаем
// на свежие, чтобы принадлежность импортируемых заметок указывала на вновь
// созданные папки, а не на возможно чужие/несуществующие. Поддерживаем и старый
// формат (folderId/pinned скаляры), и новый (folderIds/pinnedIn массивы).
export async function importData(data) {
  const storage = getStorage();
  const now = new Date().toISOString();
  const folderIdMap = new Map();

  for (const folder of data.folders || []) {
    const newId = crypto.randomUUID();
    folderIdMap.set(folder.id, newId);
    await storage.createFolder({ ...folder, id: newId });
  }

  for (const item of data.items) {
    const srcFolderIds = Array.isArray(item.folderIds) ? item.folderIds : item.folderId ? [item.folderId] : [];
    // Папки не из набора экспорта отбрасываем (folderIdMap.get вернёт undefined).
    const folderIds = srcFolderIds.map((id) => folderIdMap.get(id)).filter(Boolean);
    const srcPinnedIn = Array.isArray(item.pinnedIn) ? item.pinnedIn : item.pinned ? ["all"] : [];
    // Спец-ключи мест оставляем как есть, id папок ремапим (неизвестные отбрасываем).
    const pinnedIn = srcPinnedIn
      .map((key) => (key === "all" || key === "favorites" || key === "unfiled" ? key : folderIdMap.get(key)))
      .filter(Boolean);
    await storage.createItem({
      ...item,
      id: crypto.randomUUID(),
      folderIds,
      pinnedIn,
      createdAt: item.createdAt || now,
      updatedAt: now,
    });
  }

  return { folders: (data.folders || []).length, items: data.items.length };
}
