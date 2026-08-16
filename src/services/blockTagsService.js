import { getStorage } from "../data/storageAdapter.js";
import { createBlockTagModel } from "../data/models.js";

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
