import { t } from "../i18n/i18n.js";

/**
 * Полоска поиска в верхней части экрана. Живёт вне маршрутов и монтируется один
 * раз — как панель настроек (см. mountSettings в src/settings/settingsPanel.js),
 * поэтому при переходе между разделами не пересоздаётся и не теряет введённое.
 */
let barEl = null;
let inputEl = null;
let scopeBtn = null;

// "global" — по всему приложению, "local" — по разделу, в котором находимся.
// На главной локального поиска нет: искать там больше негде.
let scope = "global";
let currentRoute = "home";

export function mountSearch() {
  if (barEl) return;

  barEl = document.createElement("div");
  barEl.className = "search-bar";
  barEl.innerHTML = `
    <div class="search-field">
      <span class="search-icon">⌕</span>
      <input type="text" class="search-input" data-role="search-input">
      <button type="button" class="search-scope" data-role="search-scope"></button>
    </div>
  `;
  document.body.appendChild(barEl);

  inputEl = barEl.querySelector('[data-role="search-input"]');
  scopeBtn = barEl.querySelector('[data-role="search-scope"]');

  // Tab переключает область поиска, а не уводит фокус из поля — так владелец
  // может сменить охват, не отрывая рук от клавиатуры.
  inputEl.addEventListener("keydown", (event) => {
    if (event.key !== "Tab" || event.shiftKey) return;
    event.preventDefault();
    toggleScope();
  });
  scopeBtn.addEventListener("click", () => {
    toggleScope();
    inputEl.focus();
  });

  renderLabels();
}

function toggleScope() {
  if (currentRoute === "home") return; // на главной переключать не на что
  scope = scope === "global" ? "local" : "global";
  renderLabels();
}

/**
 * Роутер сообщает, какой раздел открыт: по умолчанию на главной ищем везде,
 * внутри раздела — по нему одному.
 */
export function refreshSearchScope(route) {
  currentRoute = route;
  scope = route === "home" ? "global" : "local";
  renderLabels();
}

/** Смена языка перерисовывает разделы; подписи полоски обновляем вместе с ними. */
export function renderLabels() {
  if (!barEl) return;
  inputEl.placeholder = t("search.placeholder");
  scopeBtn.textContent = scope === "global" ? t("search.scopeGlobal") : t("search.scopeLocal");
  scopeBtn.title = t("search.scopeHint");
  scopeBtn.disabled = currentRoute === "home";
}
