import { t } from "../../i18n/i18n.js";

const CIRCLE_RADIUS = 86; // px — фиксированный размер, чтобы JS-расчёт позиций совпадал с реальным размером на экране
const EDGE_MARGIN = 100;
const MIN_GAP = 25; // минимальный зазор между краями соседних кружков

const CIRCLES = [
  { key: "tasks", tag: "a", href: "#/tasks", labelKey: "home.tasks" },
  { key: "documents", tag: "a", href: "#/documents", labelKey: "home.documents" },
  { key: "calendar", tag: "a", href: "#/calendar", labelKey: "home.calendar" },
  { key: "ai", tag: "div", labelKey: "home.ai", overlayKey: "home.aiUnavailable" },
];

export async function renderHomeView(container) {
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const positions = placeCircles(CIRCLES.length, CIRCLE_RADIUS, vw, vh);
  const centerX = vw / 2;
  const centerY = vh / 2;

  const lines = positions
    .map((p) => `<line x1="${p.x}" y1="${p.y}" x2="${centerX}" y2="${centerY}"></line>`)
    .join("");

  const circles = CIRCLES.map((circle, i) => {
    const pos = positions[i];
    const style = `left:${pos.x}px; top:${pos.y}px; width:${CIRCLE_RADIUS * 2}px; height:${CIRCLE_RADIUS * 2}px;`;
    const label = `<span class="home-circle-label">${t(circle.labelKey)}</span>`;

    if (circle.tag === "div") {
      const overlay = `<span class="home-circle-overlay">${t(circle.overlayKey)}</span>`;
      return `<div class="home-circle home-circle--${circle.key}" style="${style}" tabindex="0">${label}${overlay}</div>`;
    }

    return `<a href="${circle.href}" class="home-circle home-circle--${circle.key}" style="${style}">${label}</a>`;
  }).join("");

  container.innerHTML = `
    <div class="home">
      <svg class="home-lines" width="${vw}" height="${vh}">${lines}</svg>
      ${circles}
    </div>
  `;
}

// Случайно расставляет n кружков радиуса r в пределах экрана так, чтобы они
// не пересекались (расстояние между центрами >= 2r + MIN_GAP) и держались на
// расстоянии EDGE_MARGIN от краёв. При исчерпании попыток — запасная точка на
// равномерной сетке, чтобы никогда не зависнуть на маленьких вьюпортах.
function placeCircles(n, r, vw, vh) {
  let margin = EDGE_MARGIN;
  while (margin > 0 && (vw - 2 * (margin + r) < 0 || vh - 2 * (margin + r) < 0)) {
    margin -= 10;
  }
  margin = Math.max(0, margin);

  const minDist = 2 * r + MIN_GAP;
  const points = [];

  for (let i = 0; i < n; i++) {
    let placed = null;
    for (let attempt = 0; attempt < 300 && !placed; attempt++) {
      const x = margin + r + Math.random() * Math.max(0, vw - 2 * (margin + r));
      const y = margin + r + Math.random() * Math.max(0, vh - 2 * (margin + r));
      if (points.every((p) => Math.hypot(p.x - x, p.y - y) >= minDist)) {
        placed = { x, y };
      }
    }
    points.push(placed || fallbackPoint(i, n, r, margin, vw, vh));
  }

  return points;
}

function fallbackPoint(index, total, r, margin, vw, vh) {
  const usableWidth = Math.max(1, vw - 2 * (margin + r));
  const step = total > 1 ? usableWidth / (total - 1) : 0;
  return {
    x: margin + r + step * index,
    y: vh / 2,
  };
}
