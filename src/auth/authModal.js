import { t } from "../i18n/i18n.js";
import { pushLayer } from "../utils/escapeLayers.js";
import { escapeAttr } from "../utils/dom.js";
import { signInWithPassword, signUp, signInWithGoogle, setGuestChosen } from "./authService.js";

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
          <button type="button" class="auth-back-btn" data-action="back" aria-label="${t("auth.back")}">←</button>
          <input type="email" class="modal-input" data-role="email" placeholder="${t("auth.email")}" value="${escapeAttr(email)}">
          <input type="password" class="modal-input" data-role="password" placeholder="${t("auth.password")}">
          <p class="auth-error" data-role="error" hidden></p>
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

      const runLogin = async () => {
        email = emailInput.value.trim();
        const { session, error } = await signInWithPassword(email, passwordInput.value);
        if (error || !session) {
          // code "invalid_credentials" — Supabase реально отверг пару email/
          // пароль, тут уместен свой понятный переведённый текст. Любая другая
          // причина (сбой сети — AuthRetryableFetchError без code, недоступен
          // сервер и т.д.) — показываем настоящее сообщение Supabase, а не
          // один и тот же текст про пароль независимо от причины (ТЗ).
          const isBadCredentials = !error || error.code === "invalid_credentials";
          errorEl.textContent = isBadCredentials ? t("auth.errorInvalidCredentials") : error.message;
          errorEl.hidden = false;
          return;
        }
        finish();
      };
      overlay.querySelector('[data-action="login"]').addEventListener("click", runLogin);
      passwordInput.addEventListener("keydown", (event) => {
        if (event.key === "Enter") runLogin();
      });
      emailInput.focus();
    }

    function renderRegister() {
      overlay.innerHTML = `
        <div class="modal-box auth-box">
          <button type="button" class="auth-back-btn" data-action="back" aria-label="${t("auth.back")}">←</button>
          <input type="email" class="modal-input" data-role="email" placeholder="${t("auth.email")}" value="${escapeAttr(email)}">
          <input type="password" class="modal-input" data-role="password" placeholder="${t("auth.password")}">
          <input type="password" class="modal-input" data-role="confirmPassword" placeholder="${t("auth.confirmPassword")}">
          <p class="auth-error" data-role="error" hidden></p>
          <p class="auth-hint" data-role="hint" hidden></p>
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
      const hintEl = overlay.querySelector('[data-role="hint"]');

      overlay.querySelector('[data-action="register"]').addEventListener("click", async () => {
        errorEl.hidden = true;
        hintEl.hidden = true;
        if (passwordInput.value !== confirmInput.value) {
          errorEl.textContent = t("auth.errorPasswordMismatch");
          errorEl.hidden = false;
          return;
        }
        email = emailInput.value.trim();
        const { session, error } = await signUp(email, passwordInput.value);
        if (error) {
          errorEl.textContent = error.message;
          errorEl.hidden = false;
          return;
        }
        if (!session) {
          // В Supabase включено подтверждение email — сразу войти не получится,
          // пока пользователь не перейдёт по ссылке из письма.
          hintEl.textContent = t("auth.checkEmailToConfirm");
          hintEl.hidden = false;
          return;
        }
        finish();
      });
      emailInput.focus();
    }

    // Пока не навешана ни на одну кнопку — Google-провайдер ещё не включён
    // в Supabase (см. .auth-google-btn/.auth-google-overlay в auth.css),
    // код уже готов, останется вернуть addEventListener на обе кнопки.
    async function runGoogle() {
      const { error } = await signInWithGoogle();
      if (!error) return; // успех — браузер уже уходит на страницу Google
      const errorEl = overlay.querySelector('[data-role="error"]');
      errorEl.textContent = error.message;
      errorEl.hidden = false;
    }

    function render() {
      if (step === "start") renderStart();
      else if (step === "login") renderLogin();
      else renderRegister();
    }

    render();
  });
}
