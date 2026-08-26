import { getCachedSession } from "../auth/authService.js";
import { extractImageMetadata, extractDrawingMetadata } from "../utils/dom.js";
import { uploadPhotoToStorage, createSignedUrlMap, syncImagesForNote, syncDrawingsForNote } from "../data/supabaseAdapter.js";

// Заливает фото в Storage для залогиненного пользователя — гость получает
// null, вызывающий код (richTextEditor.js, через колбэк uploadPhoto) в этом
// случае просто не трогает data-storage-path и продолжает работать на
// локальном base64, как раньше (ТЗ п.6).
export async function uploadPhoto(noteId, blob) {
  if (!getCachedSession()) return null;
  return uploadPhotoToStorage(noteId, blob);
}

// Свежие signed URL для уже залитых фото — по путям, сохранённым в content
// как data-storage-path. Гость — пустая карта (у него таких атрибутов не
// бывает вообще, вызывающий код и не будет спрашивать).
export async function resolvePhotoSources(paths) {
  if (!getCachedSession() || !paths.length) return new Map();
  return createSignedUrlMap(paths);
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
