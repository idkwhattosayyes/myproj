import { getStorage } from "../data/storageAdapter.js";
import { createBlockTagModel } from "../data/models.js";
import { extractTaggedBlocks, getBlockLines, getBlockTagIds, setBlockTagIds } from "../modules/shared/blockTags.js";
import { getCachedSession } from "../auth/authService.js";
import { syncBlocksForNote, findTaggedBlocks } from "../data/supabaseAdapter.js";
import * as itemsService from "./itemsService.js";

const storage = getStorage();

// Реестр тегов дёргается на КАЖДОЕ создание редактора (richTextEditor.js —
// refreshTagRegistry, вызывается при любом открытии/переключении заметки) —
// без кэша это отдельный SQL-запрос на каждое такое действие. Кэшируем
// промис, не массив — конкурентные вызовы не плодят параллельные запросы.
// Инвалидация по логауту/логину не нужна — оба всегда делают
// location.reload() (settingsPanel.js), кэш и так обнулится на следующей
// загрузке.
let tagsCache = null; // Promise<Tag[]> | null

export async function listTags() {
  if (!tagsCache) {
    tagsCache = storage.getBlockTags().catch((error) => {
      tagsCache = null; // сбой — не запоминаем навсегда, следующий вызов повторит попытку
      throw error;
    });
  }
  return tagsCache;
}

function invalidateTagsCache() {
  tagsCache = null;
}

// Регистронезависимый поиск: #yes, #Yes и #YES — один и тот же тег.
export async function findTagByName(name) {
  const key = name.trim().toLowerCase();
  const tags = await storage.getBlockTags();
  return tags.find((tag) => tag.nameKey === key) ?? null;
}

// "Занято" — ожидаемый исход, а не программная ошибка, поэтому возвращаем
// объект с error вместо throw: вызывающему UI не нужен try/catch, чтобы
// показать пользователю "This tag is already taken".
export async function createTag({ id, name, color }) {
  const existing = await findTagByName(name);
  if (existing) return { error: "taken", tag: existing };
  const tag = createBlockTagModel({ id, name, color });
  const created = await storage.createBlockTag(tag);
  invalidateTagsCache();
  return { tag: created };
}

export async function updateTag(id, { name, color }) {
  const existing = await findTagByName(name);
  if (existing && existing.id !== id) return { error: "taken", tag: existing };
  const trimmed = name.trim();
  const patch = { name: trimmed, nameKey: trimmed.toLowerCase(), color };
  const tag = await storage.updateBlockTag(id, patch);
  invalidateTagsCache();
  return { tag };
}

// Производный индекс blocks/block_tags в Supabase — держит его в актуальном
// состоянии при создании/изменении content заметки (вызывается централизованно
// из itemsService.js, а не из отдельных мест в UI, чтобы ни одна точка входа
// не осталась не покрыта — см. dataTransfer.js для единственного места, где
// content создаётся в обход itemsService). Гость — no-op, у него всё по
// старому HTML-сканирующему пути (ТЗ п.5). Ошибка глотается: это вторичный
// derived-индекс, тихий сбой самоисправится на следующем сохранении content,
// не должен топить успешное сохранение самой заметки.
export async function syncBlocksIndex(noteId, content) {
  if (!getCachedSession()) return;
  try {
    const blocks = extractTaggedBlocks(content, []);
    await syncBlocksForNote(noteId, blocks);
  } catch {
    // см. комментарий выше — сбой намеренно проглочен
  }
}

// Все блоки (по всем заметкам), у которых есть ВСЕ перечисленные теги —
// для полноэкранного браузера тегов. Для залогиненных — SQL-запрос к
// blocks/block_tags вместо сканирования HTML всех заметок (ТЗ п.4).
// listItems уже отдаёт заметки без удалённых (см. localStorageAdapter.getItems),
// лишний фильтр не нужен. Порядок и сортировка — забота вызывающего UI, не сервиса.
export async function findBlocks(tagIds) {
  if (getCachedSession()) return findTaggedBlocks(tagIds);
  const items = await itemsService.listItems("notes");
  const results = [];
  items.forEach((item) => {
    extractTaggedBlocks(item.content, tagIds).forEach((block) => {
      results.push({ ...block, itemId: item.id, itemTitle: item.title, updatedAt: item.updatedAt, order: item.order });
    });
  });
  return results;
}

// Правка тегов блока БЕЗ открытого живого редактора этой заметки (полноэкранный
// браузер тегов показывает блоки из чужих, не открытых заметок) — те же
// примитивы blockTags.js, что использует richTextEditor.js, только страница не
// живая, а detached-разобранная из сохранённого content. Тот же идиом парсинга,
// что remapInternalLinks/remapBlockTags в settings/dataTransfer.js.
async function mutateBlockTags(itemId, blockId, mutate) {
  const item = await itemsService.getItem(itemId);
  if (!item) return;
  const holder = document.createElement("div");
  holder.innerHTML = item.content;
  for (const page of holder.querySelectorAll(".rte-page")) {
    if (getBlockLines(page, blockId).length) {
      mutate(page);
      break;
    }
  }
  await itemsService.updateItem(itemId, { content: holder.innerHTML });
}

export async function removeTagFromBlock(itemId, blockId, tagId) {
  return mutateBlockTags(itemId, blockId, (page) => {
    const current = getBlockTagIds(getBlockLines(page, blockId)[0]);
    setBlockTagIds(page, blockId, current.filter((id) => id !== tagId)); // пустой список сам распускает блок
  });
}

export async function addTagToBlock(itemId, blockId, tag) {
  return mutateBlockTags(itemId, blockId, (page) => {
    const current = getBlockTagIds(getBlockLines(page, blockId)[0]);
    if (!current.includes(tag.id)) setBlockTagIds(page, blockId, [...current, tag.id]);
  });
}

// Удаление тега как сущности (не removeTagFromBlock — тот снимает тег с
// ОДНОГО блока). Тег хранится в content каждой заметки как data-tag-ids —
// таблицы tags/blocks/block_tags в Supabase лишь производный индекс, cascade
// от deleteBlockTag почистит только его, не сам content, поэтому проходим по
// всем заметкам, где тег реально встречается, и вычищаем его оттуда.
//
// Группировка по itemId — один read-modify-write на заметку, а не по одному
// на блок: несколько блоков одного тега в одной заметке иначе гонялись бы
// за одну и ту же запись параллельно (потерянная запись). Между РАЗНЫМИ
// заметками — параллельно, они не пересекаются.
async function stripTagFromItem(itemId, blockIds, tagId) {
  const item = await itemsService.getItem(itemId);
  if (!item) return;
  const holder = document.createElement("div");
  holder.innerHTML = item.content;
  holder.querySelectorAll(".rte-page").forEach((page) => {
    blockIds.forEach((blockId) => {
      if (!getBlockLines(page, blockId).length) return;
      const current = getBlockTagIds(getBlockLines(page, blockId)[0]);
      setBlockTagIds(page, blockId, current.filter((id) => id !== tagId));
    });
  });
  await itemsService.updateItem(itemId, { content: holder.innerHTML });
}

export async function deleteTag(tagId) {
  const blocks = await findBlocks([tagId]);
  const blockIdsByItem = new Map();
  blocks.forEach((b) => {
    if (!blockIdsByItem.has(b.itemId)) blockIdsByItem.set(b.itemId, []);
    blockIdsByItem.get(b.itemId).push(b.blockId);
  });
  await Promise.all(
    [...blockIdsByItem.entries()].map(([itemId, blockIds]) => stripTagFromItem(itemId, blockIds, tagId))
  );
  await storage.deleteBlockTag(tagId);
  invalidateTagsCache();
}
