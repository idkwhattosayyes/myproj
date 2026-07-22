import { renderHomeView } from "./modules/home/homeView.js";
import { renderTasksView } from "./modules/tasks/tasksView.js";
import { renderDocumentsView } from "./modules/documents/documentsView.js";
import { renderCalendarView } from "./modules/calendar/calendarView.js";
import { getLang } from "./i18n/i18n.js";
import { mountSettings, applyBorderSetting } from "./settings/settingsPanel.js";
import { closeTopLayer, getViewEscape, setViewEscape } from "./utils/escapeLayers.js";
import { watchUiScale } from "./utils/uiScale.js";

const DEFAULT_ROUTE = "home";

const routes = {
  home: renderHomeView,
  tasks: renderTasksView,
  documents: renderDocumentsView,
  calendar: renderCalendarView,
};

const view = document.getElementById("app-view");

function parseHash() {
  const [routePart, ...rest] = window.location.hash.replace(/^#\/?/, "").split("/");
  const route = routes[routePart] ? routePart : DEFAULT_ROUTE;
  const param = rest.join("/") || null;
  return { route, param };
}

async function renderRoute() {
  const { route, param } = parseHash();
  // Обработчик Esc от предыдущего раздела не должен пережить переход.
  setViewEscape(null);
  view.classList.toggle("app-view--home", route === "home");
  view.innerHTML = "";
  document.documentElement.lang = getLang();
  await routes[route](view, param);
}

// Esc сверху вниз: сначала открытые поверх страницы слои (меню, модалки,
// поповеры), затем выход из поля ввода, и только потом — шаг назад по навигации.
function isEditingField(el) {
  if (!el) return false;
  return el.isContentEditable || el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT";
}

function onEscape() {
  if (closeTopLayer()) return;

  if (isEditingField(document.activeElement)) {
    document.activeElement.blur();
    return;
  }

  const viewEscape = getViewEscape();
  if (viewEscape) {
    viewEscape();
    return;
  }
  if (parseHash().route !== DEFAULT_ROUTE) window.location.hash = "#/";
}

window.addEventListener("keydown", (event) => {
  if (event.key !== "Escape") return;
  event.preventDefault();
  onEscape();
});

window.addEventListener("hashchange", renderRoute);
window.addEventListener("DOMContentLoaded", () => {
  applyBorderSetting();
  watchUiScale();
  // Панель настроек сама перерисовывает свои подписи; роутеру остаётся
  // перерисовать текущий раздел на новом языке.
  mountSettings({ onLangChange: renderRoute });
  renderRoute();
});
