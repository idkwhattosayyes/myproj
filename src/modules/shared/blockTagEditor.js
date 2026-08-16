import { t } from "../../i18n/i18n.js";
import { pushLayer } from "../../utils/escapeLayers.js";
import { escapeAttr } from "../../utils/dom.js";

/**
 * Окно создания/редактирования тега блока: имя, цвет (нативный input
 * type="color" — тот же выбор, что и у тегов календаря, см. calendarView.js) и
 * id тега для чтения. В режиме создания id уже сгенерирован заранее вызывающим
 * кодом — чтобы честно показать его с первого кадра, а не только после Save.
 *
 * onSubmit делает саму запись (create/update тега) и возвращает {ok:true} или
 * {ok:false, message} — сообщение об уже занятом имени показывается прямо тут,
 * под полем, окно не закрывается, а не всплывает наружу как исключение.
 *
 * @param {{mode: "create"|"edit", name?: string, color?: string, id: string, onSubmit: (data: {name: string, color: string}) => Promise<{ok:true}|{ok:false,message:string}>}} options
 * @returns {Promise<boolean>} true — сохранено, false — отменено
 */
export function openBlockTagEditor({ mode, name = "", color = "#33507e", id, onSubmit }) {
  return new Promise((resolve) => {
    const overlay = document.createElement("div");
    overlay.className = "modal-overlay";
    overlay.innerHTML = `
      <div class="modal-box block-tag-editor">
        <p class="modal-message">${mode === "edit" ? t("editor.tagEditTitle") : t("editor.tagCreateTitle")}</p>
        <div class="block-tag-editor-row">
          <input type="text" class="modal-input" data-role="name" placeholder="${t("editor.tagNamePlaceholder")}" value="${escapeAttr(name)}">
          <input type="color" class="block-tag-editor-color" data-role="color" value="${escapeAttr(color)}">
        </div>
        <p class="block-tag-editor-id">${t("editor.tagIdLabel")}: <code>${escapeAttr(id)}</code></p>
        <p class="block-tag-editor-error" data-role="error" hidden></p>
        <div class="modal-actions">
          <button type="button" class="btn" data-action="cancel">${t("modal.cancel")}</button>
          <button type="button" class="btn btn-primary" data-action="confirm">${mode === "edit" ? t("modal.ok") : t("editor.tagCreate")}</button>
        </div>
      </div>`;
    document.body.appendChild(overlay);

    const nameInput = overlay.querySelector('[data-role="name"]');
    const colorInput = overlay.querySelector('[data-role="color"]');
    const errorEl = overlay.querySelector('[data-role="error"]');

    const finish = (result) => {
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
      if (pressedOutside && event.target === overlay) finish(false);
    };
    overlay.addEventListener("mousedown", onMouseDown);
    overlay.addEventListener("click", onClick);
    const unregisterLayer = pushLayer(() => finish(false));
    const unwire = () => {
      overlay.removeEventListener("mousedown", onMouseDown);
      overlay.removeEventListener("click", onClick);
      unregisterLayer();
      document.removeEventListener("keydown", onKey);
    };

    const confirm = async () => {
      const value = nameInput.value.trim();
      if (!value) {
        nameInput.focus();
        return;
      }
      const result = await onSubmit({ name: value, color: colorInput.value });
      if (result.ok) {
        finish(true);
        return;
      }
      errorEl.textContent = result.message;
      errorEl.hidden = false;
      nameInput.focus();
      nameInput.select();
    };
    overlay.querySelector('[data-action="confirm"]').addEventListener("click", confirm);
    overlay.querySelector('[data-action="cancel"]').addEventListener("click", () => finish(false));

    const onKey = (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        confirm();
      }
    };
    document.addEventListener("keydown", onKey);

    nameInput.focus();
    nameInput.select();
  });
}
