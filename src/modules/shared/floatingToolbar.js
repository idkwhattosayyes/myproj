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
// Ближе этой доли ширины текстового поля к его краю — панель прилипает к краю.
// Пять процентов, а не десять: с широкой зоной панель прилипала, когда её просто
// вели мимо края, и поставить её рядом с краем свободно было нельзя.
const EDGE_SNAP_RATIO = 0.05;
// Ближе этого расстояния к своему месту в разметке — панель примагничивается к нему.
const MAGNET_PX = 28;

// Позиция панели общая для всего раздела, а не своя у каждой заметки: поставил
// справа в одной — в другой она там же (ТЗ). Это настройка вида, не данные, поэтому
// живёт в localStorage мимо storageAdapter — как app:toolbarExpanded.
const POSITION_KEY = "app:toolbarFloat";

function readPosition() {
  try {
    const saved = JSON.parse(localStorage.getItem(POSITION_KEY) || "null");
    if (!saved || typeof saved !== "object") return null;
    return saved;
  } catch {
    return null;
  }
}

function writePosition(value) {
  if (value === null) localStorage.removeItem(POSITION_KEY);
  else localStorage.setItem(POSITION_KEY, JSON.stringify(value));
}
// Зазор между прилипшей панелью и краем поля, чтобы она не наезжала на рамку.
const EDGE_PAD_PX = 6;

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

export function attachFloatingToolbar({ hostEl, toolbarEl, boundsEl }) {
  let floating = false;
  let frame = 0;
  // К какому краю текстового поля прилипла панель: "left" | "right" | null.
  let dock = null;
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

  // Прилипла ли панель к краю текстового поля и к какому. Прилипание меняет не
  // только координату, но и вид — панель разворачивается в вертикальную полосу.
  function applyDockClasses() {
    toolbarEl.classList.toggle("is-docked", dock !== null);
    toolbarEl.classList.toggle("is-docked-right", dock === "right");
  }

  // В вертикальном виде колонка ограничена по высоте, и flex-wrap сам переносит
  // не влезшие кнопки во вторую колонку: полный набор разворачивается в две,
  // сокращённый остаётся в одной. Считать количество колонок не нужно.
  function applyDockHeight(top) {
    if (dock === null) {
      toolbarEl.style.maxHeight = "";
      return;
    }
    const bounds = boundsEl.getBoundingClientRect();
    const available = Math.min(window.innerHeight, bounds.bottom) - top - EDGE_PAD_PX;
    toolbarEl.style.maxHeight = `${Math.max(available, 0) / scale()}px`;
  }

  // Прилипшая полоса встаёт по верху видимой части текстового поля, а не в точке,
  // где её отпустили: чем выше начало, тем больше высоты у колонки и тем меньше
  // колонок нужно. По вертикали у полосы, растянутой на всё поле, положение всё
  // равно ничего не значит — значение имеет край, к которому она прилипла.
  function dockedTop() {
    const bounds = boundsEl.getBoundingClientRect();
    return Math.max(topbarHeightPx() + TOP_GAP_PX, bounds.top + EDGE_PAD_PX);
  }

  // Допустимая область — пересечение вьюпорта и текстового поля: за экран и за
  // поле панель не выходит ни при каких условиях (ТЗ, п.4). Проверять приходится
  // на каждом кадре прокрутки: поле едет вместе со страницей, а панель стоит.
  function clampToBounds(x, y, width, height) {
    const bounds = boundsEl.getBoundingClientRect();
    const left = Math.max(0, bounds.left) + EDGE_PAD_PX;
    const right = Math.min(window.innerWidth, bounds.right) - EDGE_PAD_PX;
    const top = Math.max(topbarHeightPx(), bounds.top) + EDGE_PAD_PX;
    const bottom = Math.min(window.innerHeight, bounds.bottom) - EDGE_PAD_PX;
    return {
      // Math.min с left на случай, когда панель шире или выше области: тогда
      // прижимаем её к началу, а не выталкиваем за противоположный край.
      x: Math.min(Math.max(x, left), Math.max(left, right - width)),
      y: Math.min(Math.max(y, top), Math.max(top, bottom - height)),
    };
  }

  // Панель не должна быть шире допустимой области — иначе зажимать координату
  // бессмысленно, она всё равно вылезет краем. Горизонтальная при этом переносит
  // кнопки на вторую строку (см. max-content + max-width в editor.css).
  function applyMaxWidth() {
    const bounds = boundsEl.getBoundingClientRect();
    const available = Math.min(window.innerWidth, bounds.right) - Math.max(0, bounds.left) - EDGE_PAD_PX * 2;
    toolbarEl.style.maxWidth = `${Math.max(available, 0) / scale()}px`;
  }

  function place() {
    const s = scale();
    const anchor = position || defaultAnchor();
    let { x, y } = anchor;
    applyMaxWidth();
    if (dock !== null) {
      const bounds = boundsEl.getBoundingClientRect();
      y = dockedTop();
      // Инлайновая ширина осталась от анимации отрыва — в колонке она не нужна,
      // ширину задаёт число получившихся колонок.
      toolbarEl.style.width = "";
      applyDockHeight(y);
      // Ширину меряем после maxHeight: от неё зависит, во сколько колонок лягут кнопки.
      x = dock === "left" ? bounds.left + EDGE_PAD_PX : bounds.right - toolbarEl.getBoundingClientRect().width - EDGE_PAD_PX;
    }
    const box = toolbarEl.getBoundingClientRect();
    // Пока панель тащат, границы не применяем: она свободно уходит за край, чтобы
    // её можно было подвести к самому краю и увидеть, куда ставишь. В границы её
    // возвращает отпускание (см. onPointerUp).
    if (drag) {
      toolbarEl.style.left = `${x / s}px`;
      toolbarEl.style.top = `${y / s}px`;
      return;
    }
    const clamped = clampToBounds(x, y, box.width, box.height);
    // На месте по умолчанию горизонталь не трогаем: зазор границ сдвинул бы панель
    // на свои несколько пикселей, а по ТЗ там она обязана стоять ровно там же, где
    // в разметке — «входить сама в себя».
    toolbarEl.style.left = `${(position === null && dock === null ? x : clamped.x) / s}px`;
    toolbarEl.style.top = `${clamped.y / s}px`;
  }

  // Куда панель попала по итогам перетаскивания: к краю текстового поля или в
  // свободную точку. Порог — десятая часть ширины поля, считается по центру панели.
  // Считаем по НЕзажатой позиции, а не по прямоугольнику на экране: тот уже вдавлен
  // в границы и до края не доезжает.
  //
  // И по БЛИЖНЕМУ КРАЮ панели, а не по её центру: у широкого тулбара центр от края
  // отделён половиной её ширины, и до порога он не добирается никогда — прилипнуть
  // было невозможно, сколько ни тащи. «Ближе 10% ширины поля к краю» — это про то,
  // насколько близко подошла сама панель.
  function resolveDock() {
    if (!position) return null;
    const bounds = boundsEl.getBoundingClientRect();
    const width = toolbarEl.getBoundingClientRect().width;
    const threshold = bounds.width * EDGE_SNAP_RATIO;
    if (position.x - bounds.left < threshold) return "left";
    if (bounds.right - (position.x + width) < threshold) return "right";
    return null;
  }

  // Ширину max-content анимировать нельзя, поэтому меряем цель и едем явными px.
  // По окончании перехода фиксацию снимаем — иначе панель перестанет реагировать на
  // сворачивание тулбара.
  function animateWidth(to) {
    const from = toolbarEl.offsetWidth;
    // Ехать некуда — и transitionend не придёт, а значит фиксация осталась бы
    // висеть навсегда и панель перестала бы подстраиваться под содержимое.
    if (Math.abs(from - to) < 1) {
      widthAnimation = null;
      toolbarEl.style.width = "";
      return;
    }
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
    const from = toolbarEl.offsetWidth;
    toolbarEl.classList.add("is-floating");
    applyDockClasses();
    // Снимаем остаток прошлой анимации ПЕРЕД замером: с пришпиленной шириной
    // offsetWidth вернул бы её же, а не ширину по содержимому, — панель так и
    // висела бы полосой во всю строку с пустым местом под недостающие кнопки.
    toolbarEl.style.width = "";
    const target = toolbarEl.offsetWidth; // теперь это max-content
    toolbarEl.style.width = `${from}px`; // возвращаем точку старта для перехода
    place();
    animateWidth(target);
    floating = true;
  }

  // Возврат в разметку. Прилипание к краю при этом не забывается — оно живёт в
  // dock и снова сработает, когда панель опять оторвётся (ТЗ, п.6).
  function goInline() {
    const target = hostEl.clientWidth;
    toolbarEl.classList.remove("is-floating", "is-docked", "is-docked-right");
    toolbarEl.style.left = "";
    toolbarEl.style.top = "";
    toolbarEl.style.maxHeight = "";
    toolbarEl.style.maxWidth = "";
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
    else if (floating && hostTop > threshold + HYSTERESIS_PX) goInline();
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
    // Пока панель едет, она снова горизонтальная: тащить вертикальную полосу,
    // которая на лету меняет ширину под курсором, невозможно.
    dock = null;
    applyDockClasses();
    applyDockHeight(box.top);
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
    // Порог прилипания и магнит считаем по НЕзажатой позиции — по той точке, куда
    // панель реально подвели, даже если она вышла за край.
    dock = resolveDock();
    // Магнит проверяется после краёв: у самого края побеждает прилипание.
    if (dock === null && position && Math.abs(position.x - defaultAnchor().x) < MAGNET_PX) position = null;
    // И только теперь возвращаем панель в границы — уже насовсем, в саму позицию,
    // чтобы запомнилось и восстанавливалось тоже зажатое значение.
    if (dock === null && position) {
      const box = toolbarEl.getBoundingClientRect();
      position = clampToBounds(position.x, position.y, box.width, box.height);
    }
    applyDockClasses();
    place();
    // Второй проход для прилипшей полосы: её ширина зависит от того, во сколько
    // колонок легли кнопки, а это становится известно только после первой
    // установки — с шириной от горизонтальной панели край уезжал за рамку.
    if (dock !== null) place();
    savePosition();
  }

  // Храним смещение от левого края поля, а не экранный x: так позиция переживает
  // смену ширины окна. y — от верха вьюпорта, панель ведь fixed.
  function savePosition() {
    if (dock !== null) {
      writePosition({ dock });
      return;
    }
    if (position === null) {
      writePosition(null); // вернулись к месту по умолчанию — помнить нечего
      return;
    }
    const bounds = boundsEl.getBoundingClientRect();
    writePosition({ dock: null, dx: position.x - bounds.left, y: position.y });
  }

  function restorePosition() {
    const saved = readPosition();
    if (!saved) return;
    if (saved.dock === "left" || saved.dock === "right") {
      dock = saved.dock;
      return;
    }
    if (typeof saved.dx === "number" && typeof saved.y === "number") {
      position = { x: boundsEl.getBoundingClientRect().left + saved.dx, y: saved.y };
    }
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
  // Позиция общая для раздела, поэтому поднимается при каждом открытии заметки.
  restorePosition();
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
