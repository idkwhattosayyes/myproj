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

// Папка отправляется в Корзину, а не удаляется насовсем. Заметка может быть
// сразу в нескольких папках — как и раньше, при удалении папки убираем её из
// членства (id из folderIds), а не выкидываем заметку в «Без папки» целиком;
// вложенные заметки в Корзину НЕ уходят.
export async function moveFolderToTrash(section, id) {
  const items = await storage.getItems(section);
  const affected = items.filter((item) => item.folderIds.includes(id));
  await Promise.all(
    affected.map((item) => storage.updateItem(item.id, { folderIds: item.folderIds.filter((f) => f !== id) }))
  );
  return storage.updateFolder(id, { deletedAt: new Date().toISOString(), isFavorite: false, pinned: false });
}

// Восстановленная папка возвращается «неприкреплённой» — избранное и
// закрепление уже сброшены в момент удаления и здесь не трогаются.
export async function restoreFolder(id) {
  return storage.updateFolder(id, { deletedAt: null });
}

export async function deleteFolderForever(id) {
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

// Заметка отправляется в Корзину: связи (папки, избранное, закрепление)
// сбрасываются сразу — при восстановлении они не возвращаются.
export async function moveItemToTrash(id) {
  return storage.updateItem(id, { deletedAt: new Date().toISOString(), isFavorite: false, pinnedIn: [], folderIds: [] });
}

export async function restoreItem(id) {
  return storage.updateItem(id, { deletedAt: null });
}

export async function deleteItemForever(id) {
  return storage.deleteItem(id);
}

export async function listTrash(section) {
  const [folders, items] = await Promise.all([storage.getTrashedFolders(section), storage.getTrashedItems(section)]);
  return { folders, items };
}

export async function emptyTrash(section) {
  const { folders, items } = await listTrash(section);
  await Promise.all([...folders.map((f) => deleteFolderForever(f.id)), ...items.map((i) => deleteItemForever(i.id))]);
}

export async function restoreAllTrash(section) {
  const { folders, items } = await listTrash(section);
  await Promise.all([...folders.map((f) => restoreFolder(f.id)), ...items.map((i) => restoreItem(i.id))]);
}
