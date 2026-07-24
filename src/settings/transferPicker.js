import { t } from "../i18n/i18n.js";
import { pushLayer } from "../utils/escapeLayers.js";
import { escapeHtml } from "../utils/dom.js";

/**
 * Общее окно выбора для экспорта и импорта: дерево «папки → заметки» с галочками
 * и превью содержимого справа. mode влияет только на подписи. Данные приходят
 * готовыми: при экспорте — из хранилища, при импорте — из разобранного JSON;
 * структура папок/заметок в обоих случаях одинаковая, поэтому дерево общее.
 *
 * @param {{
 *   mode: "export" | "import",
 *   folders: Array<{id: string, name: string}>,
 *   items: Array<{id: string, title: string, content: string, folderIds: string[]}>,
 *   onConfirm: (selection: {folders: Array, items: Array}) => void
 * }} options
 */
export function openTransferPicker({ mode, folders, items, onConfirm }) {
  // Заметки, сгруппированные по папке. Ключ null-папки — отдельная псевдо-группа
  // «Без папки», как и в самих разделах. Удалённое (deletedAt) в обычные группы
  // не попадает — у удалённых заметок folderIds уже пуст (см. moveItemToTrash),
  // и без этой развилки они неотличимо утонули бы среди обычных «без папки».
  const UNFILED = "__unfiled__";
  const TRASH = "__trash__";
  const itemsByGroup = new Map();
  const trashedItems = [];
  for (const item of items) {
    if (item.deletedAt) {
      trashedItems.push(item);
      continue;
    }
    // Заметка может быть в нескольких папках — в дереве показываем её под первой
    // (полное «во всех папках сразу» дерево — вне объёма этой задачи).
    const key = (item.folderIds && item.folderIds[0]) || UNFILED;
    if (!itemsByGroup.has(key)) itemsByGroup.set(key, []);
    itemsByGroup.get(key).push(item);
  }

  const activeFolders = folders.filter((f) => !f.deletedAt);
  const trashedFolders = folders.filter((f) => f.deletedAt);

  const groups = [];
  for (const folder of activeFolders) {
    groups.push({ id: folder.id, name: folder.name, children: itemsByGroup.get(folder.id) || [] });
  }
  const unfiled = itemsByGroup.get(UNFILED) || [];
  if (unfiled.length) groups.push({ id: UNFILED, name: t("panel.unfiled"), children: unfiled });

  // Корзина — отдельный бакет. Удалённые папки лежат в нём плоскими строками
  // (kind:"folder"), не контейнерами со своим деревом: детей у них уже нет —
  // заметки отвязаны в момент удаления (см. moveFolderToTrash).
  const trashChildren = [
    ...trashedFolders.map((f) => ({ kind: "folder", id: f.id, name: f.name })),
    ...trashedItems,
  ];
  if (trashChildren.length) groups.push({ id: TRASH, name: t("panel.trash"), children: trashChildren });

  const title = mode === "export" ? t("transfer.exportTitle") : t("transfer.importTitle");
  const confirmLabel = mode === "export" ? t("transfer.doExport") : t("transfer.doImport");

  const overlay = document.createElement("div");
  overlay.className = "modal-overlay";
  overlay.innerHTML = `
    <div class="modal-box transfer-box">
      <div class="transfer-header">
        <span class="transfer-title">${escapeHtml(title)}</span>
        <label class="transfer-selectall">
          <input type="checkbox" data-role="select-all" checked> ${escapeHtml(t("transfer.selectAll"))}
        </label>
      </div>
      <div class="transfer-body">
        <div class="transfer-tree" data-role="tree">
          ${groups.map(renderGroup).join("") || `<p class="transfer-preview-empty">${escapeHtml(t("settings.exportEmpty"))}</p>`}
        </div>
        <div class="transfer-preview" data-role="preview">
          <p class="transfer-preview-empty">${escapeHtml(t("transfer.previewHint"))}</p>
        </div>
      </div>
      <div class="modal-actions">
        <button type="button" class="btn" data-action="cancel">${escapeHtml(t("modal.cancel"))}</button>
        <button type="button" class="btn btn-primary" data-action="confirm">${escapeHtml(confirmLabel)}</button>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);

  const treeEl = overlay.querySelector('[data-role="tree"]');
  const previewEl = overlay.querySelector('[data-role="preview"]');

  // --- галочки ---
  // Галочка папки управляет всеми её заметками; частичный выбор показываем
  // "неопределённым" состоянием. Галочка заметки, наоборот, обновляет состояние
  // своей папки. Читаем/пишем прямо по DOM — отдельное состояние здесь только
  // усложнило бы синхронизацию.
  // .transfer-check стоит и у заметок, и у удалённых папок внутри бакета
  // "Корзина" (см. renderChild) — общий класс, чтобы не разбирать здесь два вида.
  function folderChecks(groupId) {
    return [...treeEl.querySelectorAll(`[data-children="${CSS.escape(groupId)}"] input.transfer-check`)];
  }

  function syncFolderState(groupId) {
    const folderCb = treeEl.querySelector(`input[data-folder-id="${CSS.escape(groupId)}"]`);
    const kids = folderChecks(groupId);
    const checked = kids.filter((cb) => cb.checked).length;
    folderCb.checked = kids.length > 0 && checked === kids.length;
    folderCb.indeterminate = checked > 0 && checked < kids.length;
  }

  treeEl.addEventListener("change", (event) => {
    const target = event.target;
    if (target.matches("input[data-folder-id]")) {
      const groupId = target.dataset.folderId;
      folderChecks(groupId).forEach((cb) => (cb.checked = target.checked));
      target.indeterminate = false;
    } else if (target.matches("input[data-item-id], input[data-trash-folder-id]")) {
      const groupId = target.closest("[data-children]").dataset.children;
      syncFolderState(groupId);
    }
  });

  overlay.querySelector('[data-role="select-all"]').addEventListener("change", (event) => {
    const on = event.target.checked;
    treeEl.querySelectorAll("input[type=checkbox]").forEach((cb) => {
      cb.checked = on;
      cb.indeterminate = false;
    });
  });

  // --- разворачивание папок и превью ---
  treeEl.addEventListener("click", (event) => {
    const toggle = event.target.closest(".transfer-toggle");
    if (toggle) {
      const ul = treeEl.querySelector(`[data-children="${CSS.escape(toggle.dataset.toggle)}"]`);
      const open = ul.hidden;
      ul.hidden = !open;
      toggle.textContent = open ? "▾" : "▸";
      toggle.setAttribute("aria-expanded", String(open));
      return;
    }
    const titleEl = event.target.closest(".transfer-item-title");
    if (titleEl) showPreview(titleEl.dataset.previewId);
  });

  function showPreview(itemId) {
    const item = items.find((i) => i.id === itemId);
    if (!item) return;
    treeEl.querySelectorAll(".transfer-item-title.is-active").forEach((el) => el.classList.remove("is-active"));
    treeEl.querySelector(`.transfer-item-title[data-preview-id="${CSS.escape(itemId)}"]`)?.classList.add("is-active");
    const hasContent = (item.content || "").replace(/<[^>]+>/g, "").trim() !== "";
    // Заголовок — через textContent (пользовательские данные), тело — HTML самой
    // заметки, как в редакторе.
    previewEl.innerHTML = `<h3 class="transfer-preview-title"></h3><div class="transfer-preview-body"></div>`;
    previewEl.querySelector(".transfer-preview-title").textContent = item.title || t("panel.untitled");
    const body = previewEl.querySelector(".transfer-preview-body");
    if (hasContent) body.innerHTML = item.content;
    else body.innerHTML = `<p class="transfer-preview-empty">${escapeHtml(t("transfer.emptyNote"))}</p>`;
  }

  // --- закрытие: клик снаружи (начатый на подложке) и Esc, как у модалок ---
  let pressedOnBackdrop = false;
  overlay.addEventListener("mousedown", (event) => {
    pressedOnBackdrop = event.target === overlay;
  });
  overlay.addEventListener("click", (event) => {
    if (pressedOnBackdrop && event.target === overlay) close();
  });
  const unregisterLayer = pushLayer(close);

  function close() {
    unregisterLayer();
    overlay.remove();
  }

  overlay.querySelector('[data-action="cancel"]').addEventListener("click", close);
  overlay.querySelector('[data-action="confirm"]').addEventListener("click", () => {
    onConfirm(collectSelection());
    close();
  });

  // Собираем выбранное. Папку считаем выбранной, если её галочка отмечена или
  // частична (часть заметок внутри выбрана) — так структура при экспорте/импорте
  // сохраняется. Заметки — строго по своим галочкам.
  function collectSelection() {
    const chosenItems = items.filter((i) => {
      const cb = treeEl.querySelector(`input[data-item-id="${CSS.escape(i.id)}"]`);
      return cb && cb.checked;
    });
    const chosenFolderIds = new Set(
      folders
        .filter((f) => {
          const cb = treeEl.querySelector(`input[data-folder-id="${CSS.escape(f.id)}"]`);
          if (cb) return cb.checked || cb.indeterminate;
          // Удалённые папки не заводят свою группу — лежат плоской строкой в
          // "Корзине" со своей собственной галочкой (см. renderChild).
          const trashCb = treeEl.querySelector(`input[data-trash-folder-id="${CSS.escape(f.id)}"]`);
          return trashCb && trashCb.checked;
        })
        .map((f) => f.id),
    );
    // Плюс папки-владельцы выбранных заметок — чтобы заметка не «потеряла» папки.
    for (const item of chosenItems) for (const fid of item.folderIds || []) chosenFolderIds.add(fid);
    const chosenFolders = folders.filter((f) => chosenFolderIds.has(f.id));
    return { folders: chosenFolders, items: chosenItems };
  }

  // Обычная заметка — чекбокс по data-item-id, кликабельный заголовок с превью.
  // Удалённая папка внутри "Корзины" (child.kind === "folder") — плоская строка
  // без превью (нечего показывать) со своим отдельным чекбоксом.
  function renderChild(child) {
    if (child.kind === "folder") {
      return `
        <li class="transfer-item-row">
          <input type="checkbox" class="transfer-check" data-trash-folder-id="${escapeHtml(child.id)}" checked>
          <span class="transfer-item-title">${escapeHtml(child.name)}</span>
        </li>`;
    }
    return `
        <li class="transfer-item-row">
          <input type="checkbox" class="transfer-check" data-item-id="${escapeHtml(child.id)}" checked>
          <span class="transfer-item-title" data-preview-id="${escapeHtml(child.id)}">${escapeHtml(child.title || t("panel.untitled"))}</span>
        </li>`;
  }

  function renderGroup(group) {
    const children = group.children.map(renderChild).join("");
    return `
      <div class="transfer-group">
        <div class="transfer-folder-row">
          <button type="button" class="transfer-toggle" data-toggle="${escapeHtml(group.id)}" aria-expanded="true">▾</button>
          <input type="checkbox" class="transfer-check" data-folder-id="${escapeHtml(group.id)}" checked>
          <span class="transfer-folder-name">${escapeHtml(group.name)}</span>
          <span class="transfer-group-count">(${group.children.length})</span>
        </div>
        <ul class="transfer-folder-children" data-children="${escapeHtml(group.id)}">${children}</ul>
      </div>`;
  }
}
