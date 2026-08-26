// Статус сохранения заметок/папок в облаке — маленький publish/subscribe по
// образцу src/search/blockScope.js: текущее значение + Set слушателей. Только
// облачный адаптер (src/data/supabaseAdapter.js) вызывает notify* — у гостя
// на localStorage сохранение мгновенное, индикатору тут нечего показывать.
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
