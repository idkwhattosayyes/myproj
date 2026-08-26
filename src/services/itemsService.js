import { getStorage } from "../data/storageAdapter.js";
import { createFolderModel, createItemModel } from "../data/models.js";
import { parentIdsOf, isAncestorOf } from "../data/folderTree.js";
import * as blockTagsService from "./blockTagsService.js";

const storage = getStorage();

export async function listFolders(section) {
  return storage.getFolders(section);
}

// Модель уже построена вызывающим кодом (id сгенерирован раньше, до этого
// вызова) — нужно для оптимистичного UI: panelSection.js сразу показывает
// объект на экране и persist'ит ровно ЕГО ЖЕ, а не строит новый с другим id.
export async function createFolderFromModel(model) {
  return storage.createFolder(model);
}

export async function updateFolder(id, patch) {
  return storage.updateFolder(id, patch);
}

// Перестановка меняет порядок сразу у многих записей. Отдельный метод, а не
// цикл из updateFolder/updateItem: у адаптера это одна запись в хранилище
// вместо одной на каждую сдвинувшуюся строку. orderById — { id: order }.
export async function setFoldersOrder(orderById) {
  return storage.setFoldersOrder(orderById);
}

export async function setItemsOrder(orderById) {
  return storage.setItemsOrder(orderById);
}

// Папка отправляется в Корзину, а не удаляется насовсем. Заметка может быть
// сразу в нескольких папках — как и раньше, при удалении папки убираем её из
// членства (id из folderIds), а не выкидываем заметку в «Без папки» целиком;
// вложенные заметки в Корзину НЕ уходят.
//
// deletedAt — необязательный: оптимистичный UI (panelSection.js) считает его
// ОДИН раз и передаёт сюда же, чтобы локальная и сохранённая версии не
// разъехались на пару миллисекунд (иначе при пакетном удалении может съехать
// сортировка корзины по времени).
export async function moveFolderToTrash(section, id, deletedAt = new Date().toISOString()) {
  const items = await storage.getItems(section);
  const affected = items.filter((item) => item.folderIds.includes(id));
  await Promise.all(
    affected.map((item) => storage.updateItem(item.id, { folderIds: item.folderIds.filter((f) => f !== id) }))
  );
  // Папки, вложенные в удаляемую, остаются в общем списке, но теряют связь с
  // ней как с родителем — как и у заметок выше, это необратимо при restore.
  const folders = await storage.getFolders(section);
  const nestedChildren = folders.filter((f) => parentIdsOf(f).includes(id));
  await Promise.all(
    nestedChildren.map((f) =>
      storage.updateFolder(f.id, { parentFolderIds: parentIdsOf(f).filter((p) => p !== id) })
    )
  );
  return storage.updateFolder(id, {
    deletedAt,
    isFavorite: false,
    pinned: false,
    parentFolderIds: [], // и сама папка выходит из ВСЕХ своих родителей
  });
}

// Восстановленная папка возвращается «неприкреплённой» — избранное, закрепление
// и родительские связи уже сброшены в момент удаления и здесь не трогаются.
export async function restoreFolder(id) {
  return storage.updateFolder(id, { deletedAt: null });
}

// Каскад по parentFolderIds уже выполнен в moveFolderToTrash в момент
// попадания папки в Корзину — к моменту permanent delete ссылок на неё как
// на родителя ни у кого не остаётся, чистить нечего.
export async function deleteFolderForever(id) {
  return storage.deleteFolder(id);
}

// Вкладывает folderId в parentId. null, если это создало бы цикл, папка не
// найдена, или уже вложена туда (тогда просто no-op, без дублей).
export async function moveFolderInto(section, folderId, parentId) {
  if (folderId === parentId) return null;
  const folders = await storage.getFolders(section);
  const folder = folders.find((f) => f.id === folderId);
  if (!folder) return null;
  if (parentIdsOf(folder).includes(parentId)) return folder;
  if (isAncestorOf(folders, folderId, parentId)) return null;
  return storage.updateFolder(folderId, { parentFolderIds: [...parentIdsOf(folder), parentId] });
}

// Убирает связь «папка → этот родитель», не трогая остальных родителей и саму
// папку — аналог panel.removeFromFolder у заметок, но для родительской связи.
export async function removeFolderFromParent(section, folderId, parentId) {
  const folders = await storage.getFolders(section);
  const folder = folders.find((f) => f.id === folderId);
  if (!folder) return null;
  return storage.updateFolder(folderId, { parentFolderIds: parentIdsOf(folder).filter((p) => p !== parentId) });
}

export async function listItems(section) {
  return storage.getItems(section);
}

// Заметка по id, без фильтра по разделу — нужна для внутренних ссылок: ссылка
// может вести на заметку из другого раздела (общий пул tasks/documents).
export async function getItem(id) {
  return storage.getItem(id);
}

export async function createItem(section, { title, content, folderIds, isFavorite }) {
  const item = createItemModel({ title, content, folderIds, section, isFavorite });
  const created = await storage.createItem(item);
  await blockTagsService.syncBlocksIndex(created.id, created.content);
  return created;
}

// Модель уже построена вызывающим кодом — тот же смысл, что у
// createFolderFromModel выше (см. комментарий там).
export async function createItemFromModel(model) {
  const created = await storage.createItem(model);
  await blockTagsService.syncBlocksIndex(created.id, created.content);
  return created;
}

// Правка текста или заголовка поднимает заметку наверх списка (см.
// sortItemsByPin в panelSection.js) — остальные патчи (избранное, закрепление,
// папка) на activityAt не влияют, иначе список прыгал бы от них тоже.
export async function updateItem(id, patch) {
  const activity = "content" in patch || "title" in patch ? { activityAt: new Date().toISOString() } : {};
  const updated = await storage.updateItem(id, { ...patch, ...activity });
  if ("content" in patch) await blockTagsService.syncBlocksIndex(id, patch.content);
  return updated;
}

// Заметка отправляется в Корзину: связи (папки, избранное, закрепление)
// сбрасываются сразу — при восстановлении они не возвращаются. deletedAt —
// см. комментарий у moveFolderToTrash.
export async function moveItemToTrash(id, deletedAt = new Date().toISOString()) {
  return storage.updateItem(id, { deletedAt, isFavorite: false, pinnedIn: [], folderIds: [] });
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
