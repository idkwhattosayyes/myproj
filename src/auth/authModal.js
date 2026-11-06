import { t } from "../i18n/i18n.js";
import { pushLayer } from "../utils/escapeLayers.js";
import { escapeAttr, escapeHtml } from "../utils/dom.js";
import {
  completeLoginEmail,
  signInWithPassword,
  signUp,
  signInWithGoogle,
  setGuestChosen,
  sendResetCode,
  resetPasswordWithCode,
  confirmSignUp,
} from "./authService.js";

// Тот же минимум, что требует Supabase
const MIN_PASSWORD_LENGTH = 6;

// Ошибки «Забыли пароль?», для которых есть свой понятный текст. Остальные
// (нет сети, сервер недоступен) — настоящим сообщением Supabase, как при входе
function resetErrorText(error) {
  const text = `${error.code ?? ""} ${error.message ?? ""}`.toLowerCase();
  // Писем можно отправить немного в час — ограничивают и Supabase, и Gmail
  if (error.status === 429 || text.includes("rate limit") || text.includes("over_email_send_rate_limit")) {
    return t("auth.forgot.rateLimit");
  }
  if (text.includes("otp_expired") || text.includes("token has expired")) return t("auth.forgot.badCode");
  if (text.includes("same_password") || text.includes("different from the old")) return t("auth.forgot.samePassword");
  if (text.includes("weak_password")) return t("auth.forgot.weak");
  return error.message;
}

// Переключатель показать/скрыть пароль — общий на все поля пароля модалки
// (login, register password, confirmPassword), у каждого своя кнопка внутри
// .auth-password-wrap. type="button", чтобы не участвовать в сабмите и не
// мешать Enter-обработчику на passwordInput в renderLogin.
function wirePasswordToggles(scope) {
  scope.querySelectorAll(".auth-password-toggle").forEach((btn) => {
    const input = btn.closest(".auth-password-wrap").querySelector(".modal-input");
    btn.addEventListener("click", () => {
      const reveal = input.type === "password";
      input.type = reveal ? "text" : "password";
      const key = reveal ? "auth.hidePassword" : "auth.showPassword";
      // Иконка отражает ТЕКУЩЕЕ состояние поля, а не действие по клику:
      // открытый глаз — пароль виден, закрытый — скрыт (ТЗ).
      btn.innerHTML = reveal ? '<i class="ph ph-eye"></i>' : '<i class="ph ph-eye-slash"></i>';
      btn.setAttribute("aria-label", t(key));
      btn.title = t(key);
    });
  });
}

// Единственная точка показа ошибки в модалке. Просто перезаписать текст мало:
// на повторной неудачной попытке он чаще всего тот же самый (тот же неверный
// пароль), плашка уже показана, и на экране не менялось ни пикселя — выходило,
// будто Enter не сработал и запрос завис. Поэтому каждый показ заново играет
// вспышку.
//
// Перезапуск анимации — тем же приёмом, что подсветка найденной карточки в
// blockTagsBrowser.js: снять класс, заставить браузер пересчитать раскладку
// (чтение offsetWidth), навесить обратно. Без чтения снятие и добавление в
// одной задаче схлопнутся, и анимация не пойдёт.
//
// Мигаем прозрачностью, а не атрибутом hidden: место под плашкой остаётся
// занятым и кнопка входа не прыгает вверх-вниз на каждой попытке.
function showAuthError(errorEl, text) {
  errorEl.classList.remove("is-flash");
  errorEl.textContent = text;
  errorEl.hidden = false;
  void errorEl.offsetWidth;
  errorEl.classList.add("is-flash");
}

/**
 * Экран входа — перед первым рендером раздела, если нет сессии и гость ещё
 * ни разу не выбирал "продолжить как гость" (см. hasChosenGuest), либо по
 * явному клику на "Log in" в настройках.
 * @returns {Promise<void>} резолвится, когда модалка закрылась любым способом
 * (успешный вход/регистрация, гость, Esc, клик снаружи) — дальше можно рендерить сайт.
 */
export function openAuthModal() {
  return new Promise((resolve) => {
    const overlay = document.createElement("div");
    overlay.className = "modal-overlay";
    document.body.appendChild(overlay);

    let step = "start";
    // Email, введённый на шаге логина/регистрации, переживает переключение между ними.
    let email = "";
    // Шаг «Забыли пароль?» в двух видах: сначала почта, после отправки
    // письма — код и новый пароль
    let resetCodeSent = false;

    function finish() {
      unwire();
      overlay.remove();
      resolve();
    }

    // Esc, клик снаружи и явная кнопка "Continue as a guest" — три пути к
    // одному и тому же исходу, и все три запоминают выбор гостя навсегда
    // (см. setGuestChosen): в отличие от успешного логина, это решение не
    // должно спрашиваться заново при каждой перезагрузке.
    function dismissAsGuest() {
      setGuestChosen();
      finish();
    }

    // Тот же паттерн, что в utils/modal.js (private там) и blockTagEditor.js:
    // закрывать можно только по клику, НАЧАВШЕМУСЯ снаружи, и по Esc.
    let pressedOutside = false;
    const onMouseDown = (event) => {
      pressedOutside = event.target === overlay;
    };
    const onClick = (event) => {
      if (pressedOutside && event.target === overlay) dismissAsGuest();
    };
    overlay.addEventListener("mousedown", onMouseDown);
    overlay.addEventListener("click", onClick);
    const unregisterLayer = pushLayer(dismissAsGuest);
    function unwire() {
      overlay.removeEventListener("mousedown", onMouseDown);
      overlay.removeEventListener("click", onClick);
      unregisterLayer();
    }

    function goTo(nextStep) {
      step = nextStep;
      render();
    }

    function renderStart() {
      overlay.innerHTML = `
        <div class="modal-box auth-box">
          <button type="button" class="btn btn-accent auth-btn" data-action="go-login">${t("auth.loginRegister")}</button>
          <button type="button" class="btn auth-btn" data-action="guest">${t("auth.continueGuest")}</button>
        </div>
      `;
      overlay.querySelector('[data-action="go-login"]').addEventListener("click", () => goTo("login"));
      overlay.querySelector('[data-action="guest"]').addEventListener("click", dismissAsGuest);
    }

    function renderLogin() {
      overlay.innerHTML = `
        <div class="modal-box auth-box">
          <button type="button" class="auth-back-btn" data-action="back" aria-label="${t("auth.back")}"><i class="ph ph-arrow-left"></i></button>
          <input type="email" class="modal-input" data-role="email" placeholder="${t("auth.email")}" value="${escapeAttr(email)}">
          <div class="auth-password-wrap">
            <input type="password" class="modal-input" data-role="password" placeholder="${t("auth.password")}">
            <button type="button" class="auth-password-toggle" aria-label="${escapeAttr(t("auth.showPassword"))}" title="${escapeAttr(t("auth.showPassword"))}"><i class="ph ph-eye-slash"></i></button>
          </div>
          <div class="auth-under-password">
            <p class="auth-error" data-role="error" hidden></p>
            <button type="button" class="auth-link" data-action="forgot">${t("auth.forgot.link")}</button>
          </div>
          <button type="button" class="btn btn-accent auth-btn" data-action="login">${t("auth.login")}</button>
          <div class="auth-split-row">
            <button type="button" class="btn auth-google-btn" data-action="google">
              ${t("auth.loginFromServices")}
              <span class="auth-google-overlay">${t("home.aiUnavailable")}</span>
            </button>
            <button type="button" class="btn" data-action="go-register">${t("auth.register")}</button>
          </div>
        </div>
      `;
      overlay.querySelector('[data-action="back"]').addEventListener("click", () => goTo("start"));
      overlay.querySelector('[data-action="go-register"]').addEventListener("click", () => goTo("register"));

      const emailInput = overlay.querySelector('[data-role="email"]');
      const passwordInput = overlay.querySelector('[data-role="password"]');
      const errorEl = overlay.querySelector('[data-role="error"]');

      // Уже введённую почту берём с собой — второй раз не набирать
      overlay.querySelector('[data-action="forgot"]').addEventListener("click", () => {
        email = emailInput.value.trim();
        resetCodeSent = false;
        goTo("forgot");
      });

      const runLogin = async () => {
        // Можно ввести только имя Gmail — см. completeLoginEmail
        email = completeLoginEmail(emailInput.value);
        const { session, error } = await signInWithPassword(email, passwordInput.value);
        if (error || !session) {
          // code "invalid_credentials" — Supabase реально отверг пару email/
          // пароль, тут уместен свой понятный переведённый текст. Любая другая
          // причина (сбой сети — AuthRetryableFetchError без code, недоступен
          // сервер и т.д.) — показываем настоящее сообщение Supabase, а не
          // один и тот же текст про пароль независимо от причины (ТЗ).
          const isBadCredentials = !error || error.code === "invalid_credentials";
          showAuthError(errorEl, isBadCredentials ? t("auth.errorInvalidCredentials") : error.message);
          return;
        }
        finish();
      };
      overlay.querySelector('[data-action="login"]').addEventListener("click", runLogin);
      passwordInput.addEventListener("keydown", (event) => {
        if (event.key === "Enter") runLogin();
      });
      wirePasswordToggles(overlay);
      emailInput.focus();
    }

    function renderRegister() {
      overlay.innerHTML = `
        <div class="modal-box auth-box">
          <button type="button" class="auth-back-btn" data-action="back" aria-label="${t("auth.back")}"><i class="ph ph-arrow-left"></i></button>
          <input type="email" class="modal-input" data-role="email" placeholder="${t("auth.email")}" value="${escapeAttr(email)}">
          <div class="auth-password-wrap">
            <input type="password" class="modal-input" data-role="password" placeholder="${t("auth.password")}">
            <button type="button" class="auth-password-toggle" aria-label="${escapeAttr(t("auth.showPassword"))}" title="${escapeAttr(t("auth.showPassword"))}"><i class="ph ph-eye-slash"></i></button>
          </div>
          <div class="auth-password-wrap">
            <input type="password" class="modal-input" data-role="confirmPassword" placeholder="${t("auth.confirmPassword")}">
            <button type="button" class="auth-password-toggle" aria-label="${escapeAttr(t("auth.showPassword"))}" title="${escapeAttr(t("auth.showPassword"))}"><i class="ph ph-eye-slash"></i></button>
          </div>
          <p class="auth-error" data-role="error" hidden></p>
          <button type="button" class="btn btn-accent auth-btn" data-action="register">${t("auth.register")}</button>
          <div class="auth-split-row">
            <button type="button" class="btn auth-google-btn" data-action="google">
              ${t("auth.loginFromServices")}
              <span class="auth-google-overlay">${t("home.aiUnavailable")}</span>
            </button>
            <button type="button" class="btn" data-action="back-to-login">${t("auth.backToLogin")}</button>
          </div>
        </div>
      `;
      overlay.querySelector('[data-action="back"]').addEventListener("click", () => goTo("login"));
      overlay.querySelector('[data-action="back-to-login"]').addEventListener("click", () => goTo("login"));

      const emailInput = overlay.querySelector('[data-role="email"]');
      const passwordInput = overlay.querySelector('[data-role="password"]');
      const confirmInput = overlay.querySelector('[data-role="confirmPassword"]');
      const errorEl = overlay.querySelector('[data-role="error"]');

      overlay.querySelector('[data-action="register"]').addEventListener("click", async () => {
        errorEl.hidden = true;
        if (passwordInput.value !== confirmInput.value) {
          showAuthError(errorEl, t("auth.errorPasswordMismatch"));
          return;
        }
        email = emailInput.value.trim();
        const { session, error } = await signUp(email, passwordInput.value);
        if (error) {
          showAuthError(errorEl, error.message);
          return;
        }
        if (!session) {
          // В Supabase включено подтверждение почты: аккаунт создан, но войти
          // можно только с кодом из письма «Confirm signup»
          goTo("confirm-signup");
          return;
        }
        finish();
      });
      wirePasswordToggles(overlay);
      emailInput.focus();
    }

    // Пока не навешана ни на одну кнопку — Google-провайдер ещё не включён
    // в Supabase (см. .auth-google-btn/.auth-google-overlay в auth.css),
    // код уже готов, останется вернуть addEventListener на обе кнопки.
    async function runGoogle() {
      const { error } = await signInWithGoogle();
      if (!error) return; // успех — браузер уже уходит на страницу Google
      showAuthError(overlay.querySelector('[data-role="error"]'), error.message);
    }

    // «Забыли пароль?»: почта → письмо с кодом → код и новый пароль дважды →
    // сразу вошёл. Как на телефоне (ForgotPasswordScreen.tsx)
    function renderForgot() {
      overlay.innerHTML = `
        <div class="modal-box auth-box">
          <button type="button" class="auth-back-btn" data-action="back" aria-label="${escapeAttr(t("auth.back"))}"><i class="ph ph-arrow-left"></i></button>
          <h2 class="auth-title">${escapeHtml(t("auth.forgot.title"))}</h2>
          ${resetCodeSent ? forgotCodeHtml() : forgotEmailHtml()}
          <p class="auth-error" data-role="error" hidden></p>
          <p class="auth-hint" data-role="hint" ${resetCodeSent ? "" : "hidden"}>${resetCodeSent ? escapeHtml(t("auth.forgot.codeSent").replace("{email}", email)) : ""}</p>
          ${
            resetCodeSent
              ? `<button type="button" class="btn btn-accent auth-btn" data-action="save">${escapeHtml(t("auth.forgot.save"))}</button>
                 <button type="button" class="btn auth-btn" data-action="send">${escapeHtml(t("auth.forgot.resend"))}</button>`
              : `<button type="button" class="btn btn-accent auth-btn" data-action="send">${escapeHtml(t("auth.forgot.sendCode"))}</button>`
          }
          <button type="button" class="btn auth-btn" data-action="back-to-login">${escapeHtml(t("auth.backToLogin"))}</button>
        </div>
      `;
      overlay.querySelector('[data-action="back"]').addEventListener("click", () => goTo("login"));
      overlay.querySelector('[data-action="back-to-login"]').addEventListener("click", () => goTo("login"));

      const errorEl = overlay.querySelector('[data-role="error"]');
      const sendButton = overlay.querySelector('[data-action="send"]');
      // Поле почты есть только на первом виде шага; на втором почта уже в email
      const emailInput = overlay.querySelector('[data-role="email"]');

      // «Отправить код» на первом виде и «Отправить ещё раз» на втором
      const sendCode = async () => {
        if (emailInput) email = completeLoginEmail(emailInput.value);
        if (!email) {
          showAuthError(errorEl, t("auth.forgot.emailEmpty"));
          return;
        }
        sendButton.disabled = true;
        const error = await sendResetCode(email);
        sendButton.disabled = false;
        if (error) {
          showAuthError(errorEl, resetErrorText(error));
          return;
        }
        resetCodeSent = true;
        render();
      };
      sendButton.addEventListener("click", sendCode);

      if (!resetCodeSent) {
        emailInput.addEventListener("keydown", (event) => {
          if (event.key === "Enter") sendCode();
        });
        emailInput.focus();
        return;
      }

      const codeInput = overlay.querySelector('[data-role="code"]');
      const passwordInput = overlay.querySelector('[data-role="password"]');
      const confirmInput = overlay.querySelector('[data-role="confirmPassword"]');
      const saveButton = overlay.querySelector('[data-action="save"]');

      const save = async () => {
        if (!codeInput.value.trim()) {
          showAuthError(errorEl, t("auth.forgot.codeEmpty"));
          return;
        }
        // Проверяем до отправки: код одноразовый, и если пароль отвергнут уже
        // после него, понадобится новый код
        if (passwordInput.value.length < MIN_PASSWORD_LENGTH) {
          showAuthError(errorEl, t("auth.forgot.weak"));
          return;
        }
        if (passwordInput.value !== confirmInput.value) {
          showAuthError(errorEl, t("auth.errorPasswordMismatch"));
          return;
        }
        saveButton.disabled = true;
        const error = await resetPasswordWithCode(email, codeInput.value, passwordInput.value);
        saveButton.disabled = false;
        if (error) {
          showAuthError(errorEl, resetErrorText(error));
          return;
        }
        // Вошёл с новым паролем — как после обычного входа
        finish();
      };
      saveButton.addEventListener("click", save);
      confirmInput.addEventListener("keydown", (event) => {
        if (event.key === "Enter") save();
      });
      wirePasswordToggles(overlay);
      codeInput.focus();
    }

    function forgotEmailHtml() {
      return `
        <p class="auth-hint">${escapeHtml(t("auth.forgot.emailHint"))}</p>
        <input type="email" class="modal-input" data-role="email" placeholder="${escapeAttr(t("auth.email"))}" value="${escapeAttr(email)}">
      `;
    }

    function forgotCodeHtml() {
      return `
        <input type="text" class="modal-input" data-role="code" inputmode="numeric" autocomplete="one-time-code" placeholder="${escapeAttr(t("auth.forgot.code"))}">
        <div class="auth-password-wrap">
          <input type="password" class="modal-input" data-role="password" autocomplete="new-password" placeholder="${escapeAttr(t("auth.forgot.newPassword"))}">
          <button type="button" class="auth-password-toggle" aria-label="${escapeAttr(t("auth.showPassword"))}" title="${escapeAttr(t("auth.showPassword"))}"><i class="ph ph-eye-slash"></i></button>
        </div>
        <div class="auth-password-wrap">
          <input type="password" class="modal-input" data-role="confirmPassword" autocomplete="new-password" placeholder="${escapeAttr(t("auth.confirmPassword"))}">
          <button type="button" class="auth-password-toggle" aria-label="${escapeAttr(t("auth.showPassword"))}" title="${escapeAttr(t("auth.showPassword"))}"><i class="ph ph-eye-slash"></i></button>
        </div>
      `;
    }

    // Регистрация, шаг 2: код из письма → аккаунт подтверждён и сразу вход.
    // Код, а не ссылка: ссылка вела бы на адрес сайта, а с телефона его не открыть
    function renderConfirmSignup() {
      overlay.innerHTML = `
        <div class="modal-box auth-box">
          <button type="button" class="auth-back-btn" data-action="back" aria-label="${escapeAttr(t("auth.back"))}"><i class="ph ph-arrow-left"></i></button>
          <h2 class="auth-title">${escapeHtml(t("auth.confirm.title"))}</h2>
          <p class="auth-hint">${escapeHtml(t("auth.confirm.sent").replace("{email}", email))}</p>
          <input type="text" class="modal-input" data-role="code" inputmode="numeric" autocomplete="one-time-code" placeholder="${escapeAttr(t("auth.forgot.code"))}">
          <p class="auth-error" data-role="error" hidden></p>
          <button type="button" class="btn btn-accent auth-btn" data-action="confirm">${escapeHtml(t("auth.confirm.button"))}</button>
          <button type="button" class="btn auth-btn" data-action="back-to-login">${escapeHtml(t("auth.backToLogin"))}</button>
        </div>
      `;
      overlay.querySelector('[data-action="back"]').addEventListener("click", () => goTo("register"));
      overlay.querySelector('[data-action="back-to-login"]').addEventListener("click", () => goTo("login"));

      const codeInput = overlay.querySelector('[data-role="code"]');
      const errorEl = overlay.querySelector('[data-role="error"]');
      const confirmButton = overlay.querySelector('[data-action="confirm"]');

      const confirm = async () => {
        if (!codeInput.value.trim()) {
          showAuthError(errorEl, t("auth.forgot.codeEmpty"));
          return;
        }
        confirmButton.disabled = true;
        const error = await confirmSignUp(email, codeInput.value);
        confirmButton.disabled = false;
        if (error) {
          showAuthError(errorEl, resetErrorText(error));
          return;
        }
        finish();
      };
      confirmButton.addEventListener("click", confirm);
      codeInput.addEventListener("keydown", (event) => {
        if (event.key === "Enter") confirm();
      });
      codeInput.focus();
    }

    function render() {
      if (step === "start") renderStart();
      else if (step === "login") renderLogin();
      else if (step === "forgot") renderForgot();
      else if (step === "confirm-signup") renderConfirmSignup();
      else renderRegister();
    }

    render();
  });
}
