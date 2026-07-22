export function qs(selector, scope = document) {
  return scope.querySelector(selector);
}

export function qsa(selector, scope = document) {
  return [...scope.querySelectorAll(selector)];
}

export function escapeHtml(value) {
  const div = document.createElement("div");
  div.textContent = value ?? "";
  return div.innerHTML;
}

export function escapeAttr(value) {
  return escapeHtml(value).replace(/"/g, "&quot;");
}

/**
 * HTML заметки → плоский текст для поиска. Теги заменяются пробелом, иначе
 * слова из соседних абзацев слиплись бы в одно и находились бы там, где их нет.
 * Сущности (&nbsp; и подобные) раскрываются самим браузером при разборе.
 */
export function htmlToText(html) {
  const holder = document.createElement("div");
  holder.innerHTML = String(html || "").replace(/<[^>]+>/g, " ");
  return holder.textContent.replace(/\s+/g, " ").trim();
}

/**
 * Textarea растёт вниз по мере ввода вместо того, чтобы прятать текст за
 * нижним краем. Высоту снимаем в auto перед замером — иначе scrollHeight
 * останется равным уже выставленной высоте и поле не сожмётся при удалении.
 */
export function autoGrowTextarea(el) {
  const resize = () => {
    el.style.height = "auto";
    // +2px — запас на дробную высоту строки: без него у поля впритык
    // появляется полоса прокрутки, хотя весь текст уже помещается.
    el.style.height = `${el.scrollHeight + 2}px`;
  };
  el.addEventListener("input", resize);
  resize();
}
