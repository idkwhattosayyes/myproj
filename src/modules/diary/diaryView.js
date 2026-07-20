import * as diaryService from "../../services/diaryService.js";
import { formatDate, todayISO } from "../../utils/date.js";

let state = null;

export async function renderDiaryView(container, dateParam) {
  state = {
    date: dateParam || todayISO(),
    entry: null,
  };
  await loadEntry();
  render(container);
}

async function loadEntry() {
  state.entry = await diaryService.getEntryByDate(state.date);
}

function render(container) {
  container.innerHTML = `
    <div class="diary-layout">
      <div class="diary-toolbar">
        <input type="date" class="diary-date-picker" value="${state.date}">
        <button type="button" class="btn" data-action="today">Сегодня</button>
      </div>
      <h2 class="diary-date-title">${formatDate(state.date)}</h2>
      <textarea class="diary-content" placeholder="Что произошло сегодня?"></textarea>
      <div class="diary-actions">
        <button type="button" class="btn btn-primary" data-action="save">Сохранить</button>
        <span class="diary-status" data-role="status"></span>
      </div>
    </div>
  `;

  const textarea = container.querySelector(".diary-content");
  textarea.value = state.entry ? state.entry.content : "";

  container.querySelector(".diary-date-picker").addEventListener("change", async (event) => {
    if (!event.target.value) return;
    state.date = event.target.value;
    await loadEntry();
    render(container);
  });

  container.querySelector('[data-action="today"]').addEventListener("click", async () => {
    state.date = todayISO();
    await loadEntry();
    render(container);
  });

  container.querySelector('[data-action="save"]').addEventListener("click", async () => {
    state.entry = await diaryService.saveEntry(state.date, textarea.value);
    const statusEl = container.querySelector('[data-role="status"]');
    statusEl.textContent = "Сохранено";
    setTimeout(() => {
      statusEl.textContent = "";
    }, 1500);
  });
}
