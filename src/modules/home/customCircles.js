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
// item.title (см. homeView.js), поэтому здесь только id заметки/папки.
export function addCircle({ noteId, folderId }) {
  const state = readState();
  state.circles.push({ id: crypto.randomUUID(), noteId, folderId });
  writeState(state);
}

export function removeCircle(id) {
  const state = readState();
  state.circles = state.circles.filter((circle) => circle.id !== id);
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
