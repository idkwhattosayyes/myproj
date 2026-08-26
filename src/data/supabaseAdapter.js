// Заметки, папки, теги блоков, избранное/закрепление и фото/рисунки (Storage +
// производный индекс images/drawings) для залогиненного пользователя — через
// Supabase. Остальные методы контракта (дневник, календарь, clearAll) сюда не
// входят, их для залогиненных тоже отдаёт localStorageAdapter — маршрутизация
// в storageAdapter.js.
import { supabaseClient } from "./supabaseClient.js";
import { getCachedSession } from "../auth/authService.js";
import { withSaveStatus } from "../utils/saveStatus.js";

// section в живых Supabase-данных всегда "notes" (легаси tasks/documents —
// мёртвый код на localStorage-стороне), поэтому здесь она читается/пишется
// как константа — отдельной колонки под неё нет.

const ITEM_FIELD_MAP = {
  title: "title",
  content: "content",
  pageMode: "page_mode",
  openAtEnd: "open_at_end",
  order: "sort_order",
  createdAt: "created_at",
  updatedAt: "updated_at",
  activityAt: "activity_at",
  deletedAt: "deleted_at",
};

const FOLDER_FIELD_MAP = {
  name: "name",
  color: "color",
  icon: "icon",
  order: "sort_order",
  deletedAt: "deleted_at",
};

function toRow(fieldMap, source) {
  const row = {};
  for (const [jsKey, column] of Object.entries(fieldMap)) {
    if (jsKey in source) row[column] = source[jsKey];
  }
  return row;
}

function mapItemRow(row, folderIds, isFavorite, pinnedIn) {
  return {
    id: row.id,
    title: row.title,
    content: row.content,
    folderIds,
    section: "notes",
    isFavorite,
    pinnedIn,
    pageMode: row.page_mode,
    openAtEnd: row.open_at_end,
    order: row.sort_order,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    activityAt: row.activity_at,
    deletedAt: row.deleted_at,
  };
}

// nameKey (JS, нормализованное для проверки на дубли) ↔ name (Postgres,
// unique(user_id, name)); name (JS, как ввёл пользователь) ↔ display_name.
function mapTagRow(row) {
  return { id: row.id, name: row.display_name, nameKey: row.name, color: row.color };
}

function mapFolderRow(row, parentFolderIds, isFavorite, pinned) {
  return {
    id: row.id,
    name: row.name,
    section: "notes",
    isFavorite,
    pinned,
    order: row.sort_order,
    deletedAt: row.deleted_at,
    parentFolderIds,
  };
}

// note_folder_links/folder_folder_links — RLS уже сузила их до строк текущего
// пользователя, поэтому здесь читаем таблицу связи целиком и склеиваем в JS.
// Так проще и читаемее, чем PostgREST embed-синтаксис с двумя внешними ключами
// folder_folder_links → folders (parent/child) — там пришлось бы явно называть
// авто-сгенерированные имена констрейнтов.
async function fetchFolderIdsByNoteId() {
  const { data, error } = await supabaseClient.from("note_folder_links").select("note_id, folder_id");
  if (error) throw error;
  const map = new Map();
  for (const row of data) {
    const list = map.get(row.note_id) || [];
    list.push(row.folder_id);
    map.set(row.note_id, list);
  }
  return map;
}

async function fetchFolderIdsForNote(noteId) {
  const { data, error } = await supabaseClient.from("note_folder_links").select("folder_id").eq("note_id", noteId);
  if (error) throw error;
  return data.map((row) => row.folder_id);
}

async function replaceNoteFolderLinks(noteId, folderIds) {
  const { error: delError } = await supabaseClient.from("note_folder_links").delete().eq("note_id", noteId);
  if (delError) throw delError;
  if (!folderIds.length) return;
  const rows = folderIds.map((folderId) => ({ note_id: noteId, folder_id: folderId }));
  const { error: insError } = await supabaseClient.from("note_folder_links").insert(rows);
  if (insError) throw insError;
}

async function fetchParentFolderIdsByFolderId() {
  const { data, error } = await supabaseClient.from("folder_folder_links").select("parent_folder_id, child_folder_id");
  if (error) throw error;
  const map = new Map();
  for (const row of data) {
    const list = map.get(row.child_folder_id) || [];
    list.push(row.parent_folder_id);
    map.set(row.child_folder_id, list);
  }
  return map;
}

async function fetchParentFolderIdsFor(folderId) {
  const { data, error } = await supabaseClient.from("folder_folder_links").select("parent_folder_id").eq("child_folder_id", folderId);
  if (error) throw error;
  return data.map((row) => row.parent_folder_id);
}

async function replaceFolderFolderLinks(childFolderId, parentFolderIds) {
  const { error: delError } = await supabaseClient.from("folder_folder_links").delete().eq("child_folder_id", childFolderId);
  if (delError) throw delError;
  if (!parentFolderIds.length) return;
  const rows = parentFolderIds.map((parentId) => ({ parent_folder_id: parentId, child_folder_id: childFolderId }));
  const { error: insError } = await supabaseClient.from("folder_folder_links").insert(rows);
  if (insError) throw insError;
}

// Избранное — просто наличие строки. upsert вместо insert+"проглотить unique-
// violation": повторный клик/гонка при быстром двойном тоггле не должны
// падать на нарушении уникальности (user_id, item_type, item_id) — upsert
// идемпотентен, не требует разбора кода ошибки Postgres. RLS with check уже
// гарантирует user_id.
async function setFavorite(itemType, itemId, isFavorite) {
  if (isFavorite) {
    const { error } = await supabaseClient
      .from("favorites")
      .upsert(
        { user_id: getCachedSession().user.id, item_type: itemType, item_id: itemId },
        { onConflict: "user_id,item_type,item_id" }
      );
    if (error) throw error;
  } else {
    const { error } = await supabaseClient.from("favorites").delete().eq("item_type", itemType).eq("item_id", itemId);
    if (error) throw error;
  }
}

async function fetchIsFavorite(itemType, itemId) {
  const { data, error } = await supabaseClient
    .from("favorites")
    .select("id")
    .eq("item_type", itemType)
    .eq("item_id", itemId)
    .maybeSingle();
  if (error) throw error;
  return !!data;
}

// Bulk-версия fetchIsFavorite — один запрос на весь список (getItems/getFolders),
// а не по запросу на карточку.
async function fetchFavoriteIdSet(itemType) {
  const { data, error } = await supabaseClient.from("favorites").select("item_id").eq("item_type", itemType);
  if (error) throw error;
  return new Set(data.map((row) => row.item_id));
}

// Закрепление — снос-и-пересоздание строк pins для одной сущности (тот же
// приём, что replaceNoteFolderLinks выше). У заметки contexts = pinnedIn как
// есть (0+ мест показа сразу). У папки закрепление глобальное (folder.pinned,
// булев) — вызывающий код сводит его к contexts = pinned ? ["global"] : [].
// "global" — литерал, который никогда не совпадёт ни с одним из мест показа
// заметки ("all"/"favorites"/"unfiled"/uuid папки), поэтому одна функция
// безопасно обслуживает оба item_type. Дедуп на входе — contexts дублей
// давать не должен, но повторный элемент в одном insert упёрся бы в
// unique-constraint (пакетный insert сам не дедуплицирует).
async function replacePins(itemType, itemId, contexts) {
  const { error: delError } = await supabaseClient.from("pins").delete().eq("item_type", itemType).eq("item_id", itemId);
  if (delError) throw delError;
  const uniqueContexts = [...new Set(contexts)];
  if (!uniqueContexts.length) return;
  const userId = getCachedSession().user.id;
  const rows = uniqueContexts.map((sectionContext) => ({
    user_id: userId,
    item_type: itemType,
    item_id: itemId,
    section_context: sectionContext,
  }));
  const { error: insError } = await supabaseClient.from("pins").insert(rows);
  if (insError) throw insError;
}

async function fetchPinnedIn(itemType, itemId) {
  const { data, error } = await supabaseClient
    .from("pins")
    .select("section_context")
    .eq("item_type", itemType)
    .eq("item_id", itemId);
  if (error) throw error;
  return data.map((row) => row.section_context);
}

// Bulk-версия fetchPinnedIn — один запрос на весь список.
async function fetchPinsByItemId(itemType) {
  const { data, error } = await supabaseClient.from("pins").select("item_id, section_context").eq("item_type", itemType);
  if (error) throw error;
  const map = new Map();
  for (const row of data) {
    const list = map.get(row.item_id) || [];
    list.push(row.section_context);
    map.set(row.item_id, list);
  }
  return map;
}

export const supabaseAdapter = {
  // Folders ------------------------------------------------------------
  async getFolders() {
    const [foldersResult, parentIdsByFolder, favoriteIds, pinsByFolder] = await Promise.all([
      supabaseClient.from("folders").select("*").is("deleted_at", null).order("sort_order"),
      fetchParentFolderIdsByFolderId(),
      fetchFavoriteIdSet("folder"),
      fetchPinsByItemId("folder"),
    ]);
    if (foldersResult.error) throw foldersResult.error;
    return foldersResult.data.map((row) =>
      mapFolderRow(
        row,
        parentIdsByFolder.get(row.id) || [],
        favoriteIds.has(row.id),
        (pinsByFolder.get(row.id) || []).includes("global")
      )
    );
  },

  // Корзина: попадание в неё гарантированно уже сбросило isFavorite/pinned до
  // false — deletedAt ставит только itemsService.moveFolderToTrash, тем же
  // вызовом updateFolder, что и сброс избранного/закрепления. Поэтому здесь
  // без доп. запросов, false литералом.
  async getTrashedFolders() {
    const [foldersResult, parentIdsByFolder] = await Promise.all([
      supabaseClient.from("folders").select("*").not("deleted_at", "is", null).order("deleted_at", { ascending: false }),
      fetchParentFolderIdsByFolderId(),
    ]);
    if (foldersResult.error) throw foldersResult.error;
    return foldersResult.data.map((row) => mapFolderRow(row, parentIdsByFolder.get(row.id) || [], false, false));
  },

  async createFolder(folder) {
    return withSaveStatus(async () => {
      const row = toRow(FOLDER_FIELD_MAP, folder);
      row.id = folder.id;
      row.user_id = getCachedSession().user.id;
      const { data, error } = await supabaseClient.from("folders").insert(row).select().single();
      if (error) throw error;
      const parentFolderIds = folder.parentFolderIds || [];
      if (parentFolderIds.length) await replaceFolderFolderLinks(data.id, parentFolderIds);
      const isFavorite = !!folder.isFavorite;
      if (isFavorite) await setFavorite("folder", data.id, true);
      const pinned = !!folder.pinned;
      if (pinned) await replacePins("folder", data.id, ["global"]);
      return mapFolderRow(data, parentFolderIds, isFavorite, pinned);
    });
  },

  async updateFolder(id, patch) {
    return withSaveStatus(async () => {
      const { parentFolderIds, isFavorite, pinned, ...rest } = patch;
      const row = toRow(FOLDER_FIELD_MAP, rest);
      let data = null;
      if (Object.keys(row).length) {
        const result = await supabaseClient.from("folders").update(row).eq("id", id).select().maybeSingle();
        if (result.error) throw result.error;
        data = result.data;
      }
      if (parentFolderIds !== undefined) await replaceFolderFolderLinks(id, parentFolderIds);
      if (isFavorite !== undefined) await setFavorite("folder", id, isFavorite);
      if (pinned !== undefined) await replacePins("folder", id, pinned ? ["global"] : []);
      if (!data) {
        const result = await supabaseClient.from("folders").select("*").eq("id", id).maybeSingle();
        if (result.error) throw result.error;
        data = result.data;
      }
      if (!data) return null;
      const finalParentFolderIds = parentFolderIds !== undefined ? parentFolderIds : await fetchParentFolderIdsFor(id);
      const finalIsFavorite = isFavorite !== undefined ? isFavorite : await fetchIsFavorite("folder", id);
      const finalPinned = pinned !== undefined ? pinned : (await fetchPinnedIn("folder", id)).includes("global");
      return mapFolderRow(data, finalParentFolderIds, finalIsFavorite, finalPinned);
    });
  },

  async setFoldersOrder(orderById) {
    const entries = Object.entries(orderById);
    if (!entries.length) return;
    await withSaveStatus(() =>
      Promise.all(
        entries.map(async ([id, order]) => {
          const { error } = await supabaseClient.from("folders").update({ sort_order: order }).eq("id", id);
          if (error) throw error;
        })
      )
    );
  },

  // favorites/pins не имеют FK на folders (item_id полиморфный — общая колонка
  // на note/folder), поэтому Postgres не каскадит сюда сам. Структурно эти
  // строки уже пусты к этому моменту (moveFolderToTrash сбрасывает isFavorite/
  // pinned до постановки deletedAt), но фоновый persist() позднего клика
  // "избранное"/"закрепить", отправленный ДО ухода в Корзину и доехавший до
  // сервера ПОСЛЕ — теоретически мог воскресить строку уже после трэша.
  // Удаление 0 строк — бесплатный no-op, чистим здесь как страховку от этой
  // гонки (permanent delete необратим, в отличие от обычного дрейфа
  // состояния при гонке кликов).
  async deleteFolder(id) {
    await withSaveStatus(async () => {
      const { error } = await supabaseClient.from("folders").delete().eq("id", id);
      if (error) throw error;
      await Promise.all([
        supabaseClient.from("favorites").delete().eq("item_type", "folder").eq("item_id", id),
        supabaseClient.from("pins").delete().eq("item_type", "folder").eq("item_id", id),
      ]);
    });
  },

  // Items ----------------------------------------------------------------
  async getItems() {
    const [itemsResult, folderIdsByNote, favoriteIds, pinsByItem] = await Promise.all([
      supabaseClient.from("notes").select("*").is("deleted_at", null).order("sort_order"),
      fetchFolderIdsByNoteId(),
      fetchFavoriteIdSet("note"),
      fetchPinsByItemId("note"),
    ]);
    if (itemsResult.error) throw itemsResult.error;
    return itemsResult.data.map((row) =>
      mapItemRow(row, folderIdsByNote.get(row.id) || [], favoriteIds.has(row.id), pinsByItem.get(row.id) || [])
    );
  },

  // См. комментарий у getTrashedFolders — тот же инвариант для заметок
  // (itemsService.moveItemToTrash).
  async getTrashedItems() {
    const [itemsResult, folderIdsByNote] = await Promise.all([
      supabaseClient.from("notes").select("*").not("deleted_at", "is", null).order("deleted_at", { ascending: false }),
      fetchFolderIdsByNoteId(),
    ]);
    if (itemsResult.error) throw itemsResult.error;
    return itemsResult.data.map((row) => mapItemRow(row, folderIdsByNote.get(row.id) || [], false, []));
  },

  async getItem(id) {
    const { data, error } = await supabaseClient.from("notes").select("*").eq("id", id).maybeSingle();
    if (error) throw error;
    if (!data) return null;
    const [folderIds, isFavorite, pinnedIn] = await Promise.all([
      fetchFolderIdsForNote(id),
      fetchIsFavorite("note", id),
      fetchPinnedIn("note", id),
    ]);
    return mapItemRow(data, folderIds, isFavorite, pinnedIn);
  },

  async createItem(item) {
    return withSaveStatus(async () => {
      const row = toRow(ITEM_FIELD_MAP, item);
      row.id = item.id;
      row.user_id = getCachedSession().user.id;
      const { data, error } = await supabaseClient.from("notes").insert(row).select().single();
      if (error) throw error;
      const folderIds = item.folderIds || [];
      if (folderIds.length) await replaceNoteFolderLinks(data.id, folderIds);
      const isFavorite = !!item.isFavorite;
      if (isFavorite) await setFavorite("note", data.id, true);
      const pinnedIn = item.pinnedIn || [];
      if (pinnedIn.length) await replacePins("note", data.id, pinnedIn);
      return mapItemRow(data, folderIds, isFavorite, pinnedIn);
    });
  },

  async updateItem(id, patch) {
    return withSaveStatus(async () => {
      const { folderIds, isFavorite, pinnedIn, ...rest } = patch;
      const row = toRow(ITEM_FIELD_MAP, rest);
      let data = null;
      if (Object.keys(row).length) {
        const result = await supabaseClient.from("notes").update(row).eq("id", id).select().maybeSingle();
        if (result.error) throw result.error;
        data = result.data;
      }
      if (folderIds !== undefined) await replaceNoteFolderLinks(id, folderIds);
      if (isFavorite !== undefined) await setFavorite("note", id, isFavorite);
      if (pinnedIn !== undefined) await replacePins("note", id, pinnedIn);
      if (!data) {
        const result = await supabaseClient.from("notes").select("*").eq("id", id).maybeSingle();
        if (result.error) throw result.error;
        data = result.data;
      }
      if (!data) return null;
      const finalFolderIds = folderIds !== undefined ? folderIds : await fetchFolderIdsForNote(id);
      const finalIsFavorite = isFavorite !== undefined ? isFavorite : await fetchIsFavorite("note", id);
      const finalPinnedIn = pinnedIn !== undefined ? pinnedIn : await fetchPinnedIn("note", id);
      return mapItemRow(data, finalFolderIds, finalIsFavorite, finalPinnedIn);
    });
  },

  async setItemsOrder(orderById) {
    const entries = Object.entries(orderById);
    if (!entries.length) return;
    await withSaveStatus(() =>
      Promise.all(
        entries.map(async ([id, order]) => {
          const { error } = await supabaseClient.from("notes").update({ sort_order: order }).eq("id", id);
          if (error) throw error;
        })
      )
    );
  },

  // См. комментарий у deleteFolder — тот же defensive cleanup для заметок.
  // Плюс файлы фото в Storage: on delete cascade чистит DB-строки images/
  // drawings автоматически, но Storage — отдельная подсистема, cascade FK её
  // не касается. Папка note-images/{userId}/{noteId}/ убирается целиком по
  // префиксу — заметка удаляется навсегда одним действием, отдельно ходить
  // за путями каждого фото в images не нужно.
  async deleteItem(id) {
    await withSaveStatus(async () => {
      const { error } = await supabaseClient.from("notes").delete().eq("id", id);
      if (error) throw error;
      await Promise.all([
        supabaseClient.from("favorites").delete().eq("item_type", "note").eq("item_id", id),
        supabaseClient.from("pins").delete().eq("item_type", "note").eq("item_id", id),
      ]);
      const userId = getCachedSession().user.id;
      const { data: files } = await supabaseClient.storage.from("note-images").list(`${userId}/${id}`);
      if (files?.length) {
        const paths = files.map((f) => `${userId}/${id}/${f.name}`);
        await supabaseClient.storage.from("note-images").remove(paths).catch(() => {});
      }
    });
  },

  // Block tags (справочник тегов блоков) ----------------------------------
  async getBlockTags() {
    const { data, error } = await supabaseClient.from("tags").select("*").order("display_name");
    if (error) throw error;
    return data.map(mapTagRow);
  },

  async createBlockTag(tag) {
    return withSaveStatus(async () => {
      const row = { id: tag.id, user_id: getCachedSession().user.id, name: tag.nameKey, display_name: tag.name, color: tag.color };
      const { data, error } = await supabaseClient.from("tags").insert(row).select().single();
      if (error) throw error;
      return mapTagRow(data);
    });
  },

  async updateBlockTag(id, patch) {
    return withSaveStatus(async () => {
      const row = {};
      if (patch.name !== undefined) row.display_name = patch.name;
      if (patch.nameKey !== undefined) row.name = patch.nameKey;
      if (patch.color !== undefined) row.color = patch.color;
      const { data, error } = await supabaseClient.from("tags").update(row).eq("id", id).select().maybeSingle();
      if (error) throw error;
      return data ? mapTagRow(data) : null;
    });
  },
};

// Производный индекс blocks/block_tags — полный снос-и-пересоздание строк
// заметки при каждой синхронизации (тот же приём, что replaceNoteFolderLinks/
// replaceFolderFolderLinks выше). Не часть контракта StorageAdapter: у гостя
// нет осмысленного localStorage-аналога (findBlocks идёт своим, отдельным
// путём через extractTaggedBlocks по всем заметкам) — вызывается напрямую из
// blockTagsService.js, минуя getStorage(). blocks — [{blockId, tagIds, html,
// text}], форма ровно как у extractTaggedBlocks.
export async function syncBlocksForNote(noteId, blocks) {
  const { error: delError } = await supabaseClient.from("blocks").delete().eq("note_id", noteId);
  if (delError) throw delError;
  if (!blocks.length) return;
  const rows = blocks.map((b) => ({ note_id: noteId, block_key: b.blockId, html: b.html, preview_text: b.text }));
  const { data: inserted, error: insError } = await supabaseClient.from("blocks").insert(rows).select();
  if (insError) throw insError;
  const idByKey = new Map(inserted.map((row) => [row.block_key, row.id]));
  const linkRows = blocks.flatMap((b) => b.tagIds.map((tagId) => ({ block_id: idByKey.get(b.blockId), tag_id: tagId })));
  if (linkRows.length) {
    const { error: linkError } = await supabaseClient.from("block_tags").insert(linkRows);
    if (linkError) throw linkError;
  }
}

// Все блоки (по всем заметкам), у которых есть ВСЕ перечисленные теги — SQL-путь
// для полноэкранного браузера тегов (замена сканирования HTML). AND-фильтр —
// задача реляционного деления, простыми фильтрами PostgREST не выражается,
// поэтому сначала считаем пересечение в JS по block_tags, потом одним запросом
// тянем сами блоки. Пустой tagIds — не гипотетический случай: и кнопка "#" у
// поиска, и "Clear all" в браузере открывают именно пустой фильтр ("все блоки").
export async function findTaggedBlocks(tagIds) {
  let blockIds = null; // null = без ограничения по id
  if (tagIds.length) {
    const { data, error } = await supabaseClient.from("block_tags").select("block_id, tag_id").in("tag_id", tagIds);
    if (error) throw error;
    const tagsByBlock = new Map();
    data.forEach((row) => {
      const set = tagsByBlock.get(row.block_id) || new Set();
      set.add(row.tag_id);
      tagsByBlock.set(row.block_id, set);
    });
    blockIds = [...tagsByBlock.entries()].filter(([, set]) => tagIds.every((id) => set.has(id))).map(([id]) => id);
    if (!blockIds.length) return [];
  }

  let query = supabaseClient
    .from("blocks")
    .select("id, note_id, block_key, html, preview_text, block_tags(tag_id), notes!inner(title, updated_at, sort_order, deleted_at)")
    .is("notes.deleted_at", null);
  if (blockIds) query = query.in("id", blockIds);
  const { data, error } = await query;
  if (error) throw error;

  return data.map((row) => ({
    blockId: row.block_key,
    tagIds: row.block_tags.map((bt) => bt.tag_id),
    html: row.html,
    text: row.preview_text,
    itemId: row.note_id,
    itemTitle: row.notes.title,
    updatedAt: row.notes.updated_at,
    order: row.notes.sort_order,
  }));
}

const PHOTO_BUCKET = "note-images";
// Signed URL живёт этот срок, затем протухает; самовосстановление — по
// событию error на самом <img> (см. richTextEditor.js), не по таймеру: проще
// и не нужно отслеживать "заметку закрыли — не забыть снять таймер".
const SIGNED_URL_TTL_SECONDS = 3600;

// Заливает уже сжатый/при необходимости отредактированный (карандашом поверх)
// Blob фото — вызывающий код (richTextEditor.js через photoStorageService.js)
// передаёт именно то, что видно на экране, не оригинал с телефона. Путь —
// {userId}/{noteId}/{imageId}.{ext}: второй сегмент даёт тривиальный
// bulk-delete по префиксу при permanent delete заметки (см. deleteItem выше),
// первый — то единственное, что проверяет RLS-политика на storage.objects
// (см. supabase/005_note_images_storage.sql). Сразу же создаёт signed URL —
// одним заходом, без отдельного round-trip только за ссылкой для отображения.
export async function uploadPhotoToStorage(noteId, blob) {
  const userId = getCachedSession().user.id;
  const imageId = crypto.randomUUID();
  const ext = blob.type === "image/png" ? "png" : "jpg";
  const path = `${userId}/${noteId}/${imageId}.${ext}`;
  const { error } = await supabaseClient.storage.from(PHOTO_BUCKET).upload(path, blob, { contentType: blob.type });
  if (error) throw error;
  const { data, error: signError } = await supabaseClient.storage.from(PHOTO_BUCKET).createSignedUrl(path, SIGNED_URL_TTL_SECONDS);
  if (signError) throw signError;
  return { storagePath: path, signedUrl: data.signedUrl };
}

// Batch-версия — один запрос на все фото заметки при открытии, не по запросу
// на картинку (createSignedUrls, plural API).
export async function createSignedUrlMap(paths) {
  if (!paths.length) return new Map();
  const { data, error } = await supabaseClient.storage.from(PHOTO_BUCKET).createSignedUrls(paths, SIGNED_URL_TTL_SECONDS);
  if (error) throw error;
  return new Map(data.map((row) => [row.path, row.signedUrl]));
}

// Точечное удаление одного файла — вызывается из richTextEditor.js
// (attachBackgroundUpload) при замене версии фото ("Изменить" оставляет
// старый файл ненужным) или когда фото удалили/заменили раньше, чем долетел
// ответ на аплоад (только что залитый файл никому больше не нужен). Ошибка
// не пробрасывается — вызывающий код уже трактует это как best-effort.
export async function removePhotoFromStorage(path) {
  await supabaseClient.storage.from(PHOTO_BUCKET).remove([path]).catch(() => {});
}

// Производный индекс images — снос-и-пересоздание строк заметки, тот же
// приём, что syncBlocksForNote выше. В отличие от blocks/block_tags, здесь за
// DB-строкой стоит РЕАЛЬНЫЙ файл в Storage — простое "тихое самоисправление"
// оставило бы файл удалённого/перезалитого фото висеть в бакете навсегда.
// Поэтому читаем старые storage_path ДО пересоздания, и то, чего нет в новом
// наборе (фото удалили через ПКМ/выделение, или "Изменить" залило новую
// версию поверх старой — см. richTextEditor.js) — чистим из Storage
// best-effort ПОСЛЕ: неудачная уборка файла не должна валить сохранение
// самого индекса позиций.
export async function syncImagesForNote(noteId, images) {
  const { data: existing, error: selError } = await supabaseClient.from("images").select("storage_path").eq("note_id", noteId);
  if (selError) throw selError;
  const keptPaths = new Set(images.map((i) => i.storagePath));
  const removedPaths = existing.map((row) => row.storage_path).filter((path) => !keptPaths.has(path));

  const { error: delError } = await supabaseClient.from("images").delete().eq("note_id", noteId);
  if (delError) throw delError;
  if (images.length) {
    const rows = images.map((i) => ({
      note_id: noteId,
      storage_path: i.storagePath,
      position_x_percent: i.xPercent,
      position_y_percent: i.yPercent,
      width_percent: i.widthPercent,
      z_index: i.zIndex,
      title: i.title,
      anchor_line_id: i.anchorLineId,
    }));
    const { error: insError } = await supabaseClient.from("images").insert(rows);
    if (insError) throw insError;
  }
  if (removedPaths.length) {
    await supabaseClient.storage.from(PHOTO_BUCKET).remove(removedPaths).catch(() => {});
  }
}

// Производный индекс drawings — обычный снос-и-пересоздание, без diff-очистки:
// рисунок хранится как текст (path_data), в Storage файла нет и нечего
// чистить. Таблица физически не хранит цвет/толщину штриха (в схеме таких
// колонок нет) — не страшно, рендер всё равно берётся из content, это чисто
// вспомогательный индекс.
export async function syncDrawingsForNote(noteId, drawings) {
  const { error: delError } = await supabaseClient.from("drawings").delete().eq("note_id", noteId);
  if (delError) throw delError;
  if (!drawings.length) return;
  const rows = drawings.map((d) => ({
    note_id: noteId,
    path_data: d.pathData,
    position_x_percent: d.xPercent,
    position_y_percent: d.yPercent,
    z_index: d.zIndex,
    anchor_line_id: d.anchorLineId,
  }));
  const { error: insError } = await supabaseClient.from("drawings").insert(rows);
  if (insError) throw insError;
}
