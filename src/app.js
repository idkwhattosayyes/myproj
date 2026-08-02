import { renderHomeView } from "./modules/home/homeView.js";
import { renderDocumentsView } from "./modules/documents/documentsView.js";
import { renderCalendarView } from "./modules/calendar/calendarView.js";
import { getLang } from "./i18n/i18n.js";
import { mountSettings, applyBorderSetting } from "./settings/settingsPanel.js";
import { closeTopLayer, getViewEscape, setViewEscape } from "./utils/escapeLayers.js";
import { setNavigateHandler } from "./search/searchTarget.js";
import { watchUiScale } from "./utils/uiScale.js";
import { mountSearch, refreshSearchScope, renderLabels as renderSearchLabels } from "./search/searchBar.js";
import { mountQuickNote } from "./search/quickNote.js";
import { refreshActivePanelItems } from "./modules/shared/panelSection.js";

const DEFAULT_ROUTE = "home";

const routes = {
  home: renderHomeView,
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
  // Полоска поиска живёт вне маршрутов, но её охват зависит от раздела.
  refreshSearchScope(route);
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
  // Полоска поиска сама не знает про роутер: она отдаёт нужный раздел, а переход
  // делаем здесь. Если раздел уже открыт (локальный поиск внутри него),
  // hashchange не сработает — перерисовываем вручную.
  const navigate = (route) => {
    const target = `#/${route}`;
    if (window.location.hash === target) renderRoute();
    else window.location.hash = target;
  };
  mountSearch({ onNavigate: navigate });
  // Внутренние ссылки на заметки (richTextEditor.js) переходят через тот же
  // роутер, но не могут импортировать app.js напрямую (циклический импорт).
  setNavigateHandler(navigate);
  // Быстрая заметка живёт рядом с поиском. «Принять» сохраняет запись в фоне;
  // onSaved обновляет список открытого раздела Заметок/Документов, если он сейчас
  // смонтирован (иначе тихий no-op — экран не трогаем). Переносят текст в раздел
  // только кнопки «В Заметки»/«В Документы» (через onNavigate).
  mountQuickNote({ onNavigate: navigate, onSaved: refreshActivePanelItems });
  // Панель настроек сама перерисовывает свои подписи; роутеру остаётся
  // перерисовать текущий раздел и полоску поиска на новом языке.
  mountSettings({
    onLangChange: () => {
      renderSearchLabels();
      renderRoute();
    },
  });
  renderRoute();
});
