import { getStorage } from "../data/storageAdapter.js";
import { createBlockTagModel } from "../data/models.js";
import { extractTaggedBlocks, getBlockLines, getBlockTagIds, setBlockTagIds } from "../modules/shared/blockTags.js";
import * as itemsService from "./itemsService.js";

const storage = getStorage();

export async function listTags() {
  return storage.getBlockTags();
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
  return { tag: await storage.createBlockTag(tag) };
}

export async function updateTag(id, { name, color }) {
  const existing = await findTagByName(name);
  if (existing && existing.id !== id) return { error: "taken", tag: existing };
  const trimmed = name.trim();
  const patch = { name: trimmed, nameKey: trimmed.toLowerCase(), color };
  const tag = await storage.updateBlockTag(id, patch);
  return { tag };
}

// Все блоки (по всем заметкам), у которых есть ВСЕ перечисленные теги —
// для полноэкранного браузера тегов. listItems уже отдаёт заметки без
// удалённых (см. localStorageAdapter.getItems), лишний фильтр не нужен.
// Порядок и сортировка — забота вызывающего UI, не сервиса.
export async function findBlocks(tagIds) {
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
