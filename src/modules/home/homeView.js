import { t } from "../../i18n/i18n.js";
import { escapeHtml } from "../../utils/dom.js";
import { openNotePicker } from "./notePicker.js";
import * as customCircles from "./customCircles.js";
import * as itemsService from "../../services/itemsService.js";
import { setPendingTarget, getNavigateHandler } from "../../search/searchTarget.js";
import { showContextMenu } from "../shared/contextMenu.js";

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
        <button type="button" class="home-add-circle" title="${escapeHtml(t("home.addCircle"))}">+</button>
      </div>
    </div>
  `;

  positionExtraCircles(container);
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

// Кружки без своего места в CSS (карандаш, кастомные ярлыки на заметки)
// раскладываются равным шагом по кругу вокруг центра — отдельным, более узким
// кольцом, чем у трёх системных кружков (у тех радиус ~30%). Их количество
// заранее не известно и меняется во время сессии, поэтому шаг между ними
// подстраивается под текущее число; при определённом количестве этот шаг мог
// бы случайно совпасть с углом одного из системных кружков — другой радиус
// гарантирует, что кружки в этом случае не сядут друг на друга буквально.
const EXTRA_MIN_RADIUS = 20; // % — радиус при 0-1 доп. кружках
const EXTRA_ANGLE_OFFSET = 90; // ° — начальный поворот, чисто эстетический
// Диаметр кружка (clamp(120px,16vw,172px)) — примерно постоянная доля ширины
// .home-circles (clamp(320px,58vw,460px)) на всём диапазоне вьюпортов: оба
// clamp() подобраны в одной пропорции. Запас — чтобы кружки не касались впритык.
const CIRCLE_TO_CONTAINER_RATIO = 0.375;
const OVERLAP_MARGIN = 1.15;

// Радиус кольца, при котором хорда между соседними из `count` кружков не
// меньше их диаметра — иначе они накладываются друг на друга. Порядок/схема
// расположения (угол = смещение + index·шаг) не меняется вообще — растёт
// только это общее для всех число, кружки просто отодвигаются от центра.
function extraRadiusFor(count) {
  if (count <= 1) return EXTRA_MIN_RADIUS;
  const needed = ((CIRCLE_TO_CONTAINER_RATIO * OVERLAP_MARGIN) / (2 * Math.sin(Math.PI / count))) * 100;
  return Math.max(EXTRA_MIN_RADIUS, needed);
}

function positionExtraCircles(container) {
  const extras = [...container.querySelectorAll(".home-circle--pencil, .home-circle--custom")];
  const step = 360 / extras.length;
  const radius = extraRadiusFor(extras.length);
  extras.forEach((circle, index) => {
    const angle = ((EXTRA_ANGLE_OFFSET + index * step) * Math.PI) / 180;
    circle.style.top = `${50 + radius * Math.sin(angle)}%`;
    circle.style.left = `${50 + radius * Math.cos(angle)}%`;
  });
}

// Базовые позиции кружков заданы в CSS (круг вокруг центра). Здесь при каждом
// заходе добавляем небольшое случайное смещение через --tx/--ty, чтобы схема
// оставалась узнаваемой, но не была статичной.
function applyJitter(container) {
  const JITTER = 32; // px, максимальное отклонение в каждую сторону
  container.querySelectorAll(".home-circle").forEach((circle) => {
    const tx = Math.round((Math.random() * 2 - 1) * JITTER);
    const ty = Math.round((Math.random() * 2 - 1) * JITTER);
    circle.style.setProperty("--tx", `${tx}px`);
    circle.style.setProperty("--ty", `${ty}px`);
  });
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

  svg.innerHTML = [...circles]
    .map((circle) => {
      const rect = circle.getBoundingClientRect();
      const x = rect.left + rect.width / 2;
      const y = rect.top + rect.height / 2;
      return `<line x1="${x}" y1="${y}" x2="${centerX}" y2="${centerY}"></line>`;
    })
    .join("");
}
