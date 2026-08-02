import { t } from "../../i18n/i18n.js";
import { escapeHtml } from "../../utils/dom.js";
import { pushLayer } from "../../utils/escapeLayers.js";
import * as itemsService from "../../services/itemsService.js";

const FAVORITES_ID = "favorites";
const ALL_ID = "all";
const UNFILED_ID = "unfiled";

/**
 * Модалка "папка → заметка" для кастомных кружков главной страницы. Слева —
 * дерево папок раздела Notes плюс псевдо-разделы Favorites/All/Unfiled (как в
 * боковой панели раздела Notes), справа — заметки внутри выбранного пункта.
 * "Done" активна только когда заметка выбрана.
 *
 * @returns {Promise<{noteId: string, folderId: string} | null>}
 */
export function openNotePicker() {
  return new Promise((resolve) => {
    let settled = false;
    function finish(result) {
      if (settled) return;
      settled = true;
      close();
      resolve(result);
    }

    const overlay = document.createElement("div");
    overlay.className = "modal-overlay";
    overlay.innerHTML = `
      <div class="modal-box note-picker-box">
        <div class="transfer-title">${escapeHtml(t("home.pickerTitle"))}</div>
        <div class="transfer-body">
          <div class="transfer-tree" data-role="folders"></div>
          <div class="transfer-tree" data-role="notes"></div>
        </div>
        <div class="modal-actions">
          <button type="button" class="btn" data-action="cancel">${escapeHtml(t("modal.cancel"))}</button>
          <button type="button" class="btn btn-primary" data-action="done" disabled>${escapeHtml(t("home.pickerDone"))}</button>
        </div>
      </div>
    `;
    document.body.appendChild(overlay);

    const foldersEl = overlay.querySelector('[data-role="folders"]');
    const notesEl = overlay.querySelector('[data-role="notes"]');
    const doneBtn = overlay.querySelector('[data-action="done"]');

    let folders = [];
    let items = [];
    let selectedFolderId = null;
    let selectedNoteId = null;
    const expandedFolderIds = new Set();

    function childFoldersOf(parentId) {
      return folders
        .filter((folder) => (folder.parentFolderIds || []).includes(parentId))
        .sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
    }

    function rootFolders() {
      return folders
        .filter((folder) => !(folder.parentFolderIds || []).length)
        .sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
    }

    function renderFolderRow(folder, depth) {
      const isExpanded = expandedFolderIds.has(folder.id);
      const children = childFoldersOf(folder.id);
      const toggle = children.length
        ? `<button type="button" class="transfer-toggle" data-toggle-folder="${folder.id}">${isExpanded ? "▾" : "▸"}</button>`
        : `<span class="transfer-toggle"></span>`;
      const row = `
        <div class="note-picker-row ${selectedFolderId === folder.id ? "is-selected" : ""}"
             data-pick-folder="${folder.id}" style="padding-left: ${depth * 14}px">
          ${toggle}
          <span>${escapeHtml(folder.name)}</span>
        </div>`;
      const childrenHtml = isExpanded ? children.map((child) => renderFolderRow(child, depth + 1)).join("") : "";
      return row + childrenHtml;
    }

    // Строка псевдо-раздела — тот же макет, что у обычной папки, но без
    // стрелки разворачивания (детей не бывает) и с фиксированным id/подписью.
    function pseudoFolderRow(id, label) {
      return `
        <div class="note-picker-row ${selectedFolderId === id ? "is-selected" : ""}" data-pick-folder="${id}">
          <span class="transfer-toggle"></span>
          <span>${escapeHtml(label)}</span>
        </div>`;
    }

    function renderFolders() {
      const pseudoRows =
        pseudoFolderRow(FAVORITES_ID, t("panel.favorites")) +
        pseudoFolderRow(ALL_ID, t("panel.all")) +
        pseudoFolderRow(UNFILED_ID, t("panel.unfiled"));
      foldersEl.innerHTML = pseudoRows + rootFolders().map((folder) => renderFolderRow(folder, 0)).join("");
    }

    function notesInSelectedFolder() {
      if (selectedFolderId === ALL_ID) return items;
      if (selectedFolderId === FAVORITES_ID) return items.filter((item) => item.isFavorite);
      if (selectedFolderId === UNFILED_ID) return items.filter((item) => !item.folderIds.length);
      return items.filter((item) => item.folderIds.includes(selectedFolderId));
    }

    function renderNotes() {
      if (!selectedFolderId) {
        notesEl.innerHTML = "";
        return;
      }
      notesEl.innerHTML = notesInSelectedFolder()
        .map(
          (item) => `
        <div class="note-picker-row ${selectedNoteId === item.id ? "is-selected" : ""}" data-pick-note="${item.id}">
          <span>${escapeHtml(item.title || t("panel.untitled"))}</span>
        </div>`
        )
        .join("");
    }

    foldersEl.addEventListener("click", (event) => {
      const toggleBtn = event.target.closest("[data-toggle-folder]");
      if (toggleBtn) {
        const id = toggleBtn.dataset.toggleFolder;
        if (expandedFolderIds.has(id)) expandedFolderIds.delete(id);
        else expandedFolderIds.add(id);
        renderFolders();
        return;
      }
      const row = event.target.closest("[data-pick-folder]");
      if (!row) return;
      selectedFolderId = row.dataset.pickFolder;
      selectedNoteId = null;
      doneBtn.disabled = true;
      renderFolders();
      renderNotes();
    });

    notesEl.addEventListener("click", (event) => {
      const row = event.target.closest("[data-pick-note]");
      if (!row) return;
      selectedNoteId = row.dataset.pickNote;
      doneBtn.disabled = false;
      renderNotes();
    });

    overlay.querySelector('[data-action="cancel"]').addEventListener("click", () => finish(null));
    doneBtn.addEventListener("click", () => {
      if (!selectedNoteId || !selectedFolderId) return;
      finish({ noteId: selectedNoteId, folderId: selectedFolderId });
    });

    // Закрываем только по клику, начавшемуся снаружи (соглашение проекта) —
    // иначе зажатие кнопки внутри окна с отпусканием снаружи схлопывало бы его.
    let mouseDownOnOverlay = false;
    overlay.addEventListener("mousedown", (event) => {
      mouseDownOnOverlay = event.target === overlay;
    });
    overlay.addEventListener("click", (event) => {
      if (mouseDownOnOverlay && event.target === overlay) finish(null);
    });

    const unregisterLayer = pushLayer(() => finish(null));

    function close() {
      overlay.remove();
      unregisterLayer();
    }

    itemsService
      .listFolders("notes")
      .then((loadedFolders) => {
        folders = loadedFolders;
        return itemsService.listItems("notes");
      })
      .then((loadedItems) => {
        items = loadedItems;
        renderFolders();
      });
  });
}
