import { t, getLang } from "../../i18n/i18n.js";
import { openAlert } from "../../utils/modal.js";
import { escapeHtml, escapeAttr } from "../../utils/dom.js";
import { downloadText } from "../../utils/download.js";

/**
 * Печать и выгрузка ОДНОЙ заметки.
 *
 * Документ собирается из ЖИВОГО DOM открытого редактора, а не из сохранённого
 * content заметки. Так получаются бесплатно три вещи, которых в сохранённом
 * HTML просто нет:
 *   • рабочие адреса фото — у залогиненного они временные (signed) и живут
 *     ровно до следующего открытия заметки, см. resolvePhotoSources;
 *   • посчитанные пиксельные позиции фото и рисунков — в заметке хранятся
 *     только проценты и якоря, в пиксели их переводит раскладка редактора;
 *   • цвет рамки блока — он приходит из реестра тегов и живёт в инлайновой
 *     переменной --block-tag-color, которую ставит renderBlockVisuals.
 *
 * Живой DOM при этом только ЧИТАЕТСЯ. Менять его нельзя: на нём висит
 * MutationObserver истории правок — любая вставка узла засорила бы отмену и
 * дёрнула автосохранение. Поэтому всё делается на cloneNode.
 */

// Адреса стилей считаем от адреса самого модуля, а не от адреса страницы:
// роут у приложения hash-овый (#/notes), и относительный путь от документа
// указывал бы не туда.
const EDITOR_CSS_URL = new URL("../../../styles/editor.css", import.meta.url).href;
const PRINT_CSS_URL = new URL("../../../styles/notePrint.css", import.meta.url).href;

// Сколько ждать картинки и шрифты перед вызовом печати. Ограничение
// обязательно: у залогиненного ссылка на фото может протухнуть, такой запрос
// не завершится ни успехом, ни ошибкой, и печать ждала бы вечно.
const ASSET_TIMEOUT = 5000;

// Крайняя страховка на случай, если afterprint не придёт (бывает в части
// браузеров и при отмене диалога системой) — чтобы iframe не остался в
// документе навсегда.
const FRAME_CLEANUP_TIMEOUT = 60000;

// Служебные узлы редактора, которых в документе быть не должно: кнопка
// «добавить страницу», крестик удаления страницы, ручки выделенного фото,
// точки дополнительных тегов, панель тегов и промежуточный текст голосового
// ввода. Список шире, чем в serializeEditor: там часть этих узлов просто не
// успевает попасть в клон, а здесь берётся весь живой контейнер целиком.
const EDITOR_ONLY_SELECTOR = ".rte-interim, .rte-photo-handles, .rte-block-dots, .rte-block-panel, .rte-add-page, .rte-page-delete";

// Классы состояния, которые видны только внутри редактора: выделенное фото,
// подсветка найденного и оранжевая рамка переполнения листа.
const EDITOR_ONLY_CLASSES = ["is-selected", "is-search-hit", "is-overflow"];

/**
 * Копия содержимого редактора, пригодная для постороннего документа.
 * Возвращается именно клон — живой узел не трогаем (см. комментарий модуля).
 */
function cloneNote(contentEl) {
  const clone = contentEl.cloneNode(true);
  clone.querySelectorAll(EDITOR_ONLY_SELECTOR).forEach((node) => node.remove());
  clone.querySelectorAll(EDITOR_ONLY_CLASSES.map((cls) => `.${cls}`).join(",")).forEach((el) => {
    el.classList.remove(...EDITOR_ONLY_CLASSES);
  });
  // Страницы вне приложения не редактируются, а contenteditable в чужом
  // документе ещё и подсвечивал бы каретку при клике.
  clone.querySelectorAll("[contenteditable]").forEach((el) => {
    el.removeAttribute("contenteditable");
    el.removeAttribute("spellcheck");
  });
  return clone;
}

/**
 * Правило страницы под режим заметки.
 *
 * В постраничном режиме лист уже нарисован как A4 со своими полями — поля
 * печати обнуляем, иначе они сложатся с полями листа. В сплошном режиме
 * страницу задаёт принтер, и поля нужны свои.
 */
function pageRule(pageMode) {
  return pageMode === "paged" ? "@page { size: A4; margin: 0; }" : "@page { size: A4; margin: 15mm; }";
}

/**
 * Заголовок заметки над текстом — только в сплошном режиме: на готовом листе
 * ему негде встать, не сдвинув всё остальное.
 */
function headingHtml(title, pageMode) {
  if (pageMode === "paged" || !title) return "";
  return `<h1 class="note-print-title">${escapeHtml(title)}</h1>`;
}

/** Склейка готового документа. Единственное место, где он собирается строкой. */
function buildDocument({ clone, head, title, pageMode }) {
  return `<!doctype html>
<html lang="${escapeAttr(getLang())}">
<head>
<meta charset="utf-8">
<title>${escapeHtml(title || t("panel.untitled"))}</title>
${head}
</head>
<body class="note-print">
${headingHtml(title, pageMode)}
${clone.outerHTML}
</body>
</html>`;
}

/**
 * Документ для печати: стили подключаются ссылками. Путь относительный, но
 * рамка печати того же происхождения, что и приложение, поэтому он резолвится
 * как обычно, а браузер берёт файлы из своего кеша.
 */
function buildPrintDocument({ contentEl, title, pageMode }) {
  const head = `<link rel="stylesheet" href="${escapeAttr(EDITOR_CSS_URL)}">
<link rel="stylesheet" href="${escapeAttr(PRINT_CSS_URL)}">
<style>${pageRule(pageMode)}</style>`;
  return buildDocument({ clone: cloneNote(contentEl), head, title, pageMode });
}

// Тексты стилей, вшиваемые в файл. Читаются один раз за сессию: serve.json
// отдаёт всё с Cache-Control: no-store, и без своего кеша каждая выгрузка
// заново тянула бы оба файла по сети.
const styleTextCache = new Map();

async function loadStyleText(url) {
  if (!styleTextCache.has(url)) {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`style ${url}: ${response.status}`);
    styleTextCache.set(url, await response.text());
  }
  return styleTextCache.get(url);
}

/** Blob → data:-адрес. FileReader, потому что он есть везде и без зависимостей. */
function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

/**
 * Переводит картинки в сам файл.
 *
 * У гостя фото и так лежат в заметке как data: — их пропускаем. У
 * залогиненного это ссылка на хранилище, которая протухнет: без вшивания файл
 * через сутки покажет пустые рамки, а без сети — сразу.
 *
 * Неудачи не отменяют выгрузку: лучше отдать файл без одной картинки, чем не
 * отдать ничего. Сколько их было — возвращаем, чтобы предупредить.
 */
async function inlinePhotos(clone) {
  const remote = [...clone.querySelectorAll("img")].filter((img) => img.src && !img.src.startsWith("data:"));
  let failed = 0;
  await Promise.all(
    remote.map(async (img) => {
      try {
        const response = await fetch(img.src);
        if (!response.ok) throw new Error(String(response.status));
        img.src = await blobToDataUrl(await response.blob());
      } catch (error) {
        console.error("inlinePhotos", error);
        failed += 1;
      }
    })
  );
  return failed;
}

/**
 * Автономный документ: стили вшиты текстом, картинки — в data:. Такой файл
 * открывается двойным кликом и без сети.
 */
async function buildStandaloneDocument({ contentEl, title, pageMode }) {
  const clone = cloneNote(contentEl);
  // Обе задачи независимы, поэтому идут параллельно: стили читаются из кеша
  // или сети, картинки скачиваются.
  const [failed, editorCss, printCss] = await Promise.all([
    inlinePhotos(clone),
    loadStyleText(EDITOR_CSS_URL),
    loadStyleText(PRINT_CSS_URL),
  ]);
  const head = `<style>${editorCss}</style>
<style>${printCss}</style>
<style>${pageRule(pageMode)}</style>`;
  return { html: buildDocument({ clone, head, title, pageMode }), failed };
}

/* ------------------------------------------------------------------ *
 * Версия для Word
 *
 * Word открывает HTML своим движком, и тот НЕ понимает почти ничего из
 * editor.css: переменных (--block-tag-color), логических свойств
 * (margin-inline-start, на котором держится весь отступ по Tab), counter(),
 * content у псевдоэлементов, flex. Вшивать туда стили бессмысленно, а местами
 * вредно — часть правил он применит наполовину.
 *
 * Поэтому оформление не переписывается правило за правилом, а ЗАПЕКАЕТСЯ:
 * читаем у живого узла то, что насчитал браузер, и кладём результат инлайном
 * на его копию. Логические свойства при этом сами превращаются в готовые
 * margin-left/right — в том числе зеркально для иврита, — а источник правды
 * остаётся один: editor.css, просто берём его результат, а не текст.
 *
 * Остальное (маркеры списков, квадратики, полоски блоков) рисуется
 * псевдоэлементами, которых у Word нет вовсе — это доделывают flatten*.
 * ------------------------------------------------------------------ */

// Свойства, которые переносим. Список узкий намеренно: всё подряд раздуло бы
// файл в разы и притащило бы position/overflow, от которых Word ломается.
const BAKED_PROPS = [
  "font-family",
  "font-size",
  "font-weight",
  "font-style",
  "text-decoration-line",
  "color",
  "background-color",
  "text-align",
  "direction",
  "line-height",
  "margin-top",
  "margin-right",
  "margin-bottom",
  "margin-left",
  "padding-top",
  "padding-right",
  "padding-bottom",
  "padding-left",
];

/**
 * Идёт по живому дереву и по его копии одновременно.
 *
 * Нужно потому, что getComputedStyle на отсоединённом узле возвращает пустоту:
 * значения есть только у того, что реально в документе. Оба обхода в одном
 * порядке, структура совпадает узел в узел.
 */
function walkPairs(liveRoot, cloneRoot, visit) {
  const liveWalker = document.createTreeWalker(liveRoot, NodeFilter.SHOW_ELEMENT);
  const cloneWalker = document.createTreeWalker(cloneRoot, NodeFilter.SHOW_ELEMENT);
  visit(liveRoot, cloneRoot);
  for (let live = liveWalker.nextNode(), copy = cloneWalker.nextNode(); live && copy; live = liveWalker.nextNode(), copy = cloneWalker.nextNode()) {
    visit(live, copy);
  }
}

/**
 * Переносит вычисленное оформление на копию.
 *
 * Свойство пишется, только если отличается от родительского: наследуемого и
 * так хватит, а файл иначе распухает вдвое на ровном месте.
 */
function bakeComputedStyles(liveRoot, cloneRoot) {
  walkPairs(liveRoot, cloneRoot, (live, copy) => {
    const own = window.getComputedStyle(live);
    const parent = live.parentElement ? window.getComputedStyle(live.parentElement) : null;
    BAKED_PROPS.forEach((prop) => {
      const value = own.getPropertyValue(prop);
      if (!value) return;
      if (parent && parent.getPropertyValue(prop) === value) return;
      copy.style.setProperty(prop, value);
    });
  });
}

/**
 * Маркеры списков обратно на браузерные.
 *
 * В приложении list-style выключен, а точка и номер нарисованы псевдоэлементом
 * (у номера — ещё и через CSS-счётчик). В Word от такого списка остался бы
 * голый текст без единого маркера. Нумерацию Word считает сам, и вложенные
 * списки начинает заново — как и счётчик в редакторе.
 *
 * Отступ переносим со СТРОКИ на список: под маркер место отводит сам Word, и
 * запечённый padding пункта сложился бы с ним в двойной.
 */
function flattenLists(clone) {
  clone.querySelectorAll("ul, ol").forEach((list) => {
    const checklist = list.classList.contains("checklist") || list.closest("ul.checklist");
    list.style.listStyleType = checklist ? "none" : list.tagName === "OL" ? "decimal" : "disc";
    list.style.paddingInlineStart = checklist ? "0" : "1.6em";
    list.style.marginInlineStart = "";
  });
  clone.querySelectorAll("li").forEach((li) => {
    li.style.paddingInlineStart = "";
    li.style.paddingLeft = "";
    li.style.paddingRight = "";
  });
}

/**
 * Чек-лист — символами в самом тексте.
 *
 * Квадратик и галочка нарисованы псевдоэлементом, то есть для Word их нет.
 * Зачёркнутость выполненного пункта тоже не переживёт переноса:
 * text-decoration на блочном элементе Word игнорирует, а тег <s> понимает
 * железно.
 */
function flattenChecklist(clone) {
  clone.querySelectorAll("ul.checklist > li").forEach((li) => {
    const done = li.classList.contains("is-done");
    if (done) {
      const struck = document.createElement("s");
      struck.append(...li.childNodes);
      struck.style.color = "#9ca3af";
      li.appendChild(struck);
      // Зачёркивание теперь несёт <s>. Запечённое с пункта снимаем, иначе оно
      // легло бы и на саму галочку — там, где браузер его всё-таки применяет.
      li.style.textDecorationLine = "";
    }
    li.prepend(document.createTextNode(done ? "☑ " : "☐ "));
  });
}

/**
 * Полоски блоков с тегами — в настоящие рамки.
 *
 * Цвет живёт в переменной --block-tag-color (её ставит renderBlockVisuals из
 * реестра тегов), а сама полоска — псевдоэлемент: ни того, ни другого Word не
 * знает. Читаем цвет у живой строки и вешаем на копию обычную границу.
 *
 * Полупрозрачности (в приложении 0.55) у границы тоже не будет, поэтому цвет
 * заранее смешиваем с белым — на бумаге результат тот же.
 */
function flattenBlockBars(liveRoot, cloneRoot) {
  walkPairs(liveRoot, cloneRoot, (live, copy) => {
    const isStart = live.hasAttribute("data-block-start");
    const isEnd = live.hasAttribute("data-block-end");
    if (!isStart && !isEnd) return;
    const color = window.getComputedStyle(live).getPropertyValue("--block-tag-color").trim();
    if (!color) return;
    const faded = blendWithWhite(color, 0.55);
    if (isStart) copy.style.borderTop = `2px solid ${faded}`;
    if (isEnd) copy.style.borderBottom = `2px solid ${faded}`;
  });
}

/** Цвет поверх белого при заданной непрозрачности. Понимает rgb() и #rrggbb. */
function blendWithWhite(color, alpha) {
  const rgb = color.startsWith("#")
    ? [1, 3, 5].map((i) => parseInt(color.slice(i, i + 2), 16))
    : (color.match(/\d+/g) || []).slice(0, 3).map(Number);
  if (rgb.length !== 3 || rgb.some(Number.isNaN)) return color;
  return `rgb(${rgb.map((c) => Math.round(c * alpha + 255 * (1 - alpha))).join(", ")})`;
}

/**
 * Разделитель нарисован заливкой, а не рамкой (см. hr.rte-divider). Фон у hr
 * Word не покажет — переводим в границу того же цвета и толщины.
 */
function flattenDivider(liveRoot, cloneRoot) {
  walkPairs(liveRoot, cloneRoot, (live, copy) => {
    if (!live.matches("hr")) return;
    const style = window.getComputedStyle(live);
    const height = parseFloat(style.height) || 4;
    copy.style.background = "none";
    copy.style.height = "0";
    copy.style.border = "none";
    copy.style.borderTop = `${height}px solid ${style.backgroundColor}`;
  });
}

/**
 * Ссылкам возвращаем href.
 *
 * В приложении его нет: адреса лежат в data-links (JSON-массив), а переход
 * делает обработчик клика. В файле такая ссылка была бы мёртвой.
 *
 * Ссылки на другие заметки (data-link-type="internal") ведут внутрь
 * приложения, снаружи им вести некуда — остаются обычным текстом.
 */
function flattenLinks(clone) {
  clone.querySelectorAll("a.rte-link").forEach((link) => {
    const raw = link.dataset.links;
    if (!raw) return;
    try {
      const urls = JSON.parse(raw);
      if (urls.length) {
        link.href = urls[0];
        link.title = urls.join("\n");
      }
    } catch (error) {
      console.error("flattenLinks", error);
    }
  });
}

/**
 * Снимает то, что Word всё равно не поймёт, но на что он реагирует шумом в
 * разметке. Оформление к этому моменту уже запечено инлайном, так что классы и
 * data-атрибуты больше ни на что не влияют. dir оставляем — на нём держится
 * иврит.
 */
function stripNonWordAttributes(clone) {
  clone.querySelectorAll("*").forEach((el) => {
    el.removeAttribute("class");
    [...el.attributes].filter((attr) => attr.name.startsWith("data-")).forEach((attr) => el.removeAttribute(attr.name));
  });
}

/**
 * Рисунки — в картинки.
 *
 * Рисунок нарисован инлайновым <svg>, а его HTML-импортёр Word выбрасывает
 * целиком: в документе не осталось бы ничего. Переводим в PNG.
 *
 * Обрезаем по самому штриху (getBBox), а не по слою: слой растянут на всю
 * страницу и почти весь прозрачен — картинка размером с лист разнесла бы
 * вёрстку. Рисуем в двойном разрешении, иначе линия выходит рваной.
 *
 * transform-box и transform-origin задаются в editor.css, то есть снаружи
 * этого svg. В отдельной картинке их нет, поэтому переносим значениями: без
 * них масштаб считался бы от центра и штрих уехал бы.
 */
const DRAWING_PADDING = 8;

async function rasterizeDrawings(liveRoot, cloneRoot) {
  const jobs = [];
  walkPairs(liveRoot, cloneRoot, (live, copy) => {
    if (live.matches("svg.rte-drawing-layer")) jobs.push({ live, copy });
  });
  await Promise.all(
    jobs.map(async ({ live, copy }) => {
      try {
        const img = await drawingToImage(live);
        if (img) copy.replaceWith(img);
        else copy.remove();
      } catch (error) {
        console.error("rasterizeDrawings", error);
        copy.remove();
      }
    })
  );
}

async function drawingToImage(svg) {
  const path = svg.querySelector("path");
  if (!path) return null;
  const box = path.getBBox();
  const stroke = parseFloat(window.getComputedStyle(path).strokeWidth) || 0;
  const pad = DRAWING_PADDING + stroke;
  const x = box.x - pad;
  const y = box.y - pad;
  const width = Math.max(1, Math.ceil(box.width + pad * 2));
  const height = Math.max(1, Math.ceil(box.height + pad * 2));

  const copy = path.cloneNode(true);
  copy.style.transformBox = "view-box";
  copy.style.transformOrigin = "0 0";
  const standalone =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="${x} ${y} ${width} ${height}">${copy.outerHTML}</svg>`;

  const bitmap = await loadImage(`data:image/svg+xml;charset=utf-8,${encodeURIComponent(standalone)}`);
  const canvas = document.createElement("canvas");
  canvas.width = width * 2;
  canvas.height = height * 2;
  canvas.getContext("2d").drawImage(bitmap, 0, 0, canvas.width, canvas.height);

  const out = document.createElement("img");
  out.src = canvas.toDataURL("image/png");
  out.style.width = `${width}px`;
  out.style.height = `${height}px`;
  // Рисунок уже не слой поверх страницы, а картинка в потоке — позицию ему
  // дальше назначит groundFloatingObjects, по тому же якорю, что и фото.
  out.dataset.layout = "float";
  if (svg.dataset.anchor) out.dataset.anchor = svg.dataset.anchor;
  if (svg.dataset.leftPct) out.dataset.leftPct = svg.dataset.leftPct;
  return out;
}

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("image decode failed"));
    img.src = src;
  });
}

/**
 * Опускает объекты с абсолютной позицией в поток текста.
 *
 * В приложении фото и рисунки стоят поверх страницы по координатам. Word так
 * не умеет: через HTML-импорт объект либо схлопывается в начало документа,
 * либо уезжает за поле. Поэтому ставим его отдельным абзацем сразу за строкой,
 * к которой он привязан (data-anchor), а от горизонтальной позиции оставляем
 * только выравнивание. Точное место и порядок наложения при этом теряются —
 * зато объект стоит там, где про него написано, и документ читается.
 */
function groundFloatingObjects(clone) {
  const floats = [...clone.querySelectorAll('[data-layout="float"]')];
  // Куда класть следующий объект этого якоря. Без этого каждый следующий
  // вставлялся бы сразу за строкой и стопка переворачивалась бы задом наперёд.
  const lastPlaced = new Map();
  floats.forEach((el) => {
    const anchorId = el.dataset.anchor;
    const holder = document.createElement("p");
    holder.style.textAlign = alignFromLeftPercent(el.dataset.leftPct);
    holder.style.margin = "0.4rem 0";
    // Абсолютные координаты вместе с наложением на текст больше не нужны —
    // дальше объект живёт обычной картинкой в абзаце.
    ["position", "left", "top", "transform", "zIndex", "float"].forEach((prop) => {
      el.style.removeProperty(prop.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`));
    });
    el.replaceWith(holder);
    holder.appendChild(el);

    const anchorLine = anchorId ? clone.querySelector(`[data-anchor="${CSS.escape(anchorId)}"]:not([data-layout])`) : null;
    const after = lastPlaced.get(anchorId) || anchorLine;
    if (after && after !== holder) after.after(holder);
    if (anchorId) lastPlaced.set(anchorId, holder);
  });
}

/** Левее трети листа — по левому краю, правее двух третей — по правому. */
function alignFromLeftPercent(leftPct) {
  const value = parseFloat(leftPct);
  if (Number.isNaN(value)) return "center";
  if (value < 40) return "left";
  if (value > 60) return "right";
  return "center";
}

/**
 * Заголовки документа для Word.
 *
 * Без @page WordSection1 он открывает файл как веб-страницу — без листа A4 и
 * без полей; задать их из HTML больше нечем. Условный комментарий просит сразу
 * показать разметку страницы, а не веб-режим.
 */
function wordHead(title) {
  return `<meta name="ProgId" content="Word.Document">
<meta name="Generator" content="Microsoft Word 15">
<!--[if gte mso 9]><xml><w:WordDocument><w:View>Print</w:View></w:WordDocument></xml><![endif]-->
<style>
@page WordSection1 { size: 21cm 29.7cm; margin: 2cm; }
div.WordSection1 { page: WordSection1; }
body { font-family: -apple-system, "Segoe UI", Roboto, Arial, sans-serif; color: #1f2328; }
</style>
<!-- ${escapeHtml(title || "")} -->`;
}

/**
 * Листы заметки для Word.
 *
 * Разрыв страницы между ними ставим явно: рамка листа со своими размерами в
 * Word не переживает, а без разрыва все страницы слились бы в одну простыню.
 * У последнего листа разрыва нет — иначе документ закончится пустой страницей.
 *
 * Узлы страниц ищутся ЗАРАНЕЕ и передаются сюда: к этому моменту с копии уже
 * сняты классы (они Word'у не нужны), и по .rte-page страницу было бы не
 * найти — всё содержимое склеилось бы в один блок.
 */
function wordPagesHtml(pages, clone) {
  const parts = pages.length ? pages.map((page) => page.innerHTML) : [clone.innerHTML];
  return parts.join('\n<br clear="all" style="page-break-before: always">\n');
}

/** Документ для Word: оформление запечено, всё непереносимое уплощено. */
async function buildWordDocument({ contentEl, title }) {
  const clone = cloneNote(contentEl);
  const failed = await inlinePhotos(clone);
  // Всё, что ниже читает живой редактор, читает его со светлой бумагой: в
  // тёмной теме вычисленные цвета были бы светлым текстом, и в Word он ушёл бы
  // на белую страницу (см. .rte-content.is-exporting в editor.css). Класс
  // снимаем в finally — даже если выгрузка упала, редактор не останется светлым.
  contentEl.classList.add("is-exporting");
  try {
    // Порядок важен. Сначала запекаем — flatten* ниже дописывают поверх свои
    // правки, и перезатереть их запеканием было бы нельзя.
    bakeComputedStyles(contentEl, clone);
    flattenBlockBars(contentEl, clone);
    flattenDivider(contentEl, clone);
    // Рисунки — до опускания в поток: растеризация заменяет узел, и опускать
    // нужно уже картинку. Обе функции читают живой DOM, поэтому идут парами.
    await rasterizeDrawings(contentEl, clone);
  } finally {
    contentEl.classList.remove("is-exporting");
  }
  groundFloatingObjects(clone);
  // Список правим после запекания: именно оно кладёт на пункт padding, который
  // сложился бы с местом под маркер.
  flattenLists(clone);
  flattenChecklist(clone);
  flattenLinks(clone);
  // Страницы запоминаем до чистки: она снимает классы, по которым их ищут.
  const pages = [...clone.querySelectorAll(".rte-page")];
  stripNonWordAttributes(clone);

  const heading = title ? `<h1 style="font-size:1.5rem;font-weight:600;margin-bottom:0.8rem">${escapeHtml(title)}</h1>` : "";
  const html = `<!doctype html>
<html xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:w="urn:schemas-microsoft-com:office:word" lang="${escapeAttr(getLang())}">
<head>
<meta charset="utf-8">
<title>${escapeHtml(title || t("panel.untitled"))}</title>
${wordHead(title)}
</head>
<body>
<div class="WordSection1">
${heading}
${wordPagesHtml(pages, clone)}
</div>
</body>
</html>`;
  return { html, failed };
}

// Символы, запрещённые в именах файлов Windows. Плюс точки и пробелы по краям:
// имя вида "заметка." Проводник не принимает.
const UNSAFE_FILE_CHARS = /[\\/:*?"<>| -]/g;
const FILE_NAME_LIMIT = 80;

function safeFileName(title) {
  const cleaned = String(title || "").replace(UNSAFE_FILE_CHARS, " ").replace(/\s+/g, " ").trim().replace(/^\.+|\.+$/g, "");
  return (cleaned || t("panel.untitled")).slice(0, FILE_NAME_LIMIT);
}

/**
 * Ждёт картинки и шрифты, но не дольше timeoutMs.
 *
 * error у картинки ждём наравне с load: не дождавшись ни того, ни другого,
 * печать зависла бы на первой недоступной ссылке.
 */
function waitForAssets(doc, timeoutMs) {
  const images = [...doc.images].map((img) => {
    if (img.complete) return Promise.resolve();
    return new Promise((resolve) => {
      img.addEventListener("load", resolve, { once: true });
      img.addEventListener("error", resolve, { once: true });
    });
  });
  const fonts = doc.fonts ? doc.fonts.ready : Promise.resolve();
  const everything = Promise.all([...images, fonts]);
  const timeout = new Promise((resolve) => setTimeout(resolve, timeoutMs));
  return Promise.race([everything, timeout]);
}

/**
 * Показывает системный диалог печати с готовым документом.
 *
 * Почему iframe, а не новое окно: окно блокируется всплывающими фильтрами и
 * мелькает перед глазами. Почему srcdoc: документ остаётся того же
 * происхождения (иначе не вызвать print() изнутри) и относительные адреса
 * стилей резолвятся от родительской страницы.
 *
 * Рамка уезжает за экран, но остаётся НАСТОЯЩЕГО размера листа: display:none
 * вообще не печатается, а нулевая ширина дала бы вьюпорт в 0px, и всё, что
 * считается в процентах (фото, рисунки), разъехалось бы.
 *
 * Убираем рамку по afterprint, а не сразу после print(): в части браузеров
 * print() возвращает управление, пока диалог ещё открыт, и preview опустел бы.
 */
function openPrintFrame(html) {
  const frame = document.createElement("iframe");
  frame.setAttribute("aria-hidden", "true");
  frame.style.cssText = "position:fixed;left:-10000px;top:0;width:794px;height:1123px;border:0";
  frame.srcdoc = html;

  let cleaned = false;
  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    frame.remove();
  };

  frame.addEventListener("load", async () => {
    const win = frame.contentWindow;
    // Окно могли закрыть/перерисовать, пока грузился документ.
    if (!win) return cleanup();
    await waitForAssets(win.document, ASSET_TIMEOUT);
    if (!frame.isConnected) return;
    win.addEventListener("afterprint", cleanup, { once: true });
    setTimeout(cleanup, FRAME_CLEANUP_TIMEOUT);
    // Без focus() часть браузеров печатает родительское окно вместо рамки.
    win.focus();
    win.print();
  });

  document.body.appendChild(frame);
}

/**
 * Печать открытой заметки.
 * @param {{contentEl: HTMLElement, title: string, pageMode: string}} options
 */
export async function printNote({ contentEl, title, pageMode }) {
  try {
    openPrintFrame(buildPrintDocument({ contentEl, title, pageMode }));
  } catch (error) {
    console.error("printNote", error);
    await openAlert({ message: t("editor.exportFailed") });
  }
}

/**
 * Выгрузка заметки в автономный .html — он открывается и в браузере, и в
 * Word, и импортом в Google Docs.
 * @param {{contentEl: HTMLElement, title: string, pageMode: string}} options
 */
export async function downloadNoteHtml({ contentEl, title, pageMode }) {
  try {
    const { html, failed } = await buildStandaloneDocument({ contentEl, title, pageMode });
    downloadText(html, `${safeFileName(title)}.html`, "text/html;charset=utf-8");
    // Предупреждаем ПОСЛЕ выгрузки: файл уже у пользователя, просто неполный.
    if (failed) await openAlert({ message: t("editor.exportPhotosFailed") });
  } catch (error) {
    console.error("downloadNoteHtml", error);
    await openAlert({ message: t("editor.exportFailed") });
  }
}

/**
 * Выгрузка заметки в .doc — файл, который открывается в Word.
 *
 * Внутри честный HTML, а не формат Word: своего упаковщика .docx без
 * зависимостей не собрать, а такой файл Word открывает штатно уже четверть
 * века. Отсюда и особенности: он может спросить подтверждение формата при
 * открытии и весит больше настоящего .docx.
 * @param {{contentEl: HTMLElement, title: string}} options
 */
export async function downloadNoteDoc({ contentEl, title }) {
  try {
    const { html, failed } = await buildWordDocument({ contentEl, title });
    // BOM в начале: без него Word иногда читает файл в системной кодировке и
    // кириллица с ивритом превращаются в мусор, несмотря на meta charset.
    downloadText(`﻿${html}`, `${safeFileName(title)}.doc`, "application/msword");
    if (failed) await openAlert({ message: t("editor.exportPhotosFailed") });
  } catch (error) {
    console.error("downloadNoteDoc", error);
    await openAlert({ message: t("editor.exportFailed") });
  }
}
