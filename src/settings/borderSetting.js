const STORAGE_KEY = "app:borderEnabled";

let borderEnabled = localStorage.getItem(STORAGE_KEY) !== "0";

export function getBorderEnabled() {
  return borderEnabled;
}

export function setBorderEnabled(enabled) {
  borderEnabled = enabled;
  localStorage.setItem(STORAGE_KEY, enabled ? "1" : "0");
}
