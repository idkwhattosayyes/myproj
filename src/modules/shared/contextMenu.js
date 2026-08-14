import { pushLayer } from "../../utils/escapeLayers.js";
import { clamp } from "../../utils/dom.js";

// Зазор от краёв экрана — тот же, что у панели выделения и поповера ссылки
// в richTextEditor.js.
const EDGE_PAD_PX = 8;

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

/**
 * Ставит меню у точки клика, не выпуская его за экран. Вызывать ТОЛЬКО после
 * вставки в DOM: до неё у меню нет размеров, а без высоты не узнать, влезает ли
 * оно вниз. Раньше left/top проставлялись до вставки и без единой проверки —
 * поэтому у нижнего края экрана меню обрезалось и часть пунктов была недоступна.
 *
 * Высота у меню переменная: у папки и заметки то 4 пункта, то 5.
 */
function placeMenu(menu, x, y) {
  const box = menu.getBoundingClientRect();
  // Не влезает вниз — открываем вверх, нижним краем на курсор. Так пункты
  // остаются у того элемента, по которому кликнули, а не уезжают к другому краю.
  const fitsBelow = y + box.height + EDGE_PAD_PX <= window.innerHeight;
  const top = fitsBelow ? y : y - box.height;
  // Меню выше экрана даже вверх ногами — clamp вернёт min и прижмёт его к верху;
  // доехать до нижних пунктов даёт max-height с прокруткой в panels.css.
  menu.style.left = `${clamp(x, EDGE_PAD_PX, window.innerWidth - box.width - EDGE_PAD_PX)}px`;
  menu.style.top = `${clamp(top, EDGE_PAD_PX, window.innerHeight - box.height - EDGE_PAD_PX)}px`;
}

/** @param {{label: string, onClick: () => void}[]} items */
export function showContextMenu(x, y, items) {
  closeMenu();

  const menu = document.createElement("div");
  menu.className = "context-menu";
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
  placeMenu(menu, x, y);
  activeMenu = menu;
  unregisterLayer = pushLayer(closeMenu);

  // Закрыть по клику вне меню — навешиваем на следующий тик, иначе поймает текущий contextmenu-клик.
  setTimeout(() => document.addEventListener("click", closeMenu, { once: true }), 0);
}
