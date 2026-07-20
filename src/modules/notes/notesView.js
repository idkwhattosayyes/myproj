import * as notesService from "../../services/notesService.js";
import * as searchService from "../../services/searchService.js";
import { getBacklinks } from "../../services/linksService.js";
import { renderNoteEditor } from "./noteEditor.js";
import { renderNoteReader } from "./noteReader.js";
import { escapeHtml, escapeAttr } from "../../utils/dom.js";
import { openConfirm, openPrompt } from "../../utils/modal.js";

let state = null;

export async function renderNotesView(container) {
  state = {
    folders: await notesService.listFolders(),
    notes: await notesService.listNotes(),
    selectedFolderId: "all", // "all" | "unfiled" | id папки
    selectedTag: null,
    selectedNoteId: null,
    mode: "reader", // "reader" | "writer"
    searchQuery: "",
    searchScope: "all", // "all" | "folder" | "note"
  };
  render(container);
}

function render(container) {
  container.innerHTML = `
    <div class="notes-layout">
      <aside class="notes-sidebar">
        <div class="notes-sidebar-actions">
          <button type="button" class="btn" data-action="new-note">+ Заметка</button>
          <button type="button" class="btn" data-action="new-folder">+ Папка</button>
        </div>
        <div class="notes-search">
          <input type="text" class="notes-search-input" data-role="search-input" placeholder="Поиск...">
          <select class="notes-search-scope" data-role="search-scope">
            <option value="all">Везде</option>
            ${isRealFolderId(state.selectedFolderId) ? `<option value="folder">В этой папке</option>` : ""}
            ${state.selectedNoteId ? `<option value="note">В этой заметке</option>` : ""}
          </select>
        </div>
        <nav class="notes-folder-tree" data-role="folder-tree"></nav>
        <div class="notes-tag-list">
          <h3>Теги</h3>
          <ul class="folder-list" data-role="tags"></ul>
        </div>
      </aside>
      <section class="notes-main" data-role="main"></section>
    </div>
  `;

  renderFolderTree(container);
  renderTagList(container);
  wireSidebarActions(container);
  wireSearch(container);
  renderMain(container);
}

function wireSearch(container) {
  const input = container.querySelector('[data-role="search-input"]');
  const scopeSelect = container.querySelector('[data-role="search-scope"]');

  input.value = state.searchQuery;
  if ([...scopeSelect.options].some((option) => option.value === state.searchScope)) {
    scopeSelect.value = state.searchScope;
  } else {
    state.searchScope = "all";
    scopeSelect.value = "all";
  }

  input.addEventListener("input", () => {
    state.searchQuery = input.value;
    renderMain(container);
  });

  scopeSelect.addEventListener("change", () => {
    state.searchScope = scopeSelect.value;
    renderMain(container);
  });
}

function getSearchScope() {
  if (state.searchScope === "folder" && isRealFolderId(state.selectedFolderId)) {
    return { type: "folder", folderId: state.selectedFolderId };
  }
  if (state.searchScope === "note" && state.selectedNoteId) {
    return { type: "note", noteId: state.selectedNoteId };
  }
  return { type: "all" };
}

function buildFolderTree(folders, parentId = null) {
  return folders
    .filter((folder) => folder.parentId === parentId)
    .map((folder) => ({ ...folder, children: buildFolderTree(folders, folder.id) }));
}

function renderFolderTree(container) {
  const treeEl = container.querySelector('[data-role="folder-tree"]');
  const tree = buildFolderTree(state.folders);

  treeEl.innerHTML = `
    <ul class="folder-list">
      <li class="folder-item ${state.selectedFolderId === "all" && !state.selectedTag ? "is-active" : ""}" data-folder-id="all">Все заметки</li>
      <li class="folder-item ${state.selectedFolderId === "unfiled" ? "is-active" : ""}" data-folder-id="unfiled">Без папки</li>
      ${renderFolderNodes(tree)}
    </ul>
  `;

  treeEl.querySelectorAll("[data-folder-id]").forEach((el) => {
    el.addEventListener("click", () => {
      state.selectedFolderId = el.dataset.folderId;
      state.selectedTag = null;
      state.selectedNoteId = null;
      render(container);
    });
  });

  treeEl.querySelectorAll("[data-delete-folder]").forEach((btn) => {
    btn.addEventListener("click", async (event) => {
      event.stopPropagation();
      const ok = await openConfirm({ message: "Удалить папку? Заметки останутся и станут «Без папки»." });
      if (!ok) return;
      const folderId = btn.dataset.deleteFolder;
      await notesService.deleteFolder(folderId);
      state.folders = await notesService.listFolders();
      state.notes = await notesService.listNotes();
      if (state.selectedFolderId === folderId) state.selectedFolderId = "all";
      render(container);
    });
  });
}

function renderFolderNodes(nodes) {
  if (!nodes.length) return "";
  return `<ul class="folder-list folder-list-nested">${nodes
    .map(
      (node) => `
        <li>
          <div class="folder-item ${state.selectedFolderId === node.id ? "is-active" : ""}" data-folder-id="${node.id}">
            <span>${escapeHtml(node.name)}</span>
            <button type="button" class="folder-delete" data-delete-folder="${node.id}" title="Удалить папку">✕</button>
          </div>
          ${renderFolderNodes(node.children)}
        </li>`
    )
    .join("")}</ul>`;
}

function renderTagList(container) {
  const listEl = container.querySelector('[data-role="tags"]');
  const tags = getAllTags();

  listEl.innerHTML = `
    <li class="tag-item ${state.selectedTag === null ? "is-active" : ""}" data-tag="">Все теги</li>
    ${tags
      .map(
        (tag) =>
          `<li class="tag-item ${state.selectedTag === tag ? "is-active" : ""}" data-tag="${escapeAttr(tag)}">#${escapeHtml(tag)}</li>`
      )
      .join("")}
  `;

  listEl.querySelectorAll("[data-tag]").forEach((el) => {
    el.addEventListener("click", () => {
      state.selectedTag = el.dataset.tag || null;
      state.selectedNoteId = null;
      render(container);
    });
  });
}

function getAllTags() {
  const tagSet = new Set();
  state.notes.forEach((note) => (note.tags || []).forEach((tag) => tagSet.add(tag)));
  return [...tagSet].sort((a, b) => a.localeCompare(b));
}

function wireSidebarActions(container) {
  container.querySelector('[data-action="new-note"]').addEventListener("click", async () => {
    const folderId = isRealFolderId(state.selectedFolderId) ? state.selectedFolderId : null;
    const note = await notesService.createNote({ title: "Новая заметка", content: "", folderId, tags: [] });
    state.notes = await notesService.listNotes();
    state.selectedNoteId = note.id;
    state.mode = "writer";
    render(container);
  });

  container.querySelector('[data-action="new-folder"]').addEventListener("click", async () => {
    const name = await openPrompt({ message: "Название папки:" });
    if (!name || !name.trim()) return;
    const parentId = isRealFolderId(state.selectedFolderId) ? state.selectedFolderId : null;
    await notesService.createFolder({ name: name.trim(), parentId });
    state.folders = await notesService.listFolders();
    render(container);
  });
}

function isRealFolderId(folderId) {
  return folderId && folderId !== "all" && folderId !== "unfiled";
}

function renderMain(container) {
  const mainEl = container.querySelector('[data-role="main"]');

  if (state.searchQuery.trim()) {
    renderSearchResults(mainEl, container);
    return;
  }

  if (state.selectedNoteId) {
    const note = state.notes.find((n) => n.id === state.selectedNoteId);
    if (!note) {
      state.selectedNoteId = null;
      renderMain(container);
      return;
    }
    renderNoteDetail(mainEl, note, container);
    return;
  }

  renderNoteList(mainEl, container);
}

function renderNoteList(mainEl, container) {
  const filtered = getFilteredNotes();

  mainEl.innerHTML = `
    <div class="notes-list-header">
      <h2>${escapeHtml(getListTitle())}</h2>
    </div>
    <ul class="notes-list">
      ${
        filtered.length
          ? filtered
              .map(
                (note) => `
        <li class="notes-list-item" data-note-id="${note.id}">
          <span class="notes-list-item-title">${escapeHtml(note.title || "Без названия")}</span>
          <span class="notes-list-item-meta">${(note.tags || []).map((t) => `#${escapeHtml(t)}`).join(" ")}</span>
        </li>`
              )
              .join("")
          : `<li class="placeholder">Заметок пока нет.</li>`
      }
    </ul>
  `;

  mainEl.querySelectorAll("[data-note-id]").forEach((el) => {
    el.addEventListener("click", () => {
      state.selectedNoteId = el.dataset.noteId;
      state.mode = "reader";
      render(container);
    });
  });
}

function getListTitle() {
  if (state.selectedTag) return `Тег: #${state.selectedTag}`;
  if (state.selectedFolderId === "all") return "Все заметки";
  if (state.selectedFolderId === "unfiled") return "Без папки";
  const folder = state.folders.find((f) => f.id === state.selectedFolderId);
  return folder ? folder.name : "Заметки";
}

function getFilteredNotes() {
  let notes = state.notes;
  if (state.selectedTag) {
    notes = notes.filter((note) => (note.tags || []).includes(state.selectedTag));
  } else if (state.selectedFolderId === "unfiled") {
    notes = notes.filter((note) => !note.folderId);
  } else if (state.selectedFolderId !== "all") {
    notes = notes.filter((note) => note.folderId === state.selectedFolderId);
  }
  return notes;
}

async function renderSearchResults(mainEl, container) {
  const query = state.searchQuery;
  const results = await searchService.search(query, getSearchScope());

  mainEl.innerHTML = `
    <div class="notes-list-header">
      <h2>Результаты поиска: «${escapeHtml(query)}»</h2>
    </div>
    <ul class="search-results-list">
      ${
        results.length
          ? results
              .map(
                (result) => `
        <li class="search-result-item" data-result-type="${result.type}" data-result-id="${result.id}" data-result-date="${result.date || ""}">
          <span class="search-result-type">${result.type === "diary" ? "Дневник" : "Заметка"}</span>
          <span class="search-result-title">${escapeHtml(result.title)}</span>
          <p class="search-result-snippet">${escapeHtml(result.snippet)}</p>
        </li>`
              )
              .join("")
          : `<li class="placeholder">Ничего не найдено.</li>`
      }
    </ul>
  `;

  mainEl.querySelectorAll("[data-result-id]").forEach((el) => {
    el.addEventListener("click", () => {
      if (el.dataset.resultType === "diary") {
        window.location.hash = `#/diary/${el.dataset.resultDate}`;
        return;
      }
      state.searchQuery = "";
      state.selectedNoteId = el.dataset.resultId;
      state.mode = "reader";
      render(container);
    });
  });
}

function renderNoteDetail(mainEl, note, container) {
  mainEl.innerHTML = `
    <div class="note-detail">
      <div class="note-detail-toolbar">
        <button type="button" class="btn" data-action="back">← Назад к списку</button>
        <div class="note-mode-toggle">
          <button type="button" class="btn ${state.mode === "reader" ? "btn-primary" : ""}" data-mode="reader">Читатель</button>
          <button type="button" class="btn ${state.mode === "writer" ? "btn-primary" : ""}" data-mode="writer">Писатель</button>
        </div>
        <button type="button" class="btn btn-danger" data-action="delete">Удалить</button>
      </div>
      <div class="note-detail-tags">
        ${(note.tags || []).map((t) => `<span class="tag-pill">#${escapeHtml(t)}</span>`).join("")}
        <button type="button" class="btn btn-small" data-action="edit-tags">теги…</button>
      </div>
      <div data-role="note-body"></div>
    </div>
  `;

  mainEl.querySelector('[data-action="back"]').addEventListener("click", () => {
    state.selectedNoteId = null;
    render(container);
  });

  mainEl.querySelectorAll("[data-mode]").forEach((btn) => {
    btn.addEventListener("click", () => {
      state.mode = btn.dataset.mode;
      render(container);
    });
  });

  mainEl.querySelector('[data-action="delete"]').addEventListener("click", async () => {
    const ok = await openConfirm({ message: "Удалить заметку безвозвратно?" });
    if (!ok) return;
    await notesService.deleteNote(note.id);
    state.notes = await notesService.listNotes();
    state.selectedNoteId = null;
    render(container);
  });

  mainEl.querySelector('[data-action="edit-tags"]').addEventListener("click", async () => {
    const current = (note.tags || []).join(", ");
    const input = await openPrompt({ message: "Теги через запятую:", defaultValue: current });
    if (input === null) return;
    const tags = input
      .split(",")
      .map((t) => t.trim())
      .filter(Boolean);
    await notesService.updateNote(note.id, { tags });
    state.notes = await notesService.listNotes();
    render(container);
  });

  const bodyEl = mainEl.querySelector('[data-role="note-body"]');

  if (state.mode === "writer") {
    renderNoteEditor(bodyEl, note, {
      allNotes: state.notes,
      onSave: async ({ title, content }) => {
        await notesService.updateNote(note.id, { title, content });
        state.notes = await notesService.listNotes();
        state.mode = "reader";
        render(container);
      },
      onCancel: () => {
        state.mode = "reader";
        render(container);
      },
    });
  } else {
    const notesById = new Map(state.notes.map((n) => [n.id, n]));
    renderNoteReader(bodyEl, note, {
      notesById,
      backlinks: getBacklinks(note.id, state.notes),
      onHighlight: async (highlight) => {
        await notesService.addHighlight(note.id, highlight);
        state.notes = await notesService.listNotes();
        render(container);
      },
      onRemoveHighlight: async (highlightId) => {
        await notesService.removeHighlight(note.id, highlightId);
        state.notes = await notesService.listNotes();
        render(container);
      },
      onOpenLink: (targetNoteId) => {
        state.searchQuery = "";
        state.selectedNoteId = targetNoteId;
        state.mode = "reader";
        render(container);
      },
    });
  }
}
