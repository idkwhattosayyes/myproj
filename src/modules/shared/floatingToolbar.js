/**
 * Тулбар редактора при прокрутке заметки отрывается от разметки и висит на экране,
 * а при возврате наверх встаёт обратно на своё место.
 *
 * Раньше это делал чистый CSS — position: sticky на хосте. Sticky не подошёл, как
 * только понадобилось таскать панель мышью: он умеет только «прилипнуть в своей
 * колее», произвольной позиции у него не бывает. Поэтому в оторванном состоянии
 * панель переходит на position: fixed, а координаты считает этот модуль.
 *
 * Про зум: у хоста висит zoom (см. utils/uiScale.js), а zoom заводит свою систему
 * координат — left/top у fixed-потомка задаются в её единицах, а не в пикселях
 * экрана. Множитель берём измерением, а не из переменной: так надёжнее, откуда бы
 * зум ни пришёл.
 */

// Насколько панель отступает от верхней полосы приложения, когда висит.
const TOP_GAP_PX = 10;
// Порог возврата чуть ниже порога отрыва: ровно на границе панель иначе дребезжит —
// оторвалась, страница стала короче на её высоту, порог сработал обратно, и так по кругу.
const HYSTERESIS_PX = 2;

function topbarHeightPx() {
  const raw = getComputedStyle(document.documentElement).getPropertyValue("--topbar-height");
  return parseFloat(raw) * parseFloat(getComputedStyle(document.documentElement).fontSize) || 0;
}

// Ручка перетаскивания: шесть точек инлайн-SVG с fill="currentColor" — тем же
// приёмом, что булавка и значок папки в panelSection.js. Эмодзи не красится, а
// цвет тут приглушённый, чтобы ручка читалась, но не спорила с кнопками.
function createDragHandle() {
  const handle = document.createElement("span");
  handle.className = "rte-drag-handle";
  handle.setAttribute("aria-hidden", "true");
  const dots = [2.5, 7, 11.5].map((cy) => `<circle cx="3" cy="${cy}" r="1.3"/><circle cx="8" cy="${cy}" r="1.3"/>`).join("");
  handle.innerHTML = `<svg viewBox="0 0 11 14" width="11" height="14" fill="currentColor">${dots}</svg>`;
  return handle;
}

export function attachFloatingToolbar({ hostEl, toolbarEl }) {
  let floating = false;
  let frame = 0;
  // Куда пользователь перетащил панель. null — панель ещё не двигали, она висит
  // над своим местом в разметке.
  let position = null;
  let drag = null;
  // Ширина, к которой едет анимация. Держим отдельно, чтобы по окончании перехода
  // снять фиксацию: дальше панель должна сама подстраиваться под свёрнутый/полный набор.
  let widthAnimation = null;

  // Во сколько раз координаты элемента отличаются от экранных. При зуме 100% это 1.
  function scale() {
    const box = toolbarEl.getBoundingClientRect();
    return toolbarEl.offsetWidth ? box.width / toolbarEl.offsetWidth : 1;
  }

  // Куда панель встаёт, когда висит и её ещё не двигали: по горизонтали ровно туда
  // же, где она стоит в разметке (по ТЗ она «входит сама в себя» и в стороны не
  // смещается), по вертикали — под верхнюю полосу приложения.
  function defaultAnchor() {
    const host = hostEl.getBoundingClientRect();
    return { x: host.left, y: topbarHeightPx() + TOP_GAP_PX };
  }

  function place() {
    const s = scale();
    const anchor = position || defaultAnchor();
    toolbarEl.style.left = `${anchor.x / s}px`;
    toolbarEl.style.top = `${anchor.y / s}px`;
  }

  // Ширину max-content анимировать нельзя, поэтому меряем цель и едем явными px.
  // По окончании перехода фиксацию снимаем — иначе панель перестанет реагировать на
  // сворачивание тулбара.
  function animateWidth(to) {
    const from = toolbarEl.offsetWidth;
    toolbarEl.style.width = `${from}px`;
    void toolbarEl.offsetWidth; // принудительный пересчёт, иначе браузер склеит два присваивания
    widthAnimation = to;
    toolbarEl.style.width = `${to}px`;
  }

  function onWidthTransitionEnd(event) {
    if (event.propertyName !== "width" || widthAnimation === null) return;
    widthAnimation = null;
    toolbarEl.style.width = "";
  }

  function goFloating() {
    // Хост держит высоту вместо ушедшей панели: без этого страница подскочит ровно
    // на её высоту и порог тут же сработает обратно.
    hostEl.style.height = `${toolbarEl.offsetHeight}px`;
    toolbarEl.classList.add("is-floating");
    const target = toolbarEl.offsetWidth; // ширина уже по содержимому — класс применён
    place();
    animateWidth(target);
    floating = true;
  }

  function goDocked() {
    const target = hostEl.clientWidth;
    toolbarEl.classList.remove("is-floating");
    toolbarEl.style.left = "";
    toolbarEl.style.top = "";
    animateWidth(target);
    hostEl.style.height = "";
    floating = false;
  }

  function update() {
    frame = 0;
    // Пока панель висит, хост стоит на месте — его верх и есть точка отсчёта.
    const hostTop = hostEl.getBoundingClientRect().top;
    const threshold = topbarHeightPx() + TOP_GAP_PX;
    if (!floating && hostTop < threshold) goFloating();
    else if (floating && hostTop > threshold + HYSTERESIS_PX) goDocked();
    else if (floating) place();
  }

  function schedule() {
    if (frame) return;
    frame = requestAnimationFrame(update);
  }

  // --- Перетаскивание за ручку -------------------------------------------
  // Своя механика, а не startRowDrag из panelSection.js: тот про клон-призрак и
  // попадание в цель, а здесь двигается сам элемент и цели нет. Указатель
  // захватываем, чтобы панель продолжала ехать, даже когда курсор ушёл с ручки.
  function onPointerDown(event) {
    if (event.button !== 0 || !floating) return;
    event.preventDefault();
    const box = toolbarEl.getBoundingClientRect();
    drag = { grabX: event.clientX - box.left, grabY: event.clientY - box.top, point: null };
    handleEl.setPointerCapture(event.pointerId);
    // Пока панель едет за курсором, переходы мешают: панель тянулась бы следом с
    // задержкой вместо того, чтобы держаться под указателем.
    toolbarEl.classList.add("is-dragging");
  }

  function applyDragPoint() {
    frame = 0;
    if (!drag || !drag.point) return;
    position = { x: drag.point.x - drag.grabX, y: drag.point.y - drag.grabY };
    place();
  }

  function onPointerMove(event) {
    if (!drag) return;
    drag.point = { x: event.clientX, y: event.clientY };
    if (!frame) frame = requestAnimationFrame(applyDragPoint);
  }

  function onPointerUp(event) {
    if (!drag) return;
    if (handleEl.hasPointerCapture(event.pointerId)) handleEl.releasePointerCapture(event.pointerId);
    drag = null;
    toolbarEl.classList.remove("is-dragging");
  }

  const handleEl = createDragHandle();
  toolbarEl.insertBefore(handleEl, toolbarEl.firstChild);
  handleEl.addEventListener("pointerdown", onPointerDown);
  handleEl.addEventListener("pointermove", onPointerMove);
  handleEl.addEventListener("pointerup", onPointerUp);
  handleEl.addEventListener("pointercancel", onPointerUp);

  window.addEventListener("scroll", schedule, { passive: true });
  window.addEventListener("resize", schedule);
  toolbarEl.addEventListener("transitionend", onWidthTransitionEnd);
  update();

  return function detach() {
    if (frame) cancelAnimationFrame(frame);
    window.removeEventListener("scroll", schedule);
    window.removeEventListener("resize", schedule);
    toolbarEl.removeEventListener("transitionend", onWidthTransitionEnd);
    handleEl.remove();
    toolbarEl.classList.remove("is-floating");
    toolbarEl.style.cssText = toolbarEl.style.cssText.replace(/(left|top|width):[^;]*;?/g, "");
    hostEl.style.height = "";
  };
}
