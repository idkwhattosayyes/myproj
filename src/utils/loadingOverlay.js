// Полноэкранный оверлей со спиннером — для операций без собственного UI,
// пока они выполняются (например импорт бэкапа, settingsPanel.js).
export function showLoadingOverlay() {
  const el = document.createElement("div");
  el.className = "loading-overlay";
  el.innerHTML = '<div class="spinner"></div>';
  document.body.appendChild(el);
  return () => el.remove();
}
