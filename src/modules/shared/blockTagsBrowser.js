import { t } from "../../i18n/i18n.js";
import { openConfirm, openAlert } from "../../utils/modal.js";
import { pushLayer } from "../../utils/escapeLayers.js";
import { escapeHtml, clamp } from "../../utils/dom.js";
import { openAnchoredMenu } from "./anchoredMenu.js";
import { openBlockTagEditor } from "./blockTagEditor.js";
import { setPendingTarget, getNavigateHandler } from "../../search/searchTarget.js";
import { setBlockSearchSource } from "../../search/blockScope.js";
import { occurrenceRange, showSearchHighlight, clearSearchHighlight } from "../../utils/searchHighlight.js";
import * as blockTagsService from "../../services/blockTagsService.js";

const SORT_KEY = "app:blockBrowserSort";
// Последний набор тегов фильтра — переживает закрытие браузера тем же
// способом, что и сортировка: кнопка "#tags" рядом с поиском (searchBar.js)
// открывает браузер именно с этим набором, а не с пустым каждый раз заново.
export const LAST_FILTER_KEY = "app:blockBrowserFilter";

// Только одно окно браузера тегов одновременно — открыть новое поверх старого
// (клик по тегу внутри уже открытого браузера) сначала закрывает прежнее, тот
// же приём, что finishPicker(null) в начале openLinkPicker в searchBar.js.
let closeCurrentBrowser = null;

/**
 * Полноэкранное меню — все блоки (по всем заметкам), у которых есть ВСЕ
 * перечисленные теги. Реестр тегов снимается один раз при открытии (нужен и
 * для раскраски карточек, и для списка "+" в фильтре).
 *
 * @param {string[]} tagIds
 */
export function openBlockTagsBrowser(tagIds) {
  if (closeCurrentBrowser) closeCurrentBrowser();

  let selectedTagIds = [...new Set(tagIds)];
  let sortMode = localStorage.getItem(SORT_KEY) || "newest";
  let tagRegistry = new Map();
  let blocks = [];
  let sorted = [];
  let closeCardPanel = null;

  const overlay = document.createElement("div");
  // Своя вторая метка рядом с .modal-overlay: затемнение и z-index берём как у
  // обычной модалки, а раскладку меняем — окно сдвинуто вниз, чтобы не
  // накрывать строку поиска (см. blockTagsBrowser.css и ТЗ раунд 3 п.6).
  overlay.className = "modal-overlay block-browser-overlay";
  overlay.innerHTML = `
    <div class="block-browser">
      <div class="block-browser-header">
        <div class="block-browser-filter" data-role="filter"></div>
        <div class="block-browser-tools">
          <span class="block-browser-count" data-role="count"></span>
          <select class="block-browser-sort" data-role="sort">
            <option value="newest">${t("blockBrowser.sortNewest")}</option>
            <option value="oldest">${t("blockBrowser.sortOldest")}</option>
            <option value="noteOrder">${t("blockBrowser.sortNoteOrder")}</option>
          </select>
          <button type="button" class="btn" data-role="clear-all">${t("blockBrowser.clearAll")}</button>
        </div>
      </div>
      <div class="block-browser-list" data-role="list"></div>
    </div>`;
  document.body.appendChild(overlay);

  const filterEl = overlay.querySelector('[data-role="filter"]');
  const countEl = overlay.querySelector('[data-role="count"]');
  const sortEl = overlay.querySelector('[data-role="sort"]');
  const listEl = overlay.querySelector('[data-role="list"]');
  sortEl.value = sortMode;

  // Закрытие — mousedown, НАЧАВШИЙСЯ вне окна (клик "за границу"), + Esc.
  let pressedOutside = false;
  const onMouseDown = (event) => {
    pressedOutside = event.target === overlay;
  };
  const onClick = (event) => {
    if (pressedOutside && event.target === overlay) close();
  };
  overlay.addEventListener("mousedown", onMouseDown);
  overlay.addEventListener("click", onClick);
  const unregisterLayer = pushLayer(close);

  function close() {
    if (closeCardPanel) closeCardPanel();
    overlay.removeEventListener("mousedown", onMouseDown);
    overlay.removeEventListener("click", onClick);
    unregisterLayer();
    overlay.remove();
    clearSearchHighlight(); // диапазон жил в карточке, а её больше нет в документе
    setBlockSearchSource(null);
    closeCurrentBrowser = null;
  }
  closeCurrentBrowser = close;

  // Пока меню открыто, поиск "в разделе" ищет по показанным здесь блокам.
  // getBlocks читает sorted (а не blocks): искать надо среди того, что реально
  // на экране и в том же порядке — sorted переприсваивается в renderList,
  // поэтому именно функция, а не снимок массива.
  // close — чтобы строка поиска могла закрыть меню, уходя в найденную по
  // названию заметку (см. ветку blockNote в openRow).
  setBlockSearchSource({ getBlocks: () => sorted, scrollToBlock, close });

  sortEl.addEventListener("change", () => {
    sortMode = sortEl.value;
    localStorage.setItem(SORT_KEY, sortMode);
    renderList();
  });
  overlay.querySelector('[data-role="clear-all"]').addEventListener("click", () => {
    selectedTagIds = [];
    reload();
  });

  // --- Загрузка/перезагрузка -----------------------------------------------
  async function reload() {
    if (!tagRegistry.size) {
      const tags = await blockTagsService.listTags();
      tagRegistry = new Map(tags.map((tag) => [tag.id, tag]));
    }
    blocks = await blockTagsService.findBlocks(selectedTagIds);
    localStorage.setItem(LAST_FILTER_KEY, JSON.stringify(selectedTagIds));
    renderFilter();
    renderList();
  }

  // --- Шапка: чипы фильтра + "+" -------------------------------------------
  function renderFilter() {
    const chips = selectedTagIds
      .map((id) => {
        const tag = tagRegistry.get(id);
        return `
        <span class="block-browser-chip" style="--tag-color:${tag ? tag.color : "transparent"}">
          ${escapeHtml(tag ? tag.name : "?")}
          <button type="button" class="block-browser-chip-remove" data-tag-id="${id}" title="${t("blockBrowser.removeFilter")}">✕</button>
        </span>`;
      })
      .join("");
    filterEl.innerHTML = `${chips}<button type="button" class="block-browser-add" data-role="add-filter" title="${t("blockBrowser.addFilter")}">+</button>`;

    filterEl.querySelectorAll(".block-browser-chip-remove").forEach((btn) => {
      btn.addEventListener("click", () => {
        selectedTagIds = selectedTagIds.filter((id) => id !== btn.dataset.tagId);
        reload();
      });
    });
    const addBtn = filterEl.querySelector('[data-role="add-filter"]');
    addBtn.addEventListener("click", () => {
      const rect = addBtn.getBoundingClientRect();
      const items = [...tagRegistry.values()]
        .filter((tag) => !selectedTagIds.includes(tag.id))
        .map((tag) => ({
          label: tag.name,
          onClick: () => {
            selectedTagIds.push(tag.id);
            reload();
          },
        }));
      openAnchoredMenu(rect.left, rect.bottom, items);
    });
  }

  // --- Список карточек ------------------------------------------------------
  function sortBlocks() {
    const copy = [...blocks];
    if (sortMode === "newest") copy.sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));
    else if (sortMode === "oldest") copy.sort((a, b) => new Date(a.updatedAt) - new Date(b.updatedAt));
    else copy.sort((a, b) => a.order - b.order);
    return copy;
  }

  function renderList() {
    countEl.textContent = t("blockBrowser.count").replace("{n}", blocks.length);
    // Список пересобирается через innerHTML — подсвеченный диапазон указывал бы
    // на узлы, которых в документе уже нет.
    clearSearchHighlight();
    sorted = sortBlocks();
    if (!sorted.length) {
      listEl.innerHTML = `<p class="block-browser-empty">${t("blockBrowser.empty")}</p>`;
      return;
    }
    listEl.innerHTML = sorted
      .map((block, index) => {
        const tag = tagRegistry.get(block.tagIds[0]);
        const words = block.text ? block.text.split(/\s+/).length : 0;
        const chars = block.text.length;
        return `
        <div class="block-browser-card" data-item-id="${block.itemId}" data-block-id="${block.blockId}" style="--tag-color:${tag ? tag.color : "transparent"}">
          <div class="block-browser-card-strip block-browser-card-strip--top" data-role="strip" data-index="${index}"></div>
          <div class="block-browser-card-head">
            <span class="block-browser-card-title">
              <span class="block-browser-card-note">${escapeHtml(block.itemTitle || t("panel.untitled"))}</span>
              <span class="block-browser-card-date">${formatUpdatedAt(block.updatedAt)}</span>
            </span>
            <span class="block-browser-card-stats">${t("editor.words")}: ${words} · ${t("editor.characters")}: ${chars}</span>
          </div>
          <div class="block-browser-card-body rte-content" contenteditable="false" data-role="body" data-index="${index}">${block.html}</div>
          <div class="block-browser-card-strip block-browser-card-strip--bottom" data-role="strip" data-index="${index}"></div>
        </div>`;
      })
      .join("");

    listEl.querySelectorAll('[data-role="strip"]').forEach((strip) => {
      strip.addEventListener("click", () => showCardTagsPanel(strip, sorted[Number(strip.dataset.index)]));
    });
    listEl.querySelectorAll('[data-role="body"]').forEach((body) => {
      // Двойной клик — открыть саму заметку на месте блока (ТЗ п.3), тем же
      // путём, что и клик по внутренней ссылке/кружку главной: setPendingTarget
      // + getNavigateHandler. Одинарный клик/выделение — просто нативное
      // выделение текста, никакого обработчика ему не нужно.
      body.addEventListener("dblclick", () => {
        const block = sorted[Number(body.dataset.index)];
        close();
        setPendingTarget({ kind: "item", id: block.itemId, blockId: block.blockId, query: "", matchIndex: 0 });
        getNavigateHandler()("notes");
      });
    });
  }

  /**
   * Переход по результату поиска "в разделе" (см. searchBar.js). Ключ карточки —
   * пара itemId + blockId: blockId уникален только внутри своей заметки.
   *
   * Если задан query, ведём к самому НАЙДЕННОМУ СЛОВУ и красим его; карточку в
   * этом случае не мигаем — маркером служит подсветка. Если слова нет (или его
   * не нашли), остаётся прежнее поведение: карточка по центру и вспышка.
   */
  function scrollToBlock(itemId, blockId, query, occurrence = 0) {
    const card = listEl.querySelector(
      `.block-browser-card[data-item-id="${itemId}"][data-block-id="${blockId}"]`
    );
    if (!card) return;
    clearSearchHighlight();

    const body = card.querySelector('[data-role="body"]');
    // Разделитель — ПРОБЕЛ: ровно так собран block.text (blockTags.js), по
    // которому считались номера вхождений. В самой карточке строки идут
    // вплотную, и склей их здесь без разделителя — номера разъедутся.
    // Внешний .trim() у block.text воспроизводить не нужно: он срезает только
    // пробелы, а вхождение непробельного запроса в них попасть не может.
    const range = body && query ? occurrenceRange([...body.children], query, occurrence, " ") : null;
    if (range) {
      const target = range.startContainer.parentElement;
      if (target) target.scrollIntoView({ block: "center", behavior: "smooth" });
      showSearchHighlight(range);
      return;
    }

    card.scrollIntoView({ block: "center", behavior: "smooth" });
    // Метка одноразовая (тот же приём, что у flashFolderId в panelSection.js):
    // снимаем её со всех карточек, иначе отыгравшие классы копились бы по
    // списку. Заодно это и перезапуск анимации — без снятия класса и
    // принудительного пересчёта повторная вспышка на той же карточке не идёт.
    listEl.querySelectorAll(".is-search-flash").forEach((el) => el.classList.remove("is-search-flash"));
    void card.offsetWidth;
    card.classList.add("is-search-flash");
  }

  // --- Панель тегов карточки (та же, что в редакторе) ----------------------
  function showCardTagsPanel(anchorEl, block) {
    if (closeCardPanel) closeCardPanel();

    const panel = document.createElement("div");
    panel.className = "rte-block-panel block-browser-tags-panel";
    panel.contentEditable = "false";
    panel.addEventListener("mousedown", (event) => event.preventDefault());

    block.tagIds.forEach((tagId) => {
      const tag = tagRegistry.get(tagId);
      const row = document.createElement("button");
      row.type = "button";
      row.className = "rte-block-panel-tag";
      row.style.setProperty("--tag-color", tag ? tag.color : "transparent");
      row.textContent = tag ? tag.name : "?";
      row.addEventListener("click", () => {
        closePanel();
        openBlockTagsBrowser([tagId]);
      });
      row.addEventListener("contextmenu", (event) => {
        event.preventDefault();
        openCardTagContextMenu(event.clientX, event.clientY, block, tagId);
      });
      panel.appendChild(row);
    });

    const addRow = document.createElement("button");
    addRow.type = "button";
    addRow.className = "rte-block-panel-add";
    addRow.textContent = `+ ${t("editor.tagAddItem")}`;
    addRow.addEventListener("click", () => {
      const rect = addRow.getBoundingClientRect();
      closePanel();
      openBlockAddCreateMenu(rect.left, rect.bottom, block);
    });
    panel.appendChild(addRow);

    document.body.appendChild(panel);
    const anchorRect = anchorEl.getBoundingClientRect();
    const box = panel.getBoundingClientRect();
    panel.style.left = `${clamp(anchorRect.left, 8, window.innerWidth - box.width - 8)}px`;
    panel.style.top = `${clamp(anchorRect.bottom + 4, 8, window.innerHeight - box.height - 8)}px`;

    function onOutside(event) {
      if (!panel.contains(event.target)) closePanel();
    }
    document.addEventListener("mousedown", onOutside, true);
    const unregister = pushLayer(closePanel);

    function closePanel() {
      panel.remove();
      document.removeEventListener("mousedown", onOutside, true);
      unregister();
      closeCardPanel = null;
    }
    closeCardPanel = closePanel;
  }

  function openCardTagContextMenu(x, y, block, tagId) {
    const tag = tagRegistry.get(tagId);
    openAnchoredMenu(x, y, [
      {
        label: t("editor.tagEditItem"),
        onClick: async () => {
          if (!tag) return;
          await openBlockTagEditor({
            mode: "edit",
            id: tag.id,
            name: tag.name,
            color: tag.color,
            onSubmit: async ({ name, color }) => {
              const result = await blockTagsService.updateTag(tag.id, { name, color });
              if (result.error === "taken") return { ok: false, message: t("editor.tagNameTaken") };
              tagRegistry.set(result.tag.id, result.tag);
              reload(); // перекрашивает все карточки этой заметки с этим тегом
              return { ok: true };
            },
          });
          // Панель держит имя/цвет тега, снятые в момент открытия — после
          // правки они устаревают, закрываем как и в редакторе.
          if (closeCardPanel) closeCardPanel();
        },
      },
      {
        label: t("editor.tagDeleteItem"),
        onClick: async () => {
          await blockTagsService.removeTagFromBlock(block.itemId, block.blockId, tagId);
          reload(); // если тег был в активном фильтре — блок сам выпадет из списка
          // Иначе панель продолжает показывать уже удалённый тег в списке.
          if (closeCardPanel) closeCardPanel();
        },
      },
      {
        label: t("editor.tagAddItem"),
        onClick: () => {
          if (closeCardPanel) closeCardPanel();
          openBlockAddCreateMenu(x, y, block);
        },
      },
    ]);
  }

  function openBlockAddCreateMenu(x, y, block) {
    openAnchoredMenu(x, y, [
      { label: t("editor.tagAdd"), onClick: () => openAddExistingMenu(x, y, block) },
      { label: t("editor.tagCreate"), onClick: () => openCreateForBlock(block) },
    ]);
  }

  function openAddExistingMenu(x, y, block) {
    const items = [...tagRegistry.values()]
      .filter((tag) => !block.tagIds.includes(tag.id))
      .map((tag) => ({
        label: tag.name,
        onClick: async () => {
          await blockTagsService.addTagToBlock(block.itemId, block.blockId, tag);
          reload();
        },
        // menuX/menuY — координаты реального ПКМ (anchoredMenu.js), не x/y
        // всего списка "+"/Add — иначе вложенное меню открывалось бы не под
        // курсором, а там, где стояла кнопка "+".
        onContextMenu: (menuX, menuY) => {
          openAnchoredMenu(menuX, menuY, [
            {
              label: t("editor.tagDeleteForever"),
              onClick: async () => {
                const count = (await blockTagsService.findBlocks([tag.id])).length;
                if (count > 0) {
                  const ok = await openConfirm({ message: t("editor.tagDeleteForeverConfirm").replace("{n}", String(count)) });
                  if (!ok) return;
                }
                try {
                  await blockTagsService.deleteTag(tag.id);
                } catch {
                  // Частичный сбой уже мог вычистить тег из части заметок —
                  // не молчим, иначе тег останется "дырявым" незамеченным.
                  await openAlert({ message: t("editor.tagDeleteForeverError") });
                  return;
                }
                // reload() не рефетчит теги сам, пока tagRegistry не пуст
                // (guard "if (!tagRegistry.size)") — обновляем вручную, тем
                // же приёмом, что уже используется рядом при edit (tagRegistry.set).
                tagRegistry.delete(tag.id);
                reload();
              },
            },
          ]);
        },
      }));
    openAnchoredMenu(x, y, items);
  }

  async function openCreateForBlock(block) {
    const id = crypto.randomUUID();
    await openBlockTagEditor({
      mode: "create",
      id,
      onSubmit: async ({ name, color }) => {
        const result = await blockTagsService.createTag({ id, name, color });
        if (result.error === "taken") return { ok: false, message: t("editor.tagNameTaken") };
        tagRegistry.set(result.tag.id, result.tag);
        await blockTagsService.addTagToBlock(block.itemId, block.blockId, result.tag);
        reload();
        return { ok: true };
      },
    });
  }

  reload();
}

// Дата последней правки заметки — тот же ручной разбор, что formatDateLabel в
// calendarView.js, но от полного таймстампа (new Date(iso)), а не от даты без
// времени. Месяцы переиспользуют существующий i18n-ключ calendar.months —
// заводить копию перевода ради одного нового потребителя незачем.
function formatUpdatedAt(iso) {
  const date = new Date(iso);
  const months = t("calendar.months");
  return `${date.getDate()} ${months[date.getMonth()]} ${date.getFullYear()}`;
}
