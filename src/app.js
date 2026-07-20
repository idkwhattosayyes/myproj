import { renderHomeView } from "./modules/home/homeView.js";
import { renderTasksView } from "./modules/tasks/tasksView.js";
import { renderDocumentsView } from "./modules/documents/documentsView.js";
import { renderCalendarView } from "./modules/calendar/calendarView.js";

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
  view.classList.toggle("app-view--home", route === "home");
  view.innerHTML = "";
  await routes[route](view, param);
}

window.addEventListener("hashchange", renderRoute);
window.addEventListener("DOMContentLoaded", renderRoute);
