import { pushLayer } from "../../utils/escapeLayers.js";
import { clamp } from "../../utils/dom.js";

// Тот же зазор от краёв экрана, что и в contextMenu.js.
const EDGE_PAD_PX = 8;

/**
 * Маленькое меню у точки (x, y) — то же оформление, что и showContextMenu
 * (тот же класс .context-menu), но закрывается ПРАВИЛЬНО: по mousedown,
 * начавшемуся снаружи, а не по click. showContextMenu исторически слушает
 * click (см. CLAUDE.md про этот баг с зажатием кнопки внутри/отпусканием
 * снаружи) — здесь не чиним старый файл заодно, а просто не повторяем баг в
 * новом. Используется для "#" (Add/Create) и для ПКМ на теге внутри окошка
 * тегов блока (Edit/Delete/Add).
 *
 * @param {number} x
 * @param {number} y
 * @param {{label: string, onClick: () => void}[]} items
 * @returns {() => void} закрыть меню programmatically
 */
export function openAnchoredMenu(x, y, items) {
  const menu = document.createElement("div");
  menu.className = "context-menu";
  items.forEach((item) => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "context-menu-item";
    btn.textContent = item.label;
    btn.addEventListener("click", () => {
      closeMenu();
      item.onClick();
    });
    menu.appendChild(btn);
  });
  document.body.appendChild(menu);
  placeMenu(menu, x, y);

  // capture: true — меню должно закрыться раньше, чем клик дойдёт до цели.
  // Иначе клик по кнопке, которая ЭТО меню и открыла (например, повторный клик
  // на "#"), сначала закрыл бы его через onOutside, а потом всплывший click тут
  // же открыл бы заново — на глаз выглядело бы так, будто меню не закрывается.
  document.addEventListener("mousedown", onOutside, true);
  const unregisterLayer = pushLayer(closeMenu);

  function onOutside(event) {
    if (!menu.contains(event.target)) closeMenu();
  }

  function closeMenu() {
    menu.remove();
    document.removeEventListener("mousedown", onOutside, true);
    unregisterLayer();
  }

  return closeMenu;
}

function placeMenu(menu, x, y) {
  const box = menu.getBoundingClientRect();
  const fitsBelow = y + box.height + EDGE_PAD_PX <= window.innerHeight;
  const top = fitsBelow ? y : y - box.height;
  menu.style.left = `${clamp(x, EDGE_PAD_PX, window.innerWidth - box.width - EDGE_PAD_PX)}px`;
  menu.style.top = `${clamp(top, EDGE_PAD_PX, window.innerHeight - box.height - EDGE_PAD_PX)}px`;
}
