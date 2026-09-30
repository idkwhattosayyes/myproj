import { t, getLang } from "../../i18n/i18n.js";
import { openAlert } from "../../utils/modal.js";
import { escapeHtml, escapeAttr } from "../../utils/dom.js";

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
 * Готовый HTML-документ с заметкой.
 *
 * Стили — те же самые, что в приложении: подключаем сам editor.css, чтобы у
 * вида заметки остался один источник правды. notePrint.css добавляет к нему
 * то, чего в приложении не требуется (печать фонов, размер страницы, снятие
 * экранного масштаба) — подробности в самом файле.
 */
function buildPrintDocument({ contentEl, title, pageMode }) {
  const clone = cloneNote(contentEl);
  // В постраничном режиме лист уже нарисован как A4 со своими полями — поля
  // печати обнуляем, иначе они сложатся с полями листа. В сплошном режиме
  // страницу задаёт принтер, и поля нужны свои.
  //
  // Заголовок заметки печатаем только в сплошном режиме по той же причине:
  // на готовом листе ему негде встать, не сдвинув всё остальное.
  const paged = pageMode === "paged";
  const pageRule = paged ? "@page { size: A4; margin: 0; }" : "@page { size: A4; margin: 15mm; }";
  const heading = paged || !title ? "" : `<h1 class="note-print-title">${escapeHtml(title)}</h1>`;

  return `<!doctype html>
<html lang="${escapeAttr(getLang())}">
<head>
<meta charset="utf-8">
<title>${escapeHtml(title || t("panel.untitled"))}</title>
<link rel="stylesheet" href="${escapeAttr(EDITOR_CSS_URL)}">
<link rel="stylesheet" href="${escapeAttr(PRINT_CSS_URL)}">
<style>${pageRule}</style>
</head>
<body class="note-print">
${heading}
${clone.outerHTML}
</body>
</html>`;
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
