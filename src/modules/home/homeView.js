import { t } from "../../i18n/i18n.js";
import { escapeHtml } from "../../utils/dom.js";
import { openNotePicker } from "./notePicker.js";
import * as customCircles from "./customCircles.js";
import * as itemsService from "../../services/itemsService.js";
import { setPendingTarget, getNavigateHandler } from "../../search/searchTarget.js";

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
      </div>
    </div>
  `;

  positionExtraCircles(container);
  applyJitter(container);
  drawConnectorLines(container);
  wirePencil(container);
  wireCustomCircles(container, customCirclesData);
}

// Заметка могла исчезнуть между сохранением кружка и этим рендером — такой
// кружок здесь просто не попадает в разметку. Постоянная чистка хранилища
// (чтобы восстановление заметки из Корзины не вернуло кружок) — отдельный шаг.
async function loadCustomCirclesData() {
  const { circles } = customCircles.getState();
  const resolved = await Promise.all(
    circles.map(async (circle) => {
      const item = await itemsService.getItem(circle.noteId);
      return item && !item.deletedAt ? { ...circle, title: item.title } : null;
    })
  );
  return resolved.filter(Boolean);
}

function wirePencil(container) {
  const pencilEl = container.querySelector('[data-role="pencil"]');
  if (!pencilEl) return;
  pencilEl.addEventListener("click", async () => {
    const picked = await openNotePicker();
    if (!picked) return;
    customCircles.addCircle(picked);
    // Карандаш «использован» — больше не появляется (см. ТЗ, п.1).
    customCircles.setPencilDismissed(true);
    renderHomeView(container);
  });
}

function wireCustomCircles(container, circles) {
  circles.forEach((circle) => {
    const el = container.querySelector(`[data-circle-id="${circle.id}"]`);
    if (!el) return;
    el.addEventListener("click", () => {
      setPendingTarget({ kind: "item", id: circle.noteId, folderId: circle.folderId, query: "", matchIndex: 0 });
      getNavigateHandler()("notes");
    });
  });
}

// Кружки без своего места в CSS (карандаш, кастомные ярлыки на заметки)
// раскладываются равным шагом по той же окружности, что и три системных
// кружка (радиус ~30% от центра), со сдвигом на середину зазора между ними,
// чтобы не садиться поверх Notes/Calendar/AI.
const EXTRA_RADIUS = 30; // % от центра .home-circles
const EXTRA_ANGLE_OFFSET = 90; // °, ровно посередине между системными кружками

function positionExtraCircles(container) {
  const extras = [...container.querySelectorAll(".home-circle--pencil, .home-circle--custom")];
  const step = 360 / extras.length;
  extras.forEach((circle, index) => {
    const angle = ((EXTRA_ANGLE_OFFSET + index * step) * Math.PI) / 180;
    circle.style.top = `${50 + EXTRA_RADIUS * Math.sin(angle)}%`;
    circle.style.left = `${50 + EXTRA_RADIUS * Math.cos(angle)}%`;
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
