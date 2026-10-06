// Общие цветовые пресеты и "последний выбранный" цвет/толщина — вынесены из
// richTextEditor.js, чтобы photoEditor.js мог использовать те же палитры и
// цвет пера без циклического импорта (richTextEditor уже импортирует
// photoEditor для окна предпросмотра фото).

// Сами цвета палитр живут в styles/theme.css под именами вроде --text-color-red
// и --highlight-yellow — там же, где все остальные цвета сайта. Здесь их только
// читают. Второй аргумент — прежнее значение на случай, если стили не загрузились
// (без него палитра вышла бы из пустых строк).
//
// Читать можно сразу при загрузке модуля: стили из <head> блокируют выполнение
// скриптов, поэтому к этому моменту theme.css уже применён. Выбранный цвет
// пишется в саму заметку hex-значением, как и раньше.
function cssColor(name, fallback) {
  const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return value || fallback;
}

export const TEXT_COLORS = [
  cssColor("--text-color-red", "#e03131"),
  cssColor("--text-color-orange", "#f08c00"),
  cssColor("--text-color-green", "#2f9e44"),
  cssColor("--text-color-blue", "#1971c2"),
  cssColor("--text-color-violet", "#7048e8"),
  cssColor("--text-color-gray", "#495057"),
];
// Заливка идёт под текст, поэтому палитра своя — светлая, иначе текст не читается.
export const HIGHLIGHT_COLORS = [
  cssColor("--highlight-yellow", "#fff3a3"),
  cssColor("--highlight-orange", "#ffd8a8"),
  cssColor("--highlight-green", "#b2f2bb"),
  cssColor("--highlight-blue", "#a5d8ff"),
  cssColor("--highlight-violet", "#d0bfff"),
  cssColor("--highlight-red", "#ffc9c9"),
];

// Перо рисования: последние выбранные цвет/толщина — в localStorage, тем же
// приёмом, что и последний цвет текста/заливки (getLastColor/setLastColor).
export const DRAW_COLOR_KEY = "app:lastDrawColor";
export const DRAW_WIDTH_KEY = "app:lastDrawWidth";
export const DRAW_DEFAULT_COLOR = cssColor("--draw-color-default", "#1f2328");
// Линия-разделитель по умолчанию — тот же цвет, что у линий внутри бумаги.
export const DIVIDER_DEFAULT_COLOR = cssColor("--paper-line", "#d0d7de");

/**
 * Обычный цвет текста заметки прямо сейчас — им «Сбросить цвет» перекрашивает
 * текст. Не константа: он свой у каждой темы (--paper-ink), а тему меняют на
 * лету. Сброс обязан совпадать с цветом поля — иначе кнопка «A» считала бы
 * сброшенный текст окрашенным (см. isColorActive в richTextEditor.js).
 */
export function currentPaperInk() {
  return cssColor("--paper-ink", "#1f2328");
}
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
