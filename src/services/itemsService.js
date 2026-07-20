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

export async function deleteFolder(section, id) {
  const items = await storage.getItems(section);
  const affected = items.filter((item) => item.folderId === id);
  await Promise.all(affected.map((item) => storage.updateItem(item.id, { folderId: null })));
  return storage.deleteFolder(id);
}

export async function listItems(section) {
  return storage.getItems(section);
}

export async function createItem(section, { title, content, folderId }) {
  const item = createItemModel({ title, content, folderId, section });
  return storage.createItem(item);
}

export async function updateItem(id, patch) {
  return storage.updateItem(id, patch);
}

export async function deleteItem(id) {
  return storage.deleteItem(id);
}
