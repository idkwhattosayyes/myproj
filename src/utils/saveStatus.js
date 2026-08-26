// Статус сохранения заметок/папок — маленький publish/subscribe по образцу
// src/search/blockScope.js: текущее значение + Set слушателей. Вызывают оба
// адаптера (supabaseAdapter.js и localStorageAdapter.js, через withSaveStatus
// ниже) — у гостя это не про сетевую задержку, а про то, чтобы реальный сбой
// (например переполнение квоты localStorage) стал виден, а не тихим.
let status = "idle"; // "idle" | "saving" | "saved" | "error"
const listeners = new Set();

function setStatus(next) {
  status = next;
  listeners.forEach((listener) => listener(next));
}

export function notifySaving() {
  setStatus("saving");
}

export function notifySaved() {
  setStatus("saved");
}

export function notifySaveError() {
  setStatus("error");
}

export function getSaveStatus() {
  return status;
}

export function onSaveStatusChange(listener) {
  listeners.add(listener);
}

// Оборачивает одну записывающую операцию адаптера индикатором. Ошибка не
// глотается — пробрасывается дальше не изменённой, у вызывающего кода
// (itemsService.js) и раньше не было catch на storage.*, поведение то же,
// просто видимое.
export async function withSaveStatus(work) {
  notifySaving();
  try {
    const result = await work();
    notifySaved();
    return result;
  } catch (error) {
    notifySaveError();
    throw error;
  }
}
