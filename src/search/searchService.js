import * as itemsService from "../services/itemsService.js";
import * as calendarEntriesService from "../services/calendarEntriesService.js";
import * as calendarTagsService from "../services/calendarTagsService.js";

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

  // Заметки и календарь — независимые источники (у залогиненного первый
  // ходит на сервер, второй читает localStorage), ждать их по очереди незачем.
  const [itemGroups, calendarGroups] = await Promise.all([
    scope !== "calendar" ? searchItems(query) : [],
    scope !== "items" ? searchCalendar(query) : [],
  ]);
  return [...itemGroups, ...calendarGroups].slice(0, MAX_GROUPS);
}

async function searchItems(query) {
  // Общее слово "photo"/"фото" (кириллица и латиница проверяются независимо
  // от текущего языка интерфейса) находит любое фото вообще — так находятся и
  // фото без названия. Хранилище получает этот признак отдельно: по тексту
  // такой запрос ничего бы не нашёл.
  const isGenericPhotoQuery = ["photo", "фото"].includes(query.toLowerCase());
  const [folders, candidates] = await Promise.all([
    itemsService.listFolders("notes"),
    // Кандидаты приходят уже с текстом без HTML и списком фото — content
    // заметок поиску не нужен (у залогиненного он даже не скачивается, см.
    // searchItems в supabaseAdapter.js). Лимит — тот же MAX_GROUPS: больше
    // групп список всё равно не покажет.
    itemsService.searchItems("notes", query, { anyPhoto: isGenericPhotoQuery, limit: MAX_GROUPS }),
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

  candidates.forEach((item) => {
    const title = item.title || "";
    const inTitle = findMatches(title, query, 1);
    const inText = findMatches(item.text, query, MATCH_FETCH_CAP);
    // Фото нигде не показывается как текст, поэтому в item.text его нет —
    // ищем по названиям отдельно: совпадение либо по названию (подстрока, как
    // раньше), либо любое фото, если запрос — общее слово.
    const photoMatches = item.photos
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
    // Хранилище отдало кандидата, а точных вхождений нет — бывает, если его
    // очистка текста разошлась с клиентской на экзотике; такой просто выпадает.
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

// Граница абзаца — пустая строка редактора: в тексте заметки строки разделены
// "\n" (см. htmlToSearchText в utils/dom.js), пустая строка даёт два "\n"
// подряд. Контекст сниппета через неё не перескакивает: слово в начале абзаца
// показывается без «хвоста» предыдущего, а «…» ставится только когда обрезан
// текст ЭТОГО абзаца. Одиночный "\n" (мягкий перенос внутри абзаца) границей
// не считается — контекст берётся с соседней строки, как и раньше.
// У строк без "\n" (папки, названия, календарь, блоки) ничего не меняется.
const PARAGRAPH_BREAK = "\n\n";

function paragraphStart(text, at) {
  // Ищем с at - 2: разрыв, стоящий вплотную перед совпадением (позиции at-2 и
  // at-1), найтись должен, а начинающийся на самом at — уже нет.
  const brk = at >= 2 ? text.lastIndexOf(PARAGRAPH_BREAK, at - 2) : -1;
  return brk === -1 ? 0 : brk + PARAGRAPH_BREAK.length;
}

function paragraphEnd(text, at) {
  const brk = text.indexOf(PARAGRAPH_BREAK, at);
  return brk === -1 ? text.length : brk;
}

function cutBefore(text, at) {
  const floor = paragraphStart(text, at);
  const start = Math.max(floor, at - SNIPPET_PADDING);
  // Оставшиеся одиночные "\n" — мягкие переносы; строка результата одна.
  return (start > floor ? "…" : "") + text.slice(start, at).replace(/\n/g, " ");
}

function cutAfter(text, at) {
  const ceiling = paragraphEnd(text, at);
  const end = Math.min(ceiling, at + SNIPPET_PADDING);
  return text.slice(at, end).replace(/\n/g, " ") + (end < ceiling ? "…" : "");
}

function formatDate(iso) {
  const [, month, day] = iso.split("-");
  return `${day}.${month}`;
}

function formatTime(entry) {
  if (entry.startTime && entry.endTime) return `${entry.startTime}–${entry.endTime}`;
  return entry.startTime || entry.endTime || "";
}
