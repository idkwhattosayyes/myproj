import * as itemsService from "../services/itemsService.js";
import * as calendarEntriesService from "../services/calendarEntriesService.js";
import * as calendarTagsService from "../services/calendarTagsService.js";
import { htmlToText } from "../utils/dom.js";

// Сколько вхождений одного и того же слова показывать внутри одной заметки:
// остальные прячем за подписью "и ещё N", иначе длинный текст занял бы весь список.
const MATCHES_PER_ITEM = 3;
// Сколько символов текста показывать вокруг найденного.
const SNIPPET_PADDING = 40;
// Предел на весь список — защита от запроса вроде одной буквы "а".
const MAX_GROUPS = 40;

/**
 * @typedef {{
 *   kind: "folder" | "item" | "calendar",
 *   id: string,
 *   section: string | null,
 *   title: string,
 *   subtitle: string,
 *   query: string,
 *   matches: {index: number, before: string, hit: string, after: string}[],
 *   moreCount: number,
 * }} SearchGroup
 */

/**
 * Ищет по названиям папок, названиям и тексту заметок и по записям календаря.
 * @param {string} rawQuery
 * @param {"all" | "items" | "calendar"} scope
 * @returns {Promise<SearchGroup[]>}
 */
export async function search(rawQuery, scope) {
  const query = rawQuery.trim();
  if (!query) return [];

  const groups = [];
  if (scope !== "calendar") groups.push(...(await searchItems(query)));
  if (scope !== "items") groups.push(...(await searchCalendar(query)));
  return groups.slice(0, MAX_GROUPS);
}

// Задачи и Документы делят общий пул (см. matchesSection в localStorageAdapter.js),
// поэтому одного запроса хватает на оба раздела.
async function searchItems(query) {
  const [folders, items] = await Promise.all([
    itemsService.listFolders("documents"),
    itemsService.listItems("documents"),
  ]);
  const folderNames = new Map(folders.map((folder) => [folder.id, folder.name]));
  const groups = [];

  folders.forEach((folder) => {
    if (!findMatches(folder.name, query, 1).matches.length) return;
    groups.push({
      kind: "folder",
      id: folder.id,
      section: folder.section,
      title: folder.name,
      subtitle: "",
      query,
      // У папки нет текста: совпало имя, и оно уже видно в заголовке группы —
      // отдельная строка с тем же именем была бы лишней.
      matches: [],
      moreCount: 0,
    });
  });

  items.forEach((item) => {
    const title = item.title || "";
    const text = htmlToText(item.content);
    const inTitle = findMatches(title, query, 1);
    const inText = findMatches(text, query, MATCHES_PER_ITEM);
    if (!inTitle.matches.length && !inText.matches.length) return;

    groups.push({
      kind: "item",
      id: item.id,
      section: item.section,
      title,
      subtitle: folderNames.get(item.folderId) || "",
      query,
      // Совпадение в названии само по себе строкой не идёт: заголовок группы и
      // так виден. Строки — это места в тексте, к которым можно перейти.
      matches: inText.matches,
      moreCount: inText.total - inText.matches.length,
    });
  });

  return groups;
}

async function searchCalendar(query) {
  const [entries, tags] = await Promise.all([
    calendarEntriesService.listAll(),
    calendarTagsService.listTags(),
  ]);
  const tagNames = new Map(tags.map((tag) => [tag.id, tag.name]));
  const groups = [];

  entries.forEach((entry) => {
    const text = (entry.title || "").replace(/\s+/g, " ").trim();
    const tagName = tagNames.get(entry.tagId) || "";
    const inText = findMatches(text, query, MATCHES_PER_ITEM);
    const inTag = findMatches(tagName, query, 1);
    if (!inText.matches.length && !inTag.matches.length) return;

    groups.push({
      kind: "calendar",
      id: entry.id,
      section: null,
      title: text,
      subtitle: [formatDate(entry.date), formatTime(entry), tagName].filter(Boolean).join(" · "),
      query,
      matches: inText.matches,
      moreCount: inText.total - inText.matches.length,
    });
  });

  return groups;
}

/**
 * Находит вхождения запроса в тексте и режет вокруг каждого кусочек для показа.
 * index — порядковый номер вхождения в тексте: по нему потом ищем это же место
 * в самой заметке, чтобы перейти именно к нему, а не к первому попавшемуся.
 */
function findMatches(text, query, limit) {
  const haystack = (text || "").toLowerCase();
  const needle = query.toLowerCase();
  const matches = [];
  let total = 0;

  for (let from = haystack.indexOf(needle); from !== -1; from = haystack.indexOf(needle, from + needle.length)) {
    if (matches.length < limit) {
      matches.push({
        index: total,
        before: cutBefore(text, from),
        hit: text.slice(from, from + query.length),
        after: cutAfter(text, from + query.length),
      });
    }
    total += 1;
  }

  return { matches, total };
}

function cutBefore(text, at) {
  const start = Math.max(0, at - SNIPPET_PADDING);
  return (start > 0 ? "…" : "") + text.slice(start, at);
}

function cutAfter(text, at) {
  const end = Math.min(text.length, at + SNIPPET_PADDING);
  return text.slice(at, end) + (end < text.length ? "…" : "");
}

function formatDate(iso) {
  const [, month, day] = iso.split("-");
  return `${day}.${month}`;
}

function formatTime(entry) {
  if (entry.startTime && entry.endTime) return `${entry.startTime}–${entry.endTime}`;
  return entry.startTime || entry.endTime || "";
}
