import { t } from "../../i18n/i18n.js";
import { pushLayer } from "../../utils/escapeLayers.js";
import { escapeHtml } from "../../utils/dom.js";
import { search } from "../../search/searchService.js";
import * as itemsService from "../../services/itemsService.js";

const INPUT_DELAY = 150;

/**
 * Пикер внутренней ссылки: сначала ищем заметку — тем же поиском и теми же
 * строками результатов, что и обычная полоска поиска (searchBar.js), только
 * без глобальной навигации. Выбор заметки открывает её содержимое; клик по
 * слову в нём и есть подтверждение — отдельной кнопки "выбрать" не нужно.
 *
 * @returns {Promise<{itemId: string, query: string, matchIndex: number} | null>}
 */
export function openInternalLinkPicker() {
  return new Promise((resolve) => {
    const overlay = document.createElement("div");
    overlay.className = "modal-overlay";
    overlay.innerHTML = `
      <div class="modal-box internal-link-picker">
        <input type="text" class="modal-input" data-role="search-input" placeholder="${t("search.placeholder")}">
        <div class="internal-link-picker-results" data-role="results"></div>
        <div class="internal-link-picker-preview" data-role="preview" hidden>
          <p class="internal-link-picker-hint">${t("editor.internalLinkPickWordHint")}</p>
          <div class="internal-link-picker-content rte-content" data-role="preview-content"></div>
        </div>
        <div class="modal-actions">
          <button type="button" class="btn" data-action="cancel">${t("modal.cancel")}</button>
        </div>
      </div>`;
    document.body.appendChild(overlay);

    const input = overlay.querySelector('[data-role="search-input"]');
    const resultsEl = overlay.querySelector('[data-role="results"]');
    const previewEl = overlay.querySelector('[data-role="preview"]');
    const previewContentEl = overlay.querySelector('[data-role="preview-content"]');

    let searchTimer = null;

    const finish = (result) => {
      clearTimeout(searchTimer);
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

    overlay.querySelector('[data-action="cancel"]').addEventListener("click", () => finish(null));

    input.addEventListener("input", () => {
      clearTimeout(searchTimer);
      searchTimer = setTimeout(runSearch, INPUT_DELAY);
    });

    async function runSearch() {
      const query = input.value.trim();
      if (!query) {
        resultsEl.innerHTML = "";
        return;
      }
      const groups = (await search(query, "items")).filter((group) => group.kind === "item");
      renderResults(groups);
    }

    function renderResults(groups) {
      if (!groups.length) {
        resultsEl.innerHTML = `<div class="search-empty">${t("search.nothing")}</div>`;
        return;
      }
      resultsEl.innerHTML = groups
        .map(
          (group, index) => `
          <button type="button" class="search-row search-row--head" data-index="${index}">
            <span class="search-kind">${t("search.kindNote")}</span>
            <span class="search-row-title">${escapeHtml(group.title || t("panel.untitled"))}</span>
            ${group.subtitle ? `<span class="search-row-sub">${escapeHtml(group.subtitle)}</span>` : ""}
          </button>`
        )
        .join("");
      resultsEl.querySelectorAll("[data-index]").forEach((btn) => {
        btn.addEventListener("click", () => openPreview(groups[Number(btn.dataset.index)]));
      });
    }

    async function openPreview(group) {
      const item = await itemsService.getItem(group.id);
      if (!item) return;
      input.hidden = true;
      resultsEl.hidden = true;
      previewEl.hidden = false;
      previewContentEl.innerHTML = item.content;
      previewContentEl.addEventListener("click", (event) => {
        const picked = wordAt(previewContentEl, event.clientX, event.clientY);
        if (!picked) return;
        const matchIndex = occurrenceIndexOf(previewContentEl, picked.node, picked.start, picked.word);
        finish({ itemId: item.id, query: picked.word, matchIndex });
      });
    }

    input.focus();
  });
}

// Слово под курсором клика: раздвигаем границы от точки клика посимвольно до
// пробела/пунктуации — простое сканирование, не Intl.Segmenter, для выбора
// одного слова этого достаточно.
function wordAt(container, x, y) {
  let range = null;
  if (document.caretRangeFromPoint) {
    range = document.caretRangeFromPoint(x, y);
  } else if (document.caretPositionFromPoint) {
    const pos = document.caretPositionFromPoint(x, y);
    if (pos) {
      range = document.createRange();
      range.setStart(pos.offsetNode, pos.offset);
    }
  }
  if (!range || range.startContainer.nodeType !== Node.TEXT_NODE || !container.contains(range.startContainer)) {
    return null;
  }

  const node = range.startContainer;
  const text = node.textContent;
  const isWordChar = (ch) => !!ch && !/[\s.,!?;:()"'«»…\-–—]/.test(ch);
  let start = range.startOffset;
  let end = range.startOffset;
  while (start > 0 && isWordChar(text[start - 1])) start--;
  while (end < text.length && isWordChar(text[end])) end++;
  if (start === end) return null;
  return { node, start, word: text.slice(start, end) };
}

// Порядковый номер вхождения слова в общем тексте контейнера — тем же
// принципом, что и подсветка результатов поиска (findOccurrenceRange в
// richTextEditor.js), только для уже найденной конкретной позиции клика.
function occurrenceIndexOf(container, targetNode, targetOffset, word) {
  const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
  let text = "";
  let targetPos = -1;
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (node === targetNode) targetPos = text.length + targetOffset;
    text += node.textContent;
  }
  if (targetPos === -1) return 0;

  const haystack = text.toLowerCase();
  const needle = word.toLowerCase();
  let count = 0;
  for (
    let from = haystack.indexOf(needle);
    from !== -1 && from < targetPos;
    from = haystack.indexOf(needle, from + needle.length)
  ) {
    count++;
  }
  return count;
}
