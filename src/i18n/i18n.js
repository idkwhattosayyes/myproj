import { translations } from "./translations.js";

const STORAGE_KEY = "app:lang";
const DEFAULT_LANG = "en";

let currentLang = localStorage.getItem(STORAGE_KEY) || DEFAULT_LANG;
if (!translations[currentLang]) currentLang = DEFAULT_LANG;

export function getLang() {
  return currentLang;
}

export function setLang(lang) {
  currentLang = translations[lang] ? lang : DEFAULT_LANG;
  localStorage.setItem(STORAGE_KEY, currentLang);
}

/** Возвращает строку или массив (например, названия месяцев) по ключу. */
export function t(key) {
  return translations[currentLang]?.[key] ?? translations[DEFAULT_LANG][key] ?? key;
}
