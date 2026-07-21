import { pushLayer } from "../../utils/escapeLayers.js";

let activeMenu = null;
let unregisterLayer = null;

function closeMenu() {
  if (!activeMenu) return;
  activeMenu.remove();
  activeMenu = null;
  if (unregisterLayer) {
    unregisterLayer();
    unregisterLayer = null;
  }
}

/** @param {{label: string, onClick: () => void}[]} items */
export function showContextMenu(x, y, items) {
  closeMenu();

  const menu = document.createElement("div");
  menu.className = "context-menu";
  menu.style.left = `${x}px`;
  menu.style.top = `${y}px`;
  menu.innerHTML = items
    .map((item, index) => `<button type="button" class="context-menu-item" data-index="${index}">${item.label}</button>`)
    .join("");

  menu.querySelectorAll("[data-index]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const item = items[Number(btn.dataset.index)];
      closeMenu();
      item.onClick();
    });
  });

  document.body.appendChild(menu);
  activeMenu = menu;
  unregisterLayer = pushLayer(closeMenu);

  // Закрыть по клику вне меню — навешиваем на следующий тик, иначе поймает текущий contextmenu-клик.
  setTimeout(() => document.addEventListener("click", closeMenu, { once: true }), 0);
}
