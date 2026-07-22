import { getMonthMatrix, todayISO, todayDMY } from "../../utils/date.js";
import { t } from "../../i18n/i18n.js";
import { escapeHtml, escapeAttr, autoGrowTextarea } from "../../utils/dom.js";
import * as calendarEntriesService from "../../services/calendarEntriesService.js";
import * as calendarTagsService from "../../services/calendarTagsService.js";
import { pushLayer, setViewEscape } from "../../utils/escapeLayers.js";

let state = null;

export async function renderCalendarView(container) {
  const now = new Date();
  state = {
    view: "months", // "months" | "month"
    year: now.getFullYear(),
    month: now.getMonth(),
    selectedDate: null,
    dayEntryType: "todo", // "note" | "todo" — какой тип записи создаётся формой ниже
    editingEntryId: null, // id записи, которая сейчас редактируется инлайн в списке
    tags: await calendarTagsService.listTags(),
    selectedTagId: null, // тег, который прикрепится к следующей создаваемой записи
    eventsPanelOpen: false, // сквозной список всех событий слева от календаря
  };
  await render(container);
}

async function render(container) {
  setViewEscape(() => escapeOneLevel(container));
  if (state.view === "months") {
    await renderMonthsView(container);
  } else {
    await renderMonthView(container);
  }
}

// Esc без открытых меню — шаг назад по календарю: список событий -> открытый
// день -> сетка дней -> список месяцев -> главная.
function escapeOneLevel(container) {
  if (state.eventsPanelOpen) {
    state.eventsPanelOpen = false;
    render(container);
    return;
  }
  if (state.view === "month" && state.selectedDate) {
    state.selectedDate = null;
    render(container);
    return;
  }
  if (state.view === "month") {
    state.view = "months";
    render(container);
    return;
  }
  window.location.hash = "#/";
}

async function renderMonthsView(container) {
  const months = t("calendar.months");
  const now = new Date();
  const isCurrentYear = state.year === now.getFullYear();

  container.innerHTML = `
    <a href="#/" class="back-link">${t("nav.backHome")}</a>
    <div class="calendar-with-events ${state.eventsPanelOpen ? "is-open" : ""}">
      <aside class="events-panel" data-role="events-panel"></aside>
      <div class="calendar-main">
        <div class="calendar-today-date">${todayDMY()}</div>
        <div class="months-toolbar">
          <button type="button" class="btn" data-action="prev-year">←</button>
          <h2 class="months-title">${state.year}</h2>
          <button type="button" class="btn" data-action="next-year">→</button>
          <button type="button" class="btn" data-action="toggle-events">☰ ${t("calendar.events")}</button>
        </div>
        <div class="month-circles">
          ${months
            .map(
              (name, index) => `
            <button type="button" class="month-circle ${isCurrentYear && index === now.getMonth() ? "is-current" : ""}" data-month="${index}">
              <span>${name}</span>
            </button>`
            )
            .join("")}
        </div>
      </div>
    </div>
  `;

  wireEventsToggle(container);
  await renderEventsPanel(container);

  container.querySelector('[data-action="prev-year"]').addEventListener("click", () => {
    state.year -= 1;
    render(container);
  });
  container.querySelector('[data-action="next-year"]').addEventListener("click", () => {
    state.year += 1;
    render(container);
  });
  container.querySelectorAll("[data-month]").forEach((btn) => {
    btn.addEventListener("click", () => {
      state.view = "month";
      state.month = Number(btn.dataset.month);
      state.selectedDate = null;
      render(container);
    });
  });
}

async function renderMonthView(container) {
  const days = getMonthMatrix(state.year, state.month);
  const today = todayISO();
  const months = t("calendar.months");
  const weekdays = t("calendar.weekdaysShort");
  state.tags = await calendarTagsService.listTags();
  const summaries = await calendarEntriesService.listDateSummaries(state.tags);

  container.innerHTML = `
    <div class="calendar-nav">
      <a href="#/" class="back-link">${t("nav.backHome")}</a>
      <button type="button" class="back-link back-link--button" data-action="back-to-months">${t("calendar.backToMonths")}</button>
    </div>
    <div class="calendar-with-events ${state.eventsPanelOpen ? "is-open" : ""}">
      <aside class="events-panel" data-role="events-panel"></aside>
      <div class="calendar-main month-view ${state.selectedDate ? "is-day-open" : ""}" data-role="month-view">
        <div class="day-grid-wrap">
          <div class="calendar-today-date">${todayDMY()}</div>
          <div class="calendar-toolbar">
            <button type="button" class="btn" data-action="prev-month">←</button>
            <h2 class="calendar-title">${months[state.month]} ${state.year}</h2>
            <button type="button" class="btn" data-action="next-month">→</button>
            <button type="button" class="btn" data-action="today">${t("calendar.today")}</button>
            <button type="button" class="btn" data-action="toggle-events">☰ ${t("calendar.events")}</button>
          </div>
          <div class="day-weekdays">
            ${weekdays.map((label) => `<div class="day-weekday">${label}</div>`).join("")}
          </div>
          <div class="day-circles">
            ${days
              .map(
                (day) => `
              <button type="button" class="day-circle ${day.inCurrentMonth ? "" : "is-outside"} ${day.iso === today ? "is-today" : ""} ${state.selectedDate === day.iso ? "is-selected" : ""}" data-date="${day.iso}">
                <span class="day-circle-number">${day.date.getDate()}</span>
                ${dayMarkerHtml(summaries.get(day.iso))}
              </button>`
              )
              .join("")}
          </div>
        </div>
        <div class="day-panel" data-role="day-panel"></div>
      </div>
    </div>
  `;

  wireEventsToggle(container);
  await renderEventsPanel(container);

  container.querySelector('[data-action="back-to-months"]').addEventListener("click", () => {
    state.view = "months";
    render(container);
  });
  container.querySelector('[data-action="prev-month"]').addEventListener("click", () => changeMonth(container, -1));
  container.querySelector('[data-action="next-month"]').addEventListener("click", () => changeMonth(container, 1));
  container.querySelector('[data-action="today"]').addEventListener("click", () => {
    const now = new Date();
    state.year = now.getFullYear();
    state.month = now.getMonth();
    state.selectedDate = null;
    render(container);
  });

  container.querySelectorAll("[data-date]").forEach((el) => {
    el.addEventListener("click", () => {
      state.selectedDate = state.selectedDate === el.dataset.date ? null : el.dataset.date;
      render(container);
    });
  });

  await renderDayPanel(container);
}

function changeMonth(container, delta) {
  let month = state.month + delta;
  let year = state.year;
  if (month < 0) {
    month = 11;
    year -= 1;
  } else if (month > 11) {
    month = 0;
    year += 1;
  }
  state.month = month;
  state.year = year;
  state.selectedDate = null;
  render(container);
}

function wireEventsToggle(container) {
  container.querySelector('[data-action="toggle-events"]').addEventListener("click", () => {
    state.eventsPanelOpen = !state.eventsPanelOpen;
    render(container);
  });
}

// Ключ сортировки записи: дата плюс время начала. Записи без времени попадают в
// конец своего дня — точного момента у них нет, но день известен.
function entrySortKey(entry) {
  return `${entry.date} ${entry.startTime || "99:99"}`;
}

function nowSortKey() {
  const now = new Date();
  const pad = (value) => String(value).padStart(2, "0");
  return `${todayISO()} ${pad(now.getHours())}:${pad(now.getMinutes())}`;
}

/**
 * Сквозной список всех событий слева от календаря. Порядок — от ранних к
 * поздним; прошедшие остаются в списке выше, чтобы к ним можно было поднять
 * прокрутку, а ближайшее подсвечено и стоит сразу под последним прошедшим.
 */
async function renderEventsPanel(container, { keepScroll = false } = {}) {
  const panelEl = container.querySelector('[data-role="events-panel"]');
  if (!state.eventsPanelOpen) {
    panelEl.innerHTML = "";
    return;
  }

  // Обновление по ходу правки записи не должно дёргать список: возвращаем ту же
  // прокрутку. К ближайшему событию уводим только при открытии панели.
  const previousScroll = keepScroll ? panelEl.querySelector('[data-role="events-list"]')?.scrollTop : null;

  state.tags = await calendarTagsService.listTags();
  const entries = (await calendarEntriesService.listAll()).sort((a, b) => entrySortKey(a).localeCompare(entrySortKey(b)));
  const nowKey = nowSortKey();
  const nextIndex = entries.findIndex((entry) => entrySortKey(entry) >= nowKey);

  panelEl.innerHTML = `
    <h3 class="events-panel-title">${t("calendar.events")}</h3>
    ${
      entries.length
        ? `<ul class="events-list" data-role="events-list">
             ${entries.map((entry, index) => renderEventRow(entry, index, nextIndex)).join("")}
           </ul>`
        : `<p class="placeholder">${t("calendar.eventsEmpty")}</p>`
    }
  `;

  const listEl = panelEl.querySelector('[data-role="events-list"]');
  if (!listEl) return;

  if (previousScroll != null) {
    listEl.scrollTop = previousScroll;
  } else {
    // Прокручиваем так, чтобы сверху осталось последнее прошедшее событие, а
    // сразу под ним — подсвеченное ближайшее.
    const nextEl = listEl.querySelector(".is-next");
    const anchor = (nextEl && nextEl.previousElementSibling) || nextEl || listEl.lastElementChild;
    if (anchor) listEl.scrollTop = anchor.offsetTop;
  }

  listEl.querySelectorAll("[data-event-date]").forEach((row) => {
    row.addEventListener("click", () => {
      const iso = row.dataset.eventDate;
      const [year, month] = iso.split("-").map(Number);
      state.view = "month";
      state.year = year;
      state.month = month - 1;
      state.selectedDate = iso;
      render(container);
    });
  });
}

function renderEventRow(entry, index, nextIndex) {
  // У заметок текст бывает многострочным: первая строка — название события,
  // остальные показываем ниже мелким шрифтом как дополнительную информацию.
  const [title, ...rest] = (entry.title || "").split("\n");
  const note = rest.join("\n").trim();
  const isPast = nextIndex === -1 || index < nextIndex;
  const time = formatTimeRange(entry);

  return `
    <li class="event-row ${isPast ? "is-past" : ""} ${index === nextIndex ? "is-next" : ""}" data-event-date="${escapeAttr(entry.date)}">
      <div class="event-row-meta">
        <span class="event-row-date">${escapeHtml(formatShortDate(entry.date))}</span>
        ${time ? `<span class="event-row-time">${escapeHtml(time)}</span>` : ""}
        ${entryTagBadge(entry)}
      </div>
      <div class="event-row-title ${entry.done ? "is-done" : ""}">${escapeHtml(title)}</div>
      ${note ? `<div class="event-row-note">${escapeHtml(note)}</div>` : ""}
    </li>`;
}

// В плотном списке дата идёт числами: название месяца в русском требует
// родительного падежа ("13 июля"), а словарь месяцев хранит именительный.
function formatShortDate(iso) {
  const [, month, day] = iso.split("-");
  return `${day}.${month}`;
}

/**
 * Правка записи видна сразу в трёх местах: список дня, маркер на кружке и
 * открытый список всех событий. Последний раньше забывали обновлять, и новая
 * запись появлялась в нём только после сворачивания-разворачивания панели.
 */
async function refreshAfterEntryChange(container) {
  await renderDayPanel(container);
  await refreshDayMarker(container, state.selectedDate);
  await renderEventsPanel(container, { keepScroll: true });
}

async function renderDayPanel(container) {
  const panelEl = container.querySelector('[data-role="day-panel"]');
  // Панель пересоздаётся целиком — открытый создатель тега остался бы висеть
  // в стеке слоёв, указывая на выброшенный DOM-узел.
  closeTagCreator();
  if (!state.selectedDate) {
    panelEl.innerHTML = "";
    return;
  }

  const entries = await calendarEntriesService.listForDate(state.selectedDate);
  // Переключение дня могло оставить editingEntryId висящим на записи, которой
  // здесь больше нет — сбрасываем, иначе список молча не покажет форму правки.
  if (state.editingEntryId && !entries.some((entry) => entry.id === state.editingEntryId)) {
    state.editingEntryId = null;
  }

  panelEl.innerHTML = `
    <div class="day-panel-inner">
      <div class="day-panel-header">
        <h3>${formatDateLabel(state.selectedDate)}</h3>
        <button type="button" class="day-panel-close" data-action="close-day" title="${t("calendar.close")}">✕</button>
      </div>
      <ul class="day-entry-list">
        ${
          entries.length
            ? entries.map((entry) => (entry.id === state.editingEntryId ? renderEditRow(entry) : renderEntryRow(entry))).join("")
            : `<li class="placeholder">${t("calendar.empty")}</li>`
        }
      </ul>
      <div class="day-entry-type-switch">
        <button type="button" class="day-entry-type-btn ${state.dayEntryType === "note" ? "is-active" : ""}" data-entry-type="note">${t("calendar.typeNote")}</button>
        <button type="button" class="day-entry-type-btn ${state.dayEntryType === "todo" ? "is-active" : ""}" data-entry-type="todo">${t("calendar.typeTodo")}</button>
      </div>
      <div class="day-entry-tags" data-role="tag-picker">
        ${renderTagChip(null, t("calendar.noTag"))}
        ${state.tags.map((tag) => renderTagChip(tag.id, tag.name, tag.color)).join("")}
        <button type="button" class="tag-chip tag-chip--new" data-action="new-tag" title="${t("calendar.newTag")}">＋</button>
      </div>
      <div class="tag-creator" data-role="tag-creator" hidden>
        <input type="text" class="tag-name-input" data-role="tag-name" placeholder="${t("calendar.tagName")}">
        <input type="color" class="tag-color-input" data-role="tag-color" value="#33507e">
        <button type="button" class="btn btn-primary btn-small" data-action="save-tag">${t("calendar.tagCreate")}</button>
      </div>
      <form class="day-entry-form" data-role="entry-form" novalidate>
        <div class="day-entry-form-times">
          <label class="day-entry-time-label">
            ${t("calendar.timeFrom")}
            <input type="time" class="day-entry-time" data-role="entry-start">
          </label>
          <label class="day-entry-time-label">
            ${t("calendar.timeTo")}
            <input type="time" class="day-entry-time" data-role="entry-end">
          </label>
        </div>
        ${
          state.dayEntryType === "note"
            ? `<textarea class="day-entry-input day-entry-textarea" placeholder="${t("calendar.addPlaceholder")}" data-role="entry-input"></textarea>`
            : `<input type="text" class="day-entry-input" placeholder="${t("calendar.addPlaceholder")}" data-role="entry-input">`
        }
        <button type="submit" class="btn btn-primary btn-small">${state.dayEntryType === "note" ? t("calendar.save") : t("calendar.add")}</button>
      </form>
    </div>
  `;

  panelEl.querySelector('[data-action="close-day"]').addEventListener("click", () => {
    state.selectedDate = null;
    render(container);
  });

  panelEl.querySelectorAll("[data-entry-type]").forEach((btn) => {
    btn.addEventListener("click", () => {
      state.dayEntryType = btn.dataset.entryType;
      renderDayPanel(container);
    });
  });

  panelEl.querySelectorAll("[data-entry-id]").forEach((row) => {
    const entryId = row.dataset.entryId;

    if (row.classList.contains("day-entry--editing")) {
      row.querySelector('[data-action="save-entry"]').addEventListener("click", async () => {
        const title = row.querySelector('[data-role="edit-title"]').value.trim();
        if (!title) return;
        await calendarEntriesService.updateEntry(entryId, {
          title,
          startTime: row.querySelector('[data-role="edit-start"]').value,
          endTime: row.querySelector('[data-role="edit-end"]').value,
        });
        state.editingEntryId = null;
        await refreshAfterEntryChange(container);
      });
      row.querySelector('[data-action="cancel-edit"]').addEventListener("click", () => {
        state.editingEntryId = null;
        renderDayPanel(container);
      });
      return;
    }

    // У заметок (в отличие от to-do) нет чекбокса — его просто не рендерим.
    const checkbox = row.querySelector('[data-role="entry-check"]');
    if (checkbox) {
      checkbox.addEventListener("change", async (event) => {
        await calendarEntriesService.toggleDone(entryId, event.target.checked);
        await refreshAfterEntryChange(container);
      });
    }
    row.querySelector('[data-role="entry-title"]').addEventListener("click", () => {
      state.editingEntryId = entryId;
      renderDayPanel(container);
    });
    row.querySelector('[data-action="delete-entry"]').addEventListener("click", async () => {
      await calendarEntriesService.deleteEntry(entryId);
      await refreshAfterEntryChange(container);
    });
  });

  // Note (textarea): Enter = перенос строки, добавление кнопкой. To-do (input):
  // Enter отправляет форму нативно. Поэтому отдельный keydown-перехват не нужен.
  // Многострочные поля растут вниз вместе с текстом — и в форме, и в правке.
  panelEl.querySelectorAll("textarea").forEach(autoGrowTextarea);
  wireTagPicker(panelEl, container);

  panelEl.querySelector('[data-role="entry-form"]').addEventListener("submit", async (event) => {
    event.preventDefault();
    const input = panelEl.querySelector('[data-role="entry-input"]');
    const startInput = panelEl.querySelector('[data-role="entry-start"]');
    const endInput = panelEl.querySelector('[data-role="entry-end"]');
    const title = input.value.trim();
    if (!title) return;
    await calendarEntriesService.createEntry(state.selectedDate, {
      title,
      type: state.dayEntryType,
      startTime: startInput.value,
      endTime: endInput.value,
      tagId: state.selectedTagId,
    });
    input.value = "";
    startInput.value = "";
    endInput.value = "";
    state.selectedTagId = null;
    await refreshAfterEntryChange(container);
  });
}

// Выбор тега и создание нового делаем без полного re-render, чтобы не терять
// уже введённый текст записи. Обновляем DOM точечно.
function wireTagPicker(panelEl, container) {
  const picker = panelEl.querySelector('[data-role="tag-picker"]');
  const creator = panelEl.querySelector('[data-role="tag-creator"]');

  picker.querySelectorAll("[data-tag-id]").forEach((chip) => {
    chip.addEventListener("click", () => {
      state.selectedTagId = chip.dataset.tagId || null;
      picker.querySelectorAll("[data-tag-id]").forEach((c) => c.classList.remove("is-selected"));
      chip.classList.add("is-selected");
    });
  });

  picker.querySelector('[data-action="new-tag"]').addEventListener("click", () => {
    if (creator.hidden) openTagCreator(creator);
    else closeTagCreator();
  });

  creator.querySelector('[data-action="save-tag"]').addEventListener("click", async () => {
    const name = creator.querySelector('[data-role="tag-name"]').value.trim();
    const color = creator.querySelector('[data-role="tag-color"]').value;
    if (!name) return;
    const tag = await calendarTagsService.createTag({ name, color });
    state.tags.push(tag);
    state.selectedTagId = tag.id;
    // Вставляем новый чип перед кнопкой "＋" и помечаем выбранным, не перерисовывая панель.
    const newChipBtn = picker.querySelector('[data-action="new-tag"]');
    newChipBtn.insertAdjacentHTML("beforebegin", renderTagChip(tag.id, tag.name, tag.color, true));
    picker.querySelectorAll("[data-tag-id]").forEach((c) => c.classList.remove("is-selected"));
    const inserted = picker.querySelector(`[data-tag-id="${tag.id}"]`);
    inserted.classList.add("is-selected");
    inserted.addEventListener("click", () => {
      state.selectedTagId = tag.id;
      picker.querySelectorAll("[data-tag-id]").forEach((c) => c.classList.remove("is-selected"));
      inserted.classList.add("is-selected");
    });
    creator.querySelector('[data-role="tag-name"]').value = "";
    closeTagCreator();
  });
}

// Создатель тега — раскрывающееся мини-меню внутри панели дня, поэтому он тоже
// закрывается по Esc (раньше, чем Esc уводит на уровень назад по календарю).
let openCreatorEl = null;
let unregisterCreatorLayer = null;

function openTagCreator(creator) {
  closeTagCreator();
  creator.hidden = false;
  creator.querySelector('[data-role="tag-name"]').focus();
  openCreatorEl = creator;
  unregisterCreatorLayer = pushLayer(closeTagCreator);
}

function closeTagCreator() {
  if (openCreatorEl) {
    openCreatorEl.hidden = true;
    openCreatorEl = null;
  }
  if (unregisterCreatorLayer) {
    unregisterCreatorLayer();
    unregisterCreatorLayer = null;
  }
}

async function refreshDayMarker(container, iso) {
  const dayEl = container.querySelector(`[data-date="${iso}"]`);
  if (!dayEl) return;
  const entries = await calendarEntriesService.listForDate(iso);
  const colors = entries
    .map((e) => (state.tags.find((tag) => tag.id === e.tagId) || {}).color)
    .filter(Boolean);
  const summary = entries.length ? { count: entries.length, colors } : null;

  const existing = dayEl.querySelector(".day-circle-marker");
  if (existing) existing.remove();
  const html = dayMarkerHtml(summary);
  if (html) dayEl.insertAdjacentHTML("beforeend", html);
}

// Маркер на кружке дня: если записей больше одной — число; если ровно одна —
// точка цвета её тега (или дефолтная, если тега нет); если записей нет — ничего.
function dayMarkerHtml(summary) {
  if (!summary || summary.count === 0) return "";
  if (summary.count > 1) {
    return `<span class="day-circle-marker day-circle-marker--count">${summary.count}</span>`;
  }
  const color = summary.colors[0];
  return `<span class="day-circle-marker"${color ? ` style="background:${escapeAttr(color)}"` : ""}></span>`;
}

// Цветной чип тега в форме дня; selected — начальное состояние выбора.
function renderTagChip(tagId, name, color, selected = false) {
  const isSelected = selected || (tagId ?? null) === state.selectedTagId;
  const style = color ? ` style="--tag-color:${escapeAttr(color)}"` : "";
  return `<button type="button" class="tag-chip ${isSelected ? "is-selected" : ""}" data-tag-id="${tagId ?? ""}"${style}>${escapeHtml(name)}</button>`;
}

// Метка тега рядом с текстом записи в списке дня.
function entryTagBadge(entry) {
  if (!entry.tagId) return "";
  const tag = state.tags.find((tg) => tg.id === entry.tagId);
  if (!tag) return "";
  return `<span class="day-entry-tag" style="background:${escapeAttr(tag.color)}">${escapeHtml(tag.name)}</span>`;
}

function renderEntryRow(entry) {
  return `
    <li class="day-entry ${entry.done ? "is-done" : ""}" data-entry-id="${entry.id}">
      ${entry.type === "note" ? "" : `<input type="checkbox" data-role="entry-check" ${entry.done ? "checked" : ""}>`}
      ${entry.startTime || entry.endTime ? `<span class="day-entry-time-range">${escapeHtml(formatTimeRange(entry))}</span>` : ""}
      ${entryTagBadge(entry)}
      <span class="day-entry-title" data-role="entry-title" title="${t("calendar.editEntry")}">${escapeHtml(entry.title)}</span>
      <button type="button" class="day-entry-delete" data-action="delete-entry" title="${t("panel.delete")}">✕</button>
    </li>`;
}

// Инлайн-форма правки — та же строка списка, только с полями вместо текста;
// тип записи (note/todo) при правке не меняется, редактируются лишь текст и время.
// Для заметки поле — textarea (многострочный текст), для to-do — однострочный input.
function renderEditRow(entry) {
  const titleField =
    entry.type === "note"
      ? `<textarea class="day-entry-edit-input day-entry-textarea" data-role="edit-title">${escapeHtml(entry.title)}</textarea>`
      : `<input type="text" class="day-entry-edit-input" data-role="edit-title" value="${escapeAttr(entry.title)}">`;
  return `
    <li class="day-entry day-entry--editing" data-entry-id="${entry.id}">
      <input type="time" class="day-entry-time" data-role="edit-start" value="${escapeAttr(entry.startTime || "")}">
      <input type="time" class="day-entry-time" data-role="edit-end" value="${escapeAttr(entry.endTime || "")}">
      ${titleField}
      <button type="button" class="btn btn-primary btn-small" data-action="save-entry">${t("calendar.save")}</button>
      <button type="button" class="btn btn-small" data-action="cancel-edit">${t("modal.cancel")}</button>
    </li>`;
}

function formatTimeRange(entry) {
  if (entry.startTime && entry.endTime) return `${entry.startTime}–${entry.endTime}`;
  return entry.startTime || entry.endTime;
}

function formatDateLabel(iso) {
  const [year, month, day] = iso.split("-").map(Number);
  const months = t("calendar.months");
  return `${day} ${months[month - 1]} ${year}`;
}
