import { t } from "../../i18n/i18n.js";
import { escapeHtml } from "../../utils/dom.js";
import { openNotePicker } from "./notePicker.js";
import * as customCircles from "./customCircles.js";
import * as itemsService from "../../services/itemsService.js";
import { setPendingTarget, getNavigateHandler } from "../../search/searchTarget.js";
import { showContextMenu } from "../shared/contextMenu.js";
import { findPosition, fitsAt } from "./circleLayout.js";

export async function renderHomeView(container) {
  const { pencilDismissed } = customCircles.getState();
  const customCirclesData = await loadCustomCirclesData();

  const pencilHtml = pencilDismissed
    ? ""
    : `
        <div class="home-circle home-circle--pencil" tabindex="0" data-role="pencil">
          <span class="home-circle-label">✏️</span>
          <span class="home-circle-overlay">${t("home.pencilTooltip")}</span>
        </div>`;

  const customCirclesHtml = customCirclesData
    .map(
      (circle) => `
        <div class="home-circle home-circle--custom" tabindex="0" data-role="custom-circle" data-circle-id="${circle.id}">
          <span class="home-circle-label">${escapeHtml(circle.title || t("panel.untitled"))}</span>
        </div>`
    )
    .join("");

  container.innerHTML = `
    <div class="home">
      <svg class="home-lines"></svg>
      <div class="home-circles">
        <a href="#/notes" class="home-circle home-circle--notes" draggable="false">
          <span class="home-circle-label">${t("home.notes")}</span>
        </a>
        <a href="#/calendar" class="home-circle home-circle--calendar" draggable="false">
          <span class="home-circle-label">${t("home.calendar")}</span>
        </a>
        <div class="home-circle home-circle--ai" tabindex="0">
          <span class="home-circle-label">${t("home.ai")}</span>
          <span class="home-circle-overlay">${t("home.aiUnavailable")}</span>
        </div>
        ${pencilHtml}
        ${customCirclesHtml}
        <button type="button" class="home-add-circle" title="${escapeHtml(t("home.addCircle"))}"></button>
      </div>
    </div>
  `;

  positionExtraCircles(container, customCirclesData);
  applyJitter(container);
  drawConnectorLines(container);
  wirePencil(container);
  wireCustomCircles(container, customCirclesData);
  wireAddCircle(container);
}

// Заметка, к которой привязан кружок, могла исчезнуть или уйти в Корзину —
// pruneDeadCircles убирает такой кружок ИЗ ХРАНИЛИЩА навсегда (а не просто
// прячет на этот рендер), поэтому восстановление заметки из Корзины кружок
// не возвращает (ТЗ, п.8).
async function loadCustomCirclesData() {
  const circles = await customCircles.pruneDeadCircles();
  return Promise.all(
    circles.map(async (circle) => {
      const item = await itemsService.getItem(circle.noteId);
      return { ...circle, title: item.title };
    })
  );
}

// Открывает меню выбора и, если пользователь дошёл до "Done", сохраняет новый
// кастомный кружок (Cancel/Esc — picked пустой, ничего не меняется). Общий
// путь для левого клика по карандашу, пункта "Customizable note" в его
// ПКМ-меню и центрального кружка-плюса — тот не должен трогать карандаш,
// поэтому dismissPencil включают только первые два места.
async function pickAndBindCircle(container, { dismissPencil = false } = {}) {
  const picked = await openNotePicker();
  if (!picked) return;
  customCircles.addCircle(picked);
  if (dismissPencil) customCircles.setPencilDismissed(true);
  renderHomeView(container);
}

function wirePencil(container) {
  const pencilEl = container.querySelector('[data-role="pencil"]');
  if (!pencilEl) return;

  // Карандаш «использован» и больше не появляется, только если пользователь
  // либо реально выбрал заметку, либо явно нажал "Ignore" в ПКМ-меню (см. ТЗ,
  // п.1 и п.4) — отмена/Esc в меню выбора оставляет карандаш как есть.
  pencilEl.addEventListener("click", () => pickAndBindCircle(container, { dismissPencil: true }));

  pencilEl.addEventListener("contextmenu", (event) => {
    event.preventDefault();
    showContextMenu(event.clientX, event.clientY, [
      {
        label: t("home.ignore"),
        onClick: () => {
          customCircles.setPencilDismissed(true);
          renderHomeView(container);
        },
      },
      {
        label: t("home.customizableNote"),
        onClick: () => pickAndBindCircle(container, { dismissPencil: true }),
      },
    ]);
  });
}

// Notes/Calendar/AI и кружок-плюс не получают этот слушатель вообще — у них
// просто нет пункта "Удалить" (см. ТЗ, п.7: дефолтные кружки нельзя удалить).
function wireCustomCircles(container, circles) {
  circles.forEach((circle) => {
    const el = container.querySelector(`[data-circle-id="${circle.id}"]`);
    if (!el) return;
    el.addEventListener("click", () => {
      setPendingTarget({ kind: "item", id: circle.noteId, folderId: circle.folderId, query: "", matchIndex: 0 });
      getNavigateHandler()("notes");
    });
    el.addEventListener("contextmenu", (event) => {
      event.preventDefault();
      showContextMenu(event.clientX, event.clientY, [
        {
          label: t("home.deleteCircle"),
          onClick: () => {
            // Удаляется только ярлык — сама заметка не трогается (ТЗ, п.6).
            customCircles.removeCircle(circle.id);
            renderHomeView(container);
          },
        },
      ]);
    });
  });
}

// Кружок-плюс не трогает карандаш (см. ТЗ, п.5: "виден всегда, независимо от
// того, нажимал ли пользователь Ignore") — dismissPencil здесь не передаём.
function wireAddCircle(container) {
  const addEl = container.querySelector(".home-add-circle");
  addEl.addEventListener("click", () => pickAndBindCircle(container));
}

// Кастомные кружки хранят однажды подобранную позицию (angle/radius, см.
// customCircles.js) — при рендере она переиспользуется как есть, если всё
// ещё ни с чем не пересекается (fitsAt), и только тогда пересчитывается через
// circleLayout.findPosition, когда её нет (новый кружок / старая запись без
// позиции) или она вдруг стала невалидной (например, после смены размера
// окна). Так раскладка не "прыгает" целиком при каждом добавлении/удалении
// соседа (ТЗ, п.2) — только у самого нового/пересекшегося кружка появляется
// новая позиция, у остальных всё остаётся как было. Карандаш отдельной
// записи не имеет и всегда ищется заново — он либо первый (ничего ещё не
// занято), либо единственный временный участник раскладки.
const CENTER_DOT_DIAMETER_PX = 26; // см. .home-add-circle в home.css

// Полярные координаты центра элемента относительно центра boxRect — та же
// система (angle°, radius% от ширины), в которой считает circleLayout.
function toPolar(el, boxRect) {
  const rect = el.getBoundingClientRect();
  const dx = rect.left + rect.width / 2 - (boxRect.left + boxRect.width / 2);
  const dy = rect.top + rect.height / 2 - (boxRect.top + boxRect.height / 2);
  return {
    angle: (Math.atan2(dy, dx) * 180) / Math.PI,
    radius: (Math.hypot(dx, dy) / boxRect.width) * 100,
  };
}

function positionExtraCircles(container, customCirclesData) {
  const pencilEl = container.querySelector('[data-role="pencil"]');
  const customEntries = customCirclesData.map((data) => ({
    data,
    el: container.querySelector(`[data-circle-id="${data.id}"]`),
  }));
  const anyEl = pencilEl || customEntries[0]?.el;
  if (!anyEl) return;

  // Мерить нужно именно .home-circles, а не container (сюда роутер передаёт
  // весь #app-view): проценты, которые мы ниже пишем в style.top/left,
  // браузер резолвит относительно .home-circles — ближайшего предка с
  // position: relative. С шириной #app-view (она в разы больше) вся
  // геометрия считалась в чужом масштабе, fitsAt рапортовал "пересечений
  // нет", а кружки на экране налезали друг на друга.
  const box = container.querySelector(".home-circles");
  const boxRect = box.getBoundingClientRect();
  const containerWidth = boxRect.width;
  const circleDiameterPx = anyEl.getBoundingClientRect().width;

  // Позиции системных кружков заданы процентами в styles/home.css — снимаем
  // их с DOM, чтобы не держать здесь вторую копию тех же чисел, которая
  // молча разъедется при любой правке стилей. applyJitter вызывается уже
  // после нас, так что ректы дают чистые базовые позиции без смещения.
  const obstacles = [
    ...box.querySelectorAll(".home-circle--notes, .home-circle--calendar, .home-circle--ai"),
  ].map((el) => ({
    ...toPolar(el, boxRect),
    diameterPx: el.getBoundingClientRect().width,
    jitterPx: SYSTEM_JITTER,
  }));
  const systemRadiusPct = Math.max(...obstacles.map((o) => o.radius));
  obstacles.push({ angle: 0, radius: 0, diameterPx: CENTER_DOT_DIAMETER_PX, jitterPx: 0 });

  function place(el, storedPos) {
    const validStored =
      storedPos &&
      typeof storedPos.angle === "number" &&
      typeof storedPos.radius === "number" &&
      fitsAt(storedPos, circleDiameterPx, EXTRA_JITTER, obstacles, containerWidth);
    const pos = validStored
      ? storedPos
      : findPosition({
          containerWidth,
          circleDiameterPx,
          circleJitterPx: EXTRA_JITTER,
          systemRadiusPct,
          systemJitterPx: SYSTEM_JITTER,
          obstacles,
        });
    el.style.top = `${50 + pos.radius * Math.sin((pos.angle * Math.PI) / 180)}%`;
    el.style.left = `${50 + pos.radius * Math.cos((pos.angle * Math.PI) / 180)}%`;
    obstacles.push({ ...pos, diameterPx: circleDiameterPx, jitterPx: EXTRA_JITTER });
    return { pos, needsPersist: !validStored };
  }

  if (pencilEl) place(pencilEl, null);

  const positionUpdates = [];
  customEntries.forEach(({ data, el }) => {
    if (!el) return;
    const stored = data.angle != null && data.radius != null ? { angle: data.angle, radius: data.radius } : null;
    const { pos, needsPersist } = place(el, stored);
    if (needsPersist) positionUpdates.push({ id: data.id, angle: pos.angle, radius: pos.radius });
  });
  if (positionUpdates.length) customCircles.updatePositions(positionUpdates);
}

// Базовые позиции кружков заданы в CSS/circleLayout (круг вокруг центра).
// Здесь при каждом заходе добавляем небольшое случайное смещение через
// --tx/--ty, чтобы схема оставалась узнаваемой, но не была статичной.
// Эти же величины уходят в circleLayout как jitterPx: раскладка закладывает
// их максимум в зазор заранее, поэтому никакой бросок не может схлопнуть
// расстояние между доп. кружками и соседями.
//
// А вот друг относительно друга три системных кружка раскладку не проходят —
// их top/left жёстко заданы в home.css, и единственное, что их сближает, это
// как раз джиттер. Считаем допустимый потолок: центры стоят на 30% ширины
// .home-circles и разнесены на 120°, то есть на 2*0.3*460*sin60° ≈ 239px;
// минус диаметр 172px остаётся ≈67px зазора. Бросок независим по x и y, так
// что каждый кружок уходит максимум на J*√2, и навстречу они съедают 2*J*√2.
// При J=32 это ≈90px — больше зазора, и Notes с Calendar иногда налезали друг
// на друга. J=16 съедает ≈45px и оставляет ≈22px гарантированно.
const SYSTEM_JITTER = 16;
const EXTRA_JITTER = 10;

function applyJitter(container) {
  const jitterOne = (circle, magnitude) => {
    const tx = Math.round((Math.random() * 2 - 1) * magnitude);
    const ty = Math.round((Math.random() * 2 - 1) * magnitude);
    circle.style.setProperty("--tx", `${tx}px`);
    circle.style.setProperty("--ty", `${ty}px`);
  };
  container
    .querySelectorAll(".home-circle--notes, .home-circle--calendar, .home-circle--ai")
    .forEach((circle) => jitterOne(circle, SYSTEM_JITTER));
  container
    .querySelectorAll(".home-circle--pencil, .home-circle--custom")
    .forEach((circle) => jitterOne(circle, EXTRA_JITTER));
}

// Круги позиционируются в CSS процентами внутри .home-circles — реальные
// экранные координаты известны только после рендера, поэтому линии к центру
// экрана считаем через getBoundingClientRect, а не аналитически.
function drawConnectorLines(container) {
  const svg = container.querySelector(".home-lines");
  const circles = container.querySelectorAll(".home-circle");
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  svg.setAttribute("width", vw);
  svg.setAttribute("height", vh);

  const centerX = vw / 2;
  const centerY = vh / 2;

  // CSS-проценты у position:fixed на паре пикселей расходятся с window.inner*
  // (скроллбар по-разному учитывается) — координаты той же точки, что и у
  // схождения линий, поэтому ставим явно, а не через top/left:50% в CSS.
  const addCircle = container.querySelector(".home-add-circle");
  addCircle.style.left = `${centerX}px`;
  addCircle.style.top = `${centerY}px`;

  svg.innerHTML = [...circles]
    .map((circle) => {
      const rect = circle.getBoundingClientRect();
      const x = rect.left + rect.width / 2;
      const y = rect.top + rect.height / 2;
      return `<line x1="${x}" y1="${y}" x2="${centerX}" y2="${centerY}"></line>`;
    })
    .join("");
}
