import { getLang, setLang, t } from "../i18n/i18n.js";
import { getBorderEnabled, setBorderEnabled } from "./borderSetting.js";
import { openConfirm } from "../utils/modal.js";
import { pushLayer } from "../utils/escapeLayers.js";
import { getStorage } from "../data/storageAdapter.js";

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

  panelEl.querySelector('[data-action="clear-data"]').addEventListener("click", async () => {
    closePanel();
    const ok = await openConfirm({ message: t("settings.clearDataConfirm") });
    if (!ok) return;
    await getStorage().clearAll();
    location.reload();
  });
}

/** Класс на body, по которому styles/panels.css убирает рамки панелей. */
export function applyBorderSetting() {
  document.body.classList.toggle("borders-disabled", !getBorderEnabled());
}
