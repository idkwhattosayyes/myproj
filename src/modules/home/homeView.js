import { t } from "../../i18n/i18n.js";
import { escapeHtml } from "../../utils/dom.js";
import { openNotePicker } from "./notePicker.js";
import * as customCircles from "./customCircles.js";
import * as itemsService from "../../services/itemsService.js";
import { setPendingTarget, getNavigateHandler } from "../../search/searchTarget.js";
import { showContextMenu } from "../shared/contextMenu.js";
import { findPosition, fitsAt } from "./circleLayout.js";

// Отцепка слушателя resize от предыдущего захода на главную. Роутер чистит
// #app-view при каждом переходе, но слушатель висит на window и это переживает —
// без снятия они копились бы с каждым возвратом на главную. Тот же приём, что у
// detachFloatingToolbar в modules/shared/panelSection.js.
let detachHomeResize = null;

export async function renderHomeView(container) {
  if (detachHomeResize) {
    detachHomeResize();
    detachHomeResize = null;
  }

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
      </div>
      <!-- Центральная точка лежит СНАРУЖИ .home-circles, хотя логически стоит в
           его середине: у контейнера есть transform (масштаб сцены), а
           трансформированный предок становится точкой отсчёта для position: fixed
           потомков — внутри дот считал бы свои пиксельные координаты от
           контейнера, да ещё и ужимался бы вместе со сценой. -->
      <button type="button" class="home-add-circle" title="${escapeHtml(t("home.addCircle"))}"></button>
    </div>
  `;

  positionExtraCircles(container, customCirclesData);
  applyJitter(container);
  // Порядок важен: масштаб меряется по ректам, в которые уже входят сдвиги
  // --tx/--ty от джиттера, а линии рисуются по ректам, уже сжатым масштабом.
  fitSceneToViewport(container);
  drawConnectorLines(container);
  detachHomeResize = watchViewportResize(container);
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
  obstacles.push({ angle: 0, radius: 0, diameterPx: CENTER_DOT_DIAMETER_PX, jitterPx: 0 });

  function place(el, storedPos) {
    const validStored =
      storedPos &&
      typeof storedPos.angle === "number" &&
      typeof storedPos.radius === "number" &&
      fitsAt(storedPos, circleDiameterPx, EXTRA_JITTER, obstacles, containerWidth);
    const pos = validStored
      ? storedPos
      : findPosition({ containerWidth, circleDiameterPx, circleJitterPx: EXTRA_JITTER, obstacles });
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
    // Первый бросок обязан примениться мгновенно. У .home-circle анимируется
    // transform (нужен для наведения), а --tx/--ty сидят в нём же — со включённым
    // переходом кружок 0.22s едет на своё место, и всё, что меряет его рект в это
    // время, получает промежуточные координаты. Линии рисовались как раз тогда и
    // приходили мимо центров на ~11px. Снимаем переход, применяем сдвиг,
    // принудительным чтением геометрии закрываем кадр и возвращаем переход.
    circle.style.transition = "none";
    circle.style.setProperty("--tx", `${tx}px`);
    circle.style.setProperty("--ty", `${ty}px`);
    circle.getBoundingClientRect();
    circle.style.transition = "";
  };
  container
    .querySelectorAll(".home-circle--notes, .home-circle--calendar, .home-circle--ai")
    .forEach((circle) => jitterOne(circle, SYSTEM_JITTER));
  container
    .querySelectorAll(".home-circle--pencil, .home-circle--custom")
    .forEach((circle) => jitterOne(circle, EXTRA_JITTER));
}

// Размер окна поменялся — сцена и линии обязаны переехать вместе. Кружки стоят в
// процентах от ширины .home-circles и уезжают на новые места сами, а вот линии
// рисуются в пикселях один раз, поэтому без пересчёта оставались от старого
// размера окна: тянулись в прежнюю сторону и прежней длины, и всё вставало на
// место только после F5.
//
// Чего тут намеренно НЕ делается:
//   - не зовём positionExtraCircles: раскладка перезапустилась бы прямо под
//     курсором и кружки прыгали бы во время тяги за рамку. Сохранённые позиции
//     пропорциональны ширине контейнера и едут правильно сами, а разошедшиеся
//     чинятся на следующем полном рендере — этот путь уже есть;
//   - не зовём applyJitter: новый бросок дёргал бы кружки случайно на каждом
//     кадре изменения размера. Уже проставленные --tx/--ty переиспользуются.
function watchViewportResize(container) {
  // resize сыплется пачками, а работа тут — чтение геометрии, поэтому на кадр
  // делаем её один раз. Тем же приёмом, что schedule() в floatingToolbar.js.
  let frame = 0;
  const update = () => {
    frame = 0;
    fitSceneToViewport(container);
    drawConnectorLines(container);
  };
  const onResize = () => {
    if (frame) return;
    frame = requestAnimationFrame(update);
  };
  window.addEventListener("resize", onResize);
  return function detach() {
    if (frame) cancelAnimationFrame(frame);
    window.removeEventListener("resize", onResize);
  };
}

// Сцену с кружками ужимаем до свободного места, вместо того чтобы переделывать
// раскладку. Кружков может быть сколько угодно, и findPosition разгоняет их от
// центра без верхней границы — рано или поздно они вылезали за экран, и главная
// начинала прокручиваться. Один коэффициент масштаба решает это разом, а заодно
// даёт требуемое «чем больше кружков, тем они мельче»: шире разлёт — меньше
// коэффициент. Сохранённые позиции при этом не трогаются и не переезжают.
function fitSceneToViewport(container) {
  const home = container.querySelector(".home");
  const box = container.querySelector(".home-circles");
  if (!home || !box) return;

  // Мерить нужно несжатую сцену, иначе счёт выходит круговой: коэффициент
  // считался бы по габаритам, которые он сам и задал.
  box.style.setProperty("--home-scale", "1");

  // Свободное место спрашиваем у самого DOM, а не считаем в JS высоту полоски
  // поиска и отступы заново: у .home они уже учтены в padding (см. home.css),
  // и число 3.2rem остаётся жить в одном месте.
  const homeStyle = getComputedStyle(home);
  const availWidth =
    home.clientWidth - parseFloat(homeStyle.paddingLeft) - parseFloat(homeStyle.paddingRight);
  const availHeight =
    home.clientHeight - parseFloat(homeStyle.paddingTop) - parseFloat(homeStyle.paddingBottom);

  const boxRect = box.getBoundingClientRect();
  const centerX = boxRect.left + boxRect.width / 2;
  const centerY = boxRect.top + boxRect.height / 2;

  // Габариты считаем симметрично центру: scale жмёт именно к нему, поэтому
  // важно, насколько далеко ушёл самый дальний край, а не где границы сцены.
  let halfWidth = 0;
  let halfHeight = 0;
  container.querySelectorAll(".home-circle").forEach((circle) => {
    const rect = circle.getBoundingClientRect();
    halfWidth = Math.max(halfWidth, Math.abs(rect.left + rect.width / 2 - centerX) + rect.width / 2);
    halfHeight = Math.max(halfHeight, Math.abs(rect.top + rect.height / 2 - centerY) + rect.height / 2);
  });
  if (!halfWidth || !halfHeight) return;

  // Больше единицы не растягиваем: когда кружков мало и всё помещается, вид
  // остаётся ровно таким, каким его задаёт CSS.
  const scale = Math.min(1, availWidth / (halfWidth * 2), availHeight / (halfHeight * 2));
  box.style.setProperty("--home-scale", String(scale));
}

// Круги позиционируются в CSS процентами внутри .home-circles — реальные
// экранные координаты известны только после рендера, поэтому линии к центру
// считаем через getBoundingClientRect, а не аналитически. Он же учитывает
// масштаб от fitSceneToViewport, поэтому линии обязаны рисоваться после него.
function drawConnectorLines(container) {
  const svg = container.querySelector(".home-lines");
  const circles = container.querySelectorAll(".home-circle");
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  svg.setAttribute("width", vw);
  svg.setAttribute("height", vh);

  // Сводим в центр .home-circles, а не экрана: кружки разложены вокруг первого,
  // и точки расходятся — по горизонтали из-за scrollbar-gutter, по вертикали
  // из-за резерва под полоску поиска. С центром экрана линии приходили мимо
  // середины схемы.
  const boxRect = container.querySelector(".home-circles").getBoundingClientRect();
  const centerX = boxRect.left + boxRect.width / 2;
  const centerY = boxRect.top + boxRect.height / 2;

  // Точка в пикселях, той же парой чисел, что и схождение линий — так это
  // гарантированно одна точка, а не два независимых расчёта.
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
