import { getCachedSession } from "../auth/authService.js";
import { extractImageMetadata, extractDrawingMetadata } from "../utils/dom.js";
import {
  uploadPhotoToStorage,
  createSignedUrlMap,
  removePhotoFromStorage,
  syncImagesForNote,
  syncDrawingsForNote,
} from "../data/supabaseAdapter.js";

// Заливает фото в Storage для залогиненного пользователя — гость получает
// null, вызывающий код (richTextEditor.js, через колбэк uploadPhoto) в этом
// случае просто не трогает data-storage-path и продолжает работать на
// локальном base64, как раньше (ТЗ п.6).
export async function uploadPhoto(noteId, blob) {
  if (!getCachedSession()) return null;
  return uploadPhotoToStorage(noteId, blob);
}

// Кэш уже resolved signed URL по storage_path — без него каждое открытие/
// переключение заметки с фото генерило бы новые подписанные ссылки заново,
// даже для уже отрисованных в этой сессии. Реальный TTL ссылки — 3600с
// (SIGNED_URL_TTL_SECONDS в supabaseAdapter.js), держим кэш валидным чуть
// меньше, с запасом. Инвалидация при редактировании фото не нужна:
// "Изменить" создаёт НОВЫЙ storage_path (attachBackgroundUpload в
// richTextEditor.js), старая запись в кэше просто больше не запрашивается.
const photoUrlCache = new Map(); // storagePath -> { url, expiresAt }
const PHOTO_URL_TTL_MS = 3000 * 1000; // с запасом от реальных 3600с

// Свежие signed URL для уже залитых фото — по путям, сохранённым в content
// как data-storage-path. Гость — пустая карта (у него таких атрибутов не
// бывает вообще, вызывающий код и не будет спрашивать).
export async function resolvePhotoSources(paths) {
  if (!getCachedSession() || !paths.length) return new Map();
  const now = Date.now();
  const result = new Map();
  const missing = [];
  for (const path of paths) {
    const cached = photoUrlCache.get(path);
    if (cached && cached.expiresAt > now) result.set(path, cached.url);
    else missing.push(path);
  }
  if (!missing.length) return result;
  const fetched = await createSignedUrlMap(missing);
  fetched.forEach((url, path) => {
    photoUrlCache.set(path, { url, expiresAt: now + PHOTO_URL_TTL_MS });
    result.set(path, url);
  });
  return result;
}

// Точечное удаление файла (замена версии при "Изменить", или файл только что
// залился, а фото уже успели удалить/заменить — см. attachBackgroundUpload в
// richTextEditor.js). Best-effort — вызывающий код не ждёт и не проверяет
// результат.
export async function removePhoto(path) {
  if (!getCachedSession()) return;
  await removePhotoFromStorage(path);
}

// Производный индекс images/drawings в Supabase — держит его в актуальном
// состоянии при создании/изменении content заметки (централизованный хук в
// itemsService.js, рядом с blockTagsService.syncBlocksIndex — тот же приём).
// Гость — no-op. Ошибка глотается: вторичный derived-индекс, тихий сбой
// самоисправится на следующем сохранении content, не должен топить успешное
// сохранение самой заметки.
export async function syncPhotosIndex(noteId, content) {
  if (!getCachedSession()) return;
  try {
    const images = extractImageMetadata(content);
    const drawings = extractDrawingMetadata(content);
    await syncImagesForNote(noteId, images);
    await syncDrawingsForNote(noteId, drawings);
  } catch {
    // см. комментарий выше — сбой намеренно проглочен
  }
}
