// Кастомные кружки-ярлыки на конкретные заметки, которые пользователь
// добавляет на главной странице. circles — через data/storageAdapter.js
// (Supabase для залогиненных, localStorage для гостя — тот же гибридный
// роутинг, что у папок/тегов). pencilDismissed — отдельно и всегда в
// localStorage: это UI-настройка "видел ли онбординг НА ЭТОМ УСТРОЙСТВЕ", а
// не данные пользователя, синхронизировать её незачем (тот же принцип, что у
// app:lastDrawColor/app:borderEnabled).
import { getStorage } from "../../data/storageAdapter.js";
import { getItem } from "../../services/itemsService.js";

// Тот же ключ, что и раньше, до переноса circles на storageAdapter.js —
// localStorageAdapter.js (гостевая сторона) пишет туда же поле .circles,
// не трогая .pencilDismissed; здесь наоборот, трогаем только своё поле.
const STORAGE_KEY = "app:homeCircles";

function readPencilState() {
  const raw = localStorage.getItem(STORAGE_KEY);
  if (!raw) return { pencilDismissed: false };
  try {
    return { pencilDismissed: !!JSON.parse(raw).pencilDismissed };
  } catch {
    return { pencilDismissed: false };
  }
}

export async function getState() {
  const circles = await getStorage().getHomeCircles();
  return { pencilDismissed: readPencilState().pencilDismissed, circles };
}

export function setPencilDismissed(dismissed) {
  const raw = localStorage.getItem(STORAGE_KEY);
  let existing = {};
  try {
    existing = raw ? JSON.parse(raw) : {};
  } catch {
    existing = {};
  }
  localStorage.setItem(STORAGE_KEY, JSON.stringify({ ...existing, pencilDismissed: dismissed }));
}

// Подпись кружка нигде не хранится — при рендере всегда берётся живой
// item.title (см. homeView.js), поэтому здесь только id заметки/папки и
// однажды подобранная позиция (angle/radius — полярные координаты от центра
// .home-circles, см. circleLayout.js). Позиция вычисляется снаружи (этот
// модуль остаётся чистым хранилищем, без геометрии) и дальше не меняется —
// так раскладка переживает перезагрузку страницы (ТЗ, п.2).
export async function addCircle({ noteId, folderId, angle, radius }) {
  return getStorage().createHomeCircle({ noteId, folderId, angle, radius });
}

// Кружки, пришедшие из импорта, дописываются к уже существующим — импорт ничего
// не затирает. id кружка выдаёт адаптер: в файле мог лежать id, уже занятый
// здесь. Ремап noteId/folderId на новые заметки и папки делает
// settings/dataTransfer.js — этот модуль остаётся чистым хранилищем.
export async function appendCircles(circles) {
  if (!circles.length) return;
  const storage = getStorage();
  for (const { noteId, folderId, angle, radius } of circles) {
    await storage.createHomeCircle({ noteId, folderId, angle, radius });
  }
}

export async function removeCircle(id) {
  return getStorage().deleteHomeCircle(id);
}

// Точечно проставляет angle/radius у кружков без сохранённой позиции —
// нужно для уже существующих записей (созданных до этого поля) и для
// самолечения, если сохранённая позиция вдруг стала пересекаться с чем-то
// (например, после смены размера окна). updates: [{id, angle, radius}].
export async function updatePositions(updates) {
  if (!updates.length) return;
  return getStorage().updateHomeCirclePositions(updates);
}

// Заметка, к которой привязан кружок, могла быть удалена насовсем или уйти в
// Корзину — в обоих случаях убираем кружок ИЗ ХРАНИЛИЩА (не просто прячем),
// чтобы восстановление заметки из Корзины его не вернуло (так требует ТЗ).
// Для Supabase-стороны "удалена насовсем" уже подчищена каскадом на note_id
// (see supabase/007_home_circles.sql) — эта проверка остаётся нужна для
// "ушла в Корзину" (мягкое удаление, каскад тут не срабатывает) и для гостя,
// у которого каскада нет вообще.
export async function pruneDeadCircles() {
  const storage = getStorage();
  const circles = await storage.getHomeCircles();
  const alive = [];
  for (const circle of circles) {
    const item = await getItem(circle.noteId);
    if (item && !item.deletedAt) {
      alive.push(circle);
    } else {
      await storage.deleteHomeCircle(circle.id);
    }
  }
  return alive;
}
