// Геометрия раскладки кружков главной страницы — чистые функции, без DOM.
// Все позиции — полярные координаты: angle° от центра .home-circles,
// radius% от его ширины (та же система, что уже использует homeView.js).

export const MARGIN_PX = 28; // запас между краями кружков, из ТЗ (20-30px)

// Три системных кружка стоят на этом радиусе (см. .home-circle--notes/
// --calendar/--ai в styles/home.css) — под этими же углами.
export const SYSTEM_RADIUS_PCT = 30;
export const SYSTEM_ANGLES = [270, 30, 150]; // Notes, Calendar, AI

const ANGLE_STEP_DEG = 10; // шаг перебора кандидатов по кругу

function polarToPx(pos, containerWidth) {
  const rad = (pos.angle * Math.PI) / 180;
  const r = (pos.radius / 100) * containerWidth;
  return { x: r * Math.cos(rad), y: r * Math.sin(rad) };
}

// obstacle: {angle, radius, diameterPx} — уже размещённые кружки (системные,
// центральная точка, ранее поставленные доп. кружки). Расстояние между
// центрами должно быть не меньше суммы радиусов плюс запас — иначе кружки
// накладываются.
export function fitsAt(candidate, candidateDiameterPx, obstacles, containerWidth) {
  const c = polarToPx(candidate, containerWidth);
  return obstacles.every((o) => {
    const p = polarToPx(o, containerWidth);
    const dist = Math.hypot(c.x - p.x, c.y - p.y);
    return dist >= candidateDiameterPx / 2 + o.diameterPx / 2 + MARGIN_PX;
  });
}

// Одно кольцо за пределами трёх системных кружков; если по кругу не нашлось
// свободного угла — кольцо отодвигается ещё на диаметр+запас и перебор
// повторяется. Открытый цикл — работает при любом количестве кружков (шаг 3
// заменит это явными слоями, но сам перебор и fitsAt остаются тем же).
export function findPosition({ containerWidth, circleDiameterPx, obstacles }) {
  const systemRadiusPx = (SYSTEM_RADIUS_PCT / 100) * containerWidth;
  let ringRadiusPx = systemRadiusPx + circleDiameterPx + MARGIN_PX;

  // Предохранитель от зависания на испорченных входных данных (например,
  // containerWidth ещё не посчитан) — в норме место находится за 1-2 кольца.
  for (let ring = 0; ring < 200; ring++) {
    for (let angle = 0; angle < 360; angle += ANGLE_STEP_DEG) {
      const candidate = { angle, radius: (ringRadiusPx / containerWidth) * 100 };
      if (fitsAt(candidate, circleDiameterPx, obstacles, containerWidth)) return candidate;
    }
    ringRadiusPx += circleDiameterPx + MARGIN_PX;
  }
  return { angle: 0, radius: (ringRadiusPx / containerWidth) * 100 };
}
