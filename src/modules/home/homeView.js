import { t } from "../../i18n/i18n.js";

export async function renderHomeView(container) {
  container.innerHTML = `
    <div class="home">
      <div class="home-circles">
        <a href="#/tasks" class="home-circle home-circle--tasks">
          <span class="home-circle-label">${t("home.tasks")}</span>
        </a>
        <a href="#/documents" class="home-circle home-circle--documents">
          <span class="home-circle-label">${t("home.documents")}</span>
        </a>
        <a href="#/calendar" class="home-circle home-circle--calendar">
          <span class="home-circle-label">${t("home.calendar")}</span>
        </a>
        <div class="home-circle home-circle--ai" tabindex="0">
          <span class="home-circle-label">${t("home.ai")}</span>
          <span class="home-circle-overlay">${t("home.aiUnavailable")}</span>
        </div>
      </div>
    </div>
  `;
}
