import { t } from "../../i18n/i18n.js";
import { pushLayer } from "../../utils/escapeLayers.js";

/**
 * Окно ввода/редактирования списка внешних ссылок для выделенного слова: по
 * одной строке на URL, круглый крестик убирает свою строку, "+" добавляет ещё
 * одну. Confirm (или Enter из любого поля) возвращает непустые значения,
 * Cancel/Esc/клик вне окна — null (ничего не менять).
 *
 * @param {string[]} [initialLinks] предзаполненные значения — режим "Change"
 * @returns {Promise<string[]|null>}
 */
export function openLinkEditor(initialLinks = []) {
  return new Promise((resolve) => {
    const overlay = document.createElement("div");
    overlay.className = "modal-overlay";
    overlay.innerHTML = `
      <div class="modal-box link-editor">
        <div class="link-editor-rows" data-role="rows"></div>
        <button type="button" class="link-editor-add" data-action="add">+ ${t("editor.linkAddRow")}</button>
        <div class="modal-actions">
          <button type="button" class="btn" data-action="cancel">${t("modal.cancel")}</button>
          <button type="button" class="btn btn-primary" data-action="confirm">${t("editor.linkConfirm")}</button>
        </div>
      </div>`;
    document.body.appendChild(overlay);

    const rows = overlay.querySelector('[data-role="rows"]');

    function addRow(value = "") {
      const row = document.createElement("div");
      row.className = "link-editor-row";
      row.innerHTML = `
        <input type="text" placeholder="${t("editor.linkUrlPlaceholder")}">
        <button type="button" class="link-editor-row-remove" title="${t("editor.linkRemoveRow")}">✕</button>`;
      const input = row.querySelector("input");
      input.value = value;
      row.querySelector(".link-editor-row-remove").addEventListener("click", () => row.remove());
      rows.appendChild(row);
      return input;
    }

    (initialLinks.length ? initialLinks : [""]).forEach((url) => addRow(url));

    overlay.querySelector('[data-action="add"]').addEventListener("click", () => addRow().focus());

    const finish = (result) => {
      document.removeEventListener("keydown", onKey);
      unwire();
      overlay.remove();
      resolve(result);
    };

    // Закрытие как у прочих модалок: mousedown, НАЧАВШИЙСЯ вне окна, + Esc.
    let pressedOutside = false;
    const onMouseDown = (event) => {
      pressedOutside = event.target === overlay;
    };
    const onClick = (event) => {
      if (pressedOutside && event.target === overlay) finish(null);
    };
    overlay.addEventListener("mousedown", onMouseDown);
    overlay.addEventListener("click", onClick);
    const unregisterLayer = pushLayer(() => finish(null));
    const unwire = () => {
      overlay.removeEventListener("mousedown", onMouseDown);
      overlay.removeEventListener("click", onClick);
      unregisterLayer();
    };

    const confirm = () => {
      const links = [...rows.querySelectorAll("input")].map((input) => input.value.trim()).filter(Boolean);
      finish(links);
    };
    overlay.querySelector('[data-action="confirm"]').addEventListener("click", confirm);
    overlay.querySelector('[data-action="cancel"]').addEventListener("click", () => finish(null));

    // Enter в любом поле подтверждает — тем же способом можно оставить
    // ссылки в режиме "Change" без изменений.
    const onKey = (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        confirm();
      }
    };
    document.addEventListener("keydown", onKey);

    const firstInput = rows.querySelector("input");
    if (firstInput) {
      firstInput.focus();
      firstInput.select();
    }
  });
}
