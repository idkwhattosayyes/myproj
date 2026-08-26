export function qs(selector, scope = document) {
  return scope.querySelector(selector);
}

export function qsa(selector, scope = document) {
  return [...scope.querySelectorAll(selector)];
}

export function escapeHtml(value) {
  const div = document.createElement("div");
  div.textContent = value ?? "";
  return div.innerHTML;
}

export function escapeAttr(value) {
  return escapeHtml(value).replace(/"/g, "&quot;");
}

/**
 * Значение, зажатое в отрезок. Вынесено сюда, потому что порядок Math.max и
 * Math.min каждый раз приходится восстанавливать в голове, а ошибка в нём тихая:
 * элемент просто уезжает не туда, и никто не падает.
 *
 * Когда max оказывается меньше min — элемент выше или шире отрезка — побеждает
 * min: прижимаем к началу, а не выталкиваем за противоположный край.
 */
export function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

/**
 * HTML заметки → плоский текст для поиска. Теги заменяются пробелом, иначе
 * слова из соседних абзацев слиплись бы в одно и находились бы там, где их нет.
 * Сущности (&nbsp; и подобные) раскрываются самим браузером при разборе.
 */
export function htmlToText(html) {
  const holder = document.createElement("div");
  holder.innerHTML = String(html || "").replace(/<[^>]+>/g, " ");
  return holder.textContent.replace(/\s+/g, " ").trim();
}

/**
 * Все вставленные фото заметки, в DOM-порядке, включая те, у которых не
 * заполнено название (data-name отсутствует — name будет null). Порядковый
 * номер элемента в возвращённом массиве — стабильный индекс фото внутри ЭТОЙ
 * заметки, используется для перехода к конкретному фото по результату поиска
 * (см. searchService.js/richTextEditor.js) — там же и htmlToText не годится:
 * он режет ВСЕ теги вместе с атрибутами, а название нигде не отображается как
 * текст (см. richTextEditor.js/photoEditor.js).
 */
export function extractPhotos(html) {
  const holder = document.createElement("div");
  holder.innerHTML = String(html || "");
  return [...holder.querySelectorAll("img.rte-photo")].map((img) => ({ name: img.dataset.name || null }));
}

// Высота листа A4 в собственных координатах редактора — то же значение, что
// A4_HEIGHT в richTextEditor.js (там же и объяснено, откуда оно). Дублируем
// константу здесь намеренно, а не импортируем: этот файл — нейтральный слой
// utils/, richTextEditor.js — UI-слой, импорт в обратную сторону нарушил бы
// однонаправленный поток modules → services → data.
const A4_HEIGHT = 1123;

// Метаданные фото для производного индекса images (Supabase, только для
// залогиненных — см. photoStorageService.js). Чисто статический парсинг, без
// обращения к layout (offsetTop/getBoundingClientRect недоступны на detached
// div и не нужны — все нужные величины уже посчитаны редактором и лежат в
// data-атрибутах). Берём только фото, реально залитые в Storage
// (data-storage-path) — ещё не загруженные (гость, или сбой аплоада) в индекс
// не попадают, это ожидаемо.
//
// position_y_percent — в модели редактора Y никогда не хранится долей высоты
// (только id строки-якоря + пиксельный оффсет на момент привязки, см.
// richTextEditor.js), а таблица images — производный индекс, не источник
// истины для рендера, поэтому point-in-time best-effort формула через
// A4_HEIGHT достаточна и не обязана быть идеально точной.
//
// Режим "интеграция с текстом" (data-anchor отсутствует — togglePhotoLayout
// его удаляет) — anchor_line_id/x/y уходят в null/0 (дефолт таблицы), не
// выдумываем синтетику для того, чего в content физически нет.
export function extractImageMetadata(html) {
  const holder = document.createElement("div");
  holder.innerHTML = String(html || "");
  return [...holder.querySelectorAll("img.rte-photo[data-storage-path]")].map((img) => {
    const hasAnchor = img.dataset.anchor !== undefined;
    const leftPct = Number(img.dataset.leftPct);
    const anchorTop = Number(img.dataset.anchorTop);
    return {
      storagePath: img.dataset.storagePath,
      xPercent: hasAnchor && Number.isFinite(leftPct) ? leftPct : 0,
      yPercent: hasAnchor && Number.isFinite(anchorTop) ? (anchorTop / A4_HEIGHT) * 100 : 0,
      widthPercent: Number(img.dataset.sizePct) || 100,
      zIndex: Number(img.style.zIndex) || 0,
      title: img.dataset.name || null,
      anchorLineId: hasAnchor ? img.dataset.anchor : null,
    };
  });
}

// То же самое для рисунков — производный индекс drawings. z-index у рисунка
// живёт на родительском <svg class="rte-drawing-layer">, не на самом <path>
// (см. createStrokeLayer в richTextEditor.js) — единственное отличие от
// извлечения фото. path_data — атрибут d как есть, геометрия штриха; цвет/
// толщина в схеме drawings не хранятся (таблица — вспомогательный индекс, не
// источник истины, рендер всё равно из content).
export function extractDrawingMetadata(html) {
  const holder = document.createElement("div");
  holder.innerHTML = String(html || "");
  return [...holder.querySelectorAll("svg.rte-drawing-layer")].flatMap((svg) => {
    const path = svg.querySelector("path");
    if (!path) return [];
    const hasAnchor = path.dataset.anchor !== undefined;
    const leftPct = Number(path.dataset.leftPct);
    const anchorTop = Number(path.dataset.anchorTop);
    return [
      {
        pathData: path.getAttribute("d") || "",
        xPercent: hasAnchor && Number.isFinite(leftPct) ? leftPct : 0,
        yPercent: hasAnchor && Number.isFinite(anchorTop) ? (anchorTop / A4_HEIGHT) * 100 : 0,
        zIndex: Number(svg.style.zIndex) || 0,
        anchorLineId: hasAnchor ? path.dataset.anchor : null,
      },
    ];
  });
}

/**
 * Textarea растёт вниз по мере ввода вместо того, чтобы прятать текст за
 * нижним краем. Высоту снимаем в auto перед замером — иначе scrollHeight
 * останется равным уже выставленной высоте и поле не сожмётся при удалении.
 */
export function autoGrowTextarea(el) {
  const resize = () => {
    el.style.height = "auto";
    // +2px — запас на дробную высоту строки: без него у поля впритык
    // появляется полоса прокрутки, хотя весь текст уже помещается.
    el.style.height = `${el.scrollHeight + 2}px`;
  };
  el.addEventListener("input", resize);
  resize();
}
