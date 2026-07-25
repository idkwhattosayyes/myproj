// Общие цветовые пресеты и "последний выбранный" цвет/толщина — вынесены из
// richTextEditor.js, чтобы photoEditor.js мог использовать те же палитры и
// цвет пера без циклического импорта (richTextEditor уже импортирует
// photoEditor для окна предпросмотра фото).

export const TEXT_COLORS = ["#e03131", "#f08c00", "#2f9e44", "#1971c2", "#7048e8", "#495057"];
// Заливка идёт под текст, поэтому палитра своя — светлая, иначе текст не читается.
export const HIGHLIGHT_COLORS = ["#fff3a3", "#ffd8a8", "#b2f2bb", "#a5d8ff", "#d0bfff", "#ffc9c9"];

// Перо рисования: последние выбранные цвет/толщина — в localStorage, тем же
// приёмом, что и последний цвет текста/заливки (getLastColor/setLastColor).
export const DRAW_COLOR_KEY = "app:lastDrawColor";
export const DRAW_WIDTH_KEY = "app:lastDrawWidth";
export const DRAW_DEFAULT_COLOR = "#1f2328";
export const DRAW_DEFAULT_WIDTH = 3;
export const DRAW_WIDTHS = [1.5, 3, 5]; // тонкая / средняя / толстая

// Последний выбранный цвет запоминается: ЛКМ по кнопке красит именно им.
export function getLastColor(storageKey, fallback) {
  return localStorage.getItem(storageKey) || fallback;
}

export function setLastColor(storageKey, color) {
  localStorage.setItem(storageKey, color);
}

export function getLastWidth(storageKey, fallback) {
  return parseFloat(localStorage.getItem(storageKey)) || fallback;
}

export function setLastWidth(storageKey, width) {
  localStorage.setItem(storageKey, String(width));
}
