import { t } from "../i18n/i18n.js";
import { escapeHtml } from "../utils/dom.js";
import { pushLayer } from "../utils/escapeLayers.js";
import { search } from "./searchService.js";
import { setPendingTarget } from "./searchTarget.js";

/**
 * Полоска поиска в верхней части экрана. Живёт вне маршрутов и монтируется один
 * раз — как панель настроек (см. mountSettings в src/settings/settingsPanel.js),
 * поэтому при переходе между разделами не пересоздаётся и не теряет введённое.
 */
let barEl = null;
let inputEl = null;
let scopeBtn = null;
let resultsEl = null;

// "global" — по всему приложению, "local" — по разделу, в котором находимся.
// На главной локального поиска нет: искать там больше негде.
let scope = "global";
let currentRoute = "home";

// Текущие результаты и строки для клавиатуры: каждая строка — это либо заголовок
// группы (переход к первому совпадению), либо конкретное совпадение в тексте.
let groups = [];
let rows = [];
let activeRow = 0;
let searchTimer = null;
let unregisterLayer = null;
let onNavigateCallback = null;

// Сколько совпадений внутри одной группы показано сейчас. Ключ — индекс группы,
// значение — сколько строк раскрыто. Клик по «Ещё совпадений» добавляет по
// EXPAND_STEP. Карта разово живёт для текущего списка: при закрытии поиска и при
// новом запросе очищается, поэтому при повторном открытии список снова свёрнут.
let visibleByGroup = new Map();

// Пауза перед поиском: при быстром наборе не пересчитываем список на каждую букву.
const INPUT_DELAY = 150;
// Сколько совпадений в группе показываем по умолчанию и на сколько раскрываем за клик.
const INITIAL_VISIBLE = 3;
const EXPAND_STEP = 10;

/** @param {{onNavigate: (route: string) => void}} options переход к разделу, где лежит найденное */
export function mountSearch({ onNavigate }) {
  onNavigateCallback = onNavigate;
  if (barEl) return;

  barEl = document.createElement("div");
  barEl.className = "search-bar";
  barEl.innerHTML = `
    <div class="search-topline">
      <div class="search-field">
        <span class="search-icon">⌕</span>
        <input type="text" class="search-input" data-role="search-input">
        <button type="button" class="search-scope" data-role="search-scope"></button>
      </div>
    </div>
    <div class="search-results" data-role="search-results" hidden></div>
  `;
  document.body.appendChild(barEl);

  inputEl = barEl.querySelector('[data-role="search-input"]');
  scopeBtn = barEl.querySelector('[data-role="search-scope"]');
  resultsEl = barEl.querySelector('[data-role="search-results"]');

  inputEl.addEventListener("input", () => scheduleSearch());
  inputEl.addEventListener("focus", () => {
    if (inputEl.value.trim() && !groups.length) scheduleSearch();
  });
  inputEl.addEventListener("keydown", onInputKeydown);
  scopeBtn.addEventListener("click", () => {
    toggleScope();
    inputEl.focus();
  });

  renderLabels();
}

function onInputKeydown(event) {
  // Tab переключает область поиска, а не уводит фокус из поля — так можно
  // сменить охват, не отрывая рук от клавиатуры.
  if (event.key === "Tab" && !event.shiftKey) {
    event.preventDefault();
    toggleScope();
    return;
  }
  if (!rows.length) return;

  if (event.key === "ArrowDown" || event.key === "ArrowUp") {
    event.preventDefault();
    const delta = event.key === "ArrowDown" ? 1 : -1;
    activeRow = (activeRow + delta + rows.length) % rows.length;
    markActiveRow();
    return;
  }
  if (event.key === "Enter") {
    event.preventDefault();
    openRow(activeRow);
  }
}

function toggleScope() {
  if (currentRoute === "home") return; // на главной переключать не на что
  scope = scope === "global" ? "local" : "global";
  renderLabels();
  scheduleSearch();
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

// Какие данные перебирать: "all" — всё, "items" — папки и заметки,
// "calendar" — записи календаря.
function currentScopeKey() {
  if (scope === "global") return "all";
  if (currentRoute === "calendar") return "calendar";
  if (currentRoute === "tasks" || currentRoute === "documents") return "items";
  return "all";
}

function scheduleSearch() {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(runSearch, INPUT_DELAY);
}

async function runSearch() {
  const query = inputEl.value.trim();
  if (!query) {
    closeResults();
    return;
  }
  groups = await search(query, currentScopeKey());
  activeRow = 0;
  // Новый запрос — раскрытие групп сбрасываем: список снова свёрнут.
  visibleByGroup.clear();
  renderResults();
}

// Сколько совпадений группы показываем сейчас (с учётом раскрытия и того, что
// реально собрано в group.matches).
function visibleCount(groupIndex, group) {
  const stored = visibleByGroup.get(groupIndex);
  const wanted = stored === undefined ? INITIAL_VISIBLE : stored;
  return Math.min(wanted, group.matches.length);
}

function renderResults() {
  rows = [];
  const html = groups
    .map((group, groupIndex) => {
      const head = `
        <button type="button" class="search-row search-row--head" data-row="${rows.push({ groupIndex, matchIndex: 0 }) - 1}">
          <span class="search-kind">${kindLabel(group.kind)}</span>
          <span class="search-row-title">${escapeHtml(group.title || t("panel.untitled"))}</span>
          ${group.subtitle ? `<span class="search-row-sub">${escapeHtml(group.subtitle)}</span>` : ""}
        </button>`;

      const visible = visibleCount(groupIndex, group);
      const matches = group.matches
        .slice(0, visible)
        .map(
          (match) => `
        <button type="button" class="search-row search-row--match" data-row="${rows.push({ groupIndex, matchIndex: match.index }) - 1}">
          ${escapeHtml(match.before)}<mark>${escapeHtml(match.hit)}</mark>${escapeHtml(match.after)}
        </button>`
        )
        .join("");

      // Скрытых совпадений: ещё не показанные из собранных + те, что не влезли в
      // потолок сбора (group.moreCount). Пока есть что догрузить (loadable) —
      // подпись кликабельная; если остаток только за потолком — просто текст.
      const loadable = group.matches.length - visible;
      const hidden = loadable + group.moreCount;
      const more = hidden
        ? loadable > 0
          ? `<button type="button" class="search-more" data-more="${groupIndex}">${escapeHtml(t("search.moreMatches").replace("{n}", hidden))}</button>`
          : `<div class="search-more">${escapeHtml(t("search.moreMatches").replace("{n}", hidden))}</div>`
        : "";

      return `<div class="search-group">${head}${matches}${more}</div>`;
    })
    .join("");

  resultsEl.innerHTML = html || `<div class="search-empty">${t("search.nothing")}</div>`;
  resultsEl.querySelectorAll("[data-row]").forEach((btn) => {
    btn.addEventListener("click", () => openRow(Number(btn.dataset.row)));
  });
  // «Ещё совпадений» раскрывает группу на EXPAND_STEP и перерисовывает список.
  // Прокрутку сохраняем, иначе перерисовка через innerHTML вернёт её к началу.
  resultsEl.querySelectorAll("[data-more]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const groupIndex = Number(btn.dataset.more);
      const current = visibleByGroup.get(groupIndex) ?? INITIAL_VISIBLE;
      visibleByGroup.set(groupIndex, current + EXPAND_STEP);
      const keepScroll = resultsEl.scrollTop;
      renderResults();
      resultsEl.scrollTop = keepScroll;
    });
  });
  openResults();
  markActiveRow();
}

function markActiveRow() {
  resultsEl.querySelectorAll("[data-row]").forEach((btn) => {
    const isActive = Number(btn.dataset.row) === activeRow;
    btn.classList.toggle("is-active", isActive);
    if (isActive) btn.scrollIntoView({ block: "nearest" });
  });
}

function openRow(rowIndex) {
  const row = rows[rowIndex];
  if (!row) return;
  const group = groups[row.groupIndex];
  if (!group) return;

  setPendingTarget({
    kind: group.kind,
    id: group.id,
    query: group.query,
    matchIndex: row.matchIndex,
  });
  closeResults();
  // Раздел, где лежит найденное. Задачи и Документы делят данные, поэтому
  // открываем тот раздел, в котором заметка была создана.
  const route = group.kind === "calendar" ? "calendar" : group.section === "tasks" ? "tasks" : "documents";
  onNavigateCallback(route);
}

function openResults() {
  if (!resultsEl.hidden) return;
  resultsEl.hidden = false;
  unregisterLayer = pushLayer(closeResults);
  // Закрываем только по клику, начавшемуся снаружи (соглашение проекта):
  // иначе зажатие кнопки внутри списка с отпусканием вне схлопывало бы его.
  document.addEventListener("mousedown", onOutsideMouseDown);
}

function closeResults() {
  groups = [];
  rows = [];
  // Закрытие поиска сбрасывает раскрытие групп — при следующем открытии список свёрнут.
  visibleByGroup.clear();
  if (resultsEl.hidden) return;
  resultsEl.hidden = true;
  resultsEl.innerHTML = "";
  document.removeEventListener("mousedown", onOutsideMouseDown);
  if (unregisterLayer) {
    unregisterLayer();
    unregisterLayer = null;
  }
}

function onOutsideMouseDown(event) {
  if (barEl.contains(event.target)) return;
  closeResults();
}

function kindLabel(kind) {
  if (kind === "folder") return t("search.kindFolder");
  if (kind === "calendar") return t("search.kindEvent");
  return t("search.kindNote");
}
