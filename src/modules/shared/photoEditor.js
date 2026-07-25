import { t } from "../../i18n/i18n.js";
import { pushLayer } from "../../utils/escapeLayers.js";
import {
  TEXT_COLORS,
  DRAW_WIDTHS,
  DRAW_COLOR_KEY,
  DRAW_WIDTH_KEY,
  DRAW_DEFAULT_COLOR,
  DRAW_DEFAULT_WIDTH,
  getLastColor,
  setLastColor,
  getLastWidth,
  setLastWidth,
} from "../../utils/colorPrefs.js";

// Максимальная сторона области предпросмотра в окне (px). Само фото может быть
// крупнее — в окне показываем масштабированную копию, рисуем карандашом по ней,
// а на подтверждении переносим рисунок на полноразмерный кадр.
const STAGE_MAX = 480;

/**
 * Окно предпросмотра/редактирования вставляемого фото: карандаш поверх кадра
 * (цвет и толщина — как у инструмента рисования в тулбаре, выбираются по ПКМ
 * на кнопке карандаша), размер в пикселях и название. Enter или кнопка —
 * подтвердить, Esc или клик вне окна — отмена. Название нигде поверх фото не
 * показывается — оно доступно в «сведениях» (том же окне при повторном
 * редактировании) и учитывается в поиске.
 *
 * @param {string} dataUrl исходное изображение (data:URL)
 * @param {{width?:number,height?:number,name?:string}} [initial] значения при
 *   повторном редактировании уже размещённого фото
 * @returns {Promise<{dataUrl:string,width:number,height:number,name:string}|null>}
 *   null означает «отменено»
 */
export function openPhotoEditor(dataUrl, initial = {}) {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => build(img);
    img.onerror = () => resolve(null);
    img.src = dataUrl;

    function build(loadedImg) {
      const natW = loadedImg.naturalWidth;
      const natH = loadedImg.naturalHeight;
      // Масштаб превью: вписываем в STAGE_MAX по длинной стороне, не увеличивая.
      const scale = Math.min(1, STAGE_MAX / Math.max(natW, natH));
      const dispW = Math.round(natW * scale);
      const dispH = Math.round(natH * scale);

      const overlay = document.createElement("div");
      overlay.className = "modal-overlay";
      overlay.innerHTML = `
        <div class="modal-box photo-editor">
          <div class="photo-editor-toolbar">
            <button type="button" class="rte-btn" data-command="photoDraw" title="${t("editor.photoDraw")}">✏</button>
            <label class="photo-editor-field">${t("editor.photoWidth")}<input type="number" min="1" data-role="w"></label>
            <label class="photo-editor-field">${t("editor.photoHeight")}<input type="number" min="1" data-role="h"></label>
            <label class="photo-editor-field photo-editor-name">${t("editor.photoName")}<input type="text" data-role="name"></label>
          </div>
          <div class="photo-editor-stage" data-role="stage" style="width:${dispW}px;height:${dispH}px">
            <canvas data-role="draw" width="${dispW}" height="${dispH}"></canvas>
          </div>
          <div class="modal-actions">
            <button type="button" class="btn" data-action="cancel">${t("modal.cancel")}</button>
            <button type="button" class="btn btn-primary" data-action="confirm">${t("modal.ok")}</button>
          </div>
        </div>`;
      document.body.appendChild(overlay);

      // Само фото — фон сцены; карандаш рисует поверх на прозрачном canvas.
      const stage = overlay.querySelector('[data-role="stage"]');
      stage.style.backgroundImage = `url(${dataUrl})`;

      const canvas = overlay.querySelector('[data-role="draw"]');
      const ctx = canvas.getContext("2d");
      ctx.lineCap = "round";
      ctx.lineJoin = "round";

      const wInput = overlay.querySelector('[data-role="w"]');
      const hInput = overlay.querySelector('[data-role="h"]');
      const nameInput = overlay.querySelector('[data-role="name"]');
      wInput.value = initial.width || natW;
      hInput.value = initial.height || natH;
      nameInput.value = initial.name || "";

      // Пропорции держим по исходному кадру: правишь ширину — высота следом.
      const ratio = natW / natH;
      wInput.addEventListener("input", () => {
        const w = parseInt(wInput.value, 10);
        if (w > 0) hInput.value = Math.round(w / ratio);
      });
      hInput.addEventListener("input", () => {
        const h = parseInt(hInput.value, 10);
        if (h > 0) wInput.value = Math.round(h * ratio);
      });

      // Карандаш. Пока выключен — canvas прозрачен для мыши, чтобы можно было
      // спокойно кликать по полям. Включён — ловит рисование. Цвет/толщина —
      // последние выбранные (те же ключи, что у пера в тулбаре документа), ПКМ
      // на кнопке открывает палитру — тот же приём, что toggleDrawPopover.
      let drawing = false;
      let hasDrawing = false;
      let penOn = false;
      canvas.style.pointerEvents = "none";
      const pencilBtn = overlay.querySelector('[data-command="photoDraw"]');
      pencilBtn.addEventListener("mousedown", (event) => event.preventDefault());

      function updatePencilSwatch() {
        pencilBtn.style.setProperty("--swatch", getLastColor(DRAW_COLOR_KEY, DRAW_DEFAULT_COLOR));
      }
      updatePencilSwatch();

      pencilBtn.addEventListener("click", () => {
        penOn = !penOn;
        pencilBtn.classList.toggle("is-active", penOn);
        canvas.style.pointerEvents = penOn ? "auto" : "none";
        canvas.style.cursor = penOn ? "crosshair" : "default";
      });

      let pencilPopover = null;
      let unregisterPencilPopover = null;
      function closePencilPopover() {
        if (!pencilPopover) return;
        pencilPopover.remove();
        pencilPopover = null;
        if (unregisterPencilPopover) {
          unregisterPencilPopover();
          unregisterPencilPopover = null;
        }
      }
      pencilBtn.addEventListener("contextmenu", (event) => {
        event.preventDefault();
        if (pencilPopover) {
          closePencilPopover();
          return;
        }
        const popover = document.createElement("div");
        popover.className = "rte-color-popover rte-draw-popover";

        DRAW_WIDTHS.forEach((width) => {
          const swatch = document.createElement("button");
          swatch.type = "button";
          swatch.className = "rte-draw-width-swatch";
          swatch.style.setProperty("--dot", `${width * 2}px`);
          swatch.title = String(width);
          swatch.addEventListener("mousedown", (e) => e.preventDefault());
          swatch.addEventListener("click", (e) => {
            e.stopPropagation();
            setLastWidth(DRAW_WIDTH_KEY, width);
            closePencilPopover();
          });
          popover.appendChild(swatch);
        });

        TEXT_COLORS.forEach((color) => {
          const swatch = document.createElement("button");
          swatch.type = "button";
          swatch.className = "rte-color-swatch";
          swatch.style.background = color;
          swatch.addEventListener("mousedown", (e) => e.preventDefault());
          swatch.addEventListener("click", (e) => {
            e.stopPropagation();
            setLastColor(DRAW_COLOR_KEY, color);
            updatePencilSwatch();
            closePencilPopover();
          });
          popover.appendChild(swatch);
        });

        pencilBtn.appendChild(popover);
        pencilPopover = popover;
        unregisterPencilPopover = pushLayer(closePencilPopover);
        setTimeout(() => document.addEventListener("click", closePencilPopover, { once: true }), 0);
      });

      const pointFrom = (event) => {
        const rect = canvas.getBoundingClientRect();
        return { x: event.clientX - rect.left, y: event.clientY - rect.top };
      };
      canvas.addEventListener("pointerdown", (event) => {
        if (!penOn) return;
        drawing = true;
        hasDrawing = true;
        // Читаем последний цвет/толщину прямо сейчас — их могли сменить через
        // ПКМ-палитру уже после открытия окна, посреди редактирования.
        ctx.strokeStyle = getLastColor(DRAW_COLOR_KEY, DRAW_DEFAULT_COLOR);
        ctx.lineWidth = getLastWidth(DRAW_WIDTH_KEY, DRAW_DEFAULT_WIDTH);
        const p = pointFrom(event);
        ctx.beginPath();
        ctx.moveTo(p.x, p.y);
        canvas.setPointerCapture(event.pointerId);
      });
      canvas.addEventListener("pointermove", (event) => {
        if (!drawing) return;
        const p = pointFrom(event);
        ctx.lineTo(p.x, p.y);
        ctx.stroke();
      });
      canvas.addEventListener("pointerup", () => {
        drawing = false;
      });

      const finish = (result) => {
        document.removeEventListener("keydown", onKey);
        unwire();
        overlay.remove();
        resolve(result);
      };

      // Закрытие как у прочих модалок: mousedown, НАЧАВШИЙСЯ вне окна, + Esc.
      let pressedOutside = false;
      const onMouseDown = (e) => {
        pressedOutside = e.target === overlay;
      };
      const onClick = (e) => {
        if (pressedOutside && e.target === overlay) finish(null);
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
        const width = Math.max(1, parseInt(wInput.value, 10) || natW);
        const height = Math.max(1, parseInt(hInput.value, 10) || natH);
        const name = nameInput.value.trim();
        // Рисовали — сплющиваем карандаш в кадр на полном разрешении (превью было
        // масштабированным, поэтому холст растягиваем до натуральных размеров).
        let outUrl = dataUrl;
        if (hasDrawing) {
          const out = document.createElement("canvas");
          out.width = natW;
          out.height = natH;
          const octx = out.getContext("2d");
          octx.drawImage(loadedImg, 0, 0, natW, natH);
          octx.drawImage(canvas, 0, 0, natW, natH);
          outUrl = out.toDataURL("image/jpeg", 0.9);
        }
        finish({ dataUrl: outUrl, width, height, name });
      };

      overlay.querySelector('[data-action="confirm"]').addEventListener("click", confirm);
      overlay.querySelector('[data-action="cancel"]').addEventListener("click", () => finish(null));

      // Enter подтверждает из любого поля (все они однострочные).
      const onKey = (event) => {
        if (event.key === "Enter") {
          event.preventDefault();
          confirm();
        }
      };
      document.addEventListener("keydown", onKey);
      nameInput.focus();
    }
  });
}
