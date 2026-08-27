import { t } from "./i18n/i18n.js";
import { onSaveStatusChange } from "./utils/saveStatus.js";
import { getCachedSession } from "./auth/authService.js";

// Плашка в углу. Гостю (localStorage) сам факт "saving"/"saved" не
// показываем — запись мгновенная, это не несёт полезной информации. Но
// "error" показываем и гостю тоже: единственный сигнал реального сбоя
// записи (например переполнение квоты localStorage), см. saveStatus.js —
// withSaveStatus вызывается в обоих адаптерах намеренно, не только ради сети.
let el = null;
let hideTimer = null;

export function mountSaveIndicator() {
  el = document.createElement("div");
  el.className = "save-indicator";
  el.hidden = true;
  document.body.appendChild(el);
  onSaveStatusChange(render);
}

function render(status) {
  clearTimeout(hideTimer);
  const loggedIn = !!getCachedSession();
  if (status === "saving") {
    if (!loggedIn) {
      el.hidden = true;
      return;
    }
    el.textContent = t("save.saving");
    el.className = "save-indicator";
    el.hidden = false;
  } else if (status === "saved") {
    if (!loggedIn) {
      // Явно скрыть, а не просто выйти — иначе завершённая ошибка с
      // прошлого сохранения так и осталась бы висеть на экране.
      el.hidden = true;
      return;
    }
    el.textContent = t("save.saved");
    el.className = "save-indicator";
    el.hidden = false;
    hideTimer = setTimeout(() => {
      el.hidden = true;
    }, 1500);
  } else if (status === "error") {
    el.textContent = t("save.error");
    el.className = "save-indicator save-indicator--error";
    el.hidden = false;
  }
}
