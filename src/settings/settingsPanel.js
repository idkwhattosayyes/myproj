import { getLang, setLang, t } from "../i18n/i18n.js";
import { getBorderEnabled, setBorderEnabled } from "./borderSetting.js";
import { openConfirm, openPrompt } from "../utils/modal.js";
import { pushLayer } from "../utils/escapeLayers.js";
import { getStorage } from "../data/storageAdapter.js";
import { getCachedSession, signOut, clearGuestChosen } from "../auth/authService.js";
import { openAuthModal } from "../auth/authModal.js";
import { escapeHtml } from "../utils/dom.js";
import { buildExportFrom, circlesForItems, downloadJson, readJsonFile, importData, isValidExport } from "./dataTransfer.js";
import { openTransferPicker } from "./transferPicker.js";
import { getState as getHomeCirclesState } from "../modules/home/customCircles.js";

// Одна шестерёнка в углу вместо россыпи плавающих переключателей: язык,
// обводка панелей и опасное действие "очистить данные" живут в одной панели.
let buttonEl = null;
let panelEl = null;
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

  panelEl = document.createElement("div");
  panelEl.className = "settings-panel";
  panelEl.id = "settings-panel";
  panelEl.hidden = true;

  document.body.append(buttonEl, panelEl);
  renderPanel();
}

function togglePanel() {
  if (panelEl.hidden) openPanel();
  else closePanel();
}

function openPanel() {
  renderPanel();
  panelEl.hidden = false;
  buttonEl.classList.add("is-active");
  unregisterLayer = pushLayer(closePanel);
  // Следующим тиком, иначе слушатель поймает клик, который сам и открыл панель.
  setTimeout(() => document.addEventListener("mousedown", onOutsideMouseDown), 0);
}

function closePanel() {
  if (panelEl.hidden) return;
  panelEl.hidden = true;
  buttonEl.classList.remove("is-active");
  document.removeEventListener("mousedown", onOutsideMouseDown);
  if (unregisterLayer) {
    unregisterLayer();
    unregisterLayer = null;
  }
}

function onOutsideMouseDown(event) {
  if (panelEl.contains(event.target) || buttonEl.contains(event.target)) return;
  closePanel();
}

function renderPanel() {
  const lang = getLang();
  const session = getCachedSession();
  panelEl.innerHTML = `
    <h3 class="settings-title">${t("settings.title")}</h3>
    ${
      session
        ? `<div class="settings-row settings-account-row">
            <span class="settings-label settings-account-email" title="${escapeHtml(session.user.email)}">${escapeHtml(session.user.email)}</span>
          </div>`
        : ""
    }
    <div class="settings-row">
      <span class="settings-label">${t("settings.language")}</span>
      <div class="settings-lang">
        <button type="button" class="settings-lang-btn ${lang === "ru" ? "is-active" : ""}" data-lang="ru">RU</button>
        <button type="button" class="settings-lang-btn ${lang === "en" ? "is-active" : ""}" data-lang="en">EN</button>
        <button type="button" class="settings-lang-btn ${lang === "he" ? "is-active" : ""}" data-lang="he">HE</button>
      </div>
    </div>
    <label class="settings-row">
      <span class="settings-label">${t("settings.toggleBorders")}</span>
      <input type="checkbox" data-role="borders" ${getBorderEnabled() ? "checked" : ""}>
    </label>
    <div class="settings-row">
      <span class="settings-label">${t("settings.dataTransfer")}</span>
      <div class="settings-io">
        <button type="button" class="btn btn-small" data-action="export">${t("settings.export")}</button>
        <button type="button" class="btn btn-small" data-action="import">${t("settings.import")}</button>
      </div>
    </div>
    <button type="button" class="btn btn-danger btn-small settings-clear" data-action="clear-data">${t("settings.clearData")}</button>
    ${
      session
        ? `<button type="button" class="btn btn-danger btn-small settings-clear" data-action="logout">${t("auth.logout")}</button>`
        : `<button type="button" class="btn btn-small settings-clear" data-action="login">${t("auth.login")}</button>`
    }
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

  panelEl.querySelector('[data-role="borders"]').addEventListener("change", (event) => {
    setBorderEnabled(event.target.checked);
    applyBorderSetting();
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
          homeCircles: circlesForItems(getHomeCirclesState().circles, pickedItems),
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
      try {
        await importData({ folders, items, homeCircles: data.homeCircles, calendar: data.calendar, blockTags: data.blockTags });
      } catch {
        // Конфликт имени тега сам по себе больше не валит импорт (см.
        // uniqueTagName в dataTransfer.js) — сюда попадают только настоящие сбои
        // (сеть, квота и т.п.). Общий индикатор сохранения в углу в этот момент
        // уже покажет "Couldn't save" от withSaveStatus — это не специфично для
        // импорта и не объясняет причину, поэтому даём своё, отдельное сообщение.
        await openConfirm({ message: t("settings.importFailed") });
        return;
      }
      location.reload();
    },
  });
}

/** Класс на body, по которому styles/panels.css убирает рамки панелей. */
export function applyBorderSetting() {
  document.body.classList.toggle("borders-disabled", !getBorderEnabled());
}
