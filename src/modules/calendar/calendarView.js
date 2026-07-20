import { getMonthMatrix, getWeekdayLabels, todayISO, MONTH_NAMES } from "../../utils/date.js";

let state = null;

export async function renderCalendarView(container) {
  const now = new Date();
  state = {
    year: now.getFullYear(),
    month: now.getMonth(),
  };
  render(container);
}

function render(container) {
  const days = getMonthMatrix(state.year, state.month);
  const today = todayISO();

  container.innerHTML = `
    <a href="#/" class="back-link">← На главную</a>
    <div class="calendar">
      <div class="calendar-toolbar">
        <button type="button" class="btn" data-action="prev">←</button>
        <h2 class="calendar-title">${MONTH_NAMES[state.month]} ${state.year}</h2>
        <button type="button" class="btn" data-action="next">→</button>
        <button type="button" class="btn" data-action="today">Сегодня</button>
      </div>
      <div class="calendar-weekdays">
        ${getWeekdayLabels()
          .map((label) => `<div class="calendar-weekday">${label}</div>`)
          .join("")}
      </div>
      <div class="calendar-grid">
        ${days
          .map(
            (day) => `
          <div class="calendar-day ${day.inCurrentMonth ? "" : "is-outside"} ${day.iso === today ? "is-today" : ""}">
            <span class="calendar-day-number">${day.date.getDate()}</span>
          </div>`
          )
          .join("")}
      </div>
    </div>
  `;

  container.querySelector('[data-action="prev"]').addEventListener("click", () => changeMonth(container, -1));
  container.querySelector('[data-action="next"]').addEventListener("click", () => changeMonth(container, 1));
  container.querySelector('[data-action="today"]').addEventListener("click", () => {
    const now = new Date();
    state.year = now.getFullYear();
    state.month = now.getMonth();
    render(container);
  });
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
  render(container);
}
