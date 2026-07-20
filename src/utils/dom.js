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
