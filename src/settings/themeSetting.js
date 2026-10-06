/**
 * Тема оформления. Как и масштаб интерфейса (uiZoomSetting.js), своя на каждом
 * устройстве: живёт в localStorage этого браузера и переживает «Очистить
 * данные» — это настройка вида, а не данные.
 *
 * Сами цвета и шрифты тем — в styles/theme.css. Здесь только выбор: атрибут
 * data-theme на <html>, по которому theme.css и переключает переменные.
 *
 * При загрузке страницы тему ставит не этот модуль, а маленький скрипт прямо в
 * <head> index.html: модули грузятся позже первой отрисовки, и тёмная тема
 * успевала бы мигнуть белым. Ключ и список тем там продублированы — меняешь
 * здесь, поменяй и там.
 */
const STORAGE_KEY = "app:theme";

export const THEMES = ["light", "dark", "sage", "sepia", "midnight", "sand"];
const DEFAULT_THEME = "light";

export function getTheme() {
  const stored = localStorage.getItem(STORAGE_KEY);
  // Мусор или тема, которой больше нет, — не применяем: без её переменных
  // сайт остался бы вовсе без цветов.
  return THEMES.includes(stored) ? stored : DEFAULT_THEME;
}

export function setTheme(theme) {
  localStorage.setItem(STORAGE_KEY, theme);
  applyTheme(theme);
}

// В отличие от масштаба — на лету, без перезагрузки: тема меняет только
// значения CSS-переменных, а не размеры, которые JS уже посчитал.
export function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
}
