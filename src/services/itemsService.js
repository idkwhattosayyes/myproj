import { getStorage } from "../data/storageAdapter.js";
import { createFolderModel, createItemModel } from "../data/models.js";

const storage = getStorage();

export async function listFolders(section) {
  return storage.getFolders(section);
}

export async function createFolder(section, name) {
  const folder = createFolderModel({ name, section });
  return storage.createFolder(folder);
}

export async function updateFolder(id, patch) {
  return storage.updateFolder(id, patch);
}

export async function deleteFolder(section, id) {
  // Заметка может быть сразу в нескольких папках — при удалении папки убираем её
  // из членства (id из folderIds), а не выкидываем заметку в «Без папки».
  const items = await storage.getItems(section);
  const affected = items.filter((item) => item.folderIds.includes(id));
  await Promise.all(
    affected.map((item) => storage.updateItem(item.id, { folderIds: item.folderIds.filter((f) => f !== id) }))
  );
  return storage.deleteFolder(id);
}

export async function listItems(section) {
  return storage.getItems(section);
}

export async function createItem(section, { title, content, folderIds, isFavorite }) {
  const item = createItemModel({ title, content, folderIds, section, isFavorite });
  return storage.createItem(item);
}

export async function updateItem(id, patch) {
  return storage.updateItem(id, patch);
}

export async function deleteItem(id) {
  return storage.deleteItem(id);
}
