import { localStorageAdapter } from "./localStorageAdapter.js";
import { supabaseAdapter } from "./supabaseAdapter.js";
import { getCachedSession } from "../auth/authService.js";

/**
 * Контракт слоя хранения данных. Любой адаптер (localStorage, позже Supabase)
 * должен реализовывать этот набор async-методов, чтобы остальной код
 * (services/*) не менялся при смене хранилища.
 *
 * @typedef {Object} StorageAdapter
 * @property {(section: string) => Promise<Object[]>} getFolders
 * @property {(folder: Object) => Promise<Object>} createFolder
 * @property {(id: string, patch: Object) => Promise<Object|null>} updateFolder
 * @property {(orderById: Object) => Promise<void>} setFoldersOrder
 * @property {(id: string) => Promise<void>} deleteFolder
 * @property {(section: string) => Promise<Object[]>} getTrashedFolders
 * @property {(section: string) => Promise<Object[]>} getItems
 * @property {(section: string) => Promise<Object[]>} getItemsWithContent
 * @property {(id: string) => Promise<Object|null>} getItem
 * @property {(item: Object) => Promise<Object>} createItem
 * @property {(id: string, patch: Object) => Promise<Object|null>} updateItem
 * @property {(orderById: Object) => Promise<void>} setItemsOrder
 * @property {(id: string) => Promise<void>} deleteItem
 * @property {(section: string) => Promise<Object[]>} getTrashedItems
 * @property {() => Promise<Object[]>} getDiaryEntries
 * @property {(date: string) => Promise<Object|null>} getDiaryEntryByDate
 * @property {(date: string, content: string) => Promise<Object>} upsertDiaryEntry
 * @property {(id: string) => Promise<void>} deleteDiaryEntry
 * @property {(date: string) => Promise<Object[]>} getCalendarEntries
 * @property {() => Promise<string[]>} getAllCalendarEntryDates
 * @property {(entry: Object) => Promise<Object>} createCalendarEntry
 * @property {(id: string, patch: Object) => Promise<Object|null>} updateCalendarEntry
 * @property {(id: string) => Promise<void>} deleteCalendarEntry
 * @property {() => Promise<void>} clearAll
 * @property {() => Promise<Object[]>} getCalendarTags
 * @property {(tag: Object) => Promise<Object>} createCalendarTag
 * @property {(id: string) => Promise<void>} deleteCalendarTag
 * @property {() => Promise<Object[]>} getBlockTags
 * @property {(tag: Object) => Promise<Object>} createBlockTag
 * @property {(id: string, patch: Object) => Promise<Object|null>} updateBlockTag
 */

// Заметки/папки, справочник тегов блоков и полная очистка данных — сущности,
// уже перенесённые на Supabase, и только для залогиненных: проверка идёт на
// каждый вызов, а не один раз при загрузке, поэтому гость никогда не задевает
// supabaseAdapter.js. Остальной контракт (дневник, календарь) пока всегда
// localStorage — так и останется, пока не приедут следующие модули.
const NOTES_AND_FOLDERS_METHODS = [
  "getFolders",
  "createFolder",
  "updateFolder",
  "setFoldersOrder",
  "deleteFolder",
  "getTrashedFolders",
  "getItems",
  "getItemsWithContent",
  "getItem",
  "createItem",
  "updateItem",
  "setItemsOrder",
  "deleteItem",
  "getTrashedItems",
];

const BLOCK_TAG_METHODS = ["getBlockTags", "createBlockTag", "updateBlockTag"];

// Затрагивает notes/folders/tags/favorites/pins/images/drawings/Storage
// разом — не укладывается в специализацию двух списков выше, отдельная запись.
const CLEAR_ALL_METHODS = ["clearAll"];

const hybridAdapter = { ...localStorageAdapter };
[...NOTES_AND_FOLDERS_METHODS, ...BLOCK_TAG_METHODS, ...CLEAR_ALL_METHODS].forEach((method) => {
  hybridAdapter[method] = (...args) => {
    const adapter = getCachedSession() ? supabaseAdapter : localStorageAdapter;
    return adapter[method](...args);
  };
});

/** @returns {StorageAdapter} */
export function getStorage() {
  return hybridAdapter;
}
