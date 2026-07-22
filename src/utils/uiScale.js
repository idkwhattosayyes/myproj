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

export function applyUiScale() {
  const zoom = window.devicePixelRatio / baseRatio;
  document.documentElement.style.setProperty("--ui-scale", String(1 / zoom));
}

export function watchUiScale() {
  applyUiScale();
  // Смена зума меняет размер вьюпорта, поэтому приходит обычный resize.
  window.addEventListener("resize", applyUiScale);
}
