// Кастомные кружки-ярлыки на конкретные заметки, которые пользователь
// добавляет на главной странице. Это раскладка главной страницы, а не
// контент заметок, поэтому храним напрямую в localStorage (как
// app:lastDrawColor), в обход data/storageAdapter.js — тот контракт про
// данные, которые переедут на Supabase, а кастомные кружки чисто локальны.
import { getItem } from "../../services/itemsService.js";

const STORAGE_KEY = "app:homeCircles";

function readState() {
  const raw = localStorage.getItem(STORAGE_KEY);
  if (!raw) return { pencilDismissed: false, circles: [] };
  try {
    const parsed = JSON.parse(raw);
    return {
      pencilDismissed: !!parsed.pencilDismissed,
      circles: Array.isArray(parsed.circles) ? parsed.circles : [],
    };
  } catch {
    return { pencilDismissed: false, circles: [] };
  }
}

function writeState(state) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
}

export function getState() {
  return readState();
}

export function setPencilDismissed(dismissed) {
  const state = readState();
  state.pencilDismissed = dismissed;
  writeState(state);
}

// Подпись кружка нигде не хранится — при рендере всегда берётся живой
// item.title (см. homeView.js), поэтому здесь только id заметки/папки и
// однажды подобранная позиция (angle/radius — полярные координаты от центра
// .home-circles, см. circleLayout.js). Позиция вычисляется снаружи (этот
// модуль остаётся чистым хранилищем, без геометрии) и дальше не меняется —
// так раскладка переживает перезагрузку страницы (ТЗ, п.2).
export function addCircle({ noteId, folderId, angle, radius }) {
  const state = readState();
  state.circles.push({ id: crypto.randomUUID(), noteId, folderId, angle, radius });
  writeState(state);
}

// Кружки, пришедшие из импорта, дописываются к уже существующим — импорт ничего
// не затирает. id кружка выдаём новый: в файле мог лежать id, уже занятый здесь.
// Ремап noteId/folderId на новые заметки и папки делает settings/dataTransfer.js —
// этот модуль остаётся чистым хранилищем.
export function appendCircles(circles) {
  if (!circles.length) return;
  const state = readState();
  circles.forEach(({ noteId, folderId, angle, radius }) => {
    state.circles.push({ id: crypto.randomUUID(), noteId, folderId, angle, radius });
  });
  writeState(state);
}

export function removeCircle(id) {
  const state = readState();
  state.circles = state.circles.filter((circle) => circle.id !== id);
  writeState(state);
}

// Точечно проставляет angle/radius у кружков без сохранённой позиции —
// нужно для уже существующих записей (созданных до этого поля) и для
// самолечения, если сохранённая позиция вдруг стала пересекаться с чем-то
// (например, после смены размера окна). updates: [{id, angle, radius}].
export function updatePositions(updates) {
  if (!updates.length) return;
  const state = readState();
  const byId = new Map(updates.map((u) => [u.id, u]));
  state.circles = state.circles.map((circle) => {
    const update = byId.get(circle.id);
    return update ? { ...circle, angle: update.angle, radius: update.radius } : circle;
  });
  writeState(state);
}

// Заметка, к которой привязан кружок, могла быть удалена насовсем или уйти в
// Корзину — в обоих случаях убираем кружок ИЗ ХРАНИЛИЩА (не просто прячем),
// чтобы восстановление заметки из Корзины его не вернуло (так требует ТЗ).
export async function pruneDeadCircles() {
  const state = readState();
  const alive = [];
  for (const circle of state.circles) {
    const item = await getItem(circle.noteId);
    if (item && !item.deletedAt) alive.push(circle);
  }
  if (alive.length !== state.circles.length) {
    state.circles = alive;
    writeState(state);
  }
  return state.circles;
}
