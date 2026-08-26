// Заметки, папки и теги блоков для залогиненного пользователя — через
// Supabase. Остальные методы контракта (дневник, календарь, clearAll) сюда не
// входят, их для залогиненных тоже отдаёт localStorageAdapter — маршрутизация
// в storageAdapter.js. Файл будет расти следующими модулями (избранное/
// закрепление, картинки/рисунки).
import { supabaseClient } from "./supabaseClient.js";
import { getCachedSession } from "../auth/authService.js";
import { withSaveStatus } from "../utils/saveStatus.js";

// isFavorite/pinned/pinnedIn/section — таких колонок в Supabase нет (см.
// supabase/schema.sql): избранное/закрепление ждут своего модуля, а section
// в живых Supabase-данных всегда "notes" (легаси tasks/documents — мёртвый
// код). Поэтому на запись эти поля просто отбрасываются, на чтение — гасятся
// в false/[]/"notes" ниже, чтобы объект имел форму, которую ждёт остальной код.

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

function mapItemRow(row, folderIds) {
  return {
    id: row.id,
    title: row.title,
    content: row.content,
    folderIds,
    section: "notes",
    isFavorite: false,
    pinnedIn: [],
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

function mapFolderRow(row, parentFolderIds) {
  return {
    id: row.id,
    name: row.name,
    section: "notes",
    isFavorite: false,
    pinned: false,
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

export const supabaseAdapter = {
  // Folders ------------------------------------------------------------
  async getFolders() {
    const [foldersResult, parentIdsByFolder] = await Promise.all([
      supabaseClient.from("folders").select("*").is("deleted_at", null).order("sort_order"),
      fetchParentFolderIdsByFolderId(),
    ]);
    if (foldersResult.error) throw foldersResult.error;
    return foldersResult.data.map((row) => mapFolderRow(row, parentIdsByFolder.get(row.id) || []));
  },

  async getTrashedFolders() {
    const [foldersResult, parentIdsByFolder] = await Promise.all([
      supabaseClient.from("folders").select("*").not("deleted_at", "is", null).order("deleted_at", { ascending: false }),
      fetchParentFolderIdsByFolderId(),
    ]);
    if (foldersResult.error) throw foldersResult.error;
    return foldersResult.data.map((row) => mapFolderRow(row, parentIdsByFolder.get(row.id) || []));
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
      return mapFolderRow(data, parentFolderIds);
    });
  },

  async updateFolder(id, patch) {
    return withSaveStatus(async () => {
      const { parentFolderIds, ...rest } = patch;
      const row = toRow(FOLDER_FIELD_MAP, rest);
      let data = null;
      if (Object.keys(row).length) {
        const result = await supabaseClient.from("folders").update(row).eq("id", id).select().maybeSingle();
        if (result.error) throw result.error;
        data = result.data;
      }
      if (parentFolderIds !== undefined) await replaceFolderFolderLinks(id, parentFolderIds);
      if (!data) {
        const result = await supabaseClient.from("folders").select("*").eq("id", id).maybeSingle();
        if (result.error) throw result.error;
        data = result.data;
      }
      if (!data) return null;
      const finalParentFolderIds = parentFolderIds !== undefined ? parentFolderIds : await fetchParentFolderIdsFor(id);
      return mapFolderRow(data, finalParentFolderIds);
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

  async deleteFolder(id) {
    await withSaveStatus(async () => {
      const { error } = await supabaseClient.from("folders").delete().eq("id", id);
      if (error) throw error;
    });
  },

  // Items ----------------------------------------------------------------
  async getItems() {
    const [itemsResult, folderIdsByNote] = await Promise.all([
      supabaseClient.from("notes").select("*").is("deleted_at", null).order("sort_order"),
      fetchFolderIdsByNoteId(),
    ]);
    if (itemsResult.error) throw itemsResult.error;
    return itemsResult.data.map((row) => mapItemRow(row, folderIdsByNote.get(row.id) || []));
  },

  async getTrashedItems() {
    const [itemsResult, folderIdsByNote] = await Promise.all([
      supabaseClient.from("notes").select("*").not("deleted_at", "is", null).order("deleted_at", { ascending: false }),
      fetchFolderIdsByNoteId(),
    ]);
    if (itemsResult.error) throw itemsResult.error;
    return itemsResult.data.map((row) => mapItemRow(row, folderIdsByNote.get(row.id) || []));
  },

  async getItem(id) {
    const { data, error } = await supabaseClient.from("notes").select("*").eq("id", id).maybeSingle();
    if (error) throw error;
    if (!data) return null;
    return mapItemRow(data, await fetchFolderIdsForNote(id));
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
      return mapItemRow(data, folderIds);
    });
  },

  async updateItem(id, patch) {
    return withSaveStatus(async () => {
      const { folderIds, ...rest } = patch;
      const row = toRow(ITEM_FIELD_MAP, rest);
      let data = null;
      if (Object.keys(row).length) {
        const result = await supabaseClient.from("notes").update(row).eq("id", id).select().maybeSingle();
        if (result.error) throw result.error;
        data = result.data;
      }
      if (folderIds !== undefined) await replaceNoteFolderLinks(id, folderIds);
      if (!data) {
        const result = await supabaseClient.from("notes").select("*").eq("id", id).maybeSingle();
        if (result.error) throw result.error;
        data = result.data;
      }
      if (!data) return null;
      const finalFolderIds = folderIds !== undefined ? folderIds : await fetchFolderIdsForNote(id);
      return mapItemRow(data, finalFolderIds);
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

  async deleteItem(id) {
    await withSaveStatus(async () => {
      const { error } = await supabaseClient.from("notes").delete().eq("id", id);
      if (error) throw error;
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
