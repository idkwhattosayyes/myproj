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
 * HTML заметки → текст для поиска, в котором строки редактора разделены "\n",
 * а пустая строка редактора — пустая строка текста. Раньше все теги
 * заменялись пробелом и пробелы схлопывались, то есть структура строк
 * терялась целиком — и сниппет результата тянул «контекст» из соседнего
 * абзаца через пустую строку (см. cutBefore/cutAfter в searchService.js).
 *
 * Шаги ЗЕРКАЛЯТ функцию note_search_text в supabase/010_notes_search.sql:
 * у залогиненного тот же текст считает Postgres, и оба обязаны давать один
 * результат, иначе сервер найдёт заметку, а клиент в её тексте — нет (или
 * наоборот). Меняешь порядок или регулярку здесь — меняй и там.
 *
 * 1. Инлайн-теги (жирный, цвет, ссылка, заголовок-в-строке…) → пусто:
 *    «hel<b>lo</b>» — это слово «hello», и найтись оно должно целиком.
 *    Первым шагом — чтобы пустая строка вида <div><b><br></b></div>
 *    (редактор переносит оформление на новую строку, см. restoreLineFormat
 *    в richTextEditor.js) на следующем шаге выглядела как обычная пустая.
 * 2. Пустая строка редактора — элемент строки (div/p/li/h1…h6), в котором
 *    нет ничего, кроме <br>, пробелов и &nbsp; (Chrome держит высоту пустой
 *    строки через <br>). Такой элемент целиком → метка EMPTY_LINE. Метка, а не
 *    сразу "\n\n": шаг 6 схлопывает подряд идущие "\n", и без метки пустая
 *    строка была бы неотличима от границы вложенных тегов. <hr>
 *    (разделитель) — тоже явный разрыв абзаца, та же метка.
 * 3. Концы строк редактора (</div>, </p>, </li>, </h1>…</h6>, </tr>), <br> и
 *    НАЧАЛО списка/таблицы (<ul>, <ol>, <table>) → "\n". Начало нужно ради
 *    вложенного списка: <li>y<ul><li>z — без него «z» оказался бы на одной
 *    строке с «y». Лишние "\n" от закрывающихся один за другим тегов
 *    (</li></ul></li>) схлопываются ниже в один.
 * 4. Остальные теги → пробел: <img> с base64 внутри src и <svg> рисунка
 *    уходят целиком, текста в них нет.
 * 5. Сущности (&nbsp; и подобные) раскрывает сам браузер: тегов уже нет,
 *    так что картинок он не создаст и грузить их не станет.
 * 6. Пробелы внутри строки — в один (неразрывный тоже); серии "\n" с
 *    пробелами между — в один "\n"; метка пустой строки → "\n" (вместе с
 *    соседним "\n" даёт те самые два подряд); пробелы вокруг "\n" и по краям
 *    — убрать.
 */
// Управляющий символ U+0001: в тексте заметки его не бывает. Через
// fromCharCode, а не литералом — в файле он был бы невидим.
const EMPTY_LINE = String.fromCharCode(1);

export function htmlToSearchText(html) {
  let text = String(html || "");
  text = text.replace(/<\/?(?:a|b|i|u|s|em|strong|span|font|mark|sub|sup|code)(?:\s[^>]*)?>/gi, "");
  text = text.replace(/<(div|p|li|h[1-6])(?:\s[^>]*)?>(?:\s|&nbsp;|<br[^>]*>)*<\/\1>/gi, EMPTY_LINE);
  text = text.replace(/<hr[^>]*>/gi, EMPTY_LINE);
  text = text.replace(/<\/(?:div|p|li|h[1-6]|tr)>|<br[^>]*>|<(?:ul|ol|table)(?:\s[^>]*)?>/gi, "\n");
  text = text.replace(/<[^>]*>/g, " ");
  const holder = document.createElement("div");
  holder.innerHTML = text;
  text = holder.textContent;
  text = text.replace(/[^\S\n]+/g, " ").replace(/[ \n]*\n[ \n]*/g, "\n");
  text = text.replaceAll(EMPTY_LINE, "\n").replace(/ *\n */g, "\n");
  return text.trim();
}

/**
 * Все вставленные фото заметки, в DOM-порядке, включая те, у которых не
 * заполнено название (data-name отсутствует — name будет null). Порядковый
 * номер элемента в возвращённом массиве — стабильный индекс фото внутри ЭТОЙ
 * заметки, используется для перехода к конкретному фото по результату поиска
 * (см. searchService.js/richTextEditor.js) — там же и htmlToSearchText не
 * годится: он режет ВСЕ теги вместе с атрибутами, а название нигде не
 * отображается как текст (см. richTextEditor.js/photoEditor.js).
 *
 * DOMParser, а не innerHTML в живой div: документ от него «инертный», <img>
 * в нём не грузятся и не декодируются. Живой div заставлял браузер разбирать
 * все base64-фото заметки на каждую букву запроса.
 */
export function extractPhotos(html) {
  const doc = new DOMParser().parseFromString(String(html || ""), "text/html");
  return [...doc.querySelectorAll("img.rte-photo")].map((img) => ({ name: img.dataset.name || null }));
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
