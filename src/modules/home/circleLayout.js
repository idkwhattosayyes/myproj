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

const ANGLE_STEP_DEG = 10; // шаг перебора кандидатов по кругу
const RADIUS_STEP_PX = 4; // шаг, с которым кольцо поиска расширяется наружу

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

// Кружок встаёт на ближайшее к центру свободное место: расширяем кольцо
// поиска наружу мелким шагом и на каждом радиусе обходим все углы — побеждает
// первый кандидат, прошедший fitsAt.
//
// Отдельных "слоёв" в коде нет, они получаются из самой геометрии. Наименьший
// радиус, на котором кружок ни с чем не сталкивается, приходится ровно на
// промежутки между системными кружками — поэтому первые три достраивают с
// Notes/Calendar/AI ровный шестиугольник. Когда промежутки заняты, свободное
// место находится только дальше от центра, и воображаемый круг расширяется
// сам собой, без верхнего предела на количество кружков.
export function findPosition({ containerWidth, circleDiameterPx, circleJitterPx, obstacles }) {
  // Предохранитель от зависания на испорченных входных данных (например,
  // containerWidth ещё не посчитан) — в норме место находится гораздо ближе.
  const maxRadiusPx = containerWidth * 4;

  for (let radiusPx = circleDiameterPx / 2; radiusPx < maxRadiusPx; radiusPx += RADIUS_STEP_PX) {
    const found = sweepRing(radiusPx, circleDiameterPx, circleJitterPx, obstacles, containerWidth);
    if (found) return found;
  }
  return { angle: 0, radius: (maxRadiusPx / containerWidth) * 100 };
}
