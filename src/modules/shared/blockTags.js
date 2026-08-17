// Блок — произвольный диапазон соседних строк в заметке, помеченный одним
// или несколькими тегами (см. richTextEditor.js).
//
// Обернуть строки блока в свой <div> нельзя: normalizeLines в richTextEditor.js
// принудительно разворачивает любые вложенные обёртки обратно на уровень листа
// (см. flattenNestedLines там же) — иначе Tab и другие построчные команды
// ломались бы на многострочных блоках. Поэтому блок держится на атрибутах
// самих строк, тем же приёмом, что и якорь рисунка (data-anchor).
//
// data-block-id  — id блока, стоит на КАЖДОЙ его строке, не только на крайних:
//   Backspace в начале первой строки блока сливает её с предыдущей и удаляет
//   узел — если бы id был только на ней, блок терял бы теги вместе со строкой.
// data-tag-ids   — JSON-массив id тегов, тоже на каждой строке блока.
// data-block-start/data-block-end — булевы метки "это верхняя/нижняя строка
//   блока", вычисляемый кэш для CSS-полоски, не источник истины: пересчитываются
//   заново из data-block-id при каждом проходе (см. recomputeBlockEdges).

// Тот же селектор, что LINE_SELECTOR в richTextEditor.js — не импортирован
// оттуда намеренно, чтобы не заводить кольцевую зависимость между модулями;
// при правке одного проверяй и другой.
const LINE_SELECTOR = "h1,h2,h3,p,div";

// Служебные слои (точки-индикаторы, панель тегов) — тоже <div> среди прямых
// потомков листа, но это не текст: тот же признак, что у isTextLine в
// richTextEditor.js — класс с префиксом rte-. Без этого исключения они
// засоряли бы индексное соседство в propagateBlockMembership.
export function pageLines(page) {
  return [...page.children].filter((el) => el.matches(LINE_SELECTOR) && !el.className.startsWith("rte-"));
}

export function getBlockTagIds(line) {
  if (!line.dataset.tagIds) return [];
  try {
    return JSON.parse(line.dataset.tagIds);
  } catch {
    return [];
  }
}

// Границы блока пересчитываются с нуля: первая и последняя (по порядку в
// листе) строка с данным blockId получают data-block-start/data-block-end.
function recomputeBlockEdges(page) {
  const lines = pageLines(page);
  const ids = new Set();
  lines.forEach((line) => {
    delete line.dataset.blockStart;
    delete line.dataset.blockEnd;
    if (line.dataset.blockId) ids.add(line.dataset.blockId);
  });
  ids.forEach((id) => {
    const own = lines.filter((line) => line.dataset.blockId === id);
    if (!own.length) return;
    own[0].dataset.blockStart = "true";
    own[own.length - 1].dataset.blockEnd = "true";
  });
}

// Строка без своего blockId, у которой ровно один сосед среди строк листа
// помечен, наследует его id и теги — этим держится «писать внутри/впритык к
// блоку — часть блока» (ТЗ п.15). Enter внутри строки блока в этом не нуждается:
// Chrome сам клонирует data-* атрибуты при разбиении, см. комментарий к
// applyLineDirection в richTextEditor.js. Здесь закрыт случай, когда
// клонирования нет — вставка из буфера, диктовка, вставка фото.
//
// known — строки, которые редактор уже видел на прошлой синхронизации.
// Без этого фильтра любая строка, оказавшаяся рядом с блоком, тегировалась бы
// на первое же не связанное с ней редактирование где угодно в заметке — а
// нужно тегировать только то, что появилось только что. Строку между двумя
// РАЗНЫМИ блоками не трогаем в любом случае — ничья, решать пользователю
// через "#", а не угадывать самим.
function propagateBlockMembership(page, known) {
  let progress = true;
  while (progress) {
    progress = false;
    const lines = pageLines(page);
    lines.forEach((line, index) => {
      if (line.dataset.blockId || known.has(line)) return;
      const prevId = lines[index - 1]?.dataset.blockId;
      const nextId = lines[index + 1]?.dataset.blockId;
      if (prevId && nextId && prevId !== nextId) return;
      const source = prevId ? lines[index - 1] : nextId ? lines[index + 1] : null;
      if (!source) return;
      line.dataset.blockId = source.dataset.blockId;
      if (source.dataset.tagIds) line.dataset.tagIds = source.dataset.tagIds;
      progress = true;
    });
  }
}

// Заводится один раз на редактор (см. ensureAnchorId в richTextEditor.js —
// тот же приём: счётчик/множество, живущее в замыкании, а не в атрибутах DOM).
// Возвращает функцию синхронизации, которая помнит, какие строки уже видела:
// это и есть граница между «только что появилось» и «давно существует и
// намеренно без тега».
export function createBlockSync(editorEl) {
  const known = new WeakSet();

  function rememberAll() {
    editorEl.querySelectorAll(".rte-page").forEach((page) => {
      pageLines(page).forEach((line) => known.add(line));
    });
  }
  // Содержимое, с которым редактор открылся, — всё "старое" по определению:
  // первый вызов синхронизации не должен ничего пропагировать, только
  // досчитать границы существующих блоков.
  rememberAll();

  return function syncBlockGeometry() {
    editorEl.querySelectorAll(".rte-page").forEach((page) => {
      propagateBlockMembership(page, known);
      recomputeBlockEdges(page);
    });
    rememberAll();
  };
}

// Снимает блок целиком со всех его строк на странице. Пустой tagIds в
// setBlockTagIds приходит сюда же — удаление последнего тега распускает блок
// тем же путём, что и ручной роспуск (ТЗ п.17).
export function dissolveBlock(page, blockId) {
  pageLines(page)
    .filter((line) => line.dataset.blockId === blockId)
    .forEach((line) => {
      delete line.dataset.blockId;
      delete line.dataset.tagIds;
      delete line.dataset.blockStart;
      delete line.dataset.blockEnd;
    });
}

export function setBlockTagIds(page, blockId, tagIds) {
  if (!tagIds.length) {
    dissolveBlock(page, blockId);
    return;
  }
  const json = JSON.stringify(tagIds);
  pageLines(page)
    .filter((line) => line.dataset.blockId === blockId)
    .forEach((line) => {
      line.dataset.tagIds = json;
    });
}

export function getBlockLines(page, blockId) {
  return pageLines(page).filter((line) => line.dataset.blockId === blockId);
}

// Помечает набор строк одним блоком: blockId может быть новым или уже
// существующим (расширение блока новым выделением).
export function assignBlock(lines, blockId, tagIds) {
  const json = JSON.stringify(tagIds);
  lines.forEach((line) => {
    line.dataset.blockId = blockId;
    line.dataset.tagIds = json;
  });
}

// Устойчивый id блока — тот же приём, что ensureAnchorId в richTextEditor.js:
// счётчик "bN" с проверкой коллизий по уже занятым id во всём редакторе (id
// обязаны быть уникальны в пределах заметки, не только текущей страницы).
export function ensureBlockIdFactory(editorEl) {
  let next = 1;
  return function ensureBlockId() {
    while (editorEl.querySelector(`[data-block-id="b${next}"]`)) next++;
    return `b${next++}`;
  };
}

// Вытаскивает из сохранённого HTML заметки все блоки, у которых есть ВСЕ
// перечисленные теги (AND) — для полноэкранного браузера тегов, работающего
// поверх заметок, а не поверх живого редактора. Парсинг через временный div —
// тот же приём, что remapInternalLinks/remapBlockTags в settings/dataTransfer.js.
// text считаем сразу (не только html) — он же пригодится для подсчёта слов и
// символов блока, незачем перепарсивать HTML заново ради этого.
export function extractTaggedBlocks(content, requiredTagIds) {
  if (!content || !requiredTagIds.length) return [];
  const holder = document.createElement("div");
  holder.innerHTML = content;
  const results = [];
  holder.querySelectorAll(".rte-page").forEach((page) => {
    const seen = new Set();
    pageLines(page).forEach((line) => {
      const blockId = line.dataset.blockId;
      if (!blockId || seen.has(blockId)) return;
      seen.add(blockId);
      const tagIds = getBlockTagIds(line);
      if (!requiredTagIds.every((id) => tagIds.includes(id))) return;
      const lines = getBlockLines(page, blockId);
      results.push({
        blockId,
        tagIds,
        html: lines.map((l) => l.outerHTML).join(""),
        text: lines.map((l) => l.textContent).join(" ").trim(),
      });
    });
  });
  return results;
}
