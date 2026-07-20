import { getMonthMatrix, todayISO, todayDMY } from "../../utils/date.js";
import { t } from "../../i18n/i18n.js";
import { escapeHtml } from "../../utils/dom.js";
import * as calendarEntriesService from "../../services/calendarEntriesService.js";

let state = null;

export async function renderCalendarView(container) {
  const now = new Date();
  state = {
    view: "months", // "months" | "month"
    year: now.getFullYear(),
    month: now.getMonth(),
    selectedDate: null,
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

  panelEl.innerHTML = `
    <div class="day-panel-inner">
      <div class="day-panel-header">
        <h3>${formatDateLabel(state.selectedDate)}</h3>
        <button type="button" class="day-panel-close" data-action="close-day" title="${t("calendar.close")}">✕</button>
      </div>
      <ul class="day-entry-list">
        ${
          entries.length
            ? entries
                .map(
                  (entry) => `
          <li class="day-entry ${entry.done ? "is-done" : ""}" data-entry-id="${entry.id}">
            <input type="checkbox" data-role="entry-check" ${entry.done ? "checked" : ""}>
            ${entry.startTime || entry.endTime ? `<span class="day-entry-time-range">${escapeHtml(formatTimeRange(entry))}</span>` : ""}
            <span class="day-entry-title">${escapeHtml(entry.title)}</span>
            <button type="button" class="day-entry-delete" data-action="delete-entry" title="${t("panel.delete")}">✕</button>
          </li>`
                )
                .join("")
            : `<li class="placeholder">${t("calendar.empty")}</li>`
        }
      </ul>
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
        <button type="submit" class="btn btn-primary btn-small">${t("calendar.add")}</button>
      </form>
    </div>
  `;

  panelEl.querySelector('[data-action="close-day"]').addEventListener("click", () => {
    state.selectedDate = null;
    render(container);
  });

  panelEl.querySelectorAll("[data-entry-id]").forEach((row) => {
    const entryId = row.dataset.entryId;
    row.querySelector('[data-role="entry-check"]').addEventListener("change", async (event) => {
      await calendarEntriesService.toggleDone(entryId, event.target.checked);
      renderDayPanel(container);
    });
    row.querySelector('[data-action="delete-entry"]').addEventListener("click", async () => {
      await calendarEntriesService.deleteEntry(entryId);
      await renderDayPanel(container);
      await refreshDayMarker(container, state.selectedDate);
    });
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

function formatTimeRange(entry) {
  if (entry.startTime && entry.endTime) return `${entry.startTime}–${entry.endTime}`;
  return entry.startTime || entry.endTime;
}

function formatDateLabel(iso) {
  const [year, month, day] = iso.split("-").map(Number);
  const months = t("calendar.months");
  return `${day} ${months[month - 1]} ${year}`;
}
