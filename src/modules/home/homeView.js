import { t } from "../../i18n/i18n.js";

export async function renderHomeView(container) {
  container.innerHTML = `
    <div class="home">
      <svg class="home-lines"></svg>
      <div class="home-circles">
        <a href="#/tasks" class="home-circle home-circle--tasks">
          <span class="home-circle-label">${t("home.tasks")}</span>
        </a>
        <a href="#/documents" class="home-circle home-circle--documents">
          <span class="home-circle-label">${t("home.documents")}</span>
        </a>
        <a href="#/calendar" class="home-circle home-circle--calendar">
          <span class="home-circle-label">${t("home.calendar")}</span>
        </a>
        <div class="home-circle home-circle--ai" tabindex="0">
          <span class="home-circle-label">${t("home.ai")}</span>
          <span class="home-circle-overlay">${t("home.aiUnavailable")}</span>
        </div>
      </div>
    </div>
  `;

  applyJitter(container);
  drawConnectorLines(container);
}

// Базовые позиции кружков заданы в CSS (круг вокруг центра). Здесь при каждом
// заходе добавляем небольшое случайное смещение через --tx/--ty, чтобы схема
// оставалась узнаваемой, но не была статичной.
function applyJitter(container) {
  const JITTER = 18; // px, максимальное отклонение в каждую сторону
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
