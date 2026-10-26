import { getStorage } from "../data/storageAdapter.js";
import { createFolderModel, createItemModel } from "../data/models.js";
import { parentIdsOf, isAncestorOf } from "../data/folderTree.js";
import * as blockTagsService from "./blockTagsService.js";
import * as photoStorageService from "./photoStorageService.js";
import { getCachedContent, setCachedContent } from "./noteContentCache.js";

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
// Своё сама папка помнит: избранное, закрепление и родителей не сбрасываем —
// после восстановления она возвращается туда же (см. restoreFolder).
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
  return storage.updateFolder(id, { deletedAt });
}

// Папка возвращается на прежнее место. Родитель, которого за это время
// удалили (в Корзину или насовсем), отпадает — иначе папка ссылалась бы на
// невидимую папку и пропала бы с верхнего уровня. Остальные родители
// остаются; если не осталось ни одного — папка просто на верхнем уровне.
//
// alsoRestoring — папки, которые восстанавливаются тем же действием
// («Восстановить всё»): родитель из их числа живой, хоть и вернётся на
// мгновение позже — без этого связь зависела бы от порядка восстановления.
export async function restoreFolder(section, id, alsoRestoring = []) {
  const [trashed, folders] = await Promise.all([storage.getTrashedFolders(section), storage.getFolders(section)]);
  const folder = trashed.find((f) => f.id === id);
  if (!folder) return null;
  const liveIds = new Set([...folders.map((f) => f.id), ...alsoRestoring]);
  const parentFolderIds = parentIdsOf(folder).filter((parentId) => liveIds.has(parentId));
  return storage.updateFolder(id, { deletedAt: null, parentFolderIds });
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

// Кандидаты поиска — с текстом без HTML и списком фото, но без content (см.
// SearchCandidate в storageAdapter.js). У залогиненного их отбирает сервер,
// у гостя — localStorageAdapter по тем же правилам. Экспорт (settingsPanel.js)
// полный content по-прежнему берёт напрямую через storage.getItemsWithContent.
export async function searchItems(section, query, options) {
  return storage.searchItems(section, query, options);
}

// Заметка по id, без фильтра по разделу — нужна для внутренних ссылок: ссылка
// может вести на заметку из другого раздела (общий пул tasks/documents).
export async function getItem(id) {
  return storage.getItem(id);
}

// Ленивая подгрузка content для заметки, которую список отдал урезанной (см.
// listItems выше). Дедуп по noteId: два быстрых клика по одной ещё грузящейся
// заметке не должны улететь двумя запросами — второй просто дожидается той
// же заявки.
const pendingContentFetches = new Map(); // noteId -> Promise<string>

export async function getItemContent(id) {
  const cached = getCachedContent(id);
  if (cached !== undefined) return cached;
  if (pendingContentFetches.has(id)) return pendingContentFetches.get(id);
  const promise = storage
    .getItem(id)
    .then((full) => {
      const content = full ? full.content : "";
      setCachedContent(id, content);
      return content;
    })
    .finally(() => pendingContentFetches.delete(id));
  pendingContentFetches.set(id, promise);
  return promise;
}

export async function createItem(section, { title, content, folderIds, isFavorite }) {
  const item = createItemModel({ title, content, folderIds, section, isFavorite });
  const created = await storage.createItem(item);
  await blockTagsService.syncBlocksIndex(created.id, created.content);
  await photoStorageService.syncPhotosIndex(created.id, created.content);
  setCachedContent(created.id, created.content);
  return created;
}

// Модель уже построена вызывающим кодом — тот же смысл, что у
// createFolderFromModel выше (см. комментарий там).
export async function createItemFromModel(model) {
  const created = await storage.createItem(model);
  await blockTagsService.syncBlocksIndex(created.id, created.content);
  await photoStorageService.syncPhotosIndex(created.id, created.content);
  setCachedContent(created.id, created.content);
  return created;
}

// Правка текста или заголовка поднимает заметку наверх списка (см.
// sortItemsByPin в panelSection.js) — остальные патчи (избранное, закрепление,
// папка) на activityAt не влияют, иначе список прыгал бы от них тоже.
export async function updateItem(id, patch) {
  const activity = "content" in patch || "title" in patch ? { activityAt: new Date().toISOString() } : {};
  const updated = await storage.updateItem(id, { ...patch, ...activity });
  if ("content" in patch) {
    await blockTagsService.syncBlocksIndex(id, patch.content);
    await photoStorageService.syncPhotosIndex(id, patch.content);
    // Кэш ленивой подгрузки (noteContentCache.js) должен оставаться
    // актуальным после правки — иначе после ухода из раздела Notes и
    // возврата отдаст старый текст.
    setCachedContent(id, patch.content);
  }
  return updated;
}

// Заметка отправляется в Корзину со всеми связями (папки, избранное,
// закрепление) — после восстановления она возвращается туда же, где была.
// Кружок главной тоже не стирается, а только прячется (см. pruneDeadCircles).
// deletedAt — см. комментарий у moveFolderToTrash.
export async function moveItemToTrash(id, deletedAt = new Date().toISOString()) {
  return storage.updateItem(id, { deletedAt });
}

// Особые места закрепления — не папки, проверять их не на что.
const PIN_PLACES = ["all", "favorites", "unfiled"];

// Папка заметки могла за это время уйти в Корзину или удалиться насовсем —
// такую связь отбрасываем, остальные папки и закрепления возвращаем как
// были. Не осталось ни одной папки — заметка окажется в «Без папки».
export async function restoreItem(id) {
  const item = await storage.getItem(id);
  if (!item) return null;
  const folders = await storage.getFolders(item.section);
  const liveIds = new Set(folders.map((f) => f.id));
  const folderIds = item.folderIds.filter((folderId) => liveIds.has(folderId));
  const pinnedIn = item.pinnedIn.filter((place) => PIN_PLACES.includes(place) || liveIds.has(place));
  return storage.updateItem(id, { deletedAt: null, folderIds, pinnedIn });
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
  const folderIds = folders.map((f) => f.id);
  // Сначала папки, потом заметки: restoreItem оставляет заметке только живые
  // папки, а папки из этой же корзины должны к тому моменту уже вернуться
  await Promise.all(folderIds.map((id) => restoreFolder(section, id, folderIds)));
  await Promise.all(items.map((i) => restoreItem(i.id)));
}
