/* =========================================================
   AUTH — invite-only login / logout / session gating
   Does NOT touch your existing HTML/CSS. It injects a minimal
   login overlay purely in JS/inline-style, shows it until a
   session exists, then calls window.onAuthReady(user) once —
   your script.js's init() hooks into that instead of running
   on DOMContentLoaded directly.

   PUBLIC SIGN-UP IS DISABLED. The only ways in are:
     1. Login with an existing email + password.
     2. Clicking a Supabase "invite" email link -> lands here
        with an active session and is asked to set a password.
     3. Clicking a "forgot password" recovery email link -> same
        set-password screen, tied to their existing account.
   ========================================================= */

(function () {
  'use strict';

  const Auth = {
    session: null,
    user: null,
  };

  // ---------- detect invite / recovery links ----------
  // Supabase appends #access_token=...&type=invite (or type=recovery)
  // to the redirect URL. We read `type` once on load so we know to
  // show the "set your password" screen instead of the normal login
  // form once detectSessionInUrl (in supabase-client.js) finishes
  // turning that link into a real session.
  function getHashType() {
    const hash = window.location.hash.startsWith('#') ? window.location.hash.slice(1) : '';
    if (!hash) return null;
    const params = new URLSearchParams(hash);
    return params.get('type'); // 'invite' | 'recovery' | null
  }
  let pendingAuthType = getHashType();

  function clearUrlHash() {
    history.replaceState(null, '', window.location.pathname + window.location.search);
  }

  // ---------- core auth actions ----------
  // NOTE: signUp() has been intentionally removed. Public self-registration
  // is disabled — new users only get access via a Supabase invite email.

  async function signIn(email, password) {
    const { data, error } = await window.sb.auth.signInWithPassword({ email, password });
    if (error) throw error;
    return data;
  }

  async function signOut() {
    const { error } = await window.sb.auth.signOut();
    if (error) throw error;
  }

  async function getSession() {
    const { data, error } = await window.sb.auth.getSession();
    if (error) throw error;
    return data.session;
  }

  async function sendPasswordReset(email) {
    const redirectTo = window.location.origin + window.location.pathname;
    const { error } = await window.sb.auth.resetPasswordForEmail(email, { redirectTo });
    if (error) throw error;
  }

  async function setNewPassword(password) {
    const { error } = await window.sb.auth.updateUser({ password });
    if (error) throw error;
  }

  // ---------- minimal auth overlay (JS-injected, not part of your CSS system) ----------

  function injectStyles() {
    if (document.getElementById('auth-gate-styles')) return;
    const style = document.createElement('style');
    style.id = 'auth-gate-styles';
    style.textContent = `
      #auth-gate {
        position: fixed; inset: 0; z-index: 99999;
        display: flex; align-items: center; justify-content: center;
        background: #0b0e14; font-family: inherit;
      }
      #auth-gate .auth-card {
        width: 340px; max-width: 90vw; padding: 28px;
        background: #12151c; border: 1px solid #232838; border-radius: 12px;
        color: #e6e8ee;
      }
      #auth-gate h2 { margin: 0 0 4px; font-size: 18px; }
      #auth-gate p.sub { margin: 0 0 18px; font-size: 13px; color: #8a90a2; }
      #auth-gate input {
        width: 100%; box-sizing: border-box; padding: 10px 12px; margin-bottom: 10px;
        background: #0b0e14; border: 1px solid #232838; border-radius: 8px;
        color: #e6e8ee; font-size: 14px;
      }
      #auth-gate button {
        width: 100%; padding: 10px 12px; margin-top: 4px; border: none; border-radius: 8px;
        background: #3b82f6; color: #fff; font-size: 14px; font-weight: 600; cursor: pointer;
      }
      #auth-gate button.secondary { background: transparent; color: #8a90a2; margin-top: 10px; }
      #auth-gate .err { color: #f87171; font-size: 12.5px; min-height: 16px; margin-top: 6px; }
      #auth-gate .msg { color: #34d399; font-size: 12.5px; min-height: 16px; margin-top: 6px; }
    `;
    document.head.appendChild(style);
  }

  function getGateEl() {
    injectStyles();
    let gate = document.getElementById('auth-gate');
    if (!gate) {
      gate = document.createElement('div');
      gate.id = 'auth-gate';
      document.body.appendChild(gate);
    }
    return gate;
  }

  // ---------- screen: login (no sign-up option — invite only) ----------
  function renderLogin() {
    const gate = getGateEl();
    gate.innerHTML = `
      <div class="auth-card">
        <h2>Welcome back</h2>
        <p class="sub">Sign in to your FX Journal</p>
        <input type="email" id="auth-email" placeholder="Email" autocomplete="email" />
        <input type="password" id="auth-password" placeholder="Password" autocomplete="current-password" />
        <button id="auth-submit">Log in</button>
        <button class="secondary" id="auth-forgot">Forgot password?</button>
        <div class="err" id="auth-err"></div>
      </div>
    `;
    document.getElementById('auth-submit').addEventListener('click', submitLogin);
    document.getElementById('auth-forgot').addEventListener('click', () => renderForgot());
    document.getElementById('auth-password').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') submitLogin();
    });
  }

  async function submitLogin() {
    const email = document.getElementById('auth-email').value.trim();
    const password = document.getElementById('auth-password').value;
    const errEl = document.getElementById('auth-err');
    errEl.textContent = '';
    if (!email || !password) { errEl.textContent = 'Email and password are required.'; return; }
    try {
      await signIn(email, password);
      hideGate();
      await boot();
    } catch (err) {
      errEl.textContent = err.message || 'Something went wrong.';
    }
  }

  // ---------- screen: forgot password ----------
  function renderForgot() {
    const gate = getGateEl();
    gate.innerHTML = `
      <div class="auth-card">
        <h2>Reset password</h2>
        <p class="sub">Enter your email and we'll send you a reset link.</p>
        <input type="email" id="auth-email" placeholder="Email" autocomplete="email" />
        <button id="auth-submit">Send reset link</button>
        <button class="secondary" id="auth-back">Back to login</button>
        <div class="err" id="auth-err"></div>
        <div class="msg" id="auth-msg"></div>
      </div>
    `;
    document.getElementById('auth-back').addEventListener('click', () => renderLogin());
    document.getElementById('auth-submit').addEventListener('click', async () => {
      const email = document.getElementById('auth-email').value.trim();
      const errEl = document.getElementById('auth-err');
      const msgEl = document.getElementById('auth-msg');
      errEl.textContent = ''; msgEl.textContent = '';
      if (!email) { errEl.textContent = 'Email is required.'; return; }
      try {
        await sendPasswordReset(email);
        msgEl.textContent = 'Check your email for a reset link.';
      } catch (err) {
        errEl.textContent = err.message || 'Something went wrong.';
      }
    });
  }

  // ---------- screen: set password (invite acceptance / recovery) ----------
  function renderSetPassword() {
    const gate = getGateEl();
    const isInvite = pendingAuthType === 'invite';
    gate.innerHTML = `
      <div class="auth-card">
        <h2>${isInvite ? 'Set up your account' : 'Choose a new password'}</h2>
        <p class="sub">${isInvite ? 'Create a password to finish setting up your FX Journal account.' : 'Enter a new password for your account.'}</p>
        <input type="password" id="auth-password" placeholder="New password" autocomplete="new-password" />
        <input type="password" id="auth-password-confirm" placeholder="Confirm password" autocomplete="new-password" />
        <button id="auth-submit">${isInvite ? 'Create account' : 'Update password'}</button>
        <div class="err" id="auth-err"></div>
      </div>
    `;
    document.getElementById('auth-submit').addEventListener('click', submitSetPassword);
    document.getElementById('auth-password-confirm').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') submitSetPassword();
    });
  }

  async function submitSetPassword() {
    const password = document.getElementById('auth-password').value;
    const confirm = document.getElementById('auth-password-confirm').value;
    const errEl = document.getElementById('auth-err');
    errEl.textContent = '';
    if (!password || password.length < 6) { errEl.textContent = 'Password must be at least 6 characters.'; return; }
    if (password !== confirm) { errEl.textContent = 'Passwords do not match.'; return; }
    try {
      await setNewPassword(password);
      pendingAuthType = null;
      clearUrlHash();
      hideGate();
      await boot();
    } catch (err) {
      errEl.textContent = err.message || 'Something went wrong.';
    }
  }

  function showGate(mode) {
    if (mode === 'set-password') renderSetPassword();
    else if (mode === 'forgot') renderForgot();
    else renderLogin();
    getGateEl().style.display = 'flex';
  }

  function hideGate() {
    const gate = document.getElementById('auth-gate');
    if (gate) gate.style.display = 'none';
  }

  // ---------- boot sequence ----------
  // script.js should NOT call its own init() on DOMContentLoaded anymore.
  // Instead it registers window.onAuthReady = init, and this file calls it
  // once a valid session exists. This is the only change required in the
  // boot path of script.js.

  async function boot() {
    const session = await getSession();

    // Invite / recovery link: Supabase already turned the link into a
    // session (detectSessionInUrl in supabase-client.js). Force the
    // set-password screen instead of dropping the user straight into
    // the app with no password of their own.
    if (pendingAuthType && session) {
      showGate('set-password');
      return;
    }

    if (!session) {
      showGate('login');
      return;
    }

    Auth.session = session;
    Auth.user = session.user;
    hideGate();
    if (typeof window.onAuthReady === 'function') {
      window.onAuthReady(Auth.user);
    }
  }

  window.sb.auth.onAuthStateChange((_event, session) => {
    Auth.session = session;
    Auth.user = session ? session.user : null;

    if (_event === 'PASSWORD_RECOVERY') {
      pendingAuthType = 'recovery';
      showGate('set-password');
      return;
    }
    if (!session) {
      showGate('login');
    }
  });

  window.Auth = Object.assign(Auth, { signIn, signOut, getSession, sendPasswordReset, setNewPassword, boot });

  document.addEventListener('DOMContentLoaded', boot);
})();
