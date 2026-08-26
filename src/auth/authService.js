import { supabaseClient } from "../data/supabaseClient.js";

// Кэш сессии — синхронный доступ нужен панели настроек (renderPanel вызывается
// синхронно). Обновляется сам через onAuthStateChange, вручную нигде не пишем.
let cachedSession = null;

supabaseClient.auth.onAuthStateChange((_event, session) => {
  cachedSession = session;
});

/** @returns {Promise<import("@supabase/supabase-js").Session|null>} */
export async function getSession() {
  const { data } = await supabaseClient.auth.getSession();
  cachedSession = data.session;
  return cachedSession;
}

/** Синхронный снимок последней известной сессии — для мест без await (панель настроек). */
export function getCachedSession() {
  return cachedSession;
}

/** @returns {Promise<{session: object|null, error: object|null}>} */
export async function signInWithPassword(email, password) {
  const { data, error } = await supabaseClient.auth.signInWithPassword({ email, password });
  return { session: data.session, error };
}

/** @returns {Promise<{session: object|null, error: object|null}>} */
export async function signUp(email, password) {
  const { data, error } = await supabaseClient.auth.signUp({ email, password });
  return { session: data.session, error };
}

/** Уводит на страницу входа Google и возвращает обратно на этот же адрес. */
export async function signInWithGoogle() {
  return supabaseClient.auth.signInWithOAuth({ provider: "google" });
}

export async function signOut() {
  await supabaseClient.auth.signOut();
}

// Выбор "продолжить как гость" — постоянный, переживает перезагрузку и
// закрытие вкладки. Мелкая UI-настройка входа, а не данные приложения,
// поэтому напрямую в localStorage, в обход storageAdapter.js (тот же
// принцип, что у app:lastDrawColor). Сбрасывается только явным логаутом —
// тогда экран авторизации обязан появиться снова.
const GUEST_CHOSEN_KEY = "app:authGuestChosen";

export function hasChosenGuest() {
  return localStorage.getItem(GUEST_CHOSEN_KEY) === "1";
}

export function setGuestChosen() {
  localStorage.setItem(GUEST_CHOSEN_KEY, "1");
}

export function clearGuestChosen() {
  localStorage.removeItem(GUEST_CHOSEN_KEY);
}
