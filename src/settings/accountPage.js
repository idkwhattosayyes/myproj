import { t } from "../i18n/i18n.js";
import { escapeAttr, escapeHtml } from "../utils/dom.js";
import { openConfirm } from "../utils/modal.js";
import { getStorage } from "../data/storageAdapter.js";
import { showLoadingOverlay } from "../utils/loadingOverlay.js";
import { openAuthModal } from "../auth/authModal.js";
import {
  getCachedSession,
  getSignInMethods,
  hasPassword,
  changeEmail,
  confirmEmailChange,
  sendResetCode,
  setPasswordWithCode,
  deleteAccount,
  signOut,
  clearGuestChosen,
} from "../auth/authService.js";

// Страницы «Аккаунта» внутри окна настроек: сам аккаунт и три формы под ним.
// Окно и переходы между страницами (стрелка назад, Esc) — в settingsPanel.js;
// здесь только содержимое страницы и что делают её кнопки.
//
// nav — что умеет окно:
//   go(page)  открыть страницу поверх текущей ("email" | "password" | "delete")
//   back()    вернуться на страницу ниже
//   close()   закрыть окно настроек целиком

/** Шапка подстраницы: стрелка назад слева, заголовок, крестик справа. */
function headerHtml(title) {
  return `
    <div class="settings-header">
      <button type="button" class="settings-back" data-action="back" title="${escapeAttr(t("auth.back"))}" aria-label="${escapeAttr(t("auth.back"))}"><i class="ph ph-arrow-left"></i></button>
      <h2 class="settings-title settings-title--sub">${escapeHtml(title)}</h2>
      <button type="button" class="settings-close" data-action="close" title="${escapeAttr(t("settings.close"))}"><i class="ph ph-x"></i></button>
    </div>
  `;
}

/** Строка-кнопка, ведущая дальше или делающая действие. */
function actionRowHtml(action, icon, label, { danger = false, chevron = false, last = false } = {}) {
  return `
    <button type="button" class="settings-row settings-nav-row ${danger ? "is-danger" : ""} ${last ? "settings-row--last" : ""}" data-action="${action}">
      <span class="settings-nav-label"><i class="ph ${icon}"></i><span>${escapeHtml(label)}</span></span>
      ${chevron ? '<i class="ph ph-caret-right settings-nav-chevron"></i>' : ""}
    </button>
  `;
}

function passwordFieldHtml(role, placeholder) {
  return `
    <div class="auth-password-wrap">
      <input type="password" class="modal-input" data-role="${role}" placeholder="${escapeAttr(placeholder)}" autocomplete="${role === "current" ? "current-password" : "new-password"}">
      <button type="button" class="auth-password-toggle" aria-label="${escapeAttr(t("auth.showPassword"))}" title="${escapeAttr(t("auth.showPassword"))}"><i class="ph ph-eye-slash"></i></button>
    </div>
  `;
}

// Тот же глаз, что в окне входа (authModal.js): иконка показывает текущее
// состояние поля — открытый глаз, когда пароль виден
function wirePasswordToggles(scope) {
  scope.querySelectorAll(".auth-password-toggle").forEach((btn) => {
    const input = btn.closest(".auth-password-wrap").querySelector(".modal-input");
    btn.addEventListener("click", () => {
      const reveal = input.type === "password";
      input.type = reveal ? "text" : "password";
      const key = reveal ? "auth.hidePassword" : "auth.showPassword";
      btn.innerHTML = reveal ? '<i class="ph ph-eye"></i>' : '<i class="ph ph-eye-slash"></i>';
      btn.setAttribute("aria-label", t(key));
      btn.title = t(key);
    });
  });
}

// Ошибка из Supabase — подробностью мелким шрифтом после нашего текста: по ней
// видно, что именно не так (слабый пароль, адрес занят, нет миграции 014)
function showError(errorEl, text, detail) {
  errorEl.classList.remove("is-info");
  errorEl.textContent = detail ? `${text} (${detail})` : text;
  errorEl.hidden = false;
  flash(errorEl);
}

// То же место под полями, но другим цветом: «код отправлен ещё раз» — не
// ошибка, а ответ на нажатие
function showHint(errorEl, text) {
  errorEl.classList.add("is-info");
  errorEl.textContent = text;
  errorEl.hidden = false;
  flash(errorEl);
}

// Надпись мигает на каждое нажатие, как ошибка в окне входа (showAuthError в
// authModal.js): текст часто тот же, что был, и без вспышки повторное нажатие
// выглядело бы как «ничего не произошло». Чтение offsetWidth заставляет
// браузер заметить, что класс снимали, — иначе анимация не начнётся заново
function flash(el) {
  el.classList.remove("is-flash");
  void el.offsetWidth;
  el.classList.add("is-flash");
}

// Тот же минимум, что требует Supabase
const MIN_PASSWORD_LENGTH = 6;

// Ошибки кодов из писем, для которых есть понятный текст; остальные — как
// прислал Supabase. email — чей код не подошёл, когда кодов два (смена почты)
function codeErrorText(error, email) {
  const text = `${error.code ?? ""} ${error.message ?? ""}`.toLowerCase();
  // Писем можно отправить немного в час — ограничивают и Supabase, и Gmail
  if (error.status === 429 || text.includes("rate limit") || text.includes("over_email_send_rate_limit")) {
    return t("auth.forgot.rateLimit");
  }
  if (text.includes("otp_expired") || text.includes("token has expired")) {
    return email ? t("account.codeWrongFor").replace("{email}", email) : t("auth.forgot.badCode");
  }
  if (text.includes("same_password") || text.includes("different from the old")) return t("account.samePassword");
  if (text.includes("weak_password")) return t("auth.forgot.weak");
  return error.message;
}

// Стрелка назад и крестик в шапке. renderAccountPage подключает их сам, а
// формы, которые перерисовывают страницу на втором шаге, — этой функцией
function wireHeader(panelEl, nav) {
  panelEl.querySelector('[data-action="back"]').addEventListener("click", nav.back);
  panelEl.querySelector('[data-action="close"]').addEventListener("click", nav.close);
}

function signInMethodLabel(session) {
  const methods = getSignInMethods(session);
  const hasGoogle = methods.includes("google");
  const hasEmail = methods.includes("email");
  if (hasGoogle && hasEmail) return t("account.methodBoth");
  if (hasGoogle) return t("account.methodGoogle");
  return t("account.methodEmail");
}

/**
 * @param {HTMLElement} panelEl
 * @param {"account" | "email" | "password" | "delete"} page
 * @param {{go: (page: string) => void, back: () => void, close: () => void}} nav
 */
export function renderAccountPage(panelEl, page, nav) {
  const session = getCachedSession();
  // Сессия кончилась, пока окно было открыто, — формам аккаунта не на чем
  // работать, показываем гостевую страницу
  const render = session ? PAGES[page] : renderGuest;
  render(panelEl, session, nav);
  panelEl.querySelector('[data-action="back"]').addEventListener("click", nav.back);
  panelEl.querySelector('[data-action="close"]').addEventListener("click", nav.close);
  wirePasswordToggles(panelEl);
  panelEl.querySelector("input")?.focus();
}

// --- Страница «Аккаунт» -----------------------------------------------------

function renderAccount(panelEl, session, nav) {
  const email = session.user.email ?? "";
  // Почта в процессе смены: письма отправлены, но подтверждены ещё не оба
  const pendingEmail = session.user.new_email;
  const canChangeEmail = hasPassword(session);
  panelEl.innerHTML = `
    ${headerHtml(t("account.title"))}
    <div class="settings-row settings-account-row">
      <i class="ph ph-user-circle settings-account-icon"></i>
      <div class="settings-account-info">
        <span class="settings-label settings-account-email" title="${escapeAttr(email)}">${escapeHtml(email)}</span>
        <span class="settings-account-hint">${escapeHtml(signInMethodLabel(session))}</span>
        ${pendingEmail ? `<span class="settings-account-hint">${escapeHtml(t("account.emailPending").replace("{email}", pendingEmail))}</span>` : ""}
      </div>
    </div>
    ${canChangeEmail ? actionRowHtml("change-email", "ph-envelope-simple", t("account.changeEmail"), { chevron: true }) : ""}
    ${actionRowHtml("change-password", "ph-password", hasPassword(session) ? t("account.changePassword") : t("account.setPassword"), { chevron: true })}
    ${actionRowHtml("logout", "ph-sign-out", t("auth.logout"))}
    ${actionRowHtml("clear-data", "ph-eraser", t("settings.clearData"), { danger: true })}
    ${actionRowHtml("delete-account", "ph-trash-simple", t("account.delete"), { danger: true, chevron: true, last: true })}
  `;

  panelEl.querySelector('[data-action="change-email"]')?.addEventListener("click", () => nav.go("email"));
  panelEl.querySelector('[data-action="change-password"]').addEventListener("click", () => nav.go("password"));
  panelEl.querySelector('[data-action="delete-account"]').addEventListener("click", () => nav.go("delete"));
  panelEl.querySelector('[data-action="clear-data"]').addEventListener("click", () => clearAllData(nav));

  panelEl.querySelector('[data-action="logout"]').addEventListener("click", async () => {
    nav.close();
    await signOut();
    // Явный логаут — единственное, что обязано снова показать экран
    // авторизации при следующей загрузке, даже если раньше был выбран гость.
    clearGuestChosen();
    // Как и при логине — после выхода всегда на главную, а не там, где
    // стояли настройки.
    location.hash = "#/";
    location.reload();
  });
}

function renderGuest(panelEl, _session, nav) {
  panelEl.innerHTML = `
    ${headerHtml(t("account.title"))}
    <div class="settings-row settings-account-row">
      <i class="ph ph-user-circle settings-account-icon"></i>
      <div class="settings-account-info">
        <span class="settings-label">${escapeHtml(t("account.guest"))}</span>
        <span class="settings-account-hint">${escapeHtml(t("account.guestHint"))}</span>
      </div>
    </div>
    ${actionRowHtml("login", "ph-sign-in", t("auth.loginRegister"))}
    ${actionRowHtml("clear-data", "ph-eraser", t("settings.clearData"), { danger: true, last: true })}
  `;

  panelEl.querySelector('[data-action="clear-data"]').addEventListener("click", () => clearAllData(nav));
  panelEl.querySelector('[data-action="login"]').addEventListener("click", async () => {
    nav.close();
    await openAuthModal();
    if (getCachedSession()) {
      // Владелец может залогиниться из любого раздела — после входа всегда
      // должен оказаться на главной, а не там, где стояли настройки.
      location.hash = "#/";
      location.reload();
    }
  });
}

async function clearAllData(nav) {
  nav.close();
  const ok = await openConfirm({ message: t("settings.clearDataConfirm") });
  if (!ok) return;
  await getStorage().clearAll();
  location.reload();
}

// --- Сменить почту ------------------------------------------------------------

function renderEmail(panelEl, session, nav) {
  const current = session.user.email ?? "";
  panelEl.innerHTML = `
    ${headerHtml(t("account.changeEmail"))}
    <div class="settings-form">
      <p class="settings-form-hint">${escapeHtml(t("account.emailCurrent").replace("{email}", current))}</p>
      <input type="email" class="modal-input" data-role="email" placeholder="${escapeAttr(t("account.emailNew"))}" autocomplete="email">
      <p class="auth-error" data-role="error" hidden></p>
      <button type="button" class="btn btn-accent settings-form-btn" data-action="submit">${t("account.emailSend")}</button>
    </div>
  `;

  const input = panelEl.querySelector('[data-role="email"]');
  const errorEl = panelEl.querySelector('[data-role="error"]');
  const submitBtn = panelEl.querySelector('[data-action="submit"]');

  async function submit() {
    const next = input.value.trim();
    if (!next || !next.includes("@")) return showError(errorEl, t("account.emailInvalid"));
    if (next.toLowerCase() === current.toLowerCase()) return showError(errorEl, t("account.emailSame"));
    submitBtn.disabled = true;
    const { error } = await changeEmail(next);
    submitBtn.disabled = false;
    if (error) return showError(errorEl, t("account.emailFailed"), error.message);
    renderEmailCodes(panelEl, nav, current, next);
  }

  submitBtn.addEventListener("click", submit);
  input.addEventListener("keydown", (event) => {
    if (event.key === "Enter") submit();
  });
}

// Смена почты, шаг 2: коды из писем на старый и на новый адрес. Два кода,
// а не один: так почту не сменит тот, у кого есть только один из ящиков
function renderEmailCodes(panelEl, nav, oldEmail, newEmail) {
  panelEl.innerHTML = `
    ${headerHtml(t("account.changeEmail"))}
    <div class="settings-form">
      <p class="settings-form-hint">${escapeHtml(t("account.emailCodesSent").replace("{oldEmail}", oldEmail).replace("{newEmail}", newEmail))}</p>
      <input type="text" class="modal-input" data-role="old-code" inputmode="numeric" autocomplete="one-time-code" placeholder="${escapeAttr(t("account.codeFrom").replace("{email}", oldEmail))}">
      <input type="text" class="modal-input" data-role="new-code" inputmode="numeric" autocomplete="one-time-code" placeholder="${escapeAttr(t("account.codeFrom").replace("{email}", newEmail))}">
      <p class="auth-error" data-role="error" hidden></p>
      <div class="settings-form-buttons">
        <button type="button" class="btn btn-accent settings-form-btn" data-action="submit">${escapeHtml(t("account.emailConfirm"))}</button>
        <button type="button" class="btn settings-form-btn" data-action="resend">${escapeHtml(t("account.resendCodes"))}</button>
      </div>
    </div>
  `;
  wireHeader(panelEl, nav);

  const oldCodeInput = panelEl.querySelector('[data-role="old-code"]');
  const newCodeInput = panelEl.querySelector('[data-role="new-code"]');
  const errorEl = panelEl.querySelector('[data-role="error"]');
  const submitBtn = panelEl.querySelector('[data-action="submit"]');
  const resendBtn = panelEl.querySelector('[data-action="resend"]');

  async function submit() {
    if (!oldCodeInput.value.trim() || !newCodeInput.value.trim()) {
      return showError(errorEl, t("account.codesEmpty"));
    }
    submitBtn.disabled = true;
    const { error, which } = await confirmEmailChange(oldEmail, oldCodeInput.value, newEmail, newCodeInput.value);
    submitBtn.disabled = false;
    if (error) {
      // Говорим, какой из двух кодов не подошёл, — иначе непонятно, что исправлять
      const email = which === "old" ? oldEmail : newEmail;
      return showError(errorEl, codeErrorText(error, email));
    }
    renderDone(panelEl, nav, t("account.changeEmail"), t("account.emailChanged").replace("{email}", newEmail));
  }

  async function resend() {
    resendBtn.disabled = true;
    const { error } = await changeEmail(newEmail);
    resendBtn.disabled = false;
    if (error) return showError(errorEl, codeErrorText(error));
    showHint(errorEl, t("account.codesResent"));
  }

  submitBtn.addEventListener("click", submit);
  resendBtn.addEventListener("click", resend);
  newCodeInput.addEventListener("keydown", (event) => {
    if (event.key === "Enter") submit();
  });
  oldCodeInput.focus();
}

// --- Сменить / задать пароль ----------------------------------------------------

// Пароль меняется только с кодом из письма — тем же, что у «Забыли пароль?».
// Текущий пароль не спрашиваем: код подтверждает, что это хозяин почты, и
// так же работает для вошедшего через Google, у которого пароля ещё нет
function renderPassword(panelEl, session, nav) {
  const email = session.user.email ?? "";
  const title = hasPassword(session) ? t("account.changePassword") : t("account.setPassword");
  panelEl.innerHTML = `
    ${headerHtml(title)}
    <div class="settings-form">
      ${hasPassword(session) ? "" : `<p class="settings-form-hint">${escapeHtml(t("account.setPasswordHint"))}</p>`}
      <p class="settings-form-hint">${escapeHtml(t("account.passwordCodeHint").replace("{email}", email))}</p>
      <p class="auth-error" data-role="error" hidden></p>
      <button type="button" class="btn btn-accent settings-form-btn" data-action="send">${escapeHtml(t("auth.forgot.sendCode"))}</button>
    </div>
  `;

  const errorEl = panelEl.querySelector('[data-role="error"]');
  const sendBtn = panelEl.querySelector('[data-action="send"]');
  sendBtn.addEventListener("click", async () => {
    sendBtn.disabled = true;
    const error = await sendResetCode(email);
    sendBtn.disabled = false;
    if (error) return showError(errorEl, codeErrorText(error));
    renderPasswordCode(panelEl, nav, email, title);
  });
}

// Смена пароля, шаг 2: код из письма и новый пароль дважды
function renderPasswordCode(panelEl, nav, email, title) {
  panelEl.innerHTML = `
    ${headerHtml(title)}
    <div class="settings-form">
      <p class="settings-form-hint">${escapeHtml(t("auth.forgot.codeSent").replace("{email}", email))}</p>
      <input type="text" class="modal-input" data-role="code" inputmode="numeric" autocomplete="one-time-code" placeholder="${escapeAttr(t("auth.forgot.code"))}">
      ${passwordFieldHtml("new", t("account.passwordNew"))}
      ${passwordFieldHtml("repeat", t("auth.confirmPassword"))}
      <p class="auth-error" data-role="error" hidden></p>
      <div class="settings-form-buttons">
        <button type="button" class="btn btn-accent settings-form-btn" data-action="submit">${escapeHtml(title)}</button>
        <button type="button" class="btn settings-form-btn" data-action="resend">${escapeHtml(t("auth.forgot.resend"))}</button>
      </div>
    </div>
  `;
  wireHeader(panelEl, nav);
  wirePasswordToggles(panelEl);

  const field = (role) => panelEl.querySelector(`[data-role="${role}"]`);
  const errorEl = field("error");
  const submitBtn = panelEl.querySelector('[data-action="submit"]');
  const resendBtn = panelEl.querySelector('[data-action="resend"]');

  async function submit() {
    const next = field("new").value;
    if (!field("code").value.trim()) return showError(errorEl, t("auth.forgot.codeEmpty"));
    // Проверяем до отправки: код одноразовый, и если пароль отвергнут уже
    // после него, понадобится новый код
    if (next.length < MIN_PASSWORD_LENGTH) return showError(errorEl, t("auth.forgot.weak"));
    if (next !== field("repeat").value) return showError(errorEl, t("auth.errorPasswordMismatch"));
    submitBtn.disabled = true;
    const { error } = await setPasswordWithCode(email, field("code").value, next);
    submitBtn.disabled = false;
    if (error) return showError(errorEl, codeErrorText(error));
    renderDone(panelEl, nav, title, t("account.passwordChanged"));
  }

  async function resend() {
    resendBtn.disabled = true;
    const error = await sendResetCode(email);
    resendBtn.disabled = false;
    if (error) return showError(errorEl, codeErrorText(error));
    showHint(errorEl, t("account.codesResent"));
  }

  submitBtn.addEventListener("click", submit);
  resendBtn.addEventListener("click", resend);
  field("repeat").addEventListener("keydown", (event) => {
    if (event.key === "Enter") submit();
  });
  field("code").focus();
}

// --- Удалить аккаунт ------------------------------------------------------------

function renderDelete(panelEl, session, nav) {
  const email = session.user.email ?? "";
  panelEl.innerHTML = `
    ${headerHtml(t("account.delete"))}
    <div class="settings-form">
      <p class="settings-form-hint">${escapeHtml(t("account.deleteWarning"))}</p>
      <p class="settings-form-hint">${escapeHtml(t("account.deleteTypeEmail").replace("{email}", email))}</p>
      <input type="email" class="modal-input" data-role="email" placeholder="${escapeAttr(email)}" autocomplete="off">
      <p class="auth-error" data-role="error" hidden></p>
      <button type="button" class="btn btn-danger settings-form-btn" data-action="submit" disabled>${t("account.deleteForever")}</button>
    </div>
  `;

  const input = panelEl.querySelector('[data-role="email"]');
  const errorEl = panelEl.querySelector('[data-role="error"]');
  const submitBtn = panelEl.querySelector('[data-action="submit"]');
  // Кнопка оживает, только когда почта введена точно — регистр не важен,
  // пробелы по краям тоже: их легко занести при копировании
  const matches = () => input.value.trim().toLowerCase() === email.toLowerCase();
  input.addEventListener("input", () => {
    submitBtn.disabled = !matches();
  });

  async function submit() {
    if (!matches()) return;
    submitBtn.disabled = true;
    errorEl.hidden = true;
    const hideLoading = showLoadingOverlay();
    const { error } = await deleteAccount();
    hideLoading();
    if (error) {
      submitBtn.disabled = false;
      return showError(errorEl, t("account.deleteFailed"), error.message);
    }
    nav.close();
    // Как после выхода: при следующей загрузке снова экран входа, и на главную
    clearGuestChosen();
    location.hash = "#/";
    location.reload();
  }

  submitBtn.addEventListener("click", submit);
  input.addEventListener("keydown", (event) => {
    if (event.key === "Enter") submit();
  });
}

// Итог формы вместо самой формы — кнопка «Готово» возвращает в «Аккаунт»
function renderDone(panelEl, nav, title, message) {
  panelEl.innerHTML = `
    ${headerHtml(title)}
    <div class="settings-form">
      <p class="settings-form-hint">${escapeHtml(message)}</p>
      <button type="button" class="btn btn-accent settings-form-btn" data-action="done">${t("account.done")}</button>
    </div>
  `;
  wireHeader(panelEl, nav);
  panelEl.querySelector('[data-action="done"]').addEventListener("click", nav.back);
  panelEl.querySelector('[data-action="done"]').focus();
}

const PAGES = {
  account: renderAccount,
  email: renderEmail,
  password: renderPassword,
  delete: renderDelete,
};
