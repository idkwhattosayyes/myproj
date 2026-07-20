export async function renderHomeView(container) {
  container.innerHTML = `
    <div class="home">
      <div class="home-circles">
        <a href="#/tasks" class="home-circle home-circle--tasks">
          <span class="home-circle-label">Задачи</span>
        </a>
        <a href="#/documents" class="home-circle home-circle--documents">
          <span class="home-circle-label">Документы</span>
        </a>
        <a href="#/calendar" class="home-circle home-circle--calendar">
          <span class="home-circle-label">Календарь</span>
        </a>
        <div class="home-circle home-circle--ai" tabindex="0">
          <span class="home-circle-label">AI</span>
          <span class="home-circle-overlay">Недоступно пока</span>
        </div>
      </div>
    </div>
  `;
}
