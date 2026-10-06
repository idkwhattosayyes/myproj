/**
 * Панели и тулбар не должны меняться в размере, когда страницу масштабируют
 * браузером (Ctrl+колесо, Ctrl +/−). Отменить сам зум нельзя — клавиатурный
 * шорткат браузера не перехватывается, — поэтому масштабируем эти элементы в
 * обратную сторону: браузер увеличил всё в 1.5 раза, мы уменьшаем панель в 1.5.
 *
 * Прочитать текущий зум напрямую браузер не даёт, но зум меняет
 * devicePixelRatio. За единицу берём то значение, которое было при загрузке
 * страницы: если её открыли уже с зумом, точкой отсчёта станет он.
 */
const baseRatio = window.devicePixelRatio;

/**
 * Масштаб всего сайта из настроек (см. src/settings/uiZoomSetting.js) — zoom на
 * <html>. Браузерным зумом его не сделать: JS не может его выставить, а наш
 * --ui-scale ниже браузерный зум для панелей нарочно гасит.
 *
 * У CSS-zoom два отличия от браузерного, и их компенсирует остальной код:
 * - vh/vw внутри zoom умножаются на него — в стилях их делят на --app-zoom;
 * - координаты мыши и getBoundingClientRect приходят в пикселях экрана, а
 *   left/top/width в стилях под zoom растягиваются — их делят на getAppZoom().
 */
let appZoom = 1;

export function applyAppZoom(percent) {
  appZoom = percent / 100;
  document.documentElement.style.setProperty("--app-zoom", String(appZoom));
}

export function getAppZoom() {
  return appZoom;
}

/**
 * Экранные пиксели (координаты мыши, getBoundingClientRect, innerWidth) →
 * пиксели для left/top/width элемента, который лежит под zoom сайта. Без
 * перевода меню, открытое у курсора при 110%, вставало бы на 10% дальше от
 * левого верхнего угла, чем курсор.
 * @param {number} screenPx
 */
export function toCssPx(screenPx) {
  return screenPx / appZoom;
}

/**
 * Сдвиг в пикселях экрана → сколько добавить к scrollTop этого контейнера.
 * Прокрутка блока считается в его собственных пикселях, и под zoom 100 единиц
 * scrollTop — это 110 пикселей экрана; прокрутка окна — в пикселях экрана.
 * currentCSSZoom — итоговый масштаб элемента со всеми предками: у панели в
 * него входит и наш --ui-scale, и масштаб сайта.
 * @param {Element} scroller
 * @param {number} screenPx
 */
export function toScrollPx(scroller, screenPx) {
  if (scroller === document.scrollingElement) return screenPx;
  return screenPx / (scroller.currentCSSZoom || 1);
}

export function applyUiScale() {
  const zoom = window.devicePixelRatio / baseRatio;
  document.documentElement.style.setProperty("--ui-scale", String(1 / zoom));
}

export function watchUiScale() {
  applyUiScale();
  // Смена зума меняет размер вьюпорта, поэтому приходит обычный resize.
  window.addEventListener("resize", applyUiScale);
}
