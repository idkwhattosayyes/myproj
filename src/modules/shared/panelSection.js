import * as itemsService from "../../services/itemsService.js";
import { renderRichTextEditor } from "./richTextEditor.js";
import { showContextMenu } from "./contextMenu.js";
import { openConfirm, openPrompt } from "../../utils/modal.js";
import { escapeHtml } from "../../utils/dom.js";

/**
 * Переиспользуемый каркас "папки слева + список заметок + редактор справа",
 * используется и Задачами, и Документами — отличаются только набором кнопок
 * тулбара (config.toolbarButtons) и section-ключом хранения (config.section).
 *
 * @param {HTMLElement} container
 * @param {{section: string, toolbarButtons: string[]}} config
 */
export async function renderPanelSection(container, config) {
  const state = {
    folders: await itemsService.listFolders(config.section),
    items: await itemsService.listItems(config.section),
    selectedFolderId: "all", // "all" | "unfiled" | id папки
    selectedItemId: null,
    foldersCollapsed: false,
    listCollapsed: false,
  };

  render(container, config, state);
}

function render(container, config, state) {
  container.innerHTML = `
    <a href="#/" class="back-link">← На главную</a>
    <div class="panel-layout">
      <aside class="panel panel-folders ${state.foldersCollapsed ? "is-collapsed" : ""}">
        <div class="panel-header">
          <button type="button" class="panel-toggle" data-action="toggle-folders" title="Свернуть/развернуть">☰</button>
          <span class="panel-title">Папки</span>
        </div>
        <div class="panel-body" data-role="folder-body"></div>
      </aside>

      <section class="panel panel-list ${state.listCollapsed ? "is-collapsed" : ""}">
        <div class="panel-header">
          <button type="button" class="panel-toggle" data-action="toggle-list" title="Свернуть/развернуть">☰</button>
          <span class="panel-title" data-role="list-title">Все</span>
          <button type="button" class="btn btn-small" data-action="new-item">+</button>
        </div>
        <div class="panel-body" data-role="list-body"></div>
      </section>

      <section class="panel-detail" data-role="detail"></section>
    </div>
  `;

  renderFolders(container, config, state);
  renderList(container, config, state);
  renderDetail(container, config, state);
  wireHeaderActions(container, config, state);
}

function wireHeaderActions(container, config, state) {
  container.querySelector('[data-action="toggle-folders"]').addEventListener("click", () => {
    state.foldersCollapsed = !state.foldersCollapsed;
    render(container, config, state);
  });

  container.querySelector('[data-action="toggle-list"]').addEventListener("click", () => {
    state.listCollapsed = !state.listCollapsed;
    render(container, config, state);
  });

  container.querySelector('[data-action="new-item"]').addEventListener("click", async () => {
    const folderId = isRealFolderId(state.selectedFolderId) ? state.selectedFolderId : null;
    const item = await itemsService.createItem(config.section, { title: "Без названия", content: "", folderId });
    state.items = await itemsService.listItems(config.section);
    state.selectedItemId = item.id;
    render(container, config, state);
  });
}

function isRealFolderId(id) {
  return id && id !== "all" && id !== "unfiled";
}

function renderFolders(container, config, state) {
  const bodyEl = container.querySelector('[data-role="folder-body"]');

  bodyEl.innerHTML = `
    <ul class="folder-list">
      <li class="folder-item ${state.selectedFolderId === "all" ? "is-active" : ""}" data-folder-id="all">Все</li>
      <li class="folder-item ${state.selectedFolderId === "unfiled" ? "is-active" : ""}" data-folder-id="unfiled">Без папки</li>
      ${state.folders
        .map(
          (folder) => `
        <li class="folder-item ${state.selectedFolderId === folder.id ? "is-active" : ""}" data-folder-id="${folder.id}">
          <span>${escapeHtml(folder.name)}</span>
          <button type="button" class="folder-delete" data-delete-folder="${folder.id}" title="Удалить папку">✕</button>
        </li>`
        )
        .join("")}
    </ul>
  `;

  bodyEl.querySelectorAll("[data-folder-id]").forEach((el) => {
    el.addEventListener("click", () => {
      state.selectedFolderId = el.dataset.folderId;
      state.selectedItemId = null;
      render(container, config, state);
    });
  });

  bodyEl.querySelectorAll("[data-delete-folder]").forEach((btn) => {
    btn.addEventListener("click", async (event) => {
      event.stopPropagation();
      const ok = await openConfirm({ message: "Удалить папку? Заметки останутся и станут «Без папки»." });
      if (!ok) return;
      const folderId = btn.dataset.deleteFolder;
      await itemsService.deleteFolder(config.section, folderId);
      state.folders = await itemsService.listFolders(config.section);
      state.items = await itemsService.listItems(config.section);
      if (state.selectedFolderId === folderId) state.selectedFolderId = "all";
      render(container, config, state);
    });
  });

  bodyEl.addEventListener("contextmenu", (event) => {
    event.preventDefault();
    showContextMenu(event.clientX, event.clientY, [
      {
        label: "Создать папку",
        onClick: async () => {
          const name = await openPrompt({ message: "Название папки:" });
          if (!name || !name.trim()) return;
          await itemsService.createFolder(config.section, name.trim());
          state.folders = await itemsService.listFolders(config.section);
          render(container, config, state);
        },
      },
    ]);
  });
}

function renderList(container, config, state) {
  const bodyEl = container.querySelector('[data-role="list-body"]');
  const titleEl = container.querySelector('[data-role="list-title"]');
  const items = getFilteredItems(state);

  titleEl.textContent = getListTitle(state);

  bodyEl.innerHTML = `
    <ul class="item-list">
      ${
        items.length
          ? items
              .map(
                (item) => `
        <li class="item-list-row ${state.selectedItemId === item.id ? "is-active" : ""}" data-item-id="${item.id}">
          ${escapeHtml(item.title || "Без названия")}
        </li>`
              )
              .join("")
          : `<li class="placeholder">Пусто</li>`
      }
    </ul>
  `;

  bodyEl.querySelectorAll("[data-item-id]").forEach((el) => {
    el.addEventListener("click", () => {
      state.selectedItemId = el.dataset.itemId;
      render(container, config, state);
    });
  });
}

function getFilteredItems(state) {
  if (state.selectedFolderId === "unfiled") return state.items.filter((item) => !item.folderId);
  if (state.selectedFolderId === "all") return state.items;
  return state.items.filter((item) => item.folderId === state.selectedFolderId);
}

function getListTitle(state) {
  if (state.selectedFolderId === "all") return "Все";
  if (state.selectedFolderId === "unfiled") return "Без папки";
  const folder = state.folders.find((f) => f.id === state.selectedFolderId);
  return folder ? folder.name : "";
}

function renderDetail(container, config, state) {
  const detailEl = container.querySelector('[data-role="detail"]');
  const item = state.items.find((i) => i.id === state.selectedItemId);

  if (!item) {
    detailEl.innerHTML = `<p class="placeholder">Выберите заметку слева или создайте новую.</p>`;
    return;
  }

  detailEl.innerHTML = `
    <div class="item-detail">
      <div class="item-detail-toolbar">
        <input type="text" class="item-title-input" data-role="title-input">
        <button type="button" class="btn btn-danger btn-small" data-action="delete-item">Удалить</button>
      </div>
      <div data-role="editor-host"></div>
    </div>
  `;

  // Debounce на сохранение — свой на каждое открытие заметки, чтобы правки
  // разных полей не перетирали друг друга и не утекали в чужую заметку при
  // быстром переключении.
  let pendingPatch = {};
  let saveTimer = null;

  function scheduleSave(patch) {
    Object.assign(item, patch);
    Object.assign(pendingPatch, patch);
    renderList(container, config, state);
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      const toSave = pendingPatch;
      pendingPatch = {};
      itemsService.updateItem(item.id, toSave);
    }, 400);
  }

  const titleInput = detailEl.querySelector('[data-role="title-input"]');
  titleInput.value = item.title;
  titleInput.addEventListener("input", () => scheduleSave({ title: titleInput.value }));

  const editorHost = detailEl.querySelector('[data-role="editor-host"]');
  renderRichTextEditor(editorHost, {
    content: item.content,
    buttons: config.toolbarButtons,
    onChange: (html) => scheduleSave({ content: html }),
  });

  detailEl.querySelector('[data-action="delete-item"]').addEventListener("click", async () => {
    const ok = await openConfirm({ message: "Удалить безвозвратно?" });
    if (!ok) return;
    clearTimeout(saveTimer);
    await itemsService.deleteItem(item.id);
    state.items = await itemsService.listItems(config.section);
    state.selectedItemId = null;
    render(container, config, state);
  });
}
