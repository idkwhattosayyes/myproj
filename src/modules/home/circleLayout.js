// Геометрия раскладки кружков главной страницы — чистые функции, без DOM.
// Все позиции — полярные координаты: angle° от центра .home-circles,
// radius% от ЕГО ширины.
//
// Про масштаб: проценты, которые homeView пишет в style.top/left, браузер
// резолвит относительно .home-circles — ближайшего предка с position:
// relative. Значит и containerWidth сюда обязан приходить от него же.
// Стоит подставить ширину другого элемента (например, всего #app-view) —
// и вся математика ниже считается в чужом масштабе: проверка на пересечения
// проходит, а кружки на экране всё равно налезают друг на друга. Этот баг
// уже чинили, не верни его.

export const MARGIN_PX = 28; // запас между краями кружков, из ТЗ (20-30px)

// Середины зазоров между соседними системными кружками — ровно между их
// углами (270↔30 → 330, 30↔150 → 90, 150↔270 → 210).
export const GAP_ANGLES = [330, 90, 210];

const ANGLE_STEP_DEG = 10; // шаг перебора кандидатов по кругу

function polarToPx(pos, containerWidth) {
  const rad = (pos.angle * Math.PI) / 180;
  const r = (pos.radius / 100) * containerWidth;
  return { x: r * Math.cos(rad), y: r * Math.sin(rad) };
}

// Джиттер бросается независимо по x и по y, поэтому худшее смещение центра —
// не сама величина, а её диагональ.
function maxShift(jitterPx) {
  return jitterPx * Math.SQRT2;
}

// obstacle: {angle, radius, diameterPx, jitterPx} — уже размещённые кружки
// (системные, центральная точка, ранее поставленные доп. кружки). Расстояние
// между центрами должно быть не меньше суммы радиусов плюс запас — иначе
// кружки накладываются.
//
// jitterPx — то, насколько applyJitter может сдвинуть кружок уже ПОСЛЕ
// раскладки. Закладываем не текущий бросок, а его максимум: бросок новый на
// каждом заходе, а найденная позиция сохраняется и обязана оставаться
// валидной после перезагрузки. Иначе гарантия держится на везении, а
// сохранённые кружки при неудачном броске начинают переезжать.
export function fitsAt(candidate, candidateDiameterPx, candidateJitterPx, obstacles, containerWidth) {
  const c = polarToPx(candidate, containerWidth);
  return obstacles.every((o) => {
    const p = polarToPx(o, containerWidth);
    const dist = Math.hypot(c.x - p.x, c.y - p.y);
    const need =
      candidateDiameterPx / 2 + o.diameterPx / 2 + MARGIN_PX + maxShift(candidateJitterPx) + maxShift(o.jitterPx);
    return dist >= need;
  });
}

// Перебирает углы 0..350 на фиксированном радиусе, возвращает первый, что
// проходит fitsAt, или null, если на этом кольце свободного места нет.
function sweepRing(ringRadiusPx, circleDiameterPx, circleJitterPx, obstacles, containerWidth) {
  for (let angle = 0; angle < 360; angle += ANGLE_STEP_DEG) {
    const candidate = { angle, radius: (ringRadiusPx / containerWidth) * 100 };
    if (fitsAt(candidate, circleDiameterPx, circleJitterPx, obstacles, containerWidth)) return candidate;
  }
  return null;
}

// Место для кружка ищется по слоям, в порядке — первое, что подошло, и используется:
//
// 1. Внешнее кольцо — сразу за тремя системными кружками, при любом угле.
// 2. Зазоры между системными — три фиксированных угла (GAP_ANGLES), радиус
//    меньше слоя 1 (то есть буквально "внутри" уже сформированного внешнего
//    круга); подбирается перебором снизу вверх, а не по формуле — так проще
//    и надёжнее, чем решать треугольник с системным кружком аналитически.
// 3. Кольца ещё дальше — та же логика, что и слой 1, только радиус растёт на
//    диаметр+запас, пока не найдётся свободный угол; открытый цикл, так что
//    работает при любом количестве кружков.
export function findPosition({
  containerWidth,
  circleDiameterPx,
  circleJitterPx,
  systemRadiusPct,
  systemJitterPx,
  obstacles,
}) {
  const systemRadiusPx = (systemRadiusPct / 100) * containerWidth;
  const clearance = circleDiameterPx + MARGIN_PX + maxShift(circleJitterPx) + maxShift(systemJitterPx);
  const ring1RadiusPx = systemRadiusPx + clearance;

  const ring1 = sweepRing(ring1RadiusPx, circleDiameterPx, circleJitterPx, obstacles, containerWidth);
  if (ring1) return ring1;

  for (const gapAngle of GAP_ANGLES) {
    // Перебираем радиус снизу вверх мелким шагом, пока кандидат в этом
    // зазоре не перестанет задевать ближайший системный кружок — потолок
    // ring1RadiusPx, дальше это уже не "внутри", а слой 1.
    for (let radiusPx = circleDiameterPx / 2; radiusPx < ring1RadiusPx; radiusPx += 4) {
      const candidate = { angle: gapAngle, radius: (radiusPx / containerWidth) * 100 };
      if (fitsAt(candidate, circleDiameterPx, circleJitterPx, obstacles, containerWidth)) return candidate;
    }
  }

  let ringRadiusPx = ring1RadiusPx;
  // Предохранитель от зависания на испорченных входных данных (например,
  // containerWidth ещё не посчитан) — в норме место находится за 1-2 кольца.
  for (let ring = 0; ring < 200; ring++) {
    ringRadiusPx += circleDiameterPx + MARGIN_PX;
    const found = sweepRing(ringRadiusPx, circleDiameterPx, circleJitterPx, obstacles, containerWidth);
    if (found) return found;
  }
  return { angle: 0, radius: (ringRadiusPx / containerWidth) * 100 };
}
