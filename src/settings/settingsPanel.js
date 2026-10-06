import { getLang, setLang, t } from "../i18n/i18n.js";
import { getBorderEnabled, setBorderEnabled } from "./borderSetting.js";
import { getSaveIndicatorEnabled, setSaveIndicatorEnabled } from "./saveIndicatorSetting.js";
import { UI_ZOOM_OPTIONS, getUiZoom, setUiZoom } from "./uiZoomSetting.js";
import { openConfirm, openPrompt } from "../utils/modal.js";
import { pushLayer } from "../utils/escapeLayers.js";
import { getStorage } from "../data/storageAdapter.js";
import { getCachedSession, signOut, clearGuestChosen } from "../auth/authService.js";
import { openAuthModal } from "../auth/authModal.js";
import { escapeHtml } from "../utils/dom.js";
import { toCssPx } from "../utils/uiScale.js";
import { buildExportFrom, circlesForItems, downloadJson, readJsonFile, importData, isValidExport } from "./dataTransfer.js";
import { openTransferPicker } from "./transferPicker.js";
import { getState as getHomeCirclesState } from "../modules/home/customCircles.js";
import { showLoadingOverlay } from "../utils/loadingOverlay.js";

// Одна шестерёнка в углу вместо россыпи плавающих переключателей: язык,
// обводка панелей и опасное действие "очистить данные" живут в одной панели.
// Панель — окно по центру экрана поверх затемнения, как меню тегов, а не
// выпадашка под шестерёнкой: у правого края выпадашка уезжала за экран при
// крупном масштабе, и места под новые настройки в ней почти не было.
let buttonEl = null;
let overlayEl = null;
let panelEl = null;
// Открыто ли окно по смыслу. Не то же самое, что overlayEl.hidden: пока идёт
// анимация закрытия, окно ещё на экране, но уже считается закрытым.
let isOpen = false;
let unregisterLayer = null;
let onLangChangeCallback = null;

/** @param {{onLangChange: () => void}} options */
export function mountSettings({ onLangChange }) {
  onLangChangeCallback = onLangChange;
  if (buttonEl) return; // уже смонтирована — панель живёт вне маршрутов

  buttonEl = document.createElement("button");
  buttonEl.type = "button";
  buttonEl.className = "settings-btn";
  buttonEl.id = "settings-btn";
  buttonEl.textContent = "⚙";
  buttonEl.title = t("settings.open");
  buttonEl.addEventListener("click", (event) => {
    event.stopPropagation();
    togglePanel();
  });

  overlayEl = document.createElement("div");
  overlayEl.className = "modal-overlay settings-overlay";
  overlayEl.hidden = true;
  panelEl = document.createElement("div");
  panelEl.className = "settings-panel";
  panelEl.id = "settings-panel";
  overlayEl.appendChild(panelEl);
  // Закрываем только нажатием, НАЧАТЫМ на затемнении (соглашение проекта):
  // зажали кнопку внутри окна и отпустили снаружи — окно остаётся.
  overlayEl.addEventListener("mousedown", (event) => {
    if (event.target === overlayEl) closePanel();
  });

  document.body.append(buttonEl, overlayEl);
  renderPanel();
}

function togglePanel() {
  if (isOpen) closePanel();
  else openPanel();
}

function openPanel() {
  renderPanel();
  isOpen = true;
  overlayEl.hidden = false;
  buttonEl.classList.add("is-active");
  unregisterLayer = pushLayer(closePanel);
  playMorph("open", null);
}

function closePanel() {
  if (!isOpen) return;
  isOpen = false;
  if (unregisterLayer) {
    unregisterLayer();
    unregisterLayer = null;
  }
  // Прячем окно только когда оно уже «втянулось» обратно в шестерёнку.
  playMorph("close", () => {
    overlayEl.hidden = true;
    buttonEl.classList.remove("is-active");
  });
}

// --- Превращение шестерёнки в окно и обратно ------------------------------
// Как на iOS: окно вырастает из самой кнопки, а кнопка на это время пропадает —
// будто окно ею и было; при закрытии оно сжимается обратно в кружок, и кнопка
// появляется на своём месте. Web Animations API (element.animate) — встроен в
// браузер, библиотек не нужно.

const MORPH_OPEN_MS = 340;
const MORPH_CLOSE_MS = 320;
// Открытие: быстрый старт и мягкая посадка — похоже на пружину iOS, без отскока.
const MORPH_OPEN_EASING = "cubic-bezier(0.2, 0.9, 0.25, 1)";
// Закрытие: плавно и в начале, и в конце. Перевёрнутая кривая открытия здесь не
// годилась — она долго держала окно большим и сдёргивала его в кнопку в самом
// конце, и было видно, как уезжает белый прямоугольник.
const MORPH_CLOSE_EASING = "cubic-bezier(0.4, 0, 0.2, 1)";

// Идёт ли открытие/закрытие прямо сейчас — их надо уметь оборвать, если кнопку
// нажали снова посреди анимации.
let morphAnimations = [];

function cancelMorph() {
  morphAnimations.forEach((animation) => animation.cancel());
  morphAnimations = [];
}

// Пользователь попросил систему или браузер поменьше двигать на экране —
// тогда окно просто появляется и исчезает.
function prefersReducedMotion() {
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/**
 * @param {"open" | "close"} direction
 * @param {(() => void) | null} onDone что сделать, когда анимация доиграла
 */
function playMorph(direction, onDone) {
  cancelMorph();
  const opening = direction === "open";

  if (prefersReducedMotion()) {
    buttonEl.style.visibility = opening ? "hidden" : "";
    if (onDone) onDone();
    return;
  }

  // Откуда и куда: оба прямоугольника — в пикселях экрана. Сдвиг пишется в
  // transform окна, а оно под масштабом сайта, поэтому через toCssPx; масштаб
  // (отношение размеров) единиц не имеет и переводить его не нужно.
  const from = buttonEl.getBoundingClientRect();
  const to = panelEl.getBoundingClientRect();
  const dx = toCssPx(from.left + from.width / 2 - (to.left + to.width / 2));
  const dy = toCssPx(from.top + from.height / 2 - (to.top + to.height / 2));
  const collapsed = {
    transform: `translate(${dx}px, ${dy}px) scale(${from.width / to.width}, ${from.height / to.height})`,
    // 50% от сторон окна после сжатия до размеров кнопки — ровный круг.
    borderRadius: "50%",
  };
  const expanded = { transform: "none", borderRadius: getComputedStyle(panelEl).borderRadius };
  const dimmed = { backgroundColor: getComputedStyle(overlayEl).backgroundColor };
  // Прозрачная версия того же цвета затемнения (theme.css): к прозрачному
  // ДРУГОГО цвета затемнение по пути меняло бы оттенок.
  const clear = { backgroundColor: getComputedStyle(document.documentElement).getPropertyValue("--overlay-backdrop-clear").trim() };

  // Кадры у открытия и закрытия разные, а не одни и те же задом наперёд.
  // Закрытию нужно своё: окно сначала скругляется в овал (к середине пути у него
  // уже радиус 50%, в кадре только transform не задан — браузер ведёт его
  // плавно между соседними кадрами), и дальше в кнопку сжимается уже круглая
  // форма, а не прямоугольник. Текст гаснет в первой четверти, чтобы не
  // сжиматься вместе с рамкой.
  const frames = opening
    ? {
        panel: [collapsed, expanded],
        content: [{ opacity: 0 }, { opacity: 0, offset: 0.4 }, { opacity: 1 }],
        overlay: [clear, dimmed],
      }
    : {
        panel: [expanded, { borderRadius: "50%", offset: 0.45 }, collapsed],
        content: [{ opacity: 1 }, { opacity: 0, offset: 0.25 }, { opacity: 0 }],
        overlay: [dimmed, clear],
      };

  const timing = {
    duration: opening ? MORPH_OPEN_MS : MORPH_CLOSE_MS,
    easing: opening ? MORPH_OPEN_EASING : MORPH_CLOSE_EASING,
    // Закрывшееся окно должно остаться сжатым до того, как его спрячут, —
    // иначе на последнем кадре оно мелькнуло бы в полный размер.
    fill: opening ? "none" : "forwards",
  };

  // Кнопка пропадает в начале открытия и возвращается только в самом конце
  // закрытия — в промежутке её роль играет само окно.
  buttonEl.style.visibility = "hidden";

  const panelAnimation = panelEl.animate(frames.panel, timing);
  morphAnimations = [
    panelAnimation,
    ...[...panelEl.children].map((child) => child.animate(frames.content, timing)),
    overlayEl.animate(frames.overlay, timing),
  ];

  // Промис finished, а не событие onfinish: событие браузер шлёт только на кадре
  // отрисовки, и в фоновой вкладке закрытие так и не завершалось бы. При обрыве
  // (cancel) промис отклоняется — прерванное закрытие не спрячет окно, которое
  // тем временем открыли снова.
  panelAnimation.finished
    .then(() => {
      if (!opening) buttonEl.style.visibility = "";
      if (onDone) onDone();
      // Закрывающие анимации держат окно сжатым (fill: forwards) — снимаем их,
      // когда оно уже спрятано, чтобы следующее открытие стартовало с чистого листа.
      cancelMorph();
    })
    .catch(() => {});
}

function renderPanel() {
  const lang = getLang();
  const session = getCachedSession();
  // Раскладка — как окно настроек в прототипе редизайна: строки с тонким
  // разделителем сверху, сегментные переключатели языка и масштаба, тумблеры,
  // внизу — опасное действие слева и вход/выход справа. Логика привязана к
  // data-атрибутам (data-lang, data-zoom, data-role, data-action), а не к
  // классам, поэтому классы здесь только про вид.
  panelEl.innerHTML = `
    <div class="settings-header">
      <h2 class="settings-title">${t("settings.title")}</h2>
      <button type="button" class="settings-close" data-action="close" title="${t("settings.close")}"><i class="ph ph-x"></i></button>
    </div>
    ${
      session
        ? `<div class="settings-row settings-account-row">
            <i class="ph ph-user-circle settings-account-icon"></i>
            <span class="settings-label settings-account-email" title="${escapeHtml(session.user.email)}">${escapeHtml(session.user.email)}</span>
          </div>`
        : ""
    }
    <div class="settings-row">
      <span class="settings-label">${t("settings.language")}</span>
      <div class="settings-segment">
        <button type="button" class="settings-segment-btn ${lang === "ru" ? "is-active" : ""}" data-lang="ru">RU</button>
        <button type="button" class="settings-segment-btn ${lang === "en" ? "is-active" : ""}" data-lang="en">EN</button>
        <button type="button" class="settings-segment-btn ${lang === "he" ? "is-active" : ""}" data-lang="he">HE</button>
      </div>
    </div>
    <div class="settings-row">
      <span class="settings-label">${t("settings.uiZoom")}</span>
      <div class="settings-segment">
        ${UI_ZOOM_OPTIONS.map(
          (percent) =>
            `<button type="button" class="settings-segment-btn ${percent === getUiZoom() ? "is-active" : ""}" data-zoom="${percent}">${percent}%</button>`
        ).join("")}
      </div>
    </div>
    <label class="settings-row settings-toggle-row">
      <span class="settings-label">${t("settings.toggleBorders")}</span>
      <input type="checkbox" class="settings-switch" data-role="borders" ${getBorderEnabled() ? "checked" : ""}>
    </label>
    <label class="settings-row settings-toggle-row">
      <span class="settings-label">${t("settings.toggleSaveIndicator")}</span>
      <input type="checkbox" class="settings-switch" data-role="save-indicator" ${getSaveIndicatorEnabled() ? "checked" : ""}>
    </label>
    <div class="settings-row settings-row--last">
      <span class="settings-label">${t("settings.dataTransfer")}</span>
      <div class="settings-io">
        <button type="button" class="settings-link" data-action="export"><i class="ph ph-upload-simple"></i>${t("settings.export")}</button>
        <button type="button" class="settings-link" data-action="import"><i class="ph ph-download-simple"></i>${t("settings.import")}</button>
      </div>
    </div>
    <div class="settings-footer">
      <button type="button" class="btn btn-danger settings-footer-btn" data-action="clear-data">${t("settings.clearData")}</button>
      ${
        session
          ? `<button type="button" class="btn btn-primary settings-footer-btn" data-action="logout">${t("auth.logout")}</button>`
          : `<button type="button" class="btn btn-primary settings-footer-btn" data-action="login">${t("auth.login")}</button>`
      }
    </div>
  `;

  panelEl.querySelectorAll("[data-lang]").forEach((btn) => {
    btn.addEventListener("click", () => {
      if (btn.dataset.lang === getLang()) return;
      setLang(btn.dataset.lang);
      renderPanel();
      buttonEl.title = t("settings.open");
      onLangChangeCallback();
    });
  });

  panelEl.querySelector('[data-action="close"]').addEventListener("click", closePanel);

  panelEl.querySelectorAll("[data-zoom]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const percent = Number(btn.dataset.zoom);
      if (percent === getUiZoom()) return;
      setUiZoom(percent);
      // Через перезагрузку, а не на лету: от масштаба зависят посчитанные при
      // открытии размеры листа, позиции рисунков и фото, место плавающего
      // тулбара. Пересчитывать всё это вживую ради настройки, которую меняют
      // раз в жизни устройства, — много кода и много мест для ошибки.
      location.reload();
    });
  });

  panelEl.querySelector('[data-role="borders"]').addEventListener("change", (event) => {
    setBorderEnabled(event.target.checked);
    applyBorderSetting();
  });

  panelEl.querySelector('[data-role="save-indicator"]').addEventListener("change", (event) => {
    setSaveIndicatorEnabled(event.target.checked);
  });

  panelEl.querySelector('[data-action="export"]').addEventListener("click", runExport);

  panelEl.querySelector('[data-action="import"]').addEventListener("click", runImport);

  panelEl.querySelector('[data-action="clear-data"]').addEventListener("click", async () => {
    closePanel();
    const ok = await openConfirm({ message: t("settings.clearDataConfirm") });
    if (!ok) return;
    await getStorage().clearAll();
    location.reload();
  });

  panelEl.querySelector('[data-action="logout"]')?.addEventListener("click", async () => {
    closePanel();
    await signOut();
    // Явный логаут — единственное, что обязано снова показать экран
    // авторизации при следующей загрузке, даже если раньше был выбран гость.
    clearGuestChosen();
    // Как и при логине — после выхода всегда на главную, а не там, где
    // стояли настройки.
    location.hash = "#/";
    location.reload();
  });

  panelEl.querySelector('[data-action="login"]')?.addEventListener("click", async () => {
    closePanel();
    await openAuthModal();
    if (getCachedSession()) {
      // Владелец может залогиниться из любого раздела — после входа всегда
      // должен оказаться на главной, а не там, где стояли настройки.
      location.hash = "#/";
      location.reload();
    }
  });
}

// Экспорт: открываем дерево «папки → заметки» с галочками и превью. Выбранное
// уходит в файл. Корзина подтягивается отдельно: обычные getFolders/getItems
// её уже не возвращают.
async function runExport() {
  const storage = getStorage();
  const [folders, items, trashedFolders, trashedItems] = await Promise.all([
    storage.getFolders("notes"),
    storage.getItemsWithContent("notes"), // экспорт должен унести полный текст заметок
    storage.getTrashedFolders("notes"),
    storage.getTrashedItems("notes"),
  ]);
  const allFolders = [...folders, ...trashedFolders];
  const allItems = [...items, ...trashedItems];
  if (!allFolders.length && !allItems.length) {
    await openConfirm({ message: t("settings.exportEmpty") });
    return;
  }
  closePanel();
  openTransferPicker({
    mode: "export",
    folders: allFolders,
    items: allItems,
    onConfirm: async ({ folders: pickedFolders, items: pickedItems }) => {
      if (!pickedFolders.length && !pickedItems.length) return;
      const name = await openPrompt({ message: t("settings.exportFilenamePrompt"), defaultValue: "myproj-export" });
      if (!name || !name.trim()) return; // отмена — экспорт не происходит
      const filename = name.trim().endsWith(".json") ? name.trim() : `${name.trim()}.json`;
      // Кружки главной, календарь и теги блоков в дереве выбора не участвуют:
      // кружки берём те, что указывают на выгружаемые заметки, календарь и
      // реестр тегов блоков — целиком.
      const [calendarEntries, calendarTags, blockTags] = await Promise.all([
        storage.getAllCalendarEntries(),
        storage.getCalendarTags(),
        storage.getBlockTags(),
      ]);
      downloadJson(
        buildExportFrom({
          folders: pickedFolders,
          items: pickedItems,
          homeCircles: circlesForItems((await getHomeCirclesState()).circles, pickedItems),
          calendar: { entries: calendarEntries, tags: calendarTags },
          blockTags,
        }),
        filename
      );
    },
  });
}

// Импорт: читаем файл, затем тем же деревом даём выбрать, что именно влить.
// Импортируются только отмеченные папки/заметки.
async function runImport() {
  closePanel();
  let data;
  try {
    data = await readJsonFile();
  } catch {
    await openConfirm({ message: t("settings.importBadFormat") });
    return;
  }
  if (!data) return; // выбор файла отменён
  if (!isValidExport(data)) {
    await openConfirm({ message: t("settings.importBadFormat") });
    return;
  }
  openTransferPicker({
    mode: "import",
    folders: data.folders || [],
    items: data.items,
    onConfirm: async ({ folders, items }) => {
      if (!folders.length && !items.length) return;
      // Дерево выбирает только папки и заметки — кружки, календарь и теги блоков
      // берём из файла как есть. Кружок на невыбранную заметку importData отбросит сам.
      // transferPicker уже закрылся к этому моменту — без оверлея тяжёлый
      // importData (последовательные записи по всем папкам/заметкам) крутится
      // за голым пустым экраном без единого признака, что что-то происходит.
      const hideLoading = showLoadingOverlay();
      try {
        await importData({ folders, items, homeCircles: data.homeCircles, calendar: data.calendar, blockTags: data.blockTags });
      } catch {
        hideLoading();
        // Конфликт имени тега сам по себе больше не валит импорт (см.
        // uniqueTagName в dataTransfer.js) — сюда попадают только настоящие сбои
        // (сеть, квота и т.п.). Общий индикатор сохранения в углу в этот момент
        // уже покажет "Couldn't save" от withSaveStatus — это не специфично для
        // импорта и не объясняет причину, поэтому даём своё, отдельное сообщение.
        await openConfirm({ message: t("settings.importFailed") });
        return;
      }
      // Оверлей нарочно не скрываем на успехе — reload и так сотрёт всё.
      location.reload();
    },
  });
}

/** Класс на body, по которому styles/panels.css убирает рамки панелей. */
export function applyBorderSetting() {
  document.body.classList.toggle("borders-disabled", !getBorderEnabled());
}
