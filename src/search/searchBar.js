import { t } from "../i18n/i18n.js";
import { escapeHtml } from "../utils/dom.js";
import { pushLayer } from "../utils/escapeLayers.js";
import { search } from "./searchService.js";
import { setPendingTarget } from "./searchTarget.js";
import { openBlockTagsBrowser, LAST_FILTER_KEY } from "../modules/shared/blockTagsBrowser.js";
import * as blockTagsService from "../services/blockTagsService.js";

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

// Режим выбора цели для внутренней ссылки (см. openLinkPicker) — та же полоска
// поиска, но клик по результату не переходит к нему, а возвращает выбор вызывающему
// коду (richTextEditor.js). pickerResolve — резолвер промиса, отданного наружу.
let pickerActive = false;
let pickerResolve = null;
let pickerUnregisterLayer = null;

// Текущие результаты и строки для клавиатуры: каждая строка — это либо заголовок
// группы (переход к первому совпадению), либо конкретное совпадение в тексте.
let groups = [];
let rows = [];
let activeRow = 0;
let searchTimer = null;
let unregisterLayer = null;
let onNavigateCallback = null;

// Режим тегов: ввод "#" в строку поиска показывает чипы тегов вместо обычных
// результатов (см. renderTagSuggestions). selectedViaPlus — теги, набранные
// через "+" на чипах-предложениях (ТЗ п.9: несколько тегов + Enter — открывает
// браузер сразу со всеми). allTags — кэш реестра на сессию тег-режима, чтобы
// не дёргать сервис на каждую напечатанную букву после "#".
let selectedViaPlus = [];
let allTags = null;

// "Билет" последнего вызова renderTagSuggestions — см. комментарий внутри неё.
let tagRenderToken = 0;

function hasHashToken(value) {
  return value.includes("#");
}

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
      <button type="button" class="search-tags-open" data-role="tags-open" title="${t("blockBrowser.openMenu")}">#tags</button>
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
  const tagsOpenBtn = barEl.querySelector('[data-role="tags-open"]');
  // Пустой фильтр — если ни разу не открывали или после Clear all (см. Step 6:
  // extractTaggedBlocks на пустом requiredTagIds теперь и есть "все блоки").
  tagsOpenBtn.addEventListener("click", () => {
    const stored = JSON.parse(localStorage.getItem(LAST_FILTER_KEY) || "[]");
    openBlockTagsBrowser(stored);
  });

  inputEl.addEventListener("input", () => {
    if (hasHashToken(inputEl.value)) renderTagSuggestions();
    else scheduleSearch();
  });
  inputEl.addEventListener("focus", () => {
    if (hasHashToken(inputEl.value)) renderTagSuggestions();
    else if (inputEl.value.trim() && !groups.length) scheduleSearch();
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
  // Несколько тегов набраны через "+" (см. renderTagSuggestions) — Enter
  // открывает браузер сразу со всеми, независимо от текущего незавершённого
  // "#..."-токена. Проверяем раньше общего "!rows.length return": в тег-режиме
  // rows пуст (это не обычные результаты), и без этой ветки Enter молча
  // проглатывался бы тем гвардом.
  if (event.key === "Enter" && selectedViaPlus.length) {
    event.preventDefault();
    const tagIds = selectedViaPlus.map((tag) => tag.id);
    closeResults();
    selectedViaPlus = [];
    inputEl.value = "";
    openBlockTagsBrowser(tagIds);
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
  if (currentRoute === "home" || pickerActive) return; // на главной переключать не на что, в режиме выбора — незачем
  scope = scope === "global" ? "local" : "global";
  renderLabels();
  scheduleSearch();
}

/**
 * Роутер сообщает, какой раздел открыт: по умолчанию на главной ищем везде,
 * внутри раздела — по нему одному. Переход в другой раздел прерывает
 * незавершённый выбор цели ссылки — заметка, из которой его начали, уже не
 * на экране.
 */
export function refreshSearchScope(route) {
  if (pickerActive) finishPicker(null);
  currentRoute = route;
  scope = route === "home" ? "global" : "local";
  renderLabels();
}

/** Смена языка перерисовывает разделы; подписи полоски обновляем вместе с ними. */
export function renderLabels() {
  if (!barEl) return;
  inputEl.placeholder = pickerActive ? t("search.pickNotePlaceholder") : t("search.placeholder");
  scopeBtn.textContent = scope === "global" ? t("search.scopeGlobal") : t("search.scopeLocal");
  scopeBtn.title = t("search.scopeHint");
  scopeBtn.disabled = currentRoute === "home" || pickerActive;
}

// Какие данные перебирать: "all" — всё, "items" — папки и заметки,
// "calendar" — записи календаря. В режиме выбора цели ссылки — только
// заметки, папки и записи календаря ссылкой быть не могут.
function currentScopeKey() {
  if (pickerActive) return "items";
  if (scope === "global") return "all";
  if (currentRoute === "calendar") return "calendar";
  if (currentRoute === "notes") return "items";
  return "all";
}

function scheduleSearch() {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(runSearch, INPUT_DELAY);
}

// Ввод "#" переключает выпадашку с обычных результатов на чипы тегов (ТЗ п.8).
// Активный токен — то, что идёт после ПОСЛЕДНЕГО "#" в поле; предыдущие
// куски (если "#" было несколько без "+") текстом не считаются, единственный
// способ набрать несколько тегов — кнопка "+" на чипе-предложении (см. ниже).
async function renderTagSuggestions() {
  // Первой строкой: иначе ранее запланированный runSearch() от ввода ДО "#"
  // сработает позже и перезапишет resultsEl.innerHTML обратно обычными
  // результатами поверх уже нарисованных чипов — гонка, которую иначе трудно
  // поймать глазами (проявляется только при быстром наборе).
  clearTimeout(searchTimer);
  groups = [];
  rows = [];
  activeRow = 0;

  // При печати каждая буква после "#" зовёт эту функцию заново, а она async:
  // на await ниже более ранний вызов может отдать управление и дорисоваться
  // ПОСЛЕ более позднего — устаревшими чипами поверх актуальных (не
  // гипотетически: allTags не всегда уже в кэше, await реально может
  // растянуться на несколько кадров при первом "#" в сессии). tagRenderToken —
  // "билет": вызов, переставший быть последним, узнаёт об этом сразу после
  // await и не имеет права трогать DOM.
  const myToken = ++tagRenderToken;

  if (!allTags) allTags = await blockTagsService.listTags();
  if (myToken !== tagRenderToken) return;

  const token = inputEl.value.slice(inputEl.value.lastIndexOf("#") + 1).trim().toLowerCase();
  const suggestions = allTags.filter(
    (tag) => tag.nameKey.includes(token) && !selectedViaPlus.some((t) => t.id === tag.id)
  );

  const selectedRow = selectedViaPlus
    .map(
      (tag) => `
    <span class="search-tag-chip search-tag-chip--selected" style="--tag-color:${tag.color}" data-tag-id="${tag.id}">
      #${escapeHtml(tag.name)}
      <button type="button" class="search-tag-chip-remove" data-tag-id="${tag.id}" title="${t("blockBrowser.removeFilter")}">✕</button>
    </span>`
    )
    .join("");
  const suggestedRow = suggestions
    .map(
      (tag) => `
    <span class="search-tag-chip" style="--tag-color:${tag.color}" data-tag-id="${tag.id}">
      <button type="button" class="search-tag-chip-name" data-tag-id="${tag.id}">#${escapeHtml(tag.name)}</button>
      <button type="button" class="search-tag-chip-plus" data-tag-id="${tag.id}" title="${t("blockBrowser.addFilter")}">+</button>
    </span>`
    )
    .join("");

  resultsEl.innerHTML = `<div class="search-tag-row">${selectedRow}${suggestedRow}</div>`;

  resultsEl.querySelectorAll(".search-tag-chip-remove").forEach((btn) => {
    btn.addEventListener("click", () => {
      selectedViaPlus = selectedViaPlus.filter((tag) => tag.id !== btn.dataset.tagId);
      renderTagSuggestions();
    });
  });
  resultsEl.querySelectorAll(".search-tag-chip-plus").forEach((btn) => {
    btn.addEventListener("click", (event) => {
      // Не даём клику по "+" всплыть до самого чипа — иначе сработал бы ещё и
      // переход в браузер, который вешается на chip-name отдельно.
      event.stopPropagation();
      const tag = allTags.find((t) => t.id === btn.dataset.tagId);
      if (tag) selectedViaPlus.push(tag);
      // Обрезаем ДО "#" включительно — режим остаётся активным, поле готово
      // принимать имя следующего тега сразу после того же "#".
      inputEl.value = inputEl.value.slice(0, inputEl.value.lastIndexOf("#") + 1);
      renderTagSuggestions();
    });
  });
  resultsEl.querySelectorAll(".search-tag-chip-name").forEach((btn) => {
    btn.addEventListener("click", () => {
      const tagIds = [...selectedViaPlus.map((t) => t.id), btn.dataset.tagId];
      closeResults();
      selectedViaPlus = [];
      inputEl.value = "";
      openBlockTagsBrowser(tagIds);
    });
  });

  openResults();
}

async function runSearch() {
  const query = inputEl.value.trim();
  if (!query) {
    closeResults();
    return;
  }
  groups = await search(query, currentScopeKey());
  if (pickerActive) {
    // Папка — не цель для ссылки; фото-совпадения не годятся в matchIndex
    // (findOccurrenceRange в richTextEditor.js ищет обычный текст, а не фото).
    // photoIndex может быть 0, поэтому проверяем именно на undefined.
    groups = groups
      .filter((group) => group.kind === "item")
      .map((group) => ({ ...group, matches: group.matches.filter((match) => match.photoIndex === undefined) }));
  }
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
        .map((match) => {
          // Фото нигде не отображается в тексте заметки — совпадение по нему
          // помечаем бейджем, чтобы было видно, что это не текст. Признак —
          // photoIndex (может быть 0, поэтому проверка именно на undefined),
          // а не photoName — у безымянного фото имени нет, но это всё равно фото.
          const isPhoto = match.photoIndex !== undefined;
          const badge = isPhoto ? `<span class="search-kind">${t("search.kindPhoto")}</span>` : "";
          // У безымянного фото hit пуст — подставляем плейсхолдер вместо него.
          const hit = match.hit || (isPhoto ? t("search.photoUnnamed") : "");
          const row = rows.push({ groupIndex, matchIndex: match.index, photoIndex: match.photoIndex }) - 1;
          return `
        <button type="button" class="search-row search-row--match" data-row="${row}">
          ${badge}${escapeHtml(match.before)}<mark>${escapeHtml(hit)}</mark>${escapeHtml(match.after)}
        </button>`;
        })
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

  if (pickerActive) {
    finishPicker({ itemId: group.id, query: group.query, matchIndex: row.matchIndex });
    return;
  }

  setPendingTarget({
    kind: group.kind,
    id: group.id,
    query: group.query,
    matchIndex: row.matchIndex,
    photoIndex: row.photoIndex,
  });
  closeResults();
  const route = group.kind === "calendar" ? "calendar" : "notes";
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
  selectedViaPlus = [];
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

/**
 * Режим выбора цели для внутренней ссылки: та же полоска поиска, но клик по
 * результату не переходит к нему, а резолвит промис вызывающему коду
 * (richTextEditor.js — привязка ссылки к исходному выделенному слову).
 * @returns {Promise<{itemId: string, query: string, matchIndex: number} | null>}
 */
export function openLinkPicker() {
  if (pickerActive) finishPicker(null); // не даём повторному вызову подвесить прошлый промис навсегда
  return new Promise((resolve) => {
    pickerResolve = resolve;
    pickerActive = true;
    inputEl.value = "";
    closeResults();
    renderLabels();
    inputEl.focus();
    // Регистрируем сразу, а не лениво при первых результатах — иначе Esc и
    // клик мимо не сработают, пока пользователь ещё не начал печатать.
    pickerUnregisterLayer = pushLayer(() => finishPicker(null));
    document.addEventListener("mousedown", onPickerOutsideMouseDown);
  });
}

function onPickerOutsideMouseDown(event) {
  if (barEl.contains(event.target)) return;
  finishPicker(null);
}

// Идемпотентна: и Esc-слой, и клик мимо, и повторный openLinkPicker могут
// теоретически столкнуться друг с другом — второй вызов должен быть no-op.
function finishPicker(result) {
  if (!pickerActive) return;
  pickerActive = false;
  const resolve = pickerResolve;
  pickerResolve = null;
  if (pickerUnregisterLayer) {
    pickerUnregisterLayer();
    pickerUnregisterLayer = null;
  }
  document.removeEventListener("mousedown", onPickerOutsideMouseDown);
  closeResults();
  renderLabels();
  if (resolve) resolve(result);
}

function kindLabel(kind) {
  if (kind === "folder") return t("search.kindFolder");
  if (kind === "calendar") return t("search.kindEvent");
  return t("search.kindNote");
}
