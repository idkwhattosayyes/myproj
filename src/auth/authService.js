import { supabaseClient } from "../data/supabaseClient.js";

// Кэш сессии — синхронный доступ нужен панели настроек (renderPanel вызывается
// синхронно). Обновляется сам через onAuthStateChange, вручную нигде не пишем.
let cachedSession = null;

// Выход, который делаем мы сами (кнопка «Выйти», удаление аккаунта, сброс
// пароля не удался). Любой другой выход — это Supabase не смог обновить
// токен, потому что сессию отменили на другом устройстве
let signingOutOnPurpose = false;

supabaseClient.auth.onAuthStateChange((event, session) => {
  const wasSignedIn = cachedSession !== null;
  cachedSession = session;
  if (event === "SIGNED_OUT" && wasSignedIn && !signingOutOnPurpose) {
    markSessionEnded();
    location.hash = "#/";
    location.reload();
  }
});

/** Выйти по своей воле — так, чтобы это не приняли за «выкинуло». */
async function signOutOnPurpose(scope) {
  signingOutOnPurpose = true;
  try {
    await supabaseClient.auth.signOut(scope ? { scope } : undefined);
  } finally {
    signingOutOnPurpose = false;
  }
}

/** @returns {Promise<import("@supabase/supabase-js").Session|null>} */
export async function getSession() {
  const { data, error } = await supabaseClient.auth.getSession();
  // Страницу открыли, когда токен уже истёк, а обновить его сервер отказал —
  // сессию отменили, пока сайт был закрыт. Не тихий гостевой режим, а вход
  // с объяснением, как при выходе на открытой странице
  if (!data.session && error?.code?.startsWith("refresh_token")) markSessionEnded();
  cachedSession = data.session;
  return cachedSession;
}

/** Синхронный снимок последней известной сессии — для мест без await (панель настроек). */
export function getCachedSession() {
  return cachedSession;
}

/**
 * Почта для входа: можно ввести только имя Gmail — «berezovecnikita» вместо
 * «berezovecnikita@gmail.com». Нет «@» — это имя, дописываем @gmail.com;
 * полный адрес любой почты остаётся как есть. То же правило на телефоне
 * (myproj-mobile/src/utils/email.ts).
 *
 * Только для входа и сброса пароля, не для регистрации: там догадка
 * «это Gmail» могла бы создать аккаунт на чужой адрес.
 */
export function completeLoginEmail(input) {
  const email = input.trim();
  if (email === "" || email.includes("@")) return email;
  return `${email}@gmail.com`;
}

/** @returns {Promise<{session: object|null, error: object|null}>} */
export async function signInWithPassword(email, password) {
  const { data, error } = await supabaseClient.auth.signInWithPassword({ email, password });
  return { session: data.session, error };
}

/**
 * «Забыли пароль?»: письмо с кодом. Supabase отвечает «отправлено» и для
 * почты без аккаунта — чтобы по ответу нельзя было узнать, чья почта
 * зарегистрирована; поэтому и мы не пишем «такой почты нет».
 * Код в письме — {{ .Token }} в шаблоне Reset Password (нужен свой SMTP).
 * @returns {Promise<object|null>} ошибка Supabase или null
 */
export async function sendResetCode(email) {
  const { error } = await supabaseClient.auth.resetPasswordForEmail(email);
  return error;
}

/**
 * Код из письма — одноразовый вход (type "recovery"): после него человек уже
 * в аккаунте и задаёт новый пароль без старого. Ссылку из письма не берём:
 * с телефона она открылась бы в браузере, а не в приложении, — код один на оба.
 * @returns {Promise<object|null>} ошибка Supabase или null (вошёл с новым паролем)
 */
export async function resetPasswordWithCode(email, code, password) {
  const { error, codeAccepted } = await setPasswordWithCode(email, code, password);
  if (error && codeAccepted) {
    // Код уже принят и человек вошёл, а пароль не сменился (такой же, как
    // старый, слишком короткий). Выходим — иначе он остался бы в аккаунте
    // с тем паролем, который как раз забыл
    await signOutOnPurpose("local");
  }
  return error;
}

/**
 * Новый пароль по коду из письма «Reset Password». Общая часть «Забыли
 * пароль?» и смены пароля в «Аккаунте»: и там и там пароль меняется только
 * с кодом, а код Supabase проверяет всегда.
 * @returns {Promise<{error: object|null, codeAccepted: boolean}>}
 *   codeAccepted — код принят (человек вошёл), даже если пароль потом отвергнут
 */
export async function setPasswordWithCode(email, code, password) {
  const verified = await supabaseClient.auth.verifyOtp({ email, token: code.trim(), type: "recovery" });
  if (verified.error) return { error: verified.error, codeAccepted: false };
  const updated = await supabaseClient.auth.updateUser({ password });
  if (!updated.error) await signOutOtherDevices();
  return { error: updated.error, codeAccepted: true };
}

/**
 * Регистрация, шаг 2: код из письма «Confirm signup». Принят — аккаунт
 * подтверждён и человек сразу вошёл.
 * @returns {Promise<object|null>} ошибка Supabase или null
 */
export async function confirmSignUp(email, code) {
  const { error } = await supabaseClient.auth.verifyOtp({ email, token: code.trim(), type: "signup" });
  return error;
}

/**
 * Смена почты, шаг 2: два кода — из письма на старый адрес и из письма на
 * новый. Каждый код проверяется вместе со своим адресом; почта сменится,
 * когда приняты оба. Порядок не важен.
 * @returns {Promise<{error: object|null, which: "old"|"new"|null}>} which — чей код не подошёл
 */
export async function confirmEmailChange(oldEmail, oldCode, newEmail, newCode) {
  const first = await supabaseClient.auth.verifyOtp({ email: oldEmail, token: oldCode.trim(), type: "email_change" });
  if (first.error) return { error: first.error, which: "old" };
  const second = await supabaseClient.auth.verifyOtp({ email: newEmail, token: newCode.trim(), type: "email_change" });
  if (second.error) return { error: second.error, which: "new" };
  // Сессия со старой почтой — берём свежую, чтобы «Аккаунт» показал новую
  await supabaseClient.auth.refreshSession();
  await signOutOtherDevices();
  return { error: null, which: null };
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
  await signOutOnPurpose();
}

// --- Выход с других устройств -------------------------------------------------
//
// Сменили пароль или почту — остальные устройства выходят из аккаунта
// (решение владельца). Само устройство, где меняли, остаётся.
async function signOutOtherDevices() {
  // Не вышло (нет сети) — пароль или почта всё равно уже сменились, это главное
  await supabaseClient.auth.signOut({ scope: "others" }).catch(() => {});
}

// Флаг для окна входа: человек видит вход не просто так, а потому что его
// выкинуло. Переживает перезагрузку страницы, которая идёт сразу после выхода
const SESSION_ENDED_KEY = "app:sessionEnded";
const SESSION_CHECK_MS = 60_000;

/**
 * Жива ли сессия на сервере. Сама страница этого не знает: токен в браузере
 * выглядит действующим до часа и после того, как сессию отменили (сменили
 * пароль или почту на другом устройстве, удалили аккаунт).
 * @returns {Promise<boolean|null>} null — не удалось спросить (нет сети), это не «вышли»
 */
async function isSessionAlive() {
  const { error } = await supabaseClient.auth.getUser();
  if (!error) return true;
  // Сервер ответил «такой сессии / такого человека нет». Остальное (нет
  // сети, сервер недоступен) — не повод выкидывать
  // 403 session_not_found — сессию отменили; токен истёк, а обновить его
  // нечем — refresh_token_not_found
  const ended =
    error.status === 401 ||
    error.status === 403 ||
    ["session_not_found", "user_not_found", "bad_jwt", "refresh_token_not_found", "refresh_token_already_used"].includes(error.code);
  return ended ? false : null;
}

// После перезагрузки — окно входа (а не тихий гостевой режим) и надпись, почему
function markSessionEnded() {
  clearGuestChosen();
  localStorage.setItem(SESSION_ENDED_KEY, "1");
}

/**
 * Сессию отменили на сервере — выходим и здесь. Окно входа после этого
 * появится само (как после явного «Выйти») и скажет почему.
 * @returns {Promise<boolean>} true — вышли
 */
export async function dropEndedSession() {
  if (!cachedSession) return false;
  if ((await isSessionAlive()) !== false) return false;
  // Только у себя: на сервере сессии уже нет
  await signOutOnPurpose("local").catch(() => {});
  markSessionEnded();
  return true;
}

/** Проверять сессию, пока страница открыта: раз в минуту и при возврате на вкладку. */
export function watchSession() {
  const check = async () => {
    if (!(await dropEndedSession())) return;
    // Как после «Выйти»: на главную и заново — там окно входа
    location.hash = "#/";
    location.reload();
  };
  setInterval(check, SESSION_CHECK_MS);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") check();
  });
}

/** Окно входа спрашивает один раз: выкинуло ли человека. Флаг после этого снят. */
export function takeSessionEndedNotice() {
  const ended = localStorage.getItem(SESSION_ENDED_KEY) === "1";
  localStorage.removeItem(SESSION_ENDED_KEY);
  return ended;
}

/**
 * Как человек входит в аккаунт: "email" (почта + пароль), "google" и т.п.
 * Способов может быть несколько — вошедший через Google может задать пароль
 * и входить ещё и по почте. Supabase хранит список в app_metadata.providers;
 * у старых аккаунтов там бывает только одиночное provider.
 * @returns {string[]}
 */
export function getSignInMethods(session) {
  const meta = session?.user?.app_metadata ?? {};
  if (Array.isArray(meta.providers) && meta.providers.length > 0) return meta.providers;
  return meta.provider ? [meta.provider] : [];
}

/** Есть ли у аккаунта пароль — от этого зависит «сменить» или «задать» пароль. */
export function hasPassword(session) {
  return getSignInMethods(session).includes("email");
}

/**
 * Смена почты, шаг 1. Сразу она не меняется: Supabase шлёт по письму с кодом
 * на старый и на новый адрес, дальше — confirmEmailChange. Повторный вызов
 * отправляет коды заново.
 * @returns {Promise<{error: object|null}>}
 */
export async function changeEmail(newEmail) {
  const { error } = await supabaseClient.auth.updateUser({ email: newEmail });
  return { error };
}

// Фото лежат в Storage папками note-images/{userId}/{noteId}/файл (см.
// supabaseAdapter.js). Удаление аккаунта в базе их не уносит — Supabase не
// даёт удалять файлы SQL-запросом, — поэтому убираем их сами, до удаления.
// list() отдаёт не больше LIST_PAGE строк за раз — читаем страницами.
const PHOTO_BUCKET = "note-images";
const LIST_PAGE = 1000;

async function listAll(folder) {
  const names = [];
  for (let offset = 0; ; offset += LIST_PAGE) {
    const { data, error } = await supabaseClient.storage.from(PHOTO_BUCKET).list(folder, { limit: LIST_PAGE, offset });
    if (error) throw error;
    names.push(...data.map((entry) => entry.name));
    if (data.length < LIST_PAGE) return names;
  }
}

async function deleteAllPhotos(userId) {
  const noteFolders = await listAll(userId);
  for (const noteId of noteFolders) {
    const files = await listAll(`${userId}/${noteId}`);
    if (files.length === 0) continue;
    const { error } = await supabaseClient.storage.from(PHOTO_BUCKET).remove(files.map((name) => `${userId}/${noteId}/${name}`));
    if (error) throw error;
  }
}

/**
 * Удаляет аккаунт насовсем: фото, затем всё остальное функцией
 * delete_my_account (supabase/014_delete_account.sql), затем выход. Выход
 * только локальный: аккаунта на сервере уже нет, выходить там не из чего.
 * @returns {Promise<{error: object|null}>}
 */
export async function deleteAccount() {
  const session = cachedSession ?? (await getSession());
  if (!session) return { error: new Error("not authenticated") };
  try {
    await deleteAllPhotos(session.user.id);
  } catch (error) {
    return { error };
  }
  const { error } = await supabaseClient.rpc("delete_my_account");
  if (error) return { error };
  await signOutOnPurpose("local");
  return { error: null };
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
