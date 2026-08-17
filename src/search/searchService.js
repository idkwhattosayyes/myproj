import * as itemsService from "../services/itemsService.js";
import * as calendarEntriesService from "../services/calendarEntriesService.js";
import * as calendarTagsService from "../services/calendarTagsService.js";
import { htmlToText, extractPhotos } from "../utils/dom.js";

// Сколько вхождений одного и того же слова СОБИРАЕМ внутри одной заметки. Показываем
// по умолчанию меньше (см. INITIAL_VISIBLE в searchBar.js), а остальные прячем за
// кликабельной подписью "Ещё совпадений: N" — она догружает их из этого запаса.
// Потолок нужен, чтобы запрос вроде одной буквы не собрал тысячи вхождений.
export const MATCH_FETCH_CAP = 200;
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
 *   matches: {index: number, before: string, hit: string, after: string, photoIndex?: number, photoName?: string | null}[],
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

async function searchItems(query) {
  const [folders, items] = await Promise.all([
    itemsService.listFolders("notes"),
    itemsService.listItems("notes"),
  ]);
  const folderNames = new Map(folders.map((folder) => [folder.id, folder.name]));
  const groups = [];
  // Заметки копим в двух ведрах: совпало НАЗВАНИЕ или только текст. Сортировки
  // тут раньше не было вовсе, и заметка с совпавшим названием стояла там, где
  // она лежит в списке — то есть могла оказаться под чужими совпадениями по
  // тексту, а при частом слове и вовсе не влезть в MAX_GROUPS (ТЗ раунд 5 п.2).
  const titleGroups = [];
  const bodyGroups = [];

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
    const inText = findMatches(text, query, MATCH_FETCH_CAP);
    // Фото нигде не показывается как текст (см. utils/dom.js), поэтому
    // htmlToText его не видит — ищем отдельно. Совпадение либо по собственному
    // названию (подстрока, как раньше), либо любое фото вообще, если запрос —
    // общее слово "photo"/"фото" (кириллица и латиница проверяются независимо
    // от текущего языка интерфейса) — так находятся и фото без названия.
    const isGenericPhotoQuery = ["photo", "фото"].includes(query.trim().toLowerCase());
    const photoMatches = extractPhotos(item.content)
      .map((photo, photoIndex) => {
        if (photo.name) {
          const found = findMatches(photo.name, query, 1);
          if (found.matches.length) return { ...found.matches[0], photoIndex, photoName: photo.name };
        }
        if (isGenericPhotoQuery) {
          // before/after пустые — searchBar.js подставит плейсхолдер вместо
          // пустого hit, если у фото нет названия.
          return { index: 0, before: "", hit: photo.name || "", after: "", photoIndex, photoName: photo.name };
        }
        return null;
      })
      .filter(Boolean);
    if (!inTitle.matches.length && !inText.matches.length && !photoMatches.length) return;

    // Группу не раздваиваем: заметка, у которой совпало и название, и текст,
    // остаётся одной группой со своими сниппетами — просто встаёт наверх.
    (inTitle.matches.length ? titleGroups : bodyGroups).push({
      kind: "item",
      id: item.id,
      section: item.section,
      title,
      subtitle: item.folderIds.map((id) => folderNames.get(id)).filter(Boolean).join(", "),
      query,
      // Совпадение в названии само по себе строкой не идёт: заголовок группы и
      // так виден. Строки — это места в тексте, к которым можно перейти.
      matches: [...inText.matches, ...photoMatches],
      moreCount: inText.total - inText.matches.length,
    });
  });

  // Сначала совпавшие имена (папки и названия заметок), потом текст. Тот же
  // приём, что в searchOpenBlocks (searchBar.js): совпадение по имени шире по
  // смыслу, чем вхождение где-то в теле. Побочно это спасает названия от
  // MAX_GROUPS — обрезается теперь самое слабое, а не то, что важнее всего.
  return [...groups, ...titleGroups, ...bodyGroups];
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
    const inText = findMatches(text, query, MATCH_FETCH_CAP);
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
 *
 * Экспортируется ради поиска по блокам открытого меню тегов (searchBar.js):
 * сниппеты там обязаны выглядеть так же, как у обычных результатов, поэтому
 * нарезка переиспользуется, а не дублируется.
 */
export function findMatches(text, query, limit) {
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
