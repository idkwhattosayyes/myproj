import { t } from "./i18n/i18n.js";
import { onSaveStatusChange } from "./utils/saveStatus.js";
import { getCachedSession } from "./auth/authService.js";
import { getSaveIndicatorEnabled } from "./settings/saveIndicatorSetting.js";

// Плашка в углу. "saving"/"saved" не показываем гостю (localStorage — запись
// мгновенная, это не несёт полезной информации) и не показываем, если сам
// индикатор выключен в настройках. Но "error" показываем всегда, независимо
// от того и от другого: единственный сигнал реального сбоя записи (например
// переполнение квоты localStorage), см. saveStatus.js — withSaveStatus
// вызывается в обоих адаптерах намеренно, не только ради сети.
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
  const indicatorEnabled = getSaveIndicatorEnabled();
  if (status === "saving") {
    if (!loggedIn || !indicatorEnabled) {
      el.hidden = true;
      return;
    }
    el.textContent = t("save.saving");
    el.className = "save-indicator";
    el.hidden = false;
  } else if (status === "saved") {
    if (!loggedIn || !indicatorEnabled) {
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
