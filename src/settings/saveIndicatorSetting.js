const STORAGE_KEY = "app:saveIndicatorEnabled";

let saveIndicatorEnabled = localStorage.getItem(STORAGE_KEY) !== "0";

export function getSaveIndicatorEnabled() {
  return saveIndicatorEnabled;
}

export function setSaveIndicatorEnabled(enabled) {
  saveIndicatorEnabled = enabled;
  localStorage.setItem(STORAGE_KEY, enabled ? "1" : "0");
}
