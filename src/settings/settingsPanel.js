import { getLang, setLang, t } from "../i18n/i18n.js";
import { getBorderEnabled, setBorderEnabled } from "./borderSetting.js";
import { openConfirm } from "../utils/modal.js";
import { pushLayer } from "../utils/escapeLayers.js";
import { getStorage } from "../data/storageAdapter.js";
import { showContextMenu } from "../modules/shared/contextMenu.js";
import { buildExport, downloadJson, readJsonFile, importData, isValidExport } from "./dataTransfer.js";
import { escapeHtml } from "../utils/dom.js";

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
  panelEl.innerHTML = `
    <h3 class="settings-title">${t("settings.title")}</h3>
    <div class="settings-row">
      <span class="settings-label">${t("settings.language")}</span>
      <div class="settings-lang">
        <button type="button" class="settings-lang-btn ${lang === "ru" ? "is-active" : ""}" data-lang="ru">RU</button>
        <button type="button" class="settings-lang-btn ${lang === "en" ? "is-active" : ""}" data-lang="en">EN</button>
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

  panelEl.querySelector('[data-action="export"]').addEventListener("click", (event) => {
    openExportMenu(event.clientX, event.clientY);
  });

  panelEl.querySelector('[data-action="import"]').addEventListener("click", runImport);

  panelEl.querySelector('[data-action="clear-data"]').addEventListener("click", async () => {
    closePanel();
    const ok = await openConfirm({ message: t("settings.clearDataConfirm") });
    if (!ok) return;
    await getStorage().clearAll();
    location.reload();
  });
}

// Экспорт: сначала выбор охвата (всё / папка / заметка), затем — при выборе
// папки или заметки — второе меню с их списком. Имена пользовательские, поэтому
// экранируем: showContextMenu вставляет label как HTML.
async function openExportMenu(x, y) {
  const storage = getStorage();
  const folders = await storage.getFolders("tasks");
  const items = await storage.getItems("tasks");

  showContextMenu(x, y, [
    { label: t("settings.exportScopeAll"), onClick: () => doExport({ kind: "all" }) },
    // Второе меню открываем следующим тиком: иначе клик по этому пункту всплывёт
    // к document и обработчик внешнего клика первого меню закроет только что
    // открытое подменю.
    { label: t("settings.exportScopeFolder"), onClick: () => setTimeout(() => openEntityMenu(x, y, folders, "name", (f) => doExport({ kind: "folder", id: f.id })), 0) },
    { label: t("settings.exportScopeItem"), onClick: () => setTimeout(() => openEntityMenu(x, y, items, "title", (i) => doExport({ kind: "item", id: i.id })), 0) },
  ]);
}

function openEntityMenu(x, y, entities, labelField, onPick) {
  if (!entities.length) {
    showContextMenu(x, y, [{ label: t("settings.exportEmpty"), onClick: () => {} }]);
    return;
  }
  showContextMenu(
    x,
    y,
    entities.map((entity) => ({
      label: escapeHtml(entity[labelField] || t("panel.untitled")),
      onClick: () => onPick(entity),
    })),
  );
}

async function doExport(scope) {
  const data = await buildExport(scope);
  if (!data.folders.length && !data.items.length) {
    await openConfirm({ message: t("settings.exportEmpty") });
    return;
  }
  downloadJson(data, "myproj-export.json");
}

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
  const counts = `${(data.folders || []).length} / ${data.items.length}`;
  const ok = await openConfirm({ message: `${t("settings.importConfirm")} (${counts})` });
  if (!ok) return;
  await importData(data);
  location.reload();
}

/** Класс на body, по которому styles/panels.css убирает рамки панелей. */
export function applyBorderSetting() {
  document.body.classList.toggle("borders-disabled", !getBorderEnabled());
}
