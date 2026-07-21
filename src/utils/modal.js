import { t } from "../i18n/i18n.js";

function createOverlay(contentHtml) {
  const overlay = document.createElement("div");
  overlay.className = "modal-overlay";
  overlay.innerHTML = `<div class="modal-box">${contentHtml}</div>`;
  document.body.appendChild(overlay);
  return overlay;
}

/** @returns {Promise<boolean>} */
export function openConfirm({ message, confirmLabel = t("modal.yes"), cancelLabel = t("modal.cancel") }) {
  return new Promise((resolve) => {
    const overlay = createOverlay(`
      <p class="modal-message"></p>
      <div class="modal-actions">
        <button type="button" class="btn" data-action="cancel">${cancelLabel}</button>
        <button type="button" class="btn btn-danger" data-action="confirm">${confirmLabel}</button>
      </div>
    `);
    overlay.querySelector(".modal-message").textContent = message;

    const finish = (result) => {
      overlay.remove();
      resolve(result);
    };

    overlay.querySelector('[data-action="confirm"]').addEventListener("click", () => finish(true));
    overlay.querySelector('[data-action="cancel"]').addEventListener("click", () => finish(false));
    overlay.addEventListener("click", (event) => {
      if (event.target === overlay) finish(false);
    });
  });
}

/** @returns {Promise<string|null>} null означает "отменено" */
export function openPrompt({ message, defaultValue = "", confirmLabel = t("modal.ok"), cancelLabel = t("modal.cancel") }) {
  return new Promise((resolve) => {
    const overlay = createOverlay(`
      <p class="modal-message"></p>
      <input type="text" class="modal-input" data-role="input">
      <div class="modal-actions">
        <button type="button" class="btn" data-action="cancel">${cancelLabel}</button>
        <button type="button" class="btn btn-primary" data-action="confirm">${confirmLabel}</button>
      </div>
    `);
    overlay.querySelector(".modal-message").textContent = message;

    const input = overlay.querySelector('[data-role="input"]');
    input.value = defaultValue;

    const finish = (result) => {
      overlay.remove();
      resolve(result);
    };

    overlay.querySelector('[data-action="confirm"]').addEventListener("click", () => finish(input.value));
    overlay.querySelector('[data-action="cancel"]').addEventListener("click", () => finish(null));
    input.addEventListener("keydown", (event) => {
      if (event.key === "Enter") finish(input.value);
      if (event.key === "Escape") finish(null);
    });
    overlay.addEventListener("click", (event) => {
      if (event.target === overlay) finish(null);
    });

    input.focus();
    input.select();
  });
}

/**
 * Одно окно для создания таблицы: сразу два поля (столбцы и строки).
 * @returns {Promise<{cols: number, rows: number}|null>} null означает "отменено"
 */
export function openTablePrompt({ colsLabel, rowsLabel, confirmLabel = t("modal.ok"), cancelLabel = t("modal.cancel") }) {
  return new Promise((resolve) => {
    const overlay = createOverlay(`
      <p class="modal-message" data-role="cols-label"></p>
      <input type="number" min="1" max="20" class="modal-input" data-role="cols" value="3">
      <p class="modal-message" data-role="rows-label"></p>
      <input type="number" min="1" max="20" class="modal-input" data-role="rows" value="3">
      <div class="modal-actions">
        <button type="button" class="btn" data-action="cancel">${cancelLabel}</button>
        <button type="button" class="btn btn-primary" data-action="confirm">${confirmLabel}</button>
      </div>
    `);
    overlay.querySelector('[data-role="cols-label"]').textContent = colsLabel;
    overlay.querySelector('[data-role="rows-label"]').textContent = rowsLabel;

    const colsInput = overlay.querySelector('[data-role="cols"]');
    const rowsInput = overlay.querySelector('[data-role="rows"]');

    const finish = (result) => {
      overlay.remove();
      resolve(result);
    };

    overlay.querySelector('[data-action="confirm"]').addEventListener("click", () =>
      finish({ cols: parseInt(colsInput.value, 10), rows: parseInt(rowsInput.value, 10) })
    );
    overlay.querySelector('[data-action="cancel"]').addEventListener("click", () => finish(null));
    overlay.addEventListener("click", (event) => {
      if (event.target === overlay) finish(null);
    });
    colsInput.focus();
    colsInput.select();
  });
}

/** @returns {Promise<void>} */
export function openAlert({ message, okLabel = t("modal.ok") }) {
  return new Promise((resolve) => {
    const overlay = createOverlay(`
      <p class="modal-message"></p>
      <div class="modal-actions">
        <button type="button" class="btn btn-primary" data-action="ok">${okLabel}</button>
      </div>
    `);
    overlay.querySelector(".modal-message").textContent = message;

    const finish = () => {
      overlay.remove();
      resolve();
    };

    overlay.querySelector('[data-action="ok"]').addEventListener("click", finish);
    overlay.addEventListener("click", (event) => {
      if (event.target === overlay) finish();
    });
  });
}
