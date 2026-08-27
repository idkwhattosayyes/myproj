// Кэш content уже открытых в этой сессии заметок. Список (panelSection.js)
// теперь получает заметки без content (см. supabaseAdapter.getItems) —
// первое открытие заметки лениво подгружает его через itemsService.js и
// кладёт сюда. Переживает переключение между заметками и повторный вход в
// раздел Notes (state в panelSection.js пересоздаётся заново при каждом
// монтировании — роутер чистит #app-view целиком, app.js — но этот кэш вне
// state, module-level), не переживает F5 — и не должен: это ровно то, что
// просит ТЗ ("повторный запрос — только при первом открытии заметки за
// сессию или явном изменении").
//
// Гостя не касается: у него content и так есть в объекте заметки сразу
// (localStorageAdapter ничего не обрезает) — вызывающий код обращается сюда,
// только когда content отсутствует, а у гостя это не бывает.
const cache = new Map(); // noteId -> content (string)

export function getCachedContent(noteId) {
  return cache.get(noteId);
}

export function setCachedContent(noteId, content) {
  cache.set(noteId, content);
}
