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

// Папки, созданные до появления вложенности, ещё не имеют parentFolderIds в
// хранилище — везде, где это поле читаем, подстраховываемся пустым массивом
// (тот же приём, что и у item.pinnedIn).
function parentIdsOf(folder) {
  return folder.parentFolderIds || [];
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
    deletedAt: new Date().toISOString(),
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

// Обходит ВСЕ пути вверх по parentFolderIds (родителей может быть несколько) —
// true, если candidateAncestorId встречается среди предков startId.
function isAncestorOf(folders, candidateAncestorId, startId) {
  const visited = new Set();
  const stack = [startId];
  while (stack.length) {
    const currentId = stack.pop();
    if (currentId === candidateAncestorId) return true;
    if (visited.has(currentId)) continue;
    visited.add(currentId);
    const node = folders.find((f) => f.id === currentId);
    if (!node) continue;
    for (const parentId of parentIdsOf(node)) stack.push(parentId);
  }
  return false;
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
