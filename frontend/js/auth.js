/* =========================================================
   AUTH — signup / login / logout / session gating
   Does NOT touch your existing HTML/CSS. It injects a minimal
   login overlay purely in JS/inline-style, shows it until a
   session exists, then calls window.onAuthReady(user) once —
   your script.js's init() hooks into that instead of running
   on DOMContentLoaded directly.
   ========================================================= */

(function () {
  'use strict';

  const Auth = {
    session: null,
    user: null,
  };

  // ---------- core auth actions ----------

  async function signUp(email, password) {
    const { data, error } = await window.sb.auth.signUp({ email, password });
    if (error) throw error;
    return data;
  }

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

  // ---------- minimal login overlay (JS-injected, not part of your CSS system) ----------

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
    `;
    document.head.appendChild(style);
  }

  function renderGate(mode) {
    injectStyles();
    let gate = document.getElementById('auth-gate');
    if (!gate) {
      gate = document.createElement('div');
      gate.id = 'auth-gate';
      document.body.appendChild(gate);
    }
    const isSignup = mode === 'signup';
    gate.innerHTML = `
      <div class="auth-card">
        <h2>${isSignup ? 'Create your account' : 'Welcome back'}</h2>
        <p class="sub">${isSignup ? 'Set up your FX Journal account' : 'Sign in to your FX Journal'}</p>
        <input type="email" id="auth-email" placeholder="Email" autocomplete="email" />
        <input type="password" id="auth-password" placeholder="Password" autocomplete="${isSignup ? 'new-password' : 'current-password'}" />
        <button id="auth-submit">${isSignup ? 'Sign up' : 'Log in'}</button>
        <button class="secondary" id="auth-toggle">${isSignup ? 'Already have an account? Log in' : "Don't have an account? Sign up"}</button>
        <div class="err" id="auth-err"></div>
      </div>
    `;
    document.getElementById('auth-toggle').addEventListener('click', () => renderGate(isSignup ? 'login' : 'signup'));
    document.getElementById('auth-submit').addEventListener('click', () => submit(isSignup));
    document.getElementById('auth-password').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') submit(isSignup);
    });
  }

  async function submit(isSignup) {
    const email = document.getElementById('auth-email').value.trim();
    const password = document.getElementById('auth-password').value;
    const errEl = document.getElementById('auth-err');
    errEl.textContent = '';
    if (!email || !password) { errEl.textContent = 'Email and password are required.'; return; }

    try {
      if (isSignup) {
        const data = await signUp(email, password);
        if (!data.session) {
          errEl.style.color = '#8a90a2';
          errEl.textContent = 'Check your email to confirm your account, then log in.';
          return;
        }
      } else {
        await signIn(email, password);
      }
      hideGate();
      await boot();
    } catch (err) {
      errEl.textContent = err.message || 'Something went wrong.';
    }
  }

  function showGate(mode) {
    renderGate(mode || 'login');
    document.getElementById('auth-gate').style.display = 'flex';
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
    if (!session) showGate('login');
  });

  window.Auth = Object.assign(Auth, { signUp, signIn, signOut, getSession, boot });

  document.addEventListener('DOMContentLoaded', boot);
})();
