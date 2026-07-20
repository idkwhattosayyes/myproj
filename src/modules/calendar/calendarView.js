import { getMonthMatrix, todayISO, todayDMY } from "../../utils/date.js";
import { t } from "../../i18n/i18n.js";
import { escapeHtml, escapeAttr } from "../../utils/dom.js";
import * as calendarEntriesService from "../../services/calendarEntriesService.js";

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
  };
  await render(container);
}

async function render(container) {
  if (state.view === "months") {
    renderMonthsView(container);
  } else {
    await renderMonthView(container);
  }
}

function renderMonthsView(container) {
  const months = t("calendar.months");
  const now = new Date();
  const isCurrentYear = state.year === now.getFullYear();

  container.innerHTML = `
    <a href="#/" class="back-link">${t("nav.backHome")}</a>
    <div class="calendar-today-date">${todayDMY()}</div>
    <div class="months-toolbar">
      <button type="button" class="btn" data-action="prev-year">←</button>
      <h2 class="months-title">${state.year}</h2>
      <button type="button" class="btn" data-action="next-year">→</button>
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
  `;

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
  const markedDates = new Set(await calendarEntriesService.listAllDates());

  container.innerHTML = `
    <div class="calendar-nav">
      <a href="#/" class="back-link">${t("nav.backHome")}</a>
      <button type="button" class="back-link back-link--button" data-action="back-to-months">${t("calendar.backToMonths")}</button>
    </div>
    <div class="month-view ${state.selectedDate ? "is-day-open" : ""}" data-role="month-view">
      <div class="day-grid-wrap">
        <div class="calendar-today-date">${todayDMY()}</div>
        <div class="calendar-toolbar">
          <button type="button" class="btn" data-action="prev-month">←</button>
          <h2 class="calendar-title">${months[state.month]} ${state.year}</h2>
          <button type="button" class="btn" data-action="next-month">→</button>
          <button type="button" class="btn" data-action="today">${t("calendar.today")}</button>
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
              ${markedDates.has(day.iso) ? '<span class="day-circle-marker"></span>' : ""}
            </button>`
            )
            .join("")}
        </div>
      </div>
      <div class="day-panel" data-role="day-panel"></div>
    </div>
  `;

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

async function renderDayPanel(container) {
  const panelEl = container.querySelector('[data-role="day-panel"]');
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
        <input type="text" class="day-entry-input" placeholder="${t("calendar.addPlaceholder")}" data-role="entry-input">
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
        await renderDayPanel(container);
        await refreshDayMarker(container, state.selectedDate);
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
        renderDayPanel(container);
      });
    }
    row.querySelector('[data-role="entry-title"]').addEventListener("click", () => {
      state.editingEntryId = entryId;
      renderDayPanel(container);
    });
    row.querySelector('[data-action="delete-entry"]').addEventListener("click", async () => {
      await calendarEntriesService.deleteEntry(entryId);
      await renderDayPanel(container);
      await refreshDayMarker(container, state.selectedDate);
    });
  });

  const titleInput = panelEl.querySelector('[data-role="entry-input"]');
  // Заметка добавляется только явной кнопкой — Enter в поле названия не должен
  // отправлять форму, в отличие от To-do, где Enter — обычный быстрый способ добавить пункт.
  titleInput.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && state.dayEntryType === "note") {
      event.preventDefault();
    }
  });

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
    });
    input.value = "";
    startInput.value = "";
    endInput.value = "";
    await renderDayPanel(container);
    await refreshDayMarker(container, state.selectedDate);
  });
}

async function refreshDayMarker(container, iso) {
  const dayEl = container.querySelector(`[data-date="${iso}"]`);
  if (!dayEl) return;
  const entries = await calendarEntriesService.listForDate(iso);
  const hasEntries = entries.length > 0;
  let marker = dayEl.querySelector(".day-circle-marker");
  if (hasEntries && !marker) {
    marker = document.createElement("span");
    marker.className = "day-circle-marker";
    dayEl.appendChild(marker);
  } else if (!hasEntries && marker) {
    marker.remove();
  }
}

function renderEntryRow(entry) {
  return `
    <li class="day-entry ${entry.done ? "is-done" : ""}" data-entry-id="${entry.id}">
      ${entry.type === "note" ? "" : `<input type="checkbox" data-role="entry-check" ${entry.done ? "checked" : ""}>`}
      ${entry.startTime || entry.endTime ? `<span class="day-entry-time-range">${escapeHtml(formatTimeRange(entry))}</span>` : ""}
      <span class="day-entry-title" data-role="entry-title" title="${t("calendar.editEntry")}">${escapeHtml(entry.title)}</span>
      <button type="button" class="day-entry-delete" data-action="delete-entry" title="${t("panel.delete")}">✕</button>
    </li>`;
}

// Инлайн-форма правки — та же строка списка, только с полями вместо текста;
// тип записи (note/todo) при правке не меняется, редактируются лишь текст и время.
function renderEditRow(entry) {
  return `
    <li class="day-entry day-entry--editing" data-entry-id="${entry.id}">
      <input type="time" class="day-entry-time" data-role="edit-start" value="${escapeAttr(entry.startTime || "")}">
      <input type="time" class="day-entry-time" data-role="edit-end" value="${escapeAttr(entry.endTime || "")}">
      <input type="text" class="day-entry-edit-input" data-role="edit-title" value="${escapeAttr(entry.title)}">
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
