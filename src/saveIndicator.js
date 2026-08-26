import { t } from "./i18n/i18n.js";
import { onSaveStatusChange } from "./utils/saveStatus.js";

// Плашка в углу — только для залогиненных: onSaveStatusChange никогда не
// срабатывает у гостя, т.к. notifySaving/notifySaved зовёт только
// src/data/supabaseAdapter.js, а не localStorageAdapter.js.
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
  if (status === "saving") {
    el.textContent = t("save.saving");
    el.className = "save-indicator";
    el.hidden = false;
  } else if (status === "saved") {
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
