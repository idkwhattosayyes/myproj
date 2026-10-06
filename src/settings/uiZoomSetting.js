/**
 * Масштаб всего интерфейса, в процентах. Свой на каждом устройстве: на мониторе
 * ПК сайт при 100% мелковат, на ноутбуке — в самый раз. Поэтому значение живёт в
 * localStorage этого браузера, а не в данных заметок, и не синхронизируется.
 *
 * Как он применяется — см. applyAppZoom в src/utils/uiScale.js.
 */
const STORAGE_KEY = "app:uiZoom";

export const UI_ZOOM_OPTIONS = [90, 100, 110, 125];
const DEFAULT_ZOOM = 100;

export function getUiZoom() {
  const stored = Number(localStorage.getItem(STORAGE_KEY));
  // Мусор или значение из старой версии списка — не применяем, иначе сайт мог
  // бы открыться в каком-нибудь 400% без кнопки, которой его вернуть.
  return UI_ZOOM_OPTIONS.includes(stored) ? stored : DEFAULT_ZOOM;
}

export function setUiZoom(percent) {
  localStorage.setItem(STORAGE_KEY, String(percent));
}
