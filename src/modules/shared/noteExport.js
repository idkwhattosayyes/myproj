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
