import { renderHomeView } from "./modules/home/homeView.js";
import { renderTasksView } from "./modules/tasks/tasksView.js";
import { renderDocumentsView } from "./modules/documents/documentsView.js";
import { renderCalendarView } from "./modules/calendar/calendarView.js";
import { getLang, setLang, t } from "./i18n/i18n.js";

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

function renderLangSwitcher() {
  let btn = document.getElementById("lang-switcher");
  if (!btn) {
    btn = document.createElement("button");
    btn.id = "lang-switcher";
    btn.className = "lang-switcher";
    btn.type = "button";
    document.body.appendChild(btn);
    btn.addEventListener("click", async () => {
      setLang(getLang() === "en" ? "ru" : "en");
      renderLangSwitcher();
      await renderRoute();
    });
  }
  btn.textContent = getLang() === "en" ? "RU" : "EN";
  btn.title = t("app.langSwitch");
  document.documentElement.lang = getLang();
}

window.addEventListener("hashchange", renderRoute);
window.addEventListener("DOMContentLoaded", () => {
  renderLangSwitcher();
  renderRoute();
});
