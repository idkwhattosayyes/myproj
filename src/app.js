import { renderNotesView } from "./modules/notes/notesView.js";
import { renderDiaryView } from "./modules/diary/diaryView.js";
import { renderCalendarView } from "./modules/calendar/calendarView.js";

const DEFAULT_ROUTE = "notes";

const routes = {
  notes: renderNotesView,
  diary: renderDiaryView,
  calendar: renderCalendarView,
};

const view = document.getElementById("app-view");
const navLinks = document.querySelectorAll(".app-nav-link");

function getRouteFromHash() {
  const hash = window.location.hash.replace(/^#\/?/, "");
  return routes[hash] ? hash : DEFAULT_ROUTE;
}

function setActiveNavLink(route) {
  navLinks.forEach((link) => {
    link.classList.toggle("is-active", link.dataset.route === route);
  });
}

async function renderRoute() {
  const route = getRouteFromHash();
  setActiveNavLink(route);
  view.innerHTML = "";
  await routes[route](view);
}

window.addEventListener("hashchange", renderRoute);
window.addEventListener("DOMContentLoaded", () => {
  if (!window.location.hash) {
    window.location.hash = `#/${DEFAULT_ROUTE}`;
    return;
  }
  renderRoute();
});
