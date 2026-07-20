import { localStorageAdapter } from "./localStorageAdapter.js";

/**
 * Контракт слоя хранения данных. Любой адаптер (localStorage, позже Supabase)
 * должен реализовывать этот набор async-методов, чтобы остальной код
 * (services/*) не менялся при смене хранилища.
 *
 * @typedef {Object} StorageAdapter
 * @property {(section: string) => Promise<Object[]>} getFolders
 * @property {(folder: Object) => Promise<Object>} createFolder
 * @property {(id: string, patch: Object) => Promise<Object|null>} updateFolder
 * @property {(id: string) => Promise<void>} deleteFolder
 * @property {(section: string) => Promise<Object[]>} getItems
 * @property {(id: string) => Promise<Object|null>} getItem
 * @property {(item: Object) => Promise<Object>} createItem
 * @property {(id: string, patch: Object) => Promise<Object|null>} updateItem
 * @property {(id: string) => Promise<void>} deleteItem
 * @property {() => Promise<Object[]>} getDiaryEntries
 * @property {(date: string) => Promise<Object|null>} getDiaryEntryByDate
 * @property {(date: string, content: string) => Promise<Object>} upsertDiaryEntry
 * @property {(id: string) => Promise<void>} deleteDiaryEntry
 */

// Единственное место, которое нужно поменять при переходе на Supabase.
const ACTIVE_ADAPTER = localStorageAdapter;

/** @returns {StorageAdapter} */
export function getStorage() {
  return ACTIVE_ADAPTER;
}
