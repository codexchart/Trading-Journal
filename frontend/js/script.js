/* =========================================================
   FX JOURNAL PRO — FULL SYSTEM
   Single source of truth: state.trades
   Everything else auto-derived.
   ========================================================= */

(function () {
  'use strict';

  // ================== STORAGE ==================
  const LS = {
    get(k, d) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch { return d; } },
    set(k, v) { localStorage.setItem(k, JSON.stringify(v)); },
    del(k) { localStorage.removeItem(k); }
  };
  const KEY = 'fx_journal_pro_v2';

  // ================== SCREENSHOT STORAGE (IndexedDB) ==================
  // WHY: base64 screenshots are large. Keeping them inside the single
  // localStorage JSON blob (with everything else) means a handful of
  // screenshots can exceed localStorage's ~5-10MB quota. When that happens
  // localStorage.setItem() throws, and — because trades/accounts/settings
  // all live in that SAME blob — the exception silently blocks EVERY save,
  // not just the screenshot. That's the real root cause behind "my data
  // disappears on refresh". IndexedDB has a far larger practical quota and
  // is built for exactly this kind of binary-ish data, so screenshots are
  // stored there instead, and trades only keep a small reference (shotId).
  const ShotDB = (() => {
    const DB_NAME = 'fx_journal_media';
    const STORE = 'shots';
    let dbPromise = null;
    function open() {
      if (dbPromise) return dbPromise;
      dbPromise = new Promise((resolve, reject) => {
        if (!window.indexedDB) { reject(new Error('IndexedDB unsupported')); return; }
        const req = indexedDB.open(DB_NAME, 1);
        req.onupgradeneeded = () => {
          if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE, { keyPath: 'id' });
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
      return dbPromise;
    }
    function set(id, dataUrl) {
      return open().then(db => new Promise((resolve, reject) => {
        try {
          const tx = db.transaction(STORE, 'readwrite');
          tx.objectStore(STORE).put({ id, data: dataUrl });
          tx.oncomplete = () => resolve(true);
          tx.onerror = () => reject(tx.error);
        } catch (err) { reject(err); }
      })).catch(err => { console.error('ShotDB.set failed', err); return false; });
    }
    function del(id) {
      return open().then(db => new Promise((resolve, reject) => {
        try {
          const tx = db.transaction(STORE, 'readwrite');
          tx.objectStore(STORE).delete(id);
          tx.oncomplete = () => resolve(true);
          tx.onerror = () => reject(tx.error);
        } catch (err) { reject(err); }
      })).catch(() => false);
    }
    function getAll() {
      return open().then(db => new Promise((resolve, reject) => {
        try {
          const tx = db.transaction(STORE, 'readonly');
          const req = tx.objectStore(STORE).getAll();
          req.onsuccess = () => resolve(req.result || []);
          req.onerror = () => reject(req.error);
        } catch (err) { reject(err); }
      })).catch(() => []);
    }
    // Closes the cached connection (if one was ever opened) so the database
    // can actually be dropped. IndexedDB refuses to run deleteDatabase()
    // to completion while any connection to it is still open in this tab —
    // it just sits there firing a 'blocked' event instead. Without this,
    // "Reset All Data" would delete/recreate at wildly different speeds
    // depending on whether a screenshot had been viewed yet this session.
    function closeConnection() {
      if (!dbPromise) return Promise.resolve();
      return dbPromise.then(db => { try { db.close(); } catch (e) {} dbPromise = null; }, () => { dbPromise = null; });
    }
    return { set, del, getAll, closeConnection };
  })();

  // In-memory cache: shotId -> dataURL. Populated from IndexedDB once at
  // startup so every render can stay perfectly synchronous, exactly as
  // before — nothing else in the render pipeline needs to become async.
  const shotCache = new Map();
  function genShotId() { return 'shot_' + Date.now() + '_' + Math.random().toString(36).slice(2, 9); }
  // Resolves the actual <img src> for a screenshot reference, whether it's
  // a locally uploaded image (IndexedDB) or a pasted external URL.
  function getShotSrc(ref) {
    if (!ref) return '';
    if (ref.type === 'upload') return shotCache.get(ref.shotId) || '';
    return ref.data || '';
  }

  // ================== STATE ==================
  const state = {
    settings: { displayName: 'Newton', pipPerLot: 10, defaultBalance: 10000 },
    accounts: [],
    trades: [],
    transactions: [],
    playbook: [],
    rules: [],
    recycleBin: [],
    currentView: 'dashboard',
    timeFilter: 'all',
    marketFilter: 'all',
    performancePeriod: 'daily',
    shotFilter: { search: '', accountId: '' },
    // Global account scope: '' = All Accounts, otherwise an account id.
    // Drives every performance section (Dashboard, Analytics, Calendar,
    // Psychology, Reports, Playbook, Trades) via getScopedTrades()/
    // getScopedAccounts() below, without introducing a second data model —
    // trades/accounts are still the single source of truth, this just
    // narrows which of them a render pass looks at.
    accountFilter: ''
  };

  // Chart.js instance cache (so we can destroy before re-creating)
  const charts = {};

  // ================== UTIL ==================
  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));
  const esc = s => (s == null ? '' : String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' }[c])));
  const num = (v, d = 0) => { const n = parseFloat(v); return isNaN(n) ? d : n; };
  const todayISO = () => new Date().toISOString().slice(0, 10);
  const fmtMoney = (v, d = 2) => (v >= 0 ? '$' : '−$') + Math.abs(v).toFixed(d);
  const fmtPct = (v, d = 1) => `${v >= 0 ? '' : '−'}${Math.abs(v).toFixed(d)}%`;
  const fmtNum = (v, d = 2) => (v == null || isNaN(v) ? '—' : Number(v).toFixed(d));

  function toast(msg, type = '') {
    const t = $('#toast');
    if (!t) return;
    t.textContent = msg;
    t.className = 'toast show' + (type ? ' ' + type : '');
    clearTimeout(t._timer);
    t._timer = setTimeout(() => t.classList.remove('show'), 2400);
  }

  // ================== PERSIST ==================
  let _saveFailed = false;
  // Set while Reset All Data is in flight. save() is also wired to
  // window 'beforeunload'/'visibilitychange' (see init()) as a safety net so
  // in-progress work is never lost — but that same safety net was the actual
  // bug behind "Reset All Data doesn't work": resetAllData() deletes
  // localStorage, then calls location.reload(), and the reload itself fires
  // 'beforeunload'. That handler called save(), which serialized the
  // still-in-memory `state` object (accounts/trades/etc. were never cleared)
  // right back into the localStorage key that had just been deleted — so
  // everything reappeared after the reload. This flag makes save() a no-op
  // for the remainder of the reset, so nothing can resurrect the wiped data.
  let _resetting = false;
  function save() {
    if (_resetting) return;
    try {
      LS.set(KEY, state);
      if (_saveFailed) { _saveFailed = false; updateStorageStatus(); }
    } catch (err) {
      // This used to fail silently, which is the #1 cause of "my data
      // disappeared after refresh" reports. Now it's surfaced to the user
      // and to the console, and older changes already in `state` are kept
      // in memory so the user can still export a JSON backup immediately.
      console.error('Save failed:', err);
      _saveFailed = true;
      toast('Storage is full — latest changes may not be saved. Use Settings → Backup All (JSON) now.', 'error');
      updateStorageStatus();
    }
  }
  function load() {
    const v = LS.get(KEY, null);
    if (v) Object.assign(state, v);
    // ensure all keys exist (in case of older save)
    state.settings = Object.assign({ displayName: 'Newton', pipPerLot: 10, defaultBalance: 10000 }, state.settings || {});
    state.accounts = state.accounts || [];
    state.trades = state.trades || [];
    state.transactions = state.transactions || [];
    state.playbook = state.playbook || [];
    state.rules = state.rules || [];
    state.recycleBin = state.recycleBin || [];
    state.accountFilter = state.accountFilter || '';
    // Migrate older recycle-bin items (flat trade objects) to the new tagged format
    state.recycleBin = state.recycleBin.map(item => {
      if (item && item.type && item.data) return item;
      const { deletedAt, ...rest } = item;
      return { type: 'trade', data: rest, deletedAt: deletedAt || new Date().toISOString() };
    });
  }

  // Older saves stored screenshots inline as `{ type:'upload', data:'<dataURL>' }`
  // directly inside the trade. Move those bytes into IndexedDB and replace the
  // trade's screenshot with a lightweight `{ type:'upload', shotId }` reference,
  // shrinking the localStorage blob dramatically and removing the quota risk.
  function migrateInlineScreenshots() {
    let migrated = false;
    const migrate = (obj) => {
      if (obj && obj.screenshot && obj.screenshot.type === 'upload' && obj.screenshot.data && !obj.screenshot.shotId) {
        const shotId = genShotId();
        shotCache.set(shotId, obj.screenshot.data);
        ShotDB.set(shotId, obj.screenshot.data);
        obj.screenshot = { type: 'upload', shotId };
        migrated = true;
      }
    };
    (state.trades || []).forEach(migrate);
    (state.recycleBin || []).forEach(item => { if (item.type === 'trade') migrate(item.data); });
    if (migrated) save();
  }

  async function preloadShotCache() {
    try {
      const all = await ShotDB.getAll();
      all.forEach(row => shotCache.set(row.id, row.data));
    } catch (err) {
      console.error('Could not preload screenshots from IndexedDB', err);
    }
  }

  function updateStorageStatus() {
    const el = $('#storage-status-text');
    const row = $('#storage-status .storage-row');
    if (!el || !row) return;
    if (_saveFailed) {
      row.classList.add('error');
      el.textContent = 'Storage is full — recent changes may not be saved. Back up your data now.';
      return;
    }
    row.classList.remove('error');
    try {
      const bytes = new Blob([JSON.stringify(state)]).size;
      const kb = (bytes / 1024).toFixed(1);
      el.textContent = `All data saving normally · journal size ~${kb} KB · screenshots stored separately in this browser's local database`;
    } catch {
      el.textContent = 'All data saving normally.';
    }
  }

  // ================== TIME / HEADER ==================
  function tickClock() {
    const now = new Date();
    let h = now.getHours();
    const m = now.getMinutes();
    const s = now.getSeconds();
    const ampm = h >= 12 ? 'PM' : 'AM';
    const h12 = h % 12 || 12;
    const hh = String(h12).padStart(2, '0');
    const mm = String(m).padStart(2, '0');
    const ss = String(s).padStart(2, '0');
    $('#live-clock').textContent = `${hh}:${mm}:${ss}`;
    $('#live-ampm').textContent = ampm;
    $('#live-date').textContent = now.toLocaleDateString(undefined, { day: '2-digit', month: 'short', year: 'numeric' });

    let greet = 'Good Evening';
    if (h >= 5 && h < 12) greet = 'Good Morning';
    else if (h >= 12 && h < 18) greet = 'Good Afternoon';
    else if (h >= 18 && h < 22) greet = 'Good Evening';
    else greet = 'Good Night';
    $('#greeting').textContent = `${greet}, ${state.settings.displayName} 👋`;
    $('#today-date').textContent = now.toLocaleDateString(undefined, { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
  }

  // ================== THEME ==================
  function applyTheme() {
    const isLight = document.body.dataset.theme === 'light';
    $('#theme-icon').className = isLight ? 'fa-solid fa-sun' : 'fa-solid fa-moon';
    $('#theme-label').textContent = 'Light Mode';
    $('#theme-state').textContent = isLight ? 'ON' : 'OFF';
  }
  function initTheme() {
    const saved = LS.get('fx_theme', 'dark');
    document.body.dataset.theme = saved;
    applyTheme();
    $('#theme-btn').addEventListener('click', () => {
      const next = document.body.dataset.theme === 'dark' ? 'light' : 'dark';
      document.body.dataset.theme = next;
      LS.set('fx_theme', next);
      applyTheme();
      // re-render charts so they pick up new palette
      if (state.currentView === 'dashboard') renderDashboard(true);
      if (state.currentView === 'analytics') renderAnalytics(true);
      if (state.currentView === 'psychology') renderPsychology(true);
    });
  }

  // ================== ACCOUNT SCOPE (GLOBAL FILTER) ==================
  // Single choke point every performance-facing render reads through instead
  // of state.trades / state.accounts directly. Trade/account CRUD keeps
  // operating on the full arrays — only display & stats are narrowed here.
  function getScopedTrades() {
    return state.accountFilter ? state.trades.filter(t => t.accountId == state.accountFilter) : state.trades;
  }
  function getScopedAccounts() {
    return state.accountFilter ? state.accounts.filter(a => a.id == state.accountFilter) : state.accounts;
  }
  // Rebuilds the dropdown's options from state.accounts, preserving the
  // current selection if that account still exists (falls back to "All
  // Accounts" if the selected account was deleted/recycled).
  function refreshGlobalAccountFilter() {
    const sel = $('#global-account-filter');
    if (!sel) return;
    const current = state.accountFilter;
    sel.innerHTML = '<option value="">All Accounts</option>' +
      state.accounts.map(a => `<option value="${a.id}">${esc(a.name)} (${esc(a.type)})</option>`).join('');
    const stillExists = current && state.accounts.some(a => a.id == current);
    sel.value = stillExists ? current : '';
    if (!stillExists && current) state.accountFilter = '';
  }
  function initGlobalAccountFilter() {
    const sel = $('#global-account-filter');
    if (!sel) return;
    refreshGlobalAccountFilter();
    sel.addEventListener('change', () => {
      state.accountFilter = sel.value;
      save();
      refreshAll();
    });
  }

  // ================== NAV ==================
  function navigate(view) {
    state.currentView = view;
    $$('.view').forEach(v => v.classList.remove('active'));
    const target = $('#view-' + view);
    if (target) target.classList.add('active');
    $$('.nav-item').forEach(n => n.classList.toggle('active', n.dataset.view === view));

    // Close mobile drawer
    $('#sidebar').classList.remove('mobile-open');
    $('#backdrop').classList.remove('show');

    // Render view-specific
    try {
      if (view === 'dashboard') renderDashboard();
      else if (view === 'calendar') renderCalendar();
      else if (view === 'trades') renderTrades();
      else if (view === 'accounts') renderAccounts();
      else if (view === 'transactions') renderTransactions();
      else if (view === 'analytics') renderAnalytics();
      else if (view === 'screenshots') renderScreenshots();
      else if (view === 'reports') renderReports();
      else if (view === 'psychology') renderPsychology();
      else if (view === 'playbook') renderPlaybook();
      else if (view === 'rules') renderRules();
      else if (view === 'recycle') renderRecycleBin();
      else if (view === 'settings') renderSettings();
    } catch (err) {
      // The tab switch above already happened, so the user isn't stuck —
      // only this one view's content failed to render. Surface it instead
      // of silently leaving a blank page.
      console.error(`Failed to render view "${view}":`, err);
      toast(`Couldn't fully render ${view} — your data is unaffected`, 'error');
    }
  }
  window.FX_navigate = navigate;

  function initNav() {
    $$('.nav-item[data-view]').forEach(b => b.addEventListener('click', () => navigate(b.dataset.view)));
    $$('.q-btn[data-goto]').forEach(b => b.addEventListener('click', () => navigate(b.dataset.goto)));

    $('#collapse-btn').addEventListener('click', () => {
      $('#sidebar').classList.toggle('collapsed');
    });
    $('#hamburger').addEventListener('click', () => {
      $('#sidebar').classList.add('mobile-open');
      $('#backdrop').classList.add('show');
    });
    $('#backdrop').addEventListener('click', () => {
      $('#sidebar').classList.remove('mobile-open');
      $('#backdrop').classList.remove('show');
    });
  }

  // ================== COMBO (CUSTOM DROPDOWN) ==================
  function initCombos(root = document) {
    $$('.combo[data-combo]', root).forEach(combo => {
      const sel = $('[data-combo-select]', combo);
      const inp = $('[data-combo-input]', combo);
      if (!sel || !inp) return;
      sel.addEventListener('change', () => {
        if (sel.value === '__custom__') {
          combo.classList.add('custom-active');
          inp.focus();
        } else {
          combo.classList.remove('custom-active');
        }
      });
    });
  }
  function getComboValue(combo) {
    if (!combo) return '';
    const sel = $('[data-combo-select]', combo);
    const inp = $('[data-combo-input]', combo);
    if (!sel) return '';
    if (sel.value === '__custom__') return (inp.value || '').trim();
    return sel.value || '';
  }
  function setComboValue(combo, value) {
    if (!combo) return;
    const sel = $('[data-combo-select]', combo);
    const inp = $('[data-combo-input]', combo);
    if (!sel) return;
    const opts = Array.from(sel.options).map(o => o.value);
    if (value && opts.includes(value)) {
      sel.value = value;
      combo.classList.remove('custom-active');
    } else if (value) {
      sel.value = '__custom__';
      inp.value = value;
      combo.classList.add('custom-active');
    } else {
      sel.value = '';
      combo.classList.remove('custom-active');
      if (inp) inp.value = '';
    }
  }

  /* =========================================================
   TRADE MATH
   ========================================================= */

function getPipMult(pair) {
  if (!pair) return 0.0001;
  const p = pair.toUpperCase().replace(/[\s\/\-_]/g, '');
  // Crypto
  if (p.includes('BTC')) return 1;
  if (p.includes('ETH')) return 0.1;
  if (p.includes('SOL')) return 0.01;
  if (p.includes('LTC')) return 0.1;
  if (p.includes('XRP')) return 0.001;
  if (p.includes('DOGE')) return 0.0001;
  if (p.includes('BNB')) return 0.01;
  // Commodities
  if (p.includes('XAU') || p.includes('GOLD')) return 0.1;
  if (p.includes('XAG') || p.includes('SILVER')) return 0.01;
  if (p.includes('USOIL') || p.includes('WTI') || p.includes('XTI') || p === 'CL') return 0.01;
  if (p.includes('UKOIL') || p.includes('BRENT') || p.includes('XBR')) return 0.01;
  if (p.includes('NATGAS') || p === 'NG') return 0.001;
  if (p.includes('COPPER') || p.includes('HG')) return 0.0001;
  // Indices
  if (p.includes('US30') || p.includes('DJ30') || p.includes('DOW') || p === 'YM') return 1;
  if (p.includes('NAS') || p.includes('NDX') || p === 'NQ') return 1;
  if (p.includes('SPX') || p.includes('SP500') || p === 'ES') return 0.1;
  if (p.includes('GER') || p.includes('DAX') || p === 'FDAX') return 1;
  if (p.includes('UK100') || p.includes('FTSE') || p === 'Z') return 1;
  if (p.includes('JPN225') || p.includes('NIKKEI') || p === 'N225') return 1;
  if (p.includes('AUS200')) return 1;
  if (p.includes('FRA40') || p.includes('CAC')) return 1;
  if (p.includes('ESP35') || p.includes('IBEX')) return 1;
  if (p.includes('HK50') || p.includes('HSI')) return 1;
  // Forex JPY pairs
  if (p.includes('JPY')) return 0.01;
  // Default: standard forex non-JPY (5-digit broker quote)
  return 0.0001;
}

function getPipValuePerLot(pair) {
  if (!pair) return 10;
  const p = pair.toUpperCase().replace(/[\s\/\-_]/g, '');
  const base = num(state.settings.pipPerLot, 10);
  // Crypto (1 contract = 1 coin typically)
  if (p.includes('BTC')) return 1;
  if (p.includes('ETH')) return 0.1;
  if (p.includes('SOL')) return 1;
  if (p.includes('LTC')) return 0.1;
  if (p.includes('XRP')) return 0.1;
  if (p.includes('BNB')) return 0.1;
  // Commodities — Gold/Silver 1 lot = 100oz/5000oz
  if (p.includes('XAU') || p.includes('GOLD')) return 10;
  if (p.includes('XAG') || p.includes('SILVER')) return 5;
  if (p.includes('USOIL') || p.includes('WTI') || p.includes('XTI') || p === 'CL') return 10;
  if (p.includes('UKOIL') || p.includes('BRENT') || p.includes('XBR')) return 10;
  if (p.includes('NATGAS') || p === 'NG') return 10;
  // Indices — 1 contract = $1 per point
  if (p.includes('US30') || p.includes('DJ30') || p.includes('DOW') || p === 'YM') return 1;
  if (p.includes('NAS') || p.includes('NDX') || p === 'NQ') return 1;
  if (p.includes('SPX') || p.includes('SP500') || p === 'ES') return 1;
  if (p.includes('GER') || p.includes('DAX') || p === 'FDAX') return 1;
  if (p.includes('UK100') || p.includes('FTSE') || p === 'Z') return 1;
  if (p.includes('JPN225') || p.includes('NIKKEI') || p === 'N225') return 1;
  if (p.includes('AUS200')) return 1;
  if (p.includes('FRA40') || p.includes('CAC')) return 1;
  // JPY pairs — 1 pip = ~1000 JPY, scaled by JPY rate (~6.67 USD at 150)
  if (p.includes('JPY')) return 6.7;
  // Standard forex (non-JPY): user setting or default 10
  return base;
}

function getInstrumentLabel(pair) {
  if (!pair) return '';
  const p = pair.toUpperCase().replace(/[\s\/\-_]/g, '');
  if (p.includes('BTC')) return 'Crypto · BTC (pip = $1)';
  if (p.includes('ETH')) return 'Crypto · ETH (pip = $0.10)';
  if (p.includes('SOL')) return 'Crypto · SOL (pip = $1)';
  if (p.includes('XAU') || p.includes('GOLD')) return 'Commodity · Gold (pip = 0.1)';
  if (p.includes('XAG') || p.includes('SILVER')) return 'Commodity · Silver (pip = 0.01)';
  if (p.includes('USOIL') || p.includes('WTI') || p.includes('XTI')) return 'Commodity · WTI Oil';
  if (p.includes('UKOIL') || p.includes('BRENT') || p.includes('XBR')) return 'Commodity · Brent Oil';
  if (p.includes('US30') || p.includes('DJ30') || p.includes('DOW')) return 'Index · US30 (1 pt)';
  if (p.includes('NAS')) return 'Index · NAS100 (1 pt)';
  if (p.includes('SPX') || p.includes('SP500')) return 'Index · SPX500 (0.1 pt)';
  if (p.includes('GER') || p.includes('DAX')) return 'Index · GER40 (1 pt)';
  if (p.includes('UK100') || p.includes('FTSE')) return 'Index · UK100 (1 pt)';
  if (p.includes('JPN225') || p.includes('NIKKEI')) return 'Index · JPN225 (1 pt)';
  if (p.includes('JPY')) return 'Forex · JPY pair (pip = 0.01)';
  if (/^[A-Z]{6}$/.test(p)) return 'Forex pair (pip = 0.0001)';
  return 'Custom instrument (pip = 0.0001)';
}

// Single source of truth for trade metrics
function calcTrade(t) {
  const m = getPipMult(t.pair);
  const pipPerLot = getPipValuePerLot(t.pair);
  const isBuy = (t.direction || 'Buy') === 'Buy';
  const entry = num(t.entry);
  const sl = num(t.sl);
  const tp = num(t.tp);
  const exit = num(t.exit);
  const lot = num(t.lot);

  const acc = t.accountId ? state.accounts.find(a => a.id == t.accountId) : null;
  const balance = acc ? acc.balance : num(t.balance, state.settings.defaultBalance);

  if (!entry || !sl || !lot) return null;

  // Pip Risk (always positive)
  const pipRisk = Math.abs(entry - sl) / m;
  // Pip Reward (potential, to TP)
  const pipReward = tp > 0 ? Math.abs(tp - entry) / m : 0;

  // Risk $ = pipRisk * lot * pipPerLot
  const riskDollar = pipRisk * lot * pipPerLot;

  // Actual outcome — only if exit is provided. No exit = open trade, 0 realized PnL.
  let pnl = 0, pipsResult = 0;
  if (exit > 0) {
    const priceMove = isBuy ? (exit - entry) : (entry - exit);
    pipsResult = priceMove / m;
    pnl = priceMove * lot * (pipPerLot / m);
  }

  const pipsWon = Math.max(0, pipsResult);
  const pipsLost = Math.max(0, -pipsResult);

  const profitDollar = pipsWon * lot * pipPerLot;
  const lossDollar = pipsLost * lot * pipPerLot;

  const riskPct = balance > 0 ? (riskDollar / balance) * 100 : 0;
  const profitPct = balance > 0 ? (profitDollar / balance) * 100 : 0;
  const lossPct = balance > 0 ? (lossDollar / balance) * 100 : 0;

  const rr = pipRisk > 0 && pipReward > 0 ? pipReward / pipRisk : 0;
  const rMultiple = riskDollar > 0 ? pnl / riskDollar : 0;

  return {
    m, pipPerLot, pipRisk, pipReward, pipsWon, pipsLost, pipsResult,
    riskDollar, rewardDollar: pipReward * lot * pipPerLot,
    profitDollar, lossDollar, pnl,
    riskPct, profitPct, lossPct,
    rr, rMultiple, balance,
    open: !exit || exit === 0
  };
}



/* =========================================================
   TRADE FORM
   ========================================================= */

let _screenshotData = null;       // pending screenshot for new/edit trade
let _editingTradeId = null;        // null = new mode; number = editing trade
let _originalTradeSnapshot = null; // snapshot for reversing side-effects on cancel
let _lastEditedId = null;          // for scroll/highlight after save

function initTradeForm() {
  initCombos($('#trade-form'));
  refreshTradeAccountSelect();

  // Default date/time
  const dEl = $('#t-date');
  if (dEl) dEl.value = todayISO();
  const tEl = $('#t-time');
  if (tEl) tEl.value = now12();

  // Pair combo — also live-update when typing in the custom input
  const pairCombo = $$('.combo[data-combo]', $('#trade-form'))[0];
  if (pairCombo) {
    const sel = $('[data-combo-select]', pairCombo);
    const inp = $('[data-combo-input]', pairCombo);
    if (sel) sel.addEventListener('change', updateTradeCalc);
    if (inp) inp.addEventListener('input', updateTradeCalc);
  }

  // Wire live calc for other inputs
  const ids = ['t-direction', 't-entry', 't-sl', 't-tp', 't-exit', 't-lot', 't-balance', 't-current'];
  ids.forEach(id => {
    const el = $('#' + id);
    if (el) {
      el.addEventListener('input', updateTradeCalc);
      if (el.tagName === 'SELECT') el.addEventListener('change', updateTradeCalc);
    }
  });

  // Account select -> fill balance
  $('#t-account').addEventListener('change', () => {
    const id = $('#t-account').value;
    const acc = state.accounts.find(a => a.id == id);
    if (acc) $('#t-balance').value = acc.balance.toFixed(2);
    updateTradeCalc();
  });

  // Screenshot
  $('#t-shot-file').addEventListener('change', handleShotFile);
  $('#t-shot-url').addEventListener('input', handleShotUrl);

  // Save
  $('#save-trade-btn').addEventListener('click', saveTrade);
  $('#reset-trade-btn').addEventListener('click', resetTradeForm);

  // Wire market filter buttons (added by fix)
  initMarketFilter();

  // Trade table row actions — one delegated listener, attached once, so
  // re-rendering the table (renderTrades) never creates duplicate listeners
  // and the View/Edit/Delete buttons always work regardless of whether the
  // row also has a screenshot thumbnail.
  const tradesBody = $('#trades-body');
  if (tradesBody) {
    tradesBody.addEventListener('click', (e) => {
      const shotEl = e.target.closest('[data-shot]');
      if (shotEl) { openShotModal(shotEl.dataset.shot); return; }
      const btn = e.target.closest('[data-action]');
      if (!btn) return;
      const id = btn.dataset.id; // keep as string — trade.id may be a Supabase uuid
      if (btn.dataset.action === 'view') viewTrade(id);
      else if (btn.dataset.action === 'edit') editTrade(id);
      else if (btn.dataset.action === 'delete') deleteTrade(id);
    });
  }
}

// Populates the trade form's Account dropdown from state.accounts, preserving
// whatever was already selected. Was previously called from createAccount()
// and deleteAccount() but never defined anywhere — that ReferenceError halted
// those functions before they could refresh anything, which is why newly
// created accounts never appeared as an option here.
function refreshTradeAccountSelect() {
  const sel = $('#t-account');
  if (!sel) return;
  const cur = sel.value;
  sel.innerHTML = '<option value="">— No account —</option>' +
    state.accounts.map(a => `<option value="${a.id}">${esc(a.name)} (${a.type})</option>`).join('');
  sel.value = cur;
}

function now12() {
  const d = new Date();
  let h = d.getHours();
  const m = d.getMinutes();
  const ampm = h >= 12 ? 'PM' : 'AM';
  h = h % 12 || 12;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')} ${ampm}`;
}

function handleShotFile(e) {
  const file = e.target.files[0];
  if (!file) return;
  if (file.size > 10 * 1024 * 1024) {
    toast('Image is larger than 10MB — please use a smaller screenshot', 'error');
    e.target.value = '';
    return;
  }
  const reader = new FileReader();
  reader.onload = ev => {
    // Reuse the existing shotId when replacing an image on an in-progress edit,
    // otherwise mint a new one.
    const shotId = (_screenshotData && _screenshotData.type === 'upload' && _screenshotData.shotId) ? _screenshotData.shotId : genShotId();
    shotCache.set(shotId, ev.target.result);
    _screenshotData = { type: 'upload', shotId };
    renderShotPreview();
    ShotDB.set(shotId, ev.target.result).then(ok => {
      if (!ok) toast('Warning: screenshot could not be saved to local storage', 'error');
    });
  };
  reader.readAsDataURL(file);
}

function handleShotUrl(e) {
  const url = e.target.value.trim();
  if (url) {
    _screenshotData = { type: 'url', data: url };
    renderShotPreview();
  } else if (_screenshotData && _screenshotData.type === 'url') {
    _screenshotData = null;
    renderShotPreview();
  }
}

function renderShotPreview() {
  const el = $('#t-shot-preview');
  if (!el) return;
  if (!_screenshotData) {
    el.innerHTML = '<span class="empty">No screenshot attached</span>';
    return;
  }
  el.innerHTML = `
    <img src="${esc(getShotSrc(_screenshotData))}" alt="screenshot preview" />
    <button type="button" class="clear-shot" id="clear-shot">Remove</button>
  `;
  $('#clear-shot').addEventListener('click', () => {
    _screenshotData = null;
    $('#t-shot-file').value = '';
    $('#t-shot-url').value = '';
    renderShotPreview();
  });
}

function updateTradeCalc() {
  const pairCombo = $$('.combo[data-combo]', $('#trade-form'))[0];
  const pairVal = pairCombo ? getComboValue(pairCombo).toUpperCase() : '';
  const t = {
    pair: pairVal,
    direction: $('#t-direction').value,
    entry: num($('#t-entry').value),
    sl: num($('#t-sl').value),
    tp: num($('#t-tp').value),
    exit: num($('#t-exit').value),
    lot: num($('#t-lot').value),
    balance: num($('#t-balance').value) || state.settings.defaultBalance,
    accountId: $('#t-account').value
  };
  const currentPrice = num($('#t-current').value);
  const m = calcTrade(t);
  const ind = $('#t-pip-indicator');
  if (ind) ind.textContent = pairVal ? getInstrumentLabel(pairVal) : '';
  if (!m) { clearCalc(); return; }
  $('#c-risk-dollar').textContent = '$' + m.riskDollar.toFixed(2);
  $('#c-reward-dollar').textContent = '$' + m.rewardDollar.toFixed(2);
  $('#c-profit-dollar').textContent = '$' + m.profitDollar.toFixed(2);
  $('#c-loss-dollar').textContent = '$' + m.lossDollar.toFixed(2);
  $('#c-risk-pct').textContent = m.riskPct.toFixed(2) + '%';
  $('#c-profit-pct').textContent = m.profitPct.toFixed(2) + '%';
  $('#c-loss-pct').textContent = m.lossPct.toFixed(2) + '%';
  $('#c-pip-risk').textContent = m.pipRisk.toFixed(1);
  $('#c-pip-reward').textContent = m.pipReward.toFixed(1);
  $('#c-pips-won').textContent = m.pipsWon.toFixed(1);
  $('#c-pips-lost').textContent = m.pipsLost.toFixed(1);
  $('#c-rr').textContent = m.rr > 0 ? m.rr.toFixed(2) : '—';
  $('#c-rmult').textContent = m.rMultiple.toFixed(2);

  // Floating P/L — only shown when no exit AND user typed current price
  const floatEl = $('#c-floating');
  if (floatEl) {
    if (currentPrice > 0 && !t.exit) {
      const isBuy = (t.direction || 'Buy') === 'Buy';
      const priceMove = isBuy ? (currentPrice - t.entry) : (t.entry - currentPrice);
      const pipsFloat = priceMove / m.m;
      const floatPnl = priceMove * num(t.lot) * (m.pipPerLot / m.m);
      const rFloat = m.riskDollar > 0 ? floatPnl / m.riskDollar : 0;
      const cls = floatPnl > 0 ? 'pos' : (floatPnl < 0 ? 'neg' : '');
      floatEl.className = cls;
      floatEl.textContent = `${floatPnl >= 0 ? '+' : ''}$${floatPnl.toFixed(2)} · ${pipsFloat >= 0 ? '+' : ''}${pipsFloat.toFixed(1)} pips · ${rFloat >= 0 ? '+' : ''}${rFloat.toFixed(2)}R`;
    } else if (t.exit) {
      floatEl.className = 'pos';
      floatEl.textContent = 'Closed @ exit';
    } else {
      floatEl.className = '';
      floatEl.textContent = '— (enter current price)';
    }
  }
}

function clearCalc() {
  ['c-risk-dollar', 'c-reward-dollar', 'c-profit-dollar', 'c-loss-dollar',
   'c-risk-pct', 'c-profit-pct', 'c-loss-pct',
   'c-pip-risk', 'c-pip-reward', 'c-pips-won', 'c-pips-lost',
   'c-rr', 'c-rmult'].forEach(id => $('#' + id).textContent = '-');
}

async function saveTrade() {
  const combos = $$('.combo[data-combo]', $('#trade-form'));
  const pair = getComboValue(combos[0]).toUpperCase();
  if (!pair) return toast('Pair is required', 'error');
  const entry = num($('#t-entry').value);
  const sl = num($('#t-sl').value);
  const tp = num($('#t-tp').value);
  const lot = num($('#t-lot').value);
  if (!entry || !sl || !lot) return toast('Entry, Stop Loss, and Lot Size are required', 'error');

  const accId = $('#t-account').value;
  const acc = accId ? state.accounts.find(a => a.id == accId) : null;

  const trade = {
    id: _editingTradeId || null, // new trades get their id from Supabase below (or a local fallback if offline)
    date: $('#t-date').value || todayISO(),
    time: $('#t-time').value || now12(),
    pair,
    direction: $('#t-direction').value,
    market: $('#t-market').value,
    accountId: accId || null,
    accountName: acc ? acc.name : '—',
    strategy: getComboValue(combos[1]),
    session: getComboValue(combos[2]),
    emotion: getComboValue(combos[3]),
    execution: getComboValue(combos[4]),
    mistake: getComboValue(combos[5]),
    grade: getComboValue(combos[6]),
    entry, sl, tp, exit: num($('#t-exit').value), lot,
    notes: $('#t-notes').value.trim(),
    screenshot: _screenshotData ? { ..._screenshotData } : null,
    createdAt: new Date().toISOString()
  };

  const m = calcTrade(trade);
  if (!m) return toast('Could not calculate trade metrics', 'error');

  // Manual Profit/Loss ($) — the only source of truth for the trade's real money result.
  const pnlRaw = $('#t-pnl').value;
  const hasManualPnl = pnlRaw !== '' && pnlRaw !== null && !isNaN(parseFloat(pnlRaw));
  const finalPnl = hasManualPnl ? num(pnlRaw) : 0;
  const finalProfitDollar = finalPnl > 0 ? finalPnl : 0;
  const finalLossDollar = finalPnl < 0 ? -finalPnl : 0;
  const finalProfitPct = (m.balance > 0 && finalPnl > 0) ? (finalPnl / m.balance) * 100 : 0;
  const finalLossPct = (m.balance > 0 && finalPnl < 0) ? (Math.abs(finalPnl) / m.balance) * 100 : 0;
  const finalRMultiple = m.riskDollar > 0 ? finalPnl / m.riskDollar : 0;

  Object.assign(trade, {
    pnl: finalPnl,
    pips: m.pipsResult,
    pipRisk: m.pipRisk,
    pipReward: m.pipReward,
    pipsWon: m.pipsWon,
    pipsLost: m.pipsLost,
    riskDollar: m.riskDollar,
    profitDollar: finalProfitDollar,
    lossDollar: finalLossDollar,
    pnlPct: m.balance > 0 ? (finalPnl / m.balance) * 100 : 0,
    rr: m.rr,
    rMultiple: finalRMultiple,
    riskPct: m.riskPct,
    profitPct: finalProfitPct,
    lossPct: finalLossPct,
    open: !hasManualPnl
  });

  if (_editingTradeId) {
    // EDIT MODE — reverse the original trade's effect on account, then apply new one
    if (_originalTradeSnapshot) {
      const orig = _originalTradeSnapshot;
      if (orig.accountId) {
        const origAcc = state.accounts.find(a => a.id == orig.accountId);
        if (origAcc) origAcc.balance = +(origAcc.balance - orig.pnl).toFixed(2);
      }
    }
    if (acc && trade.pnl !== 0) acc.balance = +(acc.balance + trade.pnl).toFixed(2);

    if (window.DB && window.DB.trades) {
      try { await window.DB.trades.update(trade.id, trade); }
      catch (err) { console.error('Trade update failed, saved locally only:', err); }
    }
    if (acc) await syncAccountBalance(acc);

    const idx = state.trades.findIndex(x => x.id == _editingTradeId);
    if (idx >= 0) state.trades[idx] = trade;
    _lastEditedId = _editingTradeId;
    save();
    toast('Trade updated — Dashboard, Reports, Analytics & Psychology refreshed');
    cancelEdit(true);
    refreshAll();
    // Scroll to the edited row
    setTimeout(() => {
      const row = document.querySelector(`[data-trade-id="${_lastEditedId}"]`);
      if (row) {
        if (row.scrollIntoView) row.scrollIntoView({ behavior: 'smooth', block: 'center' });
        row.style.transition = 'background 0.3s';
        row.style.background = 'rgba(0, 212, 255, 0.18)';
        setTimeout(() => row.style.background = '', 1600);
      }
    }, 80);
  } else {
    // NEW MODE
    if (acc && trade.pnl !== 0) {
      acc.balance = +(acc.balance + trade.pnl).toFixed(2);
      acc.tradesCount = (acc.tradesCount || 0) + 1;
    } else if (acc) {
      acc.tradesCount = (acc.tradesCount || 0) + 1;
    }

    if (window.DB && window.DB.trades) {
      try {
        const saved = await window.DB.trades.insert(trade);
        if (saved && saved.id) trade.id = saved.id;
      } catch (err) { console.error('Trade insert failed, saved locally only:', err); }
    }
    if (!trade.id) trade.id = Date.now() + Math.floor(Math.random() * 1000); // offline fallback only
    if (acc) await syncAccountBalance(acc);

    state.trades.push(trade);
    _lastEditedId = trade.id;
    save();
    toast('Trade saved');
    resetTradeForm();
    refreshAllButTrades();
    renderTrades();
  }
}

function editTrade(id) {
  const t = state.trades.find(x => x.id == id);
  if (!t) return;
  _editingTradeId = id;
  _originalTradeSnapshot = { ...t };
  // Populate form
  $('#t-date').value = t.date || todayISO();
  $('#t-time').value = t.time || now12();
  $('#t-direction').value = t.direction || 'Buy';
  $('#t-market').value = t.market || 'Forex';
  $('#t-entry').value = t.entry;
  $('#t-sl').value = t.sl;
  $('#t-tp').value = t.tp;
  $('#t-exit').value = t.exit || '';
  $('#t-lot').value = t.lot;
  $('#t-balance').value = t.balance ? +t.balance.toFixed(2) : '';
  $('#t-pnl').value = (t.open || t.pnl == null) ? '' : t.pnl;
  $('#t-notes').value = t.notes || '';
  // Account
  if (t.accountId) {
    $('#t-account').value = t.accountId;
  } else {
    $('#t-account').value = '';
  }
  // Combos
  const combos = $$('.combo[data-combo]', $('#trade-form'));
  setComboValue(combos[0], t.pair || '');
  setComboValue(combos[1], t.strategy || '');
  setComboValue(combos[2], t.session || '');
  setComboValue(combos[3], t.emotion || '');
  setComboValue(combos[4], t.execution || '');
  setComboValue(combos[5], t.mistake || '');
  setComboValue(combos[6], t.grade || '');
  // Screenshot
  _screenshotData = t.screenshot ? { ...t.screenshot } : null;
  renderShotPreview();
  // Update button label
  const saveBtn = $('#save-trade-btn');
  if (saveBtn) saveBtn.innerHTML = '<i class="fa-solid fa-rotate"></i> Update Trade';
  // Show cancel button
  let cancelBtn = $('#cancel-edit-btn');
  if (!cancelBtn) {
    cancelBtn = document.createElement('button');
    cancelBtn.type = 'button';
    cancelBtn.id = 'cancel-edit-btn';
    cancelBtn.className = 'btn-ghost';
    cancelBtn.innerHTML = '<i class="fa-solid fa-xmark"></i> Cancel Edit';
    $('#reset-trade-btn').after(cancelBtn);
    cancelBtn.addEventListener('click', () => cancelEdit(false));
  }
  cancelBtn.style.display = '';
  // Banner
  showEditBanner(t);
  updateTradeCalc();
  // Switch to trades view if not there
  if (state.currentView !== 'trades') navigate('trades');
  // Scroll to form
  const formEl = $('#trade-form');
  if (formEl && formEl.scrollIntoView) formEl.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function cancelEdit(silent) {
  _editingTradeId = null;
  _originalTradeSnapshot = null;
  const saveBtn = $('#save-trade-btn');
  if (saveBtn) saveBtn.innerHTML = '<i class="fa-solid fa-floppy-disk"></i> Save Trade';
  const cancelBtn = $('#cancel-edit-btn');
  if (cancelBtn) cancelBtn.style.display = 'none';
  hideEditBanner();
  resetTradeForm();
  if (!silent) toast('Edit cancelled');
}

function showEditBanner(t) {
  let banner = $('#edit-banner');
  if (!banner) {
    banner = document.createElement('div');
    banner.id = 'edit-banner';
    banner.className = 'edit-banner';
    const titleEl = $('#trade-form');
    titleEl.parentNode.insertBefore(banner, titleEl);
  }
  banner.innerHTML = `<i class="fa-solid fa-pen-to-square"></i> Editing trade: <strong>${esc(t.pair)}</strong> on ${esc(t.date)} &middot; <button id="cancel-edit-banner" class="banner-cancel">Cancel</button>`;
  banner.style.display = 'flex';
  $('#cancel-edit-banner').addEventListener('click', () => cancelEdit(false));
}

function hideEditBanner() {
  const banner = $('#edit-banner');
  if (banner) banner.style.display = 'none';
}

function balancePct(m, acc) {
  const bal = acc ? acc.balance : m.balance;
  return bal > 0 ? (m.pnl / bal) * 100 : 0;
}

function resetTradeForm() {
  $('#t-date').value = todayISO();
  $('#t-time').value = now12();
  $('#t-entry').value = '';
  $('#t-sl').value = '';
  $('#t-tp').value = '';
  $('#t-exit').value = '';
  $('#t-lot').value = '';
  $('#t-current').value = '';
  $('#t-pnl').value = '';
  $('#t-notes').value = '';
  $('#t-shot-file').value = '';
  $('#t-shot-url').value = '';
  _screenshotData = null;
  renderShotPreview();
  // reset combos
  $$('.combo[data-combo]', $('#trade-form')).forEach(c => setComboValue(c, ''));
  // refresh account balance
  const accId = $('#t-account').value;
  const acc = state.accounts.find(a => a.id == accId);
  if (acc) $('#t-balance').value = acc.balance.toFixed(2);
  const ind = $('#t-pip-indicator'); if (ind) ind.textContent = '';
  clearCalc();
  // Reset edit mode UI
  _editingTradeId = null;
  _originalTradeSnapshot = null;
  const saveBtn = $('#save-trade-btn');
  if (saveBtn) saveBtn.innerHTML = '<i class="fa-solid fa-floppy-disk"></i> Save Trade';
  const cancelBtn = $('#cancel-edit-btn');
  if (cancelBtn) cancelBtn.style.display = 'none';
  hideEditBanner();
}



/* =========================================================
   TRADE TABLE — Render rows + wire view/edit/delete
   ========================================================= */

function renderTrades() {
  const tbody = $('#trades-body');
  if (!tbody) return;

  // Active market filter
  const activeBtn = $('.m-btn.active', $('#market-filter'));
  const market = activeBtn ? activeBtn.dataset.market : 'all';

  // Filter + sort newest first (scoped to the selected account, if any)
  const scoped = getScopedTrades();
  const list = scoped
    .filter(t => market === 'all' || (t.market || '').toLowerCase() === market)
    .sort((a, b) => {
      const ta = new Date((a.date || '') + ' ' + ((a.time || '00:00').split(' ')[0])).getTime();
      const tb = new Date((b.date || '') + ' ' + ((b.time || '00:00').split(' ')[0])).getTime();
      return tb - ta;
    });

  // Count badge — total trades in the current account scope (unfiltered by market)
  const countEl = $('#trade-count');
  if (countEl) countEl.textContent = scoped.length;

  if (list.length === 0) {
    tbody.innerHTML = `<tr><td colspan="17" style="text-align:center;padding:24px;color:var(--muted-2);">
      ${scoped.length === 0
        ? 'No trades yet — save your first trade above to start your journal.'
        : 'No trades match the selected market filter.'}
    </td></tr>`;
    return;
  }

  tbody.innerHTML = list.map(renderTradeRow).join('');
  // Row actions (view/edit/delete) and the screenshot thumbnail are wired via a
  // single delegated listener on the tbody (see initTradeForm), so nothing
  // needs to be attached here on every render.
}

function renderTradeRow(t) {
  const m = calcTrade(t) || {};
  const dir = (t.direction || '').toLowerCase();
  const pnlClass = t.pnl > 0 ? 'pos' : (t.pnl < 0 ? 'neg' : '');

  // Screenshot thumbnail (clickable to zoom — separate from the row's View action)
  let shotCell = '<span class="no-shot">—</span>';
  if (t.screenshot) {
    const src = getShotSrc(t.screenshot);
    if (src) shotCell = `<img src="${esc(src)}" class="shot-thumb" alt="shot" data-shot="${t.id}" />`;
  }

  const exitCell = t.exit > 0 ? num(t.exit).toFixed(5) : '<span class="row-muted">open</span>';
  const pipsCell = m.pipsResult
    ? `<span class="${m.pipsResult > 0 ? 'pos' : (m.pipsResult < 0 ? 'neg' : '')}">${m.pipsResult.toFixed(1)}</span>`
    : '<span class="row-muted">—</span>';
  const pnlCell  = t.open
    ? '<span class="row-muted">open</span>'
    : `<span class="${pnlClass}">${t.pnl >= 0 ? '+' : ''}$${num(t.pnl).toFixed(2)}</span>`;

  return `
    <tr data-trade-id="${t.id}">
      <td>${esc(t.date || '—')}</td>
      <td>${esc(t.time || '—')}</td>
      <td><strong>${esc(t.pair || '—')}</strong></td>
      <td><span class="dir-badge dir-${dir}">${esc(t.direction || '—')}</span></td>
      <td>${num(t.lot).toFixed(2)}</td>
      <td>${num(t.entry).toFixed(5)}</td>
      <td>${num(t.sl).toFixed(5)}</td>
      <td>${num(t.tp).toFixed(5)}</td>
      <td>${exitCell}</td>
      <td>${pipsCell}</td>
      <td>${m.rr ? m.rr.toFixed(2) : '—'}</td>
      <td>${pnlCell}</td>
      <td>${esc(t.accountName || '—')}</td>
      <td>${esc(t.strategy || '—')}</td>
      <td>${esc(t.session || '—')}</td>
      <td>${shotCell}</td>
      <td class="row-actions">
        <button type="button" data-action="view" data-id="${t.id}" title="View details"><i class="fa-solid fa-eye"></i></button>
        <button type="button" data-action="edit" data-id="${t.id}" title="Edit trade"><i class="fa-solid fa-pen"></i></button>
        <button type="button" class="del" data-action="delete" data-id="${t.id}" title="Delete trade"><i class="fa-solid fa-trash"></i></button>
      </td>
    </tr>`;
}



/* =========================================================
   VIEW TRADE — Read-only modal with full details
   ========================================================= */

function viewTrade(id) {
  const t = state.trades.find(x => x.id == id);
  if (!t) return;
  const m = calcTrade(t) || {};

  // Remove existing modal if any
  let modal = $('#view-modal');
  if (modal) modal.remove();

  const shotHtml = t.screenshot
    ? `<div class="detail-shot"><img src="${esc(getShotSrc(t.screenshot))}" alt="screenshot" /></div>`
    : '';
  const notesHtml = t.notes
    ? `<div class="detail-notes"><span class="detail-label">Notes</span><p>${esc(t.notes)}</p></div>`
    : '';

  modal = document.createElement('div');
  modal.id = 'view-modal';
  modal.className = 'modal-overlay';
  modal.innerHTML = `
    <div class="modal-card" role="dialog" aria-modal="true">
      <div class="modal-head">
        <h3><i class="fa-solid fa-eye"></i> Trade Details — ${esc(t.pair)}</h3>
        <button type="button" class="modal-close" id="close-view-x" aria-label="Close"><i class="fa-solid fa-xmark"></i></button>
      </div>
      <div class="modal-body">
        <div class="detail-grid">
          <div><span class="detail-label">Date / Time</span><b>${esc(t.date || '—')} ${esc(t.time || '')}</b></div>
          <div><span class="detail-label">Direction</span><b>${esc(t.direction || '—')}</b></div>
          <div><span class="detail-label">Market</span><b>${esc(t.market || '—')}</b></div>
          <div><span class="detail-label">Pair</span><b>${esc(t.pair || '—')}</b></div>
          <div><span class="detail-label">Lot Size</span><b>${num(t.lot).toFixed(2)}</b></div>
          <div><span class="detail-label">Account</span><b>${esc(t.accountName || '—')}</b></div>
          <div><span class="detail-label">Entry</span><b>${num(t.entry).toFixed(5)}</b></div>
          <div><span class="detail-label">Stop Loss</span><b>${num(t.sl).toFixed(5)}</b></div>
          <div><span class="detail-label">Take Profit</span><b>${num(t.tp).toFixed(5)}</b></div>
          <div><span class="detail-label">Exit</span><b>${t.exit > 0 ? num(t.exit).toFixed(5) : '—'}</b></div>
          <div><span class="detail-label">Profit / Loss</span><b class="${t.pnl > 0 ? 'pos' : (t.pnl < 0 ? 'neg' : '')}">${t.open ? 'Open' : (t.pnl >= 0 ? '+' : '') + '$' + num(t.pnl).toFixed(2)}</b></div>
          <div><span class="detail-label">Pips</span><b>${m.pipsResult ? m.pipsResult.toFixed(1) : '—'}</b></div>
          <div><span class="detail-label">RR</span><b>${m.rr ? m.rr.toFixed(2) : '—'}</b></div>
          <div><span class="detail-label">R Multiple</span><b>${m.rMultiple ? m.rMultiple.toFixed(2) : '—'}</b></div>
          <div><span class="detail-label">Strategy</span><b>${esc(t.strategy || '—')}</b></div>
          <div><span class="detail-label">Session</span><b>${esc(t.session || '—')}</b></div>
          <div><span class="detail-label">Emotion</span><b>${esc(t.emotion || '—')}</b></div>
          <div><span class="detail-label">Execution</span><b>${esc(t.execution || '—')}</b></div>
          <div><span class="detail-label">Mistake</span><b>${esc(t.mistake || '—')}</b></div>
          <div><span class="detail-label">Grade</span><b>${esc(t.grade || '—')}</b></div>
        </div>
        ${notesHtml}
        ${shotHtml}
      </div>
      <div class="modal-foot">
        <button type="button" class="btn-ghost" id="close-view-btn">Close</button>
        <button type="button" class="btn-primary" id="view-edit-btn"><i class="fa-solid fa-pen"></i> Edit Trade</button>
      </div>
    </div>`;
  document.body.appendChild(modal);

  const close = () => modal.remove();
  $('#close-view-x').addEventListener('click', close);
  $('#close-view-btn').addEventListener('click', close);
  $('#view-edit-btn').addEventListener('click', () => { close(); editTrade(t.id); });
  modal.addEventListener('click', e => { if (e.target === modal) close(); });
  document.addEventListener('keydown', function esc(e) {
    if (e.key === 'Escape') { close(); document.removeEventListener('keydown', esc); }
  });
}



/* =========================================================
   DELETE TRADE
   ========================================================= */

async function deleteTrade(id) {
  const t = state.trades.find(x => x.id == id);
  if (!t) return;

  const ok = confirm(`Move this trade to Recycle Bin?\n\n${t.pair || '—'} · ${t.direction || '—'} · ${t.date || '—'}`);
  if (!ok) return;

  // Guard against double-deleting the same trade into the bin (e.g. a
  // stray double-click firing the handler twice before re-render).
  const alreadyInBin = state.recycleBin.some(item => item.type === 'trade' && item.data.id == id);
  if (alreadyInBin) return;

  // Reverse the trade's effect on its account balance & count
  let acc = null;
  if (t.accountId) {
    acc = state.accounts.find(a => a.id == t.accountId);
    if (acc) {
      if (!t.open && t.pnl) acc.balance = +(acc.balance - t.pnl).toFixed(2);
      acc.tradesCount = Math.max(0, (acc.tradesCount || 1) - 1);
    }
  }

  // Move the trade into the Recycle Bin instead of destroying it outright —
  // mirrors deleteAccount()/deleteTransaction() below. The screenshot blob
  // (if any) is deliberately left in shotCache/ShotDB untouched here: it's
  // still referenced by this trade's data inside the recycle bin, and is
  // only purged once the trade is permanently deleted or the trade is no
  // longer referenced anywhere (see purgeShotIfOrphaned).
  const recycleEntry = await syncRecycleInsert({ type: 'trade', data: { ...t }, deletedAt: new Date().toISOString() });
  state.recycleBin.push(recycleEntry);

  // Drop the trade from the active list
  state.trades = state.trades.filter(x => x.id != id);

  if (window.DB && window.DB.trades) {
    try { await window.DB.trades.remove(id); }
    catch (err) { console.error('Trade delete failed, removed locally only:', err); }
  }
  if (acc) await syncAccountBalance(acc);

  save();
  toast('Trade moved to Recycle Bin');
  refreshAll();   // re-renders trades + notifies other views via refreshAllButTrades
}



/* =========================================================
   MARKET FILTER
   ========================================================= */

function initMarketFilter() {
  const wrap = $('#market-filter');
  if (!wrap) return;
  wrap.addEventListener('click', e => {
    const btn = e.target.closest('.m-btn');
    if (!btn || btn.classList.contains('active')) return;
    $$('.m-btn', wrap).forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    renderTrades();
  });
}



/* =========================================================
   CALENDAR — fully derived from state.trades (single source
   of truth). No calendar-specific data is ever persisted;
   every render recomputes straight from the trade list, so
   add / edit / delete / restore can never create duplicates
   or stale numbers.
   ========================================================= */

const WEEKDAY_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
let _calCursor = (() => { const n = new Date(); return { y: n.getFullYear(), m: n.getMonth() }; })();

// Groups all trades by their exact `date` (YYYY-MM-DD) string — the same
// field Trade Management already stores — so there is exactly one bucket
// per calendar day and nothing can be double-counted.
function groupTradesByDay(trades) {
  const map = new Map();
  trades.forEach(t => {
    if (!t.date) return;
    if (!map.has(t.date)) map.set(t.date, []);
    map.get(t.date).push(t);
  });
  return map;
}

// Per-day stats. Win/loss/win-rate are based on CLOSED trades only (a trade
// with no exit price yet has pnl === 0 by definition and isn't a win or a
// loss) — everything else (net P/L, risk, avg RR) counts every trade on
// that day, open or closed.
function computeDayStats(dayTrades) {
  const closed = dayTrades.filter(t => !t.open);
  const wins = closed.filter(t => t.pnl > 0);
  const losses = closed.filter(t => t.pnl < 0);
  const netPnl = dayTrades.reduce((s, t) => s + (t.pnl || 0), 0);
  const totalRisk = dayTrades.reduce((s, t) => s + (t.riskDollar || 0), 0);
  const avgRR = dayTrades.length ? dayTrades.reduce((s, t) => s + (t.rr || 0), 0) / dayTrades.length : 0;
  return {
    count: dayTrades.length,
    wins: wins.length,
    losses: losses.length,
    winRate: closed.length ? (wins.length / closed.length) * 100 : 0,
    netPnl, totalRisk, avgRR
  };
}

function initCalendar() {
  const prev = $('#cal-prev');
  const next = $('#cal-next');
  const today = $('#cal-today');
  if (prev) prev.addEventListener('click', () => { shiftCalMonth(-1); });
  if (next) next.addEventListener('click', () => { shiftCalMonth(1); });
  if (today) today.addEventListener('click', () => {
    const n = new Date();
    _calCursor = { y: n.getFullYear(), m: n.getMonth() };
    renderCalendar();
  });
  const grid = $('#cal-grid');
  if (grid) {
    grid.addEventListener('click', e => {
      const cell = e.target.closest('[data-cal-date]');
      if (!cell) return;
      openCalendarDay(cell.dataset.calDate);
    });
  }
}

function shiftCalMonth(delta) {
  let { y, m } = _calCursor;
  m += delta;
  if (m < 0) { m = 11; y -= 1; }
  else if (m > 11) { m = 0; y += 1; }
  _calCursor = { y, m };
  renderCalendar();
}

function renderCalendar() {
  const grid = $('#cal-grid');
  const weekdaysEl = $('#cal-weekdays');
  const labelEl = $('#cal-month-label');
  const summaryEl = $('#cal-summary');
  if (!grid || !labelEl) return; // view not in DOM yet

  const { y, m } = _calCursor;
  labelEl.textContent = new Date(y, m, 1).toLocaleDateString(undefined, { month: 'long', year: 'numeric' });

  if (weekdaysEl && !weekdaysEl.childElementCount) {
    weekdaysEl.innerHTML = WEEKDAY_LABELS.map(d => `<span>${d}</span>`).join('');
  }

  const byDay = groupTradesByDay(getScopedTrades());
  const todayStr = todayISO();

  const firstOfMonth = new Date(y, m, 1);
  const startWeekday = firstOfMonth.getDay();
  const daysInMonth = new Date(y, m + 1, 0).getDate();
  const daysInPrevMonth = new Date(y, m, 0).getDate();

  const cells = [];
  // Leading days from previous month (dimmed, not interactive)
  for (let i = startWeekday - 1; i >= 0; i--) {
    cells.push({ day: daysInPrevMonth - i, outside: true });
  }
  // Days of the current month
  for (let d = 1; d <= daysInMonth; d++) {
    const dateStr = `${y}-${String(m + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    cells.push({ day: d, outside: false, dateStr });
  }
  // Trailing days to complete the last week (dimmed, not interactive)
  let trail = 1;
  while (cells.length % 7 !== 0) { cells.push({ day: trail++, outside: true }); }

  let monthTrades = [];

  grid.innerHTML = cells.map(c => {
    if (c.outside) {
      return `<div class="cal-day cal-outside"><span class="cal-day-num">${c.day}</span></div>`;
    }
    const dayTrades = byDay.get(c.dateStr) || [];
    monthTrades = monthTrades.concat(dayTrades);
    const hasTrades = dayTrades.length > 0;
    const stats = hasTrades ? computeDayStats(dayTrades) : null;
    const isToday = c.dateStr === todayStr;
    const pnlClass = stats ? (stats.netPnl > 0 ? 'pos' : (stats.netPnl < 0 ? 'neg' : '')) : '';
    return `
      <div class="cal-day${isToday ? ' cal-today' : ''}${hasTrades ? ' cal-has-trades' : ''}"
           ${hasTrades ? `data-cal-date="${c.dateStr}"` : ''} title="${hasTrades ? 'View trades for ' + c.dateStr : ''}">
        <span class="cal-day-num">${c.day}</span>
        ${stats ? `
          <span class="cal-day-pnl ${pnlClass}">${fmtMoney(stats.netPnl)}</span>
          <span class="cal-day-meta">${stats.count} trade${stats.count === 1 ? '' : 's'} &middot; W${stats.wins}/L${stats.losses}</span>
          <span class="cal-day-wr">${fmtPct(stats.winRate)} WR</span>
        ` : ''}
      </div>`;
  }).join('');

  // Month summary strip
  if (summaryEl) {
    const k = computeKPIs(monthTrades);
    const totalRisk = monthTrades.reduce((s, t) => s + (t.riskDollar || 0), 0);
    summaryEl.innerHTML = `
      <div class="kpi"><span class="kpi-l">Net P/L</span><span class="kpi-v ${k.totalPnl > 0 ? 'pos' : (k.totalPnl < 0 ? 'neg' : '')}">${fmtMoney(k.totalPnl)}</span></div>
      <div class="kpi"><span class="kpi-l">Total Trades</span><span class="kpi-v">${monthTrades.length}</span></div>
      <div class="kpi"><span class="kpi-l">Winning Trades</span><span class="kpi-v pos">${k.wins.length}</span></div>
      <div class="kpi"><span class="kpi-l">Losing Trades</span><span class="kpi-v neg">${k.losses.length}</span></div>
      <div class="kpi"><span class="kpi-l">Win Rate</span><span class="kpi-v">${fmtPct(k.winRate)}</span></div>
      <div class="kpi"><span class="kpi-l">Total Risk</span><span class="kpi-v">${fmtMoney(totalRisk)}</span></div>
      <div class="kpi"><span class="kpi-l">Average RR</span><span class="kpi-v">${fmtNum(k.avgRR)}</span></div>
    `;
  }
}

// Day-detail modal — reuses the same lightweight `.modal-overlay` pattern
// already used by viewTrade() elsewhere in the app, and reuses viewTrade()
// itself so clicking a trade row opens the exact same read-only detail view
// used from Trade Management (no duplicated markup / logic).
function openCalendarDay(dateStr) {
  const dayTrades = (groupTradesByDay(getScopedTrades()).get(dateStr) || [])
    .slice()
    .sort((a, b) => (a.time || '').localeCompare(b.time || ''));
  if (dayTrades.length === 0) return;

  const stats = computeDayStats(dayTrades);
  const niceDate = new Date(dateStr + 'T00:00:00').toLocaleDateString(undefined, { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });

  let modal = $('#cal-day-modal');
  if (modal) modal.remove();
  modal = document.createElement('div');
  modal.id = 'cal-day-modal';
  modal.className = 'modal-overlay';
  modal.innerHTML = `
    <div class="modal-card" role="dialog" aria-modal="true">
      <div class="modal-head">
        <h3><i class="fa-solid fa-calendar-day"></i> ${esc(niceDate)}</h3>
        <button type="button" class="modal-close" id="cal-day-close-x" aria-label="Close"><i class="fa-solid fa-xmark"></i></button>
      </div>
      <div class="modal-body">
        <div class="cal-modal-summary">
          <div class="kpi"><span class="kpi-l">Net P/L</span><span class="kpi-v ${stats.netPnl > 0 ? 'pos' : (stats.netPnl < 0 ? 'neg' : '')}">${fmtMoney(stats.netPnl)}</span></div>
          <div class="kpi"><span class="kpi-l">Trades</span><span class="kpi-v">${stats.count}</span></div>
          <div class="kpi"><span class="kpi-l">Wins / Losses</span><span class="kpi-v">${stats.wins} / ${stats.losses}</span></div>
          <div class="kpi"><span class="kpi-l">Win Rate</span><span class="kpi-v">${fmtPct(stats.winRate)}</span></div>
          <div class="kpi"><span class="kpi-l">Total Risk</span><span class="kpi-v">${fmtMoney(stats.totalRisk)}</span></div>
          <div class="kpi"><span class="kpi-l">Avg RR</span><span class="kpi-v">${fmtNum(stats.avgRR)}</span></div>
        </div>
        <div class="cal-trade-list">
          ${dayTrades.map(t => {
            const dir = (t.direction || '').toLowerCase();
            const pnlClass = t.pnl > 0 ? 'pos' : (t.pnl < 0 ? 'neg' : '');
            return `
            <div class="cal-trade-row" data-cal-trade="${t.id}">
              <div class="cal-trade-row-top">
                <b>${esc(t.pair || '—')}</b>
                <span class="cal-dir-badge ${dir === 'sell' ? 'sell' : 'buy'}">${esc(t.direction || '—')}</span>
                <span class="${pnlClass}">${t.open ? 'Open' : fmtMoney(t.pnl)}</span>
              </div>
              <div class="cal-trade-row-meta">
                <span>Entry: ${t.entry != null ? num(t.entry).toFixed(5) : '—'}</span>
                <span>Exit: ${t.exit > 0 ? num(t.exit).toFixed(5) : '—'}</span>
                <span>RR: ${t.rr ? fmtNum(t.rr) : '—'}</span>
                <span>${esc(t.strategy || '—')}</span>
              </div>
              ${t.notes ? `<div class="cal-trade-row-notes">${esc(t.notes)}</div>` : ''}
            </div>`;
          }).join('')}
        </div>
      </div>
      <div class="modal-foot">
        <button type="button" class="btn-ghost" id="cal-day-close-btn">Close</button>
      </div>
    </div>`;
  document.body.appendChild(modal);

  const close = () => modal.remove();
  $('#cal-day-close-x').addEventListener('click', close);
  $('#cal-day-close-btn').addEventListener('click', close);
  $$('[data-cal-trade]', modal).forEach(row => {
    row.addEventListener('click', () => { close(); viewTrade(+row.dataset.calTrade); });
  });
  modal.addEventListener('click', e => { if (e.target === modal) close(); });
  document.addEventListener('keydown', function escHandler(e) {
    if (e.key === 'Escape') { close(); document.removeEventListener('keydown', escHandler); }
  });
}


  // ================== ACCOUNTS ==================

// Phase 1 Supabase account loading
// Pulls every table from Supabase (via database.js's DB.loadAll, which
// itself falls back to each table's own local cache if the network/auth
// isn't ready) and adopts it as the new state — Supabase is the source of
// truth once a session exists. THIS WAS PREVIOUSLY DEFINED AS
// loadAccountsFromDB() BUT NEVER CALLED FROM ANYWHERE, INCLUDING init() —
// meaning accounts (and everything else) only ever loaded from the
// localStorage blob on startup, never from Supabase. That's fixed by
// actually invoking this from init(), see bottom of file.
//
// Guard: only overwrite a given list if the remote list is non-empty, OR
// the local list is already empty. DB.*.list() swallows its own errors
// and silently returns its internal local-cache fallback on failure —
// it can't tell us "the network call failed." Without this guard, a
// transient failure right after login could return an empty fallback
// cache and wipe perfectly good in-memory data. This way we only ever
// adopt an empty remote result when there was nothing to lose locally.
function adoptRemote(key, remoteArr) {
  if (!Array.isArray(remoteArr)) return;
  if (remoteArr.length > 0 || (state[key] || []).length === 0) {
    state[key] = remoteArr;
  }
}

async function loadFromSupabase() {
  if (!window.DB || !window.Auth || !window.Auth.user) return;
  try {
    const remote = await window.DB.loadAll();
    adoptRemote('accounts', remote.accounts);
    adoptRemote('trades', remote.trades);
    adoptRemote('transactions', remote.transactions);
    adoptRemote('playbook', remote.playbook);
    adoptRemote('rules', remote.rules);
    adoptRemote('recycleBin', remote.recycleBin);
    if (remote.profile) {
      state.settings = Object.assign({}, state.settings, remote.profile);
    }
    save(); // refresh the local mirror so offline fallback stays in sync
  } catch (err) {
    console.error('Could not load from Supabase, using local cache:', err);
  }
}

// Persists an account's balance/tradesCount to Supabase. Every place that
// mutates acc.balance or acc.tradesCount (trades, transactions, restores)
// must call this — previously balance changes only ever lived in the
// localStorage blob and NEVER reached the accounts table after creation,
// so the Supabase balance silently went stale the moment you logged your
// first trade.
async function syncAccountBalance(acc) {
  if (!acc || !window.DB || !window.DB.accounts) return;
  try {
    await window.DB.accounts.update(acc.id, { balance: acc.balance, tradesCount: acc.tradesCount });
  } catch (err) {
    console.error('Account balance sync failed:', err);
  }
}

// Recycle Bin sync helpers, reused by every deleteX()/restoreFromBin()/
// permDeleteFromBin() below. entry.id is the Supabase row id for that
// recycle_bin row (captured off the insert() response) — without storing
// it, remove() would have nothing to target and deleted items would
// resurrect from Supabase on next login even after being emptied locally.
async function syncRecycleInsert(entry) {
  if (window.DB && window.DB.recycleBin) {
    try {
      const saved = await window.DB.recycleBin.insert(entry);
      if (saved && saved.id) entry.id = saved.id;
    } catch (err) { console.error('Recycle bin sync (insert) failed:', err); }
  }
  return entry;
}
async function syncRecycleRemove(entry) {
  if (window.DB && window.DB.recycleBin && entry && entry.id) {
    try { await window.DB.recycleBin.remove(entry.id); }
    catch (err) { console.error('Recycle bin sync (remove) failed:', err); }
  }
}


function initAccountForm() {
  $('#create-account-btn').addEventListener('click', createAccount);
}


async function createAccount() {
  const name = $('#a-name').value.trim();
  const broker = $('#a-broker').value.trim();
  const type = $('#a-type').value;
  const balance = num($('#a-balance').value);

  if (!name || !broker || balance <= 0) {
    return toast('All account fields are required with a positive balance', 'error');
  }

  const newAccount = {
    name,
    broker,
    type,
    balance,
    startBalance: balance,
    tradesCount: 0,
    createdAt: new Date().toISOString()
  };

  let saved = newAccount;

  if (window.DB && window.DB.accounts) {
    try {
      saved = await window.DB.accounts.insert(newAccount);
    } catch (err) {
      console.error('Account save failed:', err);
    }
  }

  // fallback if offline
  if (!saved.id) {
    saved.id = Date.now();
  }

  state.accounts.push(saved);

  save();

  $('#a-name').value = '';
  $('#a-broker').value = '';
  $('#a-balance').value = '';

  renderAccounts();
  renderDashboard();
  refreshTradeAccountSelect();
  refreshTransactionAccountSelect();
  refreshGlobalAccountFilter();

  toast('Account created');
}


async function deleteAccount(id) {
  const acc = state.accounts.find(a => a.id == id);

  if (!acc) return;

  if (!confirm(`Move account "${acc.name}" to Recycle Bin?\nLinked trades keep the name but account stats are removed.`)) {
    return;
  }

  const recycleEntry = await syncRecycleInsert({
    type: 'account',
    data: { ...acc },
    deletedAt: new Date().toISOString()
  });
  state.recycleBin.push(recycleEntry);

  state.accounts = state.accounts.filter(a => a.id != id);


  if (window.DB && window.DB.accounts) {
    try {
      await window.DB.accounts.remove(id);
    } catch (err) {
      console.error('Account delete failed:', err);
    }
  }


  save();

  refreshTradeAccountSelect();
  refreshTransactionAccountSelect();
  refreshGlobalAccountFilter();

  refreshAll();

  toast('Account moved to Recycle Bin');
}


function renderAccounts() {
  const grid = $('#accounts-list');

  if (!grid) return;

  refreshTradeAccountSelect();
  refreshTransactionAccountSelect();


  if (state.accounts.length === 0) {
    grid.innerHTML = `<p class="muted" style="grid-column:1/-1;">No accounts yet. Create one above.</p>`;
    return;
  }


  grid.innerHTML = state.accounts.map(a => {

    const accTrades = state.trades.filter(t => t.accountId == a.id);

    const wins = accTrades.filter(t => t.pnl > 0).length;

    const wr = accTrades.length > 0 
      ? (wins / accTrades.length) * 100 
      : 0;

    const profit = accTrades.reduce((s,t)=>s+t.pnl,0);

    const dd = a.startBalance > 0
      ? Math.max(
          0,
          ((a.startBalance - Math.min(a.startBalance,a.balance))
          / a.startBalance) * 100
        )
      : 0;


    return `
      <div class="account-card">

        <span class="badge">${esc(a.type)}</span>

        <h4>${esc(a.name)}</h4>

        <div class="account-meta">
          ${esc(a.broker)}
        </div>

        <div class="account-balance">
          $${fmtNum(a.balance)}
        </div>


        <div class="account-stats">

          <div class="account-stat">
            <span>Profit</span>
            <b class="${profit >= 0 ? 'pos':'neg'}">
              $${fmtNum(profit)}
            </b>
          </div>


          <div class="account-stat">
            <span>Drawdown</span>
            <b>${dd.toFixed(1)}%</b>
          </div>


          <div class="account-stat">
            <span>Win Rate</span>
            <b>${wr.toFixed(1)}%</b>
          </div>


          <div class="account-stat">
            <span>Trades</span>
            <b>${accTrades.length}</b>
          </div>

        </div>


        <div class="account-actions">
          <button data-del-account="${a.id}">
            Delete
          </button>
        </div>


      </div>
    `;

  }).join('');


  $$('[data-del-account]').forEach(button => {
    button.addEventListener(
      'click',
      () => deleteAccount(button.dataset.delAccount)
    );
  });
}

  // ================== TRANSACTIONS ==================
  function refreshTransactionAccountSelect() {
    const sel = $('#x-account');
    if (!sel) return;
    sel.innerHTML = '<option value="">— Select —</option>' +
      state.accounts.map(a => `<option value="${a.id}">${esc(a.name)}</option>`).join('');
  }
  function initTransactionForm() {
    refreshTransactionAccountSelect();
    const d = $('#x-date'); if (d) d.value = todayISO();
    $('#add-tx-btn').addEventListener('click', addTransaction);
  }
  // Returns the balance delta for a transaction type. Positive = adds to balance,
// negative = subtracts. For 'adjustment' the user enters a signed value.
  function transactionDelta(type, amount, isReversal = false) {
    const sign = isReversal ? -1 : 1;
    const signedAmount = type === 'adjustment' ? amount : Math.abs(amount);
    switch (type) {
      case 'deposit':
      case 'profit':
      case 'payout':
        return sign * signedAmount;
      case 'withdrawal':
      case 'loss':
      case 'fee':
        return -sign * signedAmount;
      case 'split':     // broker profit split — broker keeps their cut, user receives share
        return sign * signedAmount;
      case 'adjustment':
        return sign * signedAmount; // signed
      default:
        return 0;
    }
  }

  async function addTransaction() {
    const accId = $('#x-account').value;
    const type = $('#x-type').value;
    const amount = num($('#x-amount').value);
    const date = $('#x-date').value;
    const note = $('#x-note').value.trim();
    if (!accId) return toast('Select an account', 'error');
    const acc = state.accounts.find(a => a.id == accId);
    if (!acc) return;
    // Adjustment is signed; others require positive amount
    if (type !== 'adjustment' && amount <= 0) return toast('Amount must be positive', 'error');
    if (type === 'adjustment' && amount === 0) return toast('Enter a non-zero adjustment value', 'error');

    const balanceBefore = acc.balance;
    const delta = transactionDelta(type, amount);
    const balanceAfter = +(balanceBefore + delta).toFixed(2);

    // Warn if withdrawal/loss would push balance negative — but allow it (real accounts can)
    if (balanceAfter < 0 && (type === 'withdrawal' || type === 'loss' || type === 'fee')) {
      if (!confirm(`Warning: this transaction will put the balance below zero (${type === 'loss' ? '-' : ''}$${Math.abs(balanceAfter).toFixed(2)}). Continue?`)) return;
    }

    acc.balance = balanceAfter;
    const tx = {
      id: null,
      accountId: accId, accountName: acc.name, type, amount,
      balanceBefore: +balanceBefore.toFixed(2),
      balanceAfter, delta: +delta.toFixed(2),
      date, note, createdAt: new Date().toISOString()
    };
    if (window.DB && window.DB.transactions) {
      try {
        const saved = await window.DB.transactions.insert(tx);
        if (saved && saved.id) tx.id = saved.id;
      } catch (err) { console.error('Transaction insert failed, saved locally only:', err); }
    }
    if (!tx.id) tx.id = Date.now() + Math.floor(Math.random() * 1000); // offline fallback only
    await syncAccountBalance(acc);
    state.transactions.push(tx);
    save();
    renderTransactions();
    renderAccounts();
    renderDashboard();
    $('#x-amount').value = ''; $('#x-note').value = '';
    const deltaTxt = delta >= 0 ? `+$${delta.toFixed(2)}` : `-$${Math.abs(delta).toFixed(2)}`;
    toast(`Saved · ${deltaTxt} · New balance $${balanceAfter.toFixed(2)}`);
  }
  async function deleteTransaction(id) {
    if (!confirm('Move this transaction to Recycle Bin? Account balance will be reversed.')) return;
    const tx = state.transactions.find(t => t.id == id);
    if (!tx) return;
    const acc = state.accounts.find(a => a.id == tx.accountId);
    if (acc) {
      const reverse = -transactionDelta(tx.type, tx.amount);
      acc.balance = +(acc.balance + reverse).toFixed(2);
    }
    const recycleEntry = await syncRecycleInsert({ type: 'transaction', data: { ...tx }, deletedAt: new Date().toISOString() });
    state.recycleBin.push(recycleEntry);
    state.transactions = state.transactions.filter(t => t.id != id);
    if (window.DB && window.DB.transactions) {
      try { await window.DB.transactions.remove(id); }
      catch (err) { console.error('Transaction delete failed, removed locally only:', err); }
    }
    if (acc) await syncAccountBalance(acc);
    save();
    renderTransactions();
    renderAccounts();
    renderDashboard();
    renderRecycleBin();
    toast('Transaction moved to Recycle Bin');
  }
  function renderTransactions() {
    const body = $('#tx-body');
    if (!body) return;
    const list = [...state.transactions].sort((a, b) => (a.date < b.date ? 1 : -1));
    if (list.length === 0) {
      body.innerHTML = `<tr><td colspan="8"><div class="empty-state">No transactions yet.</div></td></tr>`;
      return;
    }
    body.innerHTML = list.map(t => {
      const delta = t.delta != null ? t.delta : transactionDelta(t.type, t.amount);
      const deltaClass = delta >= 0 ? 'pos' : 'warn';
      const ba = t.balanceAfter != null ? '$' + fmtNum(t.balanceAfter) : '—';
      return `
        <tr>
          <td>${esc(t.date || '—')}</td>
          <td>${esc(t.accountName || '—')}</td>
          <td>${esc(t.type)}</td>
          <td>$${fmtNum(t.amount)}</td>
          <td class="${deltaClass}">${delta >= 0 ? '+' : ''}$${fmtNum(delta)}</td>
          <td class="num">${ba}</td>
          <td>${esc(t.note || '')}</td>
          <td><div class="row-actions"><button class="del" data-del-tx="${t.id}">Delete</button></div></td>
        </tr>
      `;
    }).join('');
    $$('[data-del-tx]').forEach(b => b.addEventListener('click', () => deleteTransaction(b.dataset.delTx)));
  }

  // ================== KPI / ANALYTICS ==================
  function filterByTime(trades, range) {
    if (range === 'all') return trades;
    const now = new Date();
    let from;
    if (range === 'today') from = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    else if (range === 'week') from = new Date(now.getTime() - 7 * 86400000);
    else if (range === 'month') from = new Date(now.getTime() - 30 * 86400000);
    else if (range === 'year') from = new Date(now.getTime() - 365 * 86400000);
    return trades.filter(t => new Date(t.date) >= from);
  }

  function computeKPIs(trades) {
    const total = trades.length;
    const wins = trades.filter(t => t.pnl > 0);
    const losses = trades.filter(t => t.pnl < 0);
    const be = trades.filter(t => t.pnl === 0);
    const totalPnl = trades.reduce((s, t) => s + t.pnl, 0);
    const totalProfit = wins.reduce((s, t) => s + t.pnl, 0);
    const totalLoss = Math.abs(losses.reduce((s, t) => s + t.pnl, 0));
    const winRate = total > 0 ? (wins.length / total) * 100 : 0;
    const lossRate = total > 0 ? (losses.length / total) * 100 : 0;
    const beRate = total > 0 ? (be.length / total) * 100 : 0;
    const profitFactor = totalLoss > 0 ? totalProfit / totalLoss : (totalProfit > 0 ? 999 : 0);
    const avgRR = total > 0 ? trades.reduce((s, t) => s + t.rr, 0) / total : 0;
    const avgWin = wins.length > 0 ? totalProfit / wins.length : 0;
    const avgLoss = losses.length > 0 ? totalLoss / losses.length : 0;
    const payoff = avgLoss > 0 ? avgWin / avgLoss : (avgWin > 0 ? 999 : 0);
    const totalR = trades.reduce((s, t) => s + t.rMultiple, 0);
    const expectancy = total > 0 ? totalPnl / total : 0;

    // Equity curve, max drawdown
    const sorted = [...trades].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.id - b.id));
    let peak = 0, equity = 0, mdd = 0, cdd = 0;
    const equityCurve = [], pnlCurve = [], ddCurve = [];
    sorted.forEach(t => {
      equity += t.pnl;
      equityCurve.push(+equity.toFixed(2));
      pnlCurve.push(+t.pnl.toFixed(2));
      if (equity > peak) peak = equity;
      const dd = peak > 0 ? ((peak - equity) / Math.max(1, peak)) * 100 : 0;
      if (dd > mdd) mdd = dd;
      cdd = dd;
      ddCurve.push(+dd.toFixed(2));
    });

    // Period-over-period performance change
    // Compares the back-half of trades against the front-half for growth %
    const half = Math.floor(sorted.length / 2) || 1;
    const firstHalf = sorted.slice(0, half);
    const secondHalf = sorted.slice(half);
    const firstPnl = firstHalf.reduce((s, t) => s + t.pnl, 0);
    const secondPnl = secondHalf.reduce((s, t) => s + t.pnl, 0);
    const perfChange = firstPnl !== 0 ? ((secondPnl - firstPnl) / Math.max(1, Math.abs(firstPnl))) * 100 : 0;
    const growthRate = (equity !== 0) ? (secondPnl / Math.max(1, Math.abs(equity - secondPnl))) * 100 : 0;
    const isImproving = secondPnl > firstPnl;
    const trendDir = secondPnl > firstPnl ? 'up' : (secondPnl < firstPnl ? 'down' : 'flat');

    // Streaks
    let bestWin = 0, bestLoss = 0, run = 0;
    sorted.forEach(t => {
      if (t.pnl > 0) { run = run > 0 ? run + 1 : 1; if (run > bestWin) bestWin = run; }
      else if (t.pnl < 0) { run = run < 0 ? run - 1 : -1; if (run < bestLoss) bestLoss = run; }
      else run = 0;
    });
    let currStreak = 0;
    if (sorted.length) {
      const last = sorted[sorted.length - 1].pnl;
      const sign = last > 0 ? 1 : (last < 0 ? -1 : 0);
      if (sign !== 0) {
        for (let i = sorted.length - 1; i >= 0; i--) {
          if ((sorted[i].pnl > 0 && sign === 1) || (sorted[i].pnl < 0 && sign === -1)) currStreak++;
          else break;
        }
      }
    }

    return {
      total, wins, losses, be,
      totalPnl, totalProfit, totalLoss,
      winRate, lossRate, beRate,
      profitFactor, avgRR, avgWin, avgLoss, payoff,
      totalR, expectancy,
      mdd, cdd, bestWin, bestLoss, currStreak,
      bestTrade: total > 0 ? Math.max(...trades.map(t => t.pnl)) : 0,
      worstTrade: total > 0 ? Math.min(...trades.map(t => t.pnl)) : 0,
      highestRR: total > 0 ? Math.max(...trades.map(t => t.rr)) : 0,
      perfChange, growthRate, isImproving, trendDir, firstPnl, secondPnl,
      sorted, equityCurve, pnlCurve, ddCurve
    };
  }

  // ================== DASHBOARD ==================
  function renderDashboard(forceRedraw) {
    const scopedTrades = getScopedTrades();
    const scopedAccounts = getScopedAccounts();
    const k = computeKPIs(filterByTime(scopedTrades, state.timeFilter));
    const totalBalance = scopedAccounts.reduce((s, a) => s + (a.balance || 0), 0);

    $('#k-balance').textContent = '$' + fmtNum(totalBalance);
    $('#k-profit').textContent = '$' + fmtNum(k.totalProfit);
    $('#k-loss').textContent = '$' + fmtNum(k.totalLoss);
    $('#k-winrate').textContent = k.winRate.toFixed(1) + '%';
    $('#k-pf').textContent = k.profitFactor === 999 ? '∞' : k.profitFactor.toFixed(2);
    $('#k-rr').textContent = k.avgRR.toFixed(2);
    $('#k-trades').textContent = k.total;
    $('#k-r').textContent = k.totalR.toFixed(2) + ' R';
    $('#k-mdd').textContent = k.mdd.toFixed(1) + '%';
    $('#k-streak').textContent = (k.currStreak > 0 ? '+' : '') + k.currStreak;
    $('#k-best-streak').textContent = '+' + k.bestWin;
    $('#k-best').textContent = '$' + fmtNum(k.bestTrade);
    $('#k-worst').textContent = '$' + fmtNum(k.worstTrade);
    $('#k-hi-rr').textContent = k.highestRR.toFixed(2);
    $('#k-expect').textContent = '$' + fmtNum(k.expectancy);

    // Performance vs previous period + growth + trend pills
    const perfEl = $('#k-perf');
    if (perfEl) perfEl.textContent = (k.perfChange > 0 ? '+' : '') + k.perfChange.toFixed(1) + '%';
    const growthEl = $('#k-growth');
    if (growthEl) growthEl.textContent = (k.growthRate > 0 ? '+' : '') + k.growthRate.toFixed(2) + '%';
    const trendEl = $('#k-trend');
    if (trendEl) {
      const cls = k.trendDir;
      const arrow = cls === 'up' ? '▲ Improving' : (cls === 'down' ? '▼ Declining' : '◆ Stable');
      trendEl.innerHTML = `<span class="trend-pill ${cls}">${arrow}</span>`;
    }
    // Avg win vs avg loss + payoff ratio
    const avgWEl = $('#k-avgwin'); if (avgWEl) avgWEl.textContent = '$' + fmtNum(k.avgWin);
    const avgLEl = $('#k-avgloss'); if (avgLEl) avgLEl.textContent = '$' + fmtNum(k.avgLoss);
    const payEl = $('#k-payoff'); if (payEl) payEl.textContent = k.payoff === 999 ? '∞' : k.payoff.toFixed(2);
    const lossRateEl = $('#k-lossrate'); if (lossRateEl) lossRateEl.textContent = k.lossRate.toFixed(1) + '%';
    const beRateEl = $('#k-berate'); if (beRateEl) beRateEl.textContent = k.beRate.toFixed(1) + '%';

    // Account overview
    const grid = $('#dash-accounts');
    if (grid) {
      if (scopedAccounts.length === 0) {
        grid.innerHTML = `<p class="muted" style="grid-column:1/-1;">No accounts yet.</p>`;
      } else {
        grid.innerHTML = scopedAccounts.map(a => {
          const accTrades = state.trades.filter(t => t.accountId == a.id);
          const profit = accTrades.reduce((s, t) => s + t.pnl, 0);
          return `
            <div class="account-card">
              <span class="badge">${esc(a.type)}</span>
              <h4>${esc(a.name)}</h4>
              <div class="account-meta">${esc(a.broker)}</div>
              <div class="account-balance">$${fmtNum(a.balance)}</div>
              <div class="account-stats">
                <div class="account-stat"><span>Profit</span><b class="${profit >= 0 ? 'pos' : 'neg'}">$${fmtNum(profit)}</b></div>
                <div class="account-stat"><span>Trades</span><b>${accTrades.length}</b></div>
              </div>
            </div>
          `;
        }).join('');
      }
    }

    // Last/prev win/loss
    const sortedDesc = [...scopedTrades].sort((a, b) => (a.date < b.date ? 1 : -1));
    const winsDesc = sortedDesc.filter(t => t.pnl > 0);
    const lossesDesc = sortedDesc.filter(t => t.pnl < 0);
    setInsight('h-last-win', winsDesc[0]);
    setInsight('h-last-loss', lossesDesc[0]);
    setInsight('h-prev-win', winsDesc[1]);
    setInsight('h-prev-loss', lossesDesc[1]);

    // Last 10 dots
    const dots = $('#dash-dots');
    if (dots) {
      const last10 = sortedDesc.slice(0, 10).reverse();
      dots.innerHTML = last10.map(t => {
        const cls = t.pnl > 0 ? '' : (t.pnl < 0 ? 'loss' : 'be');
        return `<div class="trade-dot ${cls}" title="${esc(t.pair)} ${esc(t.date)} $${fmtNum(t.pnl)}"></div>`;
      }).join('') || `<p class="muted">No trades yet.</p>`;
    }

    renderDashboardCharts(k, forceRedraw);
  }

  function setInsight(id, t) {
    const el = $('#' + id);
    if (!el) return;
    if (!t) { el.textContent = '—'; return; }
    el.innerHTML = `
      <div class="hist-val ${t.pnl > 0 ? 'pos' : (t.pnl < 0 ? 'neg' : '')}">${esc(t.pair)} $${fmtNum(t.pnl)}</div>
      <div class="hist-meta">${esc(t.date)} · ${esc(t.direction)} · ${fmtNum(t.pips, 1)} pips</div>
    `;
  }

  // ================== CHARTS ==================
  function chartPalette() {
    const L = document.body.dataset.theme === 'light';
    return {
      cyan: L ? '#0891b2' : '#00d4ff',
      blue: L ? '#2563eb' : '#4d8cff',
      purple: L ? '#7c3aed' : '#a78bfa',
      amber: L ? '#d97706' : '#fbbf24',
      slate: L ? '#475569' : '#64748b',
      text: L ? '#64748b' : '#8b96a8',
      grid: L ? 'rgba(0,0,0,0.08)' : 'rgba(255,255,255,0.06)',
      fillCyan: L ? 'rgba(8,145,178,0.18)' : 'rgba(0,212,255,0.18)',
      fillBlue: L ? 'rgba(37,99,235,0.18)' : 'rgba(77,140,255,0.18)',
      fillPurple: L ? 'rgba(124,58,237,0.18)' : 'rgba(167,139,250,0.18)',
      fillAmber: L ? 'rgba(217,119,6,0.18)' : 'rgba(251,191,36,0.18)'
    };
  }
  function chartOpts(opts = {}) {
    const c = chartPalette();
    return {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      animation: { duration: 600, easing: 'easeOutCubic' },
      plugins: {
        legend: { labels: { color: c.text, font: { family: 'Inter', size: 10 }, boxWidth: 12, padding: 10 }, display: opts.legend !== false },
        tooltip: {
          backgroundColor: 'rgba(13,17,23,0.95)',
          titleColor: '#00d4ff',
          bodyColor: '#e6edf3',
          borderColor: '#1f2733',
          borderWidth: 1,
          padding: 10,
          cornerRadius: 6,
          titleFont: { family: 'Inter', weight: '600' },
          bodyFont: { family: 'JetBrains Mono', size: 11 }
        }
      },
      scales: {
        x: { ticks: { color: c.text, font: { family: 'Inter', size: 10 } }, grid: { color: c.grid, display: opts.gridX !== false } },
        y: { ticks: { color: c.text, font: { family: 'Inter', size: 10 } }, grid: { color: c.grid }, beginAtZero: opts.beginZero === true }
      },
      elements: {
        // 'monotone' interpolation gives a smooth, professional-looking wave
        // without ever overshooting past the real min/max of the data — the
        // default bezier curve can dip or spike beyond actual values between
        // two sharp points, which looks unrealistic on an equity curve.
        line: { tension: 0.35, cubicInterpolationMode: 'monotone', borderWidth: 2.5 },
        point: { radius: 0, hoverRadius: 5, hoverBorderWidth: 2 }
      }
    };
  }
  // Builds a vertical gradient fill for line charts (top = line color, fading
  // to transparent) so equity/profit/drawdown curves read as polished area
  // charts rather than flat, saturated blocks of color.
  function makeGradient(ctx, chartArea, colorRgba) {
    if (!chartArea) return colorRgba;
    const gradient = ctx.createLinearGradient(0, chartArea.top, 0, chartArea.bottom);
    gradient.addColorStop(0, colorRgba.replace(/[\d.]+\)$/, '0.35)'));
    gradient.addColorStop(1, colorRgba.replace(/[\d.]+\)$/, '0.02)'));
    return gradient;
  }
  function destroyChart(key) { if (charts[key]) { charts[key].destroy(); delete charts[key]; } }

  function renderDashboardCharts(k, force) {
    const c = chartPalette();
    const kpi = k || computeKPIs(filterByTime(getScopedTrades(), state.timeFilter));
    const labels = kpi.sorted.map(t => t.date);

    // Equity
    const eqEl = $('#c-equity');
    if (eqEl) {
      destroyChart('equity');
      charts.equity = new Chart(eqEl, {
        type: 'line',
        data: { labels, datasets: [{ label: 'Equity ($)', data: kpi.equityCurve, borderColor: c.cyan, backgroundColor: (ctx) => makeGradient(ctx.chart.ctx, ctx.chart.chartArea, c.fillCyan), fill: true, pointRadius: 0, borderWidth: 2.5 }] },
        options: chartOpts()
      });
    }
    // Profit
    const pEl = $('#c-profit');
    if (pEl) {
      destroyChart('profit');
      let cum = 0; const cumData = kpi.sorted.map(t => { cum += t.pnl; return +cum.toFixed(2); });
      charts.profit = new Chart(pEl, {
        type: 'line',
        data: { labels, datasets: [{ label: 'Cumulative Profit ($)', data: cumData, borderColor: c.blue, backgroundColor: (ctx) => makeGradient(ctx.chart.ctx, ctx.chart.chartArea, c.fillBlue), fill: true, pointRadius: 0, borderWidth: 2.5 }] },
        options: chartOpts()
      });
    }
    // R
    const rEl = $('#c-r');
    if (rEl) {
      destroyChart('rc');
      let accR = 0; const rData = kpi.sorted.map(t => { accR += t.rMultiple; return +accR.toFixed(2); });
      charts.rc = new Chart(rEl, {
        type: 'line',
        data: { labels, datasets: [{ label: 'Total R', data: rData, borderColor: c.purple, backgroundColor: (ctx) => makeGradient(ctx.chart.ctx, ctx.chart.chartArea, c.fillPurple), fill: true, pointRadius: 0, borderWidth: 2.5 }] },
        options: chartOpts()
      });
    }
    // Drawdown
    const ddEl = $('#c-dd');
    if (ddEl) {
      destroyChart('dd');
      charts.dd = new Chart(ddEl, {
        type: 'line',
        data: { labels, datasets: [{ label: 'Drawdown (%)', data: kpi.ddCurve, borderColor: c.amber, backgroundColor: (ctx) => makeGradient(ctx.chart.ctx, ctx.chart.chartArea, c.fillAmber), fill: true, pointRadius: 0, borderWidth: 2 }] },
        options: chartOpts()
      });
    }
    // Distribution
    const distEl = $('#c-dist');
    if (distEl) {
      destroyChart('dist');
      charts.dist = new Chart(distEl, {
        type: 'doughnut',
        data: {
          labels: ['Wins', 'Losses', 'Break-even'],
          datasets: [{ data: [kpi.wins.length, kpi.losses.length, kpi.be.length], backgroundColor: [c.cyan, c.amber, c.purple], borderColor: 'transparent', borderWidth: 2 }]
        },
        options: { ...chartOpts(), cutout: '65%', scales: {} }
      });
    }
    // Period
    const perEl = $('#c-period');
    if (perEl) {
      destroyChart('period');
      const grouped = groupByPeriod(kpi.sorted, state.performancePeriod);
      charts.period = new Chart(perEl, {
        type: 'bar',
        data: { labels: grouped.labels, datasets: [{ label: 'PnL ($)', data: grouped.values, backgroundColor: c.cyan, borderRadius: 6 }] },
        options: chartOpts()
      });
    }
  }

  function groupByPeriod(trades, period) {
    const buckets = new Map();
    trades.forEach(t => {
      const d = new Date(t.date);
      let key;
      if (period === 'daily') key = d.toISOString().slice(0, 10);
      else if (period === 'weekly') {
        const tmp = new Date(d); tmp.setDate(d.getDate() - d.getDay()); key = tmp.toISOString().slice(0, 10);
      } else if (period === 'monthly') key = d.toISOString().slice(0, 7);
      else key = String(d.getFullYear());
      buckets.set(key, (buckets.get(key) || 0) + t.pnl);
    });
    const labels = [...buckets.keys()].sort();
    return { labels, values: labels.map(l => +buckets.get(l).toFixed(2)) };
  }

  function initFilters() {
    $$('#dash-filter .f-btn').forEach(b => b.addEventListener('click', () => {
      $$('#dash-filter .f-btn').forEach(x => x.classList.remove('active'));
      b.classList.add('active');
      state.timeFilter = b.dataset.time;
      renderDashboard();
    }));
    $$('#market-filter .m-btn').forEach(b => b.addEventListener('click', () => {
      $$('#market-filter .m-btn').forEach(x => x.classList.remove('active'));
      b.classList.add('active');
      state.marketFilter = b.dataset.market;
      renderTrades();
    }));
    $$('#perf-tabs button').forEach(b => b.addEventListener('click', () => {
      $$('#perf-tabs button').forEach(x => x.classList.remove('active'));
      b.classList.add('active');
      state.performancePeriod = b.dataset.period;
      renderDashboard();
    }));
  }

  // ================== PERCENTAGE ANALYTICS ==================
  // All figures below are derived directly from real trades/accounts — no
  // placeholder or simulated numbers. Where a metric has no single industry
  // formula (consistency, psychology, discipline, strategy performance) a
  // clearly-documented, reasonable heuristic is used instead.
  function computePercentAnalytics(trades) {
    const k = computeKPIs(trades);
    const total = trades.length;
    const startCapital = state.accounts.reduce((s, a) => s + (a.startBalance || 0), 0) || state.settings.defaultBalance || 10000;

    // Profit progress / loss impact — realized P&L as % of starting capital
    const profitProgress = startCapital > 0 ? Math.max(0, (k.totalProfit / startCapital) * 100) : 0;
    const lossImpact = startCapital > 0 ? Math.max(0, (k.totalLoss / startCapital) * 100) : 0;

    // Drawdown — reuse the equity-curve max drawdown already computed
    const drawdown = k.mdd;

    // Win rate — direct
    const winRate = k.winRate;

    // Risk/Reward score — average achieved RR normalized against a healthy
    // 1:2 benchmark, capped at 100%
    const rrScore = Math.max(0, Math.min(100, (k.avgRR / 2) * 100));

    // Account growth — net realized P&L as % of starting capital (can go negative)
    const accountGrowth = startCapital > 0 ? (k.totalPnl / startCapital) * 100 : 0;

    // Consistency — penalizes trade-to-trade PnL volatility relative to the
    // average trade size. Perfectly identical results = 100%; wild swings
    // pull it down.
    let consistency = 100;
    if (total > 1) {
      const mean = k.totalPnl / total;
      const variance = trades.reduce((s, t) => s + Math.pow(t.pnl - mean, 2), 0) / total;
      const stdDev = Math.sqrt(variance);
      const avgAbs = trades.reduce((s, t) => s + Math.abs(t.pnl), 0) / total || 1;
      consistency = Math.max(0, Math.min(100, 100 - (stdDev / avgAbs) * 40));
    }

    // Psychology score — share of trades taken in a constructive emotional
    // state (Calm / Confident / Disciplined) vs. destructive ones (Fear,
    // FOMO, Greed, Revenge, Hesitation, Impatient)
    const destructive = new Set(['Fear', 'FOMO', 'Greed', 'Revenge', 'Hesitation', 'Impatient']);
    const flaggedEmotion = trades.filter(t => t.emotion && destructive.has(t.emotion)).length;
    const loggedEmotion = trades.filter(t => t.emotion).length;
    const psychology = loggedEmotion > 0 ? Math.max(0, 100 - (flaggedEmotion / loggedEmotion) * 100) : 100;

    // Discipline score — share of trades with NO logged mistake
    const loggedMistakeField = trades.filter(t => t.mistake !== undefined && t.mistake !== null);
    const withMistake = trades.filter(t => t.mistake).length;
    const discipline = total > 0 ? Math.max(0, 100 - (withMistake / total) * 100) : 100;

    // Strategy performance — overall profit factor normalized against a
    // healthy benchmark of 2.0 (i.e. $2 made per $1 lost), capped at 100%
    const strategyPerformance = k.profitFactor === 999 ? 100 : Math.max(0, Math.min(100, (k.profitFactor / 2) * 100));

    return {
      profitProgress, lossImpact, drawdown, winRate, rrScore,
      accountGrowth, consistency, psychology, discipline, strategyPerformance
    };
  }
  function setPct(prefix, value, opts = {}) {
    const v = $('#' + prefix + '-v');
    const bar = $('#' + prefix + '-bar');
    if (!v || !bar) return;
    const display = opts.signed ? `${value >= 0 ? '+' : ''}${value.toFixed(1)}%` : `${value.toFixed(1)}%`;
    v.textContent = display;
    bar.style.width = Math.max(0, Math.min(100, Math.abs(value))) + '%';
    if (opts.cls) {
      v.className = opts.cls;
      bar.className = 'pct-fill ' + opts.cls;
    }
  }
  function renderPercentAnalytics() {
    if (!$('#pct-grid')) return;
    const p = computePercentAnalytics(getScopedTrades());
    setPct('pct-profit', p.profitProgress, { cls: 'pos' });
    setPct('pct-loss', p.lossImpact, { cls: 'neg' });
    setPct('pct-dd', p.drawdown, { cls: 'warn' });
    setPct('pct-winrate', p.winRate, { cls: p.winRate >= 50 ? 'pos' : 'warn' });
    setPct('pct-rr', p.rrScore, { cls: p.rrScore >= 50 ? 'pos' : 'warn' });
    setPct('pct-growth', p.accountGrowth, { cls: p.accountGrowth >= 0 ? 'pos' : 'neg', signed: true });
    setPct('pct-consistency', p.consistency, { cls: p.consistency >= 60 ? 'pos' : 'warn' });
    setPct('pct-psych', p.psychology, { cls: p.psychology >= 60 ? 'pos' : 'warn' });
    setPct('pct-discipline', p.discipline, { cls: p.discipline >= 70 ? 'pos' : 'warn' });
    setPct('pct-strategy', p.strategyPerformance, { cls: p.strategyPerformance >= 50 ? 'pos' : 'warn' });
  }

  // ================== ANALYTICS ==================
  function groupBy(trades, key) {
    const map = new Map();
    trades.forEach(t => {
      const k = t[key] || '—';
      if (!map.has(k)) map.set(k, { pnl: 0, wins: 0, total: 0, rrSum: 0, pipsSum: 0 });
      const v = map.get(k);
      v.pnl += t.pnl; v.total += 1; v.rrSum += t.rr; v.pipsSum += t.pips;
      if (t.pnl > 0) v.wins++;
    });
    return map;
  }
  function renderAnalytics(force) {
    renderPercentAnalytics();
    const c = chartPalette();
    const scopedTrades = getScopedTrades();
    const k = computeKPIs(scopedTrades);
    const eqEl = $('#a-equity');
    if (eqEl) {
      destroyChart('aEq');
      charts.aEq = new Chart(eqEl, {
        type: 'line',
        data: { labels: k.sorted.map(t => t.date), datasets: [{ label: 'Equity', data: k.equityCurve, borderColor: c.cyan, backgroundColor: (ctx) => makeGradient(ctx.chart.ctx, ctx.chart.chartArea, c.fillCyan), fill: true, pointRadius: 0, borderWidth: 2.5 }] },
        options: chartOpts()
      });
    }
    const pEl = $('#a-profit');
    if (pEl) {
      destroyChart('aProf');
      let acc = 0; const data = k.sorted.map(t => { acc += t.pnl; return +acc.toFixed(2); });
      charts.aProf = new Chart(pEl, {
        type: 'line',
        data: { labels: k.sorted.map(t => t.date), datasets: [{ label: 'Cumulative Profit', data, borderColor: c.blue, backgroundColor: (ctx) => makeGradient(ctx.chart.ctx, ctx.chart.chartArea, c.fillBlue), fill: true, pointRadius: 0, borderWidth: 2.5 }] },
        options: chartOpts()
      });
    }
    // WR by pair
    const wrEl = $('#a-wr-pair');
    if (wrEl) {
      destroyChart('aWr');
      const map = groupBy(scopedTrades, 'pair');
      const labels = [...map.keys()].slice(0, 12);
      const data = labels.map(l => { const v = map.get(l); return v.total > 0 ? +((v.wins / v.total) * 100).toFixed(1) : 0; });
      charts.aWr = new Chart(wrEl, {
        type: 'bar',
        data: { labels, datasets: [{ label: 'Win Rate (%)', data, backgroundColor: c.cyan, borderRadius: 6 }] },
        options: chartOpts()
      });
    }
    // RR by strategy
    const rrEl = $('#a-rr-strat');
    if (rrEl) {
      destroyChart('aRr');
      const map = groupBy(scopedTrades, 'strategy');
      const labels = [...map.keys()].slice(0, 12);
      const data = labels.map(l => { const v = map.get(l); return v.total > 0 ? +(v.rrSum / v.total).toFixed(2) : 0; });
      charts.aRr = new Chart(rrEl, {
        type: 'bar',
        data: { labels, datasets: [{ label: 'Avg RR', data, backgroundColor: c.purple, borderRadius: 6 }] },
        options: chartOpts()
      });
    }
    // Monthly PnL %
    const mEl = $('#a-month');
    if (mEl) {
      destroyChart('aMonth');
      const buckets = new Map();
      scopedTrades.forEach(t => {
        const k = t.date.slice(0, 7);
        if (!buckets.has(k)) buckets.set(k, { pnl: 0, start: 0 });
        buckets.get(k).pnl += t.pnl;
      });
      const labels = [...buckets.keys()].sort();
      const data = labels.map(l => +buckets.get(l).pnl.toFixed(2));
      charts.aMonth = new Chart(mEl, {
        type: 'bar',
        data: { labels, datasets: [{ label: 'Monthly PnL ($)', data, backgroundColor: c.blue, borderRadius: 6 }] },
        options: chartOpts()
      });
    }
    // Weekly
    const wEl = $('#a-week');
    if (wEl) {
      destroyChart('aWeek');
      const buckets = new Map();
      scopedTrades.forEach(t => {
        const d = new Date(t.date);
        const tmp = new Date(d); tmp.setDate(d.getDate() - d.getDay());
        const k = tmp.toISOString().slice(0, 10);
        buckets.set(k, (buckets.get(k) || 0) + t.pnl);
      });
      const labels = [...buckets.keys()].sort();
      const data = labels.map(l => +buckets.get(l).toFixed(2));
      charts.aWeek = new Chart(wEl, {
        type: 'bar',
        data: { labels, datasets: [{ label: 'Weekly PnL ($)', data, backgroundColor: c.purple, borderRadius: 6 }] },
        options: chartOpts()
      });
    }
    // DD
    const ddEl = $('#a-dd');
    if (ddEl) {
      destroyChart('aDd');
      charts.aDd = new Chart(ddEl, {
        type: 'line',
        data: { labels: k.sorted.map(t => t.date), datasets: [{ label: 'Drawdown (%)', data: k.ddCurve, borderColor: c.amber, backgroundColor: (ctx) => makeGradient(ctx.chart.ctx, ctx.chart.chartArea, c.fillAmber), fill: true, pointRadius: 0, borderWidth: 2 }] },
        options: chartOpts()
      });
    }
  }

  // ================== SCREENSHOTS ==================
  let _shotModalList = [];
  let _shotModalIndex = 0;
  const _selectedShots = new Set(); // trade ids selected for bulk download

  function getShotList() {
    // Same filtering logic as the gallery — so nav respects search/account filters
    let list = state.trades.filter(t => t.screenshot);
    const accFilter = state.shotFilter.accountId;
    if (accFilter) list = list.filter(t => t.accountId == accFilter);
    const search = (state.shotFilter.search || '').toLowerCase();
    if (search) {
      list = list.filter(t =>
        (t.pair || '').toLowerCase().includes(search) ||
        (t.strategy || '').toLowerCase().includes(search) ||
        (t.date || '').toLowerCase().includes(search)
      );
    }
    return list.sort((a, b) => (a.date < b.date ? 1 : -1));
  }

  function renderScreenshots() {
    const grid = $('#shot-grid');
    if (!grid) return;
    const sel = $('#ss-account');
    if (sel) {
      const cur = sel.value;
      sel.innerHTML = '<option value="">All accounts</option>' +
        state.accounts.map(a => `<option value="${a.id}">${esc(a.name)}</option>`).join('');
      sel.value = cur;
    }
    const list = getShotList();

    // Drop selections that no longer match the current filtered list
    const visibleIds = new Set(list.map(t => t.id));
    Array.from(_selectedShots).forEach(id => { if (!visibleIds.has(id)) _selectedShots.delete(id); });
    updateShotSelCount();

    if (list.length === 0) {
      grid.innerHTML = `<p class="muted" style="grid-column:1/-1;">No screenshots yet. Add one when creating a trade in the Trade Journal.</p>`;
      return;
    }
    grid.innerHTML = list.map(t => `
      <div class="shot-card" data-shot-card="${t.id}">
        <label class="shot-checkbox" title="Select for bulk download">
          <input type="checkbox" data-shot-select="${t.id}" ${_selectedShots.has(t.id) ? 'checked' : ''} />
        </label>
        <button type="button" class="shot-dl-btn" data-shot-download="${t.id}" title="Download this screenshot" aria-label="Download screenshot">
          <i class="fa-solid fa-download"></i>
        </button>
        <img src="${esc(getShotSrc(t.screenshot))}" alt="trade screenshot" loading="lazy" />
        <div class="shot-info">
          <div class="shot-pair">${esc(t.pair)} <span class="${t.pnl > 0 ? 'pos' : (t.pnl < 0 ? 'neg' : '')}">$${fmtNum(t.pnl)}</span></div>
          <div class="shot-meta">${esc(t.date)} · ${esc(t.strategy || '—')}</div>
        </div>
      </div>
    `).join('');
    $$('[data-shot-card]').forEach(card => {
      card.addEventListener('click', (e) => {
        if (e.target.closest('[data-shot-select]') || e.target.closest('[data-shot-download]')) return;
        openShotModal(card.dataset.shotCard);
      });
    });
    $$('[data-shot-select]').forEach(cb => {
      cb.addEventListener('click', e => e.stopPropagation());
      cb.addEventListener('change', () => {
        const id = num(cb.dataset.shotSelect);
        if (cb.checked) _selectedShots.add(id); else _selectedShots.delete(id);
        updateShotSelCount();
      });
    });
    $$('[data-shot-download]').forEach(btn => {
      btn.addEventListener('click', e => {
        e.stopPropagation();
        const t = list.find(x => x.id == btn.dataset.shotDownload);
        if (t) downloadSingleShot(t);
      });
    });
  }
  function updateShotSelCount() {
    const el = $('#ss-sel-count');
    if (el) el.textContent = _selectedShots.size;
  }
  function initShotFilters() {
    const s = $('#ss-search');
    if (s) s.addEventListener('input', () => { state.shotFilter.search = s.value; renderScreenshots(); });
    const a = $('#ss-account');
    if (a) a.addEventListener('change', () => { state.shotFilter.accountId = a.value; renderScreenshots(); });

    const selectAllBtn = $('#ss-select-all');
    if (selectAllBtn) selectAllBtn.addEventListener('click', () => {
      getShotList().forEach(t => _selectedShots.add(t.id));
      renderScreenshots();
    });
    const clearBtn = $('#ss-clear-selection');
    if (clearBtn) clearBtn.addEventListener('click', () => {
      _selectedShots.clear();
      renderScreenshots();
    });
    const dlSelectedBtn = $('#ss-download-selected');
    if (dlSelectedBtn) dlSelectedBtn.addEventListener('click', () => {
      const list = getShotList().filter(t => _selectedShots.has(t.id));
      if (!list.length) return toast('No screenshots selected', 'error');
      downloadMultipleShots(list);
    });
    const dlAllBtn = $('#ss-download-all');
    if (dlAllBtn) dlAllBtn.addEventListener('click', () => {
      const list = getShotList();
      if (!list.length) return toast('No screenshots to download', 'error');
      downloadMultipleShots(list);
    });
  }

  // ---- Real file download helpers (uploaded images + external image URLs) ----
  const SHOT_EXT_MAP = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/jpg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif', 'image/bmp': 'bmp', 'image/svg+xml': 'svg' };

  async function shotToBlob(src) {
    if (!src) throw new Error('No image source');
    if (src.startsWith('data:')) {
      // Uploaded images are stored as data: URIs. Decode them directly to a
      // Blob rather than routing through fetch() — this avoids any chance
      // of the request being blocked by CSP/connect-src rules and is faster,
      // since no network stack is involved at all. This always works.
      const commaIdx = src.indexOf(',');
      const header = src.slice(0, commaIdx);
      const isBase64 = /;base64/i.test(header);
      const mimeMatch = /data:([^;,]+)/i.exec(header);
      const mime = mimeMatch ? mimeMatch[1] : 'image/png';
      const body = src.slice(commaIdx + 1);
      if (isBase64) {
        const binary = atob(body);
        const len = binary.length;
        const bytes = new Uint8Array(len);
        for (let i = 0; i < len; i++) bytes[i] = binary.charCodeAt(i);
        return new Blob([bytes], { type: mime });
      }
      return new Blob([decodeURIComponent(body)], { type: mime });
    }
    // Pasted external image URLs — these depend on the host allowing
    // cross-origin fetches. Many image hosts don't send CORS headers, in
    // which case this throws and the caller falls back to opening the
    // image in a new tab so the user can save it manually (a genuine
    // browser security limitation, not something a web page can bypass).
    const res = await fetch(src, { mode: 'cors' });
    if (!res.ok) throw new Error('Fetch failed');
    return await res.blob();
  }
  function shotExt(blob, src) {
    if (blob && SHOT_EXT_MAP[blob.type]) return SHOT_EXT_MAP[blob.type];
    const m = /\.(png|jpe?g|webp|gif|bmp|svg)(?:\?|#|$)/i.exec(src || '');
    return m ? m[1].toLowerCase().replace('jpeg', 'jpg') : 'png';
  }
  function shotFilename(t, ext) {
    const pair = (t.pair || 'chart').replace(/[^a-z0-9]+/gi, '_');
    return `trade-${pair}-${t.date || 'unknown'}-${t.id}.${ext}`;
  }
  function triggerBlobDownload(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
  }
  async function downloadSingleShot(t, silent) {
    const src = getShotSrc(t.screenshot);
    if (!src) { if (!silent) toast('Screenshot data is missing', 'error'); return false; }
    try {
      const blob = await shotToBlob(src);
      triggerBlobDownload(blob, shotFilename(t, shotExt(blob, src)));
      if (!silent) toast('Screenshot downloaded to your Downloads folder');
      return true;
    } catch (err) {
      // Uploaded images (data: URIs) never hit this path — only pasted
      // external URLs can fail here, and only because the host blocks
      // cross-origin downloads. Open it in a new tab as a manual fallback.
      if (t.screenshot && t.screenshot.type === 'url') {
        window.open(src, '_blank', 'noopener');
        if (!silent) toast('This image is hosted externally and blocks direct downloads — opened in a new tab, right-click → Save Image As…', 'error');
      } else if (!silent) {
        toast('Could not download this screenshot', 'error');
      }
      return false;
    }
  }
  async function downloadMultipleShots(list) {
    if (list.length === 1) return downloadSingleShot(list[0]);
    if (typeof JSZip === 'undefined') {
      // Fallback: trigger individual downloads in sequence if JSZip failed to load
      toast(`Downloading ${list.length} screenshots…`);
      let ok = 0;
      for (const t of list) {
        if (await downloadSingleShot(t, true)) ok++;
        await new Promise(r => setTimeout(r, 350));
      }
      toast(ok ? `${ok} of ${list.length} screenshots downloaded` : 'Could not download screenshots', ok ? '' : 'error');
      return;
    }
    toast(`Zipping ${list.length} screenshots…`);
    const zip = new JSZip();
    let ok = 0;
    const usedNames = new Set();
    for (const t of list) {
      try {
        const src = getShotSrc(t.screenshot);
        if (!src) continue;
        const blob = await shotToBlob(src);
        let name = shotFilename(t, shotExt(blob, src));
        // Guard against duplicate filenames inside the zip
        if (usedNames.has(name)) {
          const dot = name.lastIndexOf('.');
          name = `${name.slice(0, dot)}-${Math.random().toString(36).slice(2, 6)}${name.slice(dot)}`;
        }
        usedNames.add(name);
        zip.file(name, blob);
        ok++;
      } catch (err) { /* skip images that can't be fetched (e.g. blocked by CORS) */ }
    }
    if (ok === 0) return toast('Could not download any screenshots — external sources may be blocking direct downloads', 'error');
    const content = await zip.generateAsync({ type: 'blob' });
    triggerBlobDownload(content, `fx-journal-screenshots-${todayISO()}.zip`);
    toast(ok === list.length ? `${ok} screenshots downloaded as ZIP` : `${ok} of ${list.length} screenshots downloaded as ZIP (some external sources blocked direct download)`);
  }
  function openShotModal(tradeId) {
    const list = getShotList();
    const idx = list.findIndex(t => t.id == tradeId);
    if (idx < 0) return;
    _shotModalList = list;
    _shotModalIndex = idx;
    renderShotModal();
    $('#modal').hidden = false;
    document.body.style.overflow = 'hidden';
  }
  function renderShotModal() {
    const t = _shotModalList[_shotModalIndex];
    if (!t) return;
    const card = $('#modal-card');
    const hasNav = _shotModalList.length > 1;
    const safeData = esc(getShotSrc(t.screenshot));
    card.innerHTML = `
      <button class="modal-close" data-modal-close aria-label="Close"><i class="fa-solid fa-xmark"></i></button>
      ${hasNav ? `<button class="modal-nav modal-prev" data-shot-prev aria-label="Previous"><i class="fa-solid fa-chevron-left"></i></button>` : ''}
      ${hasNav ? `<button class="modal-nav modal-next" data-shot-next aria-label="Next"><i class="fa-solid fa-chevron-right"></i></button>` : ''}
      <div class="modal-toolbar">
        <button class="modal-tool" data-shot-zoom-in aria-label="Zoom in"><i class="fa-solid fa-magnifying-glass-plus"></i></button>
        <button class="modal-tool" data-shot-zoom-out aria-label="Zoom out"><i class="fa-solid fa-magnifying-glass-minus"></i></button>
        <button class="modal-tool" data-shot-zoom-reset aria-label="Reset zoom"><i class="fa-solid fa-rotate"></i></button>
        <button class="modal-tool" data-shot-fullscreen aria-label="Full screen"><i class="fa-solid fa-expand"></i></button>
        <button class="modal-tool" data-shot-download-modal aria-label="Download image"><i class="fa-solid fa-download"></i></button>
      </div>
      <div class="modal-img-wrap" id="modal-img-wrap">
        <img id="modal-img" src="${safeData}" alt="screenshot" draggable="true" />
      </div>
      <div class="modal-info">
        <strong>${esc(t.pair)}</strong> · ${esc(t.direction)} · ${esc(t.date)} ${esc(t.time || '')}<br>
        <span class="${t.pnl > 0 ? 'pos' : (t.pnl < 0 ? 'neg' : '')}">$${fmtNum(t.pnl)}</span> · ${fmtNum(t.pips, 1)} pips · ${esc(t.strategy || '—')} · ${esc(t.session || '—')}
      </div>
      ${hasNav ? `<div class="modal-counter">${_shotModalIndex + 1} / ${_shotModalList.length}</div>` : ''}
    `;
    const dlBtn = card.querySelector('[data-shot-download-modal]');
    if (dlBtn) dlBtn.addEventListener('click', () => downloadSingleShot(t));
  }

  let _shotZoom = 1;
  function applyShotZoom() {
    const img = $('#modal-img');
    if (img) img.style.transform = `scale(${_shotZoom})`;
  }
  function zoomShot(delta) {
    _shotZoom = Math.min(4, Math.max(1, _shotZoom + delta));
    applyShotZoom();
  }
  function resetShotZoom() { _shotZoom = 1; applyShotZoom(); }

  function navShot(delta) {
    if (_shotModalList.length === 0) return;
    _shotModalIndex = (_shotModalIndex + delta + _shotModalList.length) % _shotModalList.length;
    _shotZoom = 1;
    renderShotModal();
  }
  function closeShotModal() {
    $('#modal').hidden = true;
    _shotModalList = [];
    _shotModalIndex = 0;
    _shotZoom = 1;
    document.body.style.overflow = '';
  }
  function initModal() {
    const modal = $('#modal');
    if (!modal) return;
    // Mouse wheel zoom (when not in fullscreen)
    modal.addEventListener('wheel', (e) => {
      if (modal.hidden) return;
      if (e.ctrlKey || e.metaKey) { e.preventDefault(); zoomShot(e.deltaY < 0 ? 0.2 : -0.2); }
    }, { passive: false });
    // Event delegation
    modal.addEventListener('click', (e) => {
      if (e.target.closest('[data-modal-close]')) { closeShotModal(); return; }
      if (e.target.closest('[data-shot-prev]')) { navShot(-1); return; }
      if (e.target.closest('[data-shot-next]')) { navShot(1); return; }
      if (e.target.closest('[data-shot-zoom-in]')) { zoomShot(0.25); return; }
      if (e.target.closest('[data-shot-zoom-out]')) { zoomShot(-0.25); return; }
      if (e.target.closest('[data-shot-zoom-reset]')) { resetShotZoom(); return; }
      if (e.target.closest('[data-shot-fullscreen]')) {
        const wrap = $('#modal-img-wrap');
        if (wrap && document.fullscreenElement !== wrap) {
          (wrap.requestFullscreen || wrap.webkitRequestFullscreen || (()=>{})).call(wrap).catch(()=>{});
        } else if (document.fullscreenElement) {
          document.exitFullscreen && document.exitFullscreen();
        }
        return;
      }
    });
    // Keyboard: Esc / ← / → / + / -
    document.addEventListener('keydown', (e) => {
      if (modal.hidden) return;
      if (e.key === 'Escape') { e.preventDefault(); closeShotModal(); }
      else if (e.key === 'ArrowLeft') { e.preventDefault(); navShot(-1); }
      else if (e.key === 'ArrowRight') { e.preventDefault(); navShot(1); }
      else if (e.key === '+' || e.key === '=') { e.preventDefault(); zoomShot(0.25); }
      else if (e.key === '-' || e.key === '_') { e.preventDefault(); zoomShot(-0.25); }
      else if (e.key === '0') { e.preventDefault(); resetShotZoom(); }
    });
  }

  // ================== REPORTS ==================
  function renderReports() {
    const scopedTrades = getScopedTrades();
    const scopedAccounts = getScopedAccounts();
    const k = computeKPIs(scopedTrades);
    $('#report-meta').textContent = 'Generated ' + new Date().toLocaleString() + ' · ' + scopedTrades.length + ' trades';

    // Summary KPIs
    const totalBalance = scopedAccounts.reduce((s, a) => s + (a.balance || 0), 0);
    $('#report-summary').innerHTML = [
      ['Total Balance', '$' + fmtNum(totalBalance)],
      ['Total PnL', '$' + fmtNum(k.totalPnl)],
      ['Win Rate', k.winRate.toFixed(1) + '%'],
      ['Loss Rate', k.lossRate.toFixed(1) + '%'],
      ['BE Rate', k.beRate.toFixed(1) + '%'],
      ['Profit Factor', k.profitFactor === 999 ? '∞' : k.profitFactor.toFixed(2)],
      ['Avg RR', k.avgRR.toFixed(2)],
      ['Payoff Ratio', k.payoff === 999 ? '∞' : k.payoff.toFixed(2)],
      ['Total Trades', k.total],
      ['Total R', k.totalR.toFixed(2) + ' R'],
      ['Max Drawdown', k.mdd.toFixed(1) + '%'],
      ['Best Streak', '+' + k.bestWin],
      ['Best Trade', '$' + fmtNum(k.bestTrade)],
      ['Worst Trade', '$' + fmtNum(k.worstTrade)],
      ['Avg Win', '$' + fmtNum(k.avgWin)],
      ['Avg Loss', '$' + fmtNum(k.avgLoss)],
      ['Expectancy', '$' + fmtNum(k.expectancy)],
      ['Performance Δ', (k.perfChange > 0 ? '+' : '') + k.perfChange.toFixed(1) + '%']
    ].map(([l, v]) => `<div class="kpi"><span class="kpi-l">${l}</span><span class="kpi-v">${v}</span></div>`).join('');

    // Win Breakdown summary
    const winBd = `
      <table class="report-table">
        <thead>
          <tr>
            <th>Metric</th>
            <th class="num">Value</th>
            <th class="num">% of Trades</th>
          </tr>
        </thead>
        <tbody>
          <tr><td>Wins</td><td class="num pos">${k.wins.length}</td><td class="num">${k.winRate.toFixed(1)}%</td></tr>
          <tr><td>Losses</td><td class="num warn">${k.losses.length}</td><td class="num">${k.lossRate.toFixed(1)}%</td></tr>
          <tr><td>Break-even</td><td class="num">${k.be.length}</td><td class="num">${k.beRate.toFixed(1)}%</td></tr>
          <tr><td>Average RR</td><td class="num">${k.avgRR.toFixed(2)}</td><td class="num">—</td></tr>
          <tr><td>Profit Factor</td><td class="num">${k.profitFactor === 999 ? '∞' : k.profitFactor.toFixed(2)}</td><td class="num">—</td></tr>
          <tr><td>Payoff Ratio</td><td class="num">${k.payoff === 999 ? '∞' : k.payoff.toFixed(2)}</td><td class="num">—</td></tr>
          <tr><td>Total R Earned</td><td class="num">${k.totalR.toFixed(2)} R</td><td class="num">—</td></tr>
          <tr><td>Expectancy / Trade</td><td class="num">$${fmtNum(k.expectancy)}</td><td class="num">—</td></tr>
        </tbody>
      </table>
    `;
    $('#report-winbreakdown').innerHTML = winBd;

    // Best/Worst
    const byPair = [...groupBy(scopedTrades, 'pair').entries()];
    const byStrat = [...groupBy(scopedTrades, 'strategy').entries()];
    const bySess = [...groupBy(scopedTrades, 'session').entries()];
    const byDay = [...groupBy(scopedTrades, 'date').entries()];

    const best = (arr) => arr.length ? [...arr].sort((a, b) => b[1].pnl - a[1].pnl)[0] : null;
    const worst = (arr) => arr.length ? [...arr].sort((a, b) => a[1].pnl - b[1].pnl)[0] : null;

    const bw = (label, bArr, wArr) => {
      if (!bArr || !wArr) {
        return `<tr><td><strong>${label}</strong></td><td colspan="6" class="muted" style="text-align:center">No trades logged yet</td></tr>`;
      }
      return `
      <tr>
        <td><strong>${label}</strong></td>
        <td class="best">${esc(bArr[0])}</td>
        <td class="num pos">$${fmtNum(bArr[1].pnl)}</td>
        <td class="num">${bArr[1].total}</td>
        <td class="worst">${esc(wArr[0])}</td>
        <td class="num warn">$${fmtNum(wArr[1].pnl)}</td>
        <td class="num">${wArr[1].total}</td>
      </tr>
    `;
    };
    $('#report-bestworst').innerHTML = `
      <div class="table-wrap">
        <table class="report-table align-table">
          <thead><tr>
            <th>Category</th><th>Best</th><th class="num">PnL</th><th class="num">Trades</th>
            <th>Worst</th><th class="num">PnL</th><th class="num">Trades</th>
          </tr></thead>
          <tbody>
            ${bw('Pair', best(byPair), worst(byPair))}
            ${bw('Strategy', best(byStrat), worst(byStrat))}
            ${bw('Session', best(bySess), worst(bySess))}
            ${bw('Day', best(byDay), worst(byDay))}
          </tbody>
        </table>
      </div>
    `;

    // Win rate breakdown by dimension
    const wrRows = (arr) => arr.map(([k, v]) => {
      const wr = v.total > 0 ? (v.wins / v.total) * 100 : 0;
      const wrCls = wr >= 50 ? 'pos' : 'warn';
      return `<tr><td>${esc(k)}</td><td class="num">${v.total}</td><td class="num ${wrCls}">${wr.toFixed(1)}%</td><td class="num">$${fmtNum(v.pnl)}</td></tr>`;
    }).join('');
    const wrSection = (label, arr) => `
      <tr class="section-label"><td colspan="4"><strong>${label}</strong></td></tr>
      ${wrRows(arr)}
    `;
    $('#report-wr').innerHTML = `
      <div class="table-wrap">
        <table class="report-table align-table">
          <thead><tr>
            <th>Dimension</th><th class="num">Trades</th><th class="num">Win Rate</th><th class="num">PnL</th>
          </tr></thead>
          <tbody>
            ${wrSection('By Pair', byPair)}
            ${wrSection('By Strategy', byStrat)}
            ${wrSection('By Session', bySess)}
          </tbody>
        </table>
      </div>
    `;

    // Period comparison
    const daily = groupByPeriod(k.sorted, 'daily');
    const weekly = groupByPeriod(k.sorted, 'weekly');
    const monthly = groupByPeriod(k.sorted, 'monthly');
    const yearly = groupByPeriod(k.sorted, 'yearly');
    const periodRow = (label, g) => {
      const total = g.values.reduce((s, v) => s + v, 0);
      const avg = g.values.length > 0 ? total / g.values.length : 0;
      const bst = g.values.length > 0 ? Math.max(...g.values) : 0;
      const wrst = g.values.length > 0 ? Math.min(...g.values) : 0;
      const winBuckets = g.values.filter(v => v > 0).length;
      const winPct = g.values.length > 0 ? (winBuckets / g.values.length) * 100 : 0;
      return `<tr>
        <td>${label}</td>
        <td class="num">${g.labels.length}</td>
        <td class="num">$${fmtNum(total)}</td>
        <td class="num">$${fmtNum(avg)}</td>
        <td class="num pos">$${fmtNum(bst)}</td>
        <td class="num warn">$${fmtNum(wrst)}</td>
        <td class="num">${winPct.toFixed(0)}%</td>
      </tr>`;
    };
    $('#report-period').innerHTML = `
      <div class="table-wrap">
        <table class="report-table align-table">
          <thead><tr>
            <th>Period</th><th class="num">Buckets</th><th class="num">Total PnL</th>
            <th class="num">Average</th><th class="num">Best</th><th class="num">Worst</th>
            <th class="num">Win %</th>
          </tr></thead>
          <tbody>
            ${periodRow('Daily', daily)}
            ${periodRow('Weekly', weekly)}
            ${periodRow('Monthly', monthly)}
            ${periodRow('Yearly', yearly)}
          </tbody>
        </table>
      </div>
    `;

    // Streaks
    $('#report-streaks').innerHTML = `
      <div class="table-wrap">
        <table class="report-table align-table">
          <thead><tr><th>Streak Metric</th><th class="num">Value</th></tr></thead>
          <tbody>
            <tr><td>Best Winning Streak</td><td class="num pos">+${k.bestWin}</td></tr>
            <tr><td>Best Losing Streak</td><td class="num warn">${k.bestLoss}</td></tr>
            <tr><td>Current Streak</td><td class="num">${(k.currStreak > 0 ? '+' : '') + k.currStreak}</td></tr>
            <tr><td>Highest RR on a Trade</td><td class="num">${k.highestRR.toFixed(2)}</td></tr>
          </tbody>
        </table>
      </div>
    `;

    // Monthly detail
    const monthlyRows = monthly.labels.map((label, i) => {
      const value = monthly.values[i];
      const wins = k.sorted.filter(t => (t.date || '').slice(0, 7) === label && t.pnl > 0).length;
      const losses = k.sorted.filter(t => (t.date || '').slice(0, 7) === label && t.pnl < 0).length;
      const total = wins + losses;
      const wr = total > 0 ? (wins / total) * 100 : 0;
      return `<tr>
        <td>${esc(label)}</td>
        <td class="num ${value >= 0 ? 'pos' : 'warn'}">$${fmtNum(value)}</td>
        <td class="num">${total}</td>
        <td class="num">${wins}</td>
        <td class="num">${losses}</td>
        <td class="num ${wr >= 50 ? 'pos' : 'warn'}">${wr.toFixed(1)}%</td>
      </tr>`;
    }).join('');
    $('#report-monthly').innerHTML = `
      <div class="table-wrap">
        <table class="report-table align-table">
          <thead><tr>
            <th>Month</th><th class="num">PnL</th><th class="num">Trades</th>
            <th class="num">Wins</th><th class="num">Losses</th><th class="num">Win Rate</th>
          </tr></thead>
          <tbody>${monthlyRows || `<tr><td colspan="6" class="muted">No data</td></tr>`}</tbody>
        </table>
      </div>
    `;

    // Weekly detail
    const weeklyRows = weekly.labels.map((label, i) => {
      const value = weekly.values[i];
      const trades = k.sorted.filter(t => {
        const d = new Date(t.date);
        const tmp = new Date(d); tmp.setDate(d.getDate() - d.getDay());
        return tmp.toISOString().slice(0, 10) === label;
      });
      const wins = trades.filter(t => t.pnl > 0).length;
      const total = trades.length;
      const wr = total > 0 ? (wins / total) * 100 : 0;
      return `<tr>
        <td>${esc(label)}</td>
        <td class="num ${value >= 0 ? 'pos' : 'warn'}">$${fmtNum(value)}</td>
        <td class="num">${total}</td>
        <td class="num ${wr >= 50 ? 'pos' : 'warn'}">${wr.toFixed(1)}%</td>
      </tr>`;
    }).join('');
    $('#report-weekly').innerHTML = `
      <div class="table-wrap">
        <table class="report-table align-table">
          <thead><tr>
            <th>Week</th><th class="num">PnL</th><th class="num">Trades</th><th class="num">Win Rate</th>
          </tr></thead>
          <tbody>${weeklyRows || `<tr><td colspan="4" class="muted">No data</td></tr>`}</tbody>
        </table>
      </div>
    `;

    // Daily detail (last 14 days)
    const dailyRows = daily.labels.slice(-14).map((label, idx, arr) => {
      const realIdx = daily.labels.length - arr.length + idx;
      const value = daily.values[realIdx];
      const trades = k.sorted.filter(t => t.date === label);
      return `<tr>
        <td>${esc(label)}</td>
        <td class="num ${value >= 0 ? 'pos' : 'warn'}">$${fmtNum(value)}</td>
        <td class="num">${trades.length}</td>
      </tr>`;
    }).reverse().join('');
    $('#report-daily').innerHTML = `
      <div class="table-wrap">
        <table class="report-table align-table">
          <thead><tr><th>Date</th><th class="num">PnL</th><th class="num">Trades</th></tr></thead>
          <tbody>${dailyRows || `<tr><td colspan="3" class="muted">No data</td></tr>`}</tbody>
        </table>
      </div>
    `;

    // All trades — proper table with consistent column count
    const sorted = [...scopedTrades].sort((a, b) => (a.date < b.date ? -1 : 1));
    $('#report-trades').innerHTML = sorted.map(t => `
      <tr>
        <td>${esc(t.date)}</td>
        <td>${esc(t.pair)}</td>
        <td>${esc(t.direction)}</td>
        <td class="num">${t.lot}</td>
        <td class="num">${fmtNum(t.entry)}</td>
        <td class="num">${fmtNum(t.sl)}</td>
        <td class="num">${fmtNum(t.tp)}</td>
        <td class="num">${fmtNum(t.exit)}</td>
        <td class="num">${fmtNum(t.pips, 1)}</td>
        <td class="num ${t.pnl > 0 ? 'pos' : (t.pnl < 0 ? 'warn' : '')}">$${fmtNum(t.pnl)}</td>
        <td>${esc(t.strategy || '—')}</td>
        <td>${esc(t.session || '—')}</td>
      </tr>
    `).join('') || `<tr><td colspan="12"><div class="empty-state">No trades to display.</div></td></tr>`;
  }
  function exportCSV() {
    const headers = ['Date', 'Time', 'Pair', 'Direction', 'Market', 'Lot', 'Entry', 'SL', 'TP', 'Exit', 'Pips', 'PnL', 'RR', 'R Multiple', 'Risk $', 'Profit $', 'Loss $', 'Account', 'Strategy', 'Session', 'Emotion', 'Execution', 'Mistake', 'Grade', 'Notes'];
    const rows = getScopedTrades().map(t => [
      t.date, t.time, t.pair, t.direction, t.market, t.lot, t.entry, t.sl, t.tp, t.exit,
      t.pips.toFixed(1), t.pnl.toFixed(2), t.rr.toFixed(2), t.rMultiple.toFixed(2),
      t.riskDollar.toFixed(2), t.profitDollar.toFixed(2), t.lossDollar.toFixed(2),
      t.accountName, t.strategy, t.session, t.emotion, t.execution, t.mistake, t.grade,
      (t.notes || '').replace(/"/g, '""')
    ].map(v => `"${v == null ? '' : v}"`).join(','));
    const csv = [headers.join(','), ...rows].join('\n');
    download(new Blob([csv], { type: 'text/csv' }), `fx-journal-${Date.now()}.csv`);
    toast('CSV exported');
  }
  function exportJSON() {
    toast('Preparing backup…');
    // Screenshots live in IndexedDB and are only referenced by id in `state`.
    // For a real, portable backup we inline the actual image bytes here so
    // the exported file is self-contained and still has every screenshot
    // even if opened on another device/browser.
    const bundle = JSON.parse(JSON.stringify(state));
    const inlineShots = (obj) => {
      if (obj && obj.screenshot && obj.screenshot.type === 'upload' && obj.screenshot.shotId) {
        obj.screenshot = { type: 'upload', shotId: obj.screenshot.shotId, data: shotCache.get(obj.screenshot.shotId) || null };
      }
    };
    bundle.trades.forEach(inlineShots);
    bundle.recycleBin.forEach(item => { if (item.type === 'trade') inlineShots(item.data); });
    download(new Blob([JSON.stringify(bundle, null, 2)], { type: 'application/json' }), `fx-journal-backup-${Date.now()}.json`);
    toast('Backup exported (includes screenshots)');
  }
  function exportPDF() {
    if (!window.html2pdf) return toast('PDF library not loaded', 'error');
    const el = $('#report-doc');
    const opt = { margin: 10, filename: `fx-journal-${Date.now()}.pdf`, image: { type: 'jpeg', quality: 0.95 }, html2canvas: { scale: 2, backgroundColor: null }, jsPDF: { unit: 'mm', format: 'a4', orientation: 'portrait' } };
    toast('Generating PDF…');
    html2pdf().set(opt).from(el).save();
  }
  function download(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = filename; a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  function initReports() {
    $('#r-print').addEventListener('click', () => window.print());
    $('#r-csv').addEventListener('click', exportCSV);
    $('#r-pdf').addEventListener('click', exportPDF);
    $('#r-json').addEventListener('click', exportJSON);
  }

  // ================== PSYCHOLOGY ==================
  function renderPsychology(force) {
    const c = chartPalette();
    const t = getScopedTrades();
    const total = t.length;
    if (total === 0) {
      $('#psy-insights').innerHTML = `<p class="muted" style="grid-column:1/-1;">No trades to analyze yet. Add trades in the Trade Journal to unlock psychology insights.</p>`;
      $('#psy-emotion-table').innerHTML = '';
      $('#psy-exec-table').innerHTML = '';
      $('#psy-mistake-table').innerHTML = '';
      $('#psy-suggestions').innerHTML = '';
    } else {
      const byEmotion = groupBy(t, 'emotion');
      const byExec = groupBy(t, 'execution');
      const bySession = groupBy(t, 'session');
      const byStrategy = groupBy(t, 'strategy');
      const byMistake = groupBy(t, 'mistake');

      // Top / Worst / Most Common
      const nonEmpty = (m) => [...m.entries()].filter(([k]) => k && k !== '—');
      const bestEmotion = nonEmpty(byEmotion).sort((a, b) => (b[1].wins / b[1].total) - (a[1].wins / a[1].total))[0];
      const worstEmotion = nonEmpty(byEmotion).sort((a, b) => (a[1].wins / a[1].total) - (b[1].wins / b[1].total))[0];
      const mostCommonEmotion = nonEmpty(byEmotion).sort((a, b) => b[1].total - a[1].total)[0];
      const bestExec = nonEmpty(byExec).sort((a, b) => (b[1].wins / b[1].total) - (a[1].wins / a[1].total))[0];
      const worstExec = nonEmpty(byExec).sort((a, b) => (a[1].wins / a[1].total) - (b[1].wins / b[1].total))[0];
      const bestSession = nonEmpty(bySession).sort((a, b) => (b[1].wins / b[1].total) - (a[1].wins / a[1].total))[0];
      const bestStrat = nonEmpty(byStrategy).sort((a, b) => b[1].rrSum / b[1].total - a[1].rrSum / a[1].total)[0];
      const mostCommonMistake = nonEmpty(byMistake).sort((a, b) => b[1].total - a[1].total)[0];

      const insights = [];
      if (mostCommonEmotion) insights.push({ type: 'pos', label: 'Most Frequent Emotion', val: mostCommonEmotion[0], meta: `${mostCommonEmotion[1].total} trades · ${((mostCommonEmotion[1].total / total) * 100).toFixed(0)}% of trades` });
      if (bestEmotion) insights.push({ type: 'pos', label: 'Best Performing Emotion', val: bestEmotion[0], meta: `${((bestEmotion[1].wins / bestEmotion[1].total) * 100).toFixed(0)}% win rate` });
      if (worstEmotion) insights.push({ type: 'neg', label: 'Worst Performing Emotion', val: worstEmotion[0], meta: `${((worstEmotion[1].wins / worstEmotion[1].total) * 100).toFixed(0)}% win rate — revisit before next session` });
      if (bestExec) insights.push({ type: 'pos', label: 'Best Execution Quality', val: bestExec[0], meta: `${((bestExec[1].wins / bestExec[1].total) * 100).toFixed(0)}% win rate` });
      if (worstExec) insights.push({ type: 'neg', label: 'Lowest Execution Quality', val: worstExec[0], meta: `${((worstExec[1].wins / worstExec[1].total) * 100).toFixed(0)}% win rate` });
      if (bestSession) insights.push({ type: 'pos', label: 'Best Session', val: bestSession[0], meta: `${((bestSession[1].wins / bestSession[1].total) * 100).toFixed(0)}% win rate` });
      if (bestStrat) insights.push({ type: 'pos', label: 'Best Strategy (RR)', val: bestStrat[0], meta: `Avg RR ${(bestStrat[1].rrSum / bestStrat[1].total).toFixed(2)}` });
      if (mostCommonMistake) insights.push({ type: 'neg', label: 'Most Common Mistake', val: mostCommonMistake[0], meta: `${mostCommonMistake[1].total} trades flagged — address in your rules` });

      const wins = t.filter(x => x.pnl > 0);
      if (wins.length / total > 0.5) insights.push({ type: 'pos', label: 'Strength', val: 'Discipline Paying Off', meta: `${((wins.length / total) * 100).toFixed(0)}% of trades are winners` });
      const aGrade = t.filter(x => x.grade === 'A+' || x.grade === 'A').length;
      if (aGrade > total * 0.4) insights.push({ type: 'pos', label: 'Strength', val: 'High-Quality Setups', meta: `${aGrade} of ${total} trades graded A or higher` });

      $('#psy-insights').innerHTML = insights.map(i => `
        <div class="insight ${i.type}">
          <h4>${i.label}</h4>
          <div class="insight-val">${esc(i.val)}</div>
          <div class="insight-meta">${i.meta}</div>
        </div>
      `).join('');

      // Detailed tables
      const tableRows = (entries) => entries.map(([k, v]) => {
        const freq = (v.total / total) * 100;
        const wr = v.total > 0 ? (v.wins / v.total) * 100 : 0;
        const wrCls = wr >= 50 ? 'pos' : 'warn';
        return `<tr>
          <td>${esc(k)}</td>
          <td class="num">${v.total}</td>
          <td class="num">${freq.toFixed(1)}%</td>
          <td class="num ${wrCls}">${wr.toFixed(1)}%</td>
          <td class="num ${v.pnl >= 0 ? 'pos' : 'warn'}">$${fmtNum(v.pnl)}</td>
        </tr>`;
      }).join('');

      $('#psy-emotion-table').innerHTML = `
        <div class="table-wrap">
          <table class="report-table align-table">
            <thead><tr><th>Emotion</th><th class="num">Trades</th><th class="num">Frequency</th><th class="num">Win Rate</th><th class="num">Total PnL</th></tr></thead>
            <tbody>${tableRows(nonEmpty(byEmotion)) || `<tr><td colspan="5" class="muted">Log emotions in your trades to see data</td></tr>`}</tbody>
          </table>
        </div>
      `;
      $('#psy-exec-table').innerHTML = `
        <div class="table-wrap">
          <table class="report-table align-table">
            <thead><tr><th>Execution Quality</th><th class="num">Trades</th><th class="num">Frequency</th><th class="num">Win Rate</th><th class="num">Total PnL</th></tr></thead>
            <tbody>${tableRows(nonEmpty(byExec)) || `<tr><td colspan="5" class="muted">Log execution quality to see data</td></tr>`}</tbody>
          </table>
        </div>
      `;

      // Mistake tracker with trend
      const mistakeEntries = nonEmpty(byMistake).sort((a, b) => b[1].total - a[1].total);
      const mistakeRows = mistakeEntries.map(([k, v]) => {
        // Trend: compare last third vs previous third
        const allMistakedTrades = t.filter(x => x.mistake === k);
        const last = Math.floor(allMistakedTrades.length / 3) || 1;
        const recent = allMistakedTrades.slice(-last).length;
        const older = allMistakedTrades.slice(0, Math.max(1, allMistakedTrades.length - last)).length;
        const recentPct = (recent / Math.max(1, last)) * 100;
        const olderPct = (older / Math.max(1, allMistakedTrades.length - last)) * 100;
        const trend = recent < older ? '↓ Improving' : (recent > older ? '↑ Worsening' : '→ Stable');
        const trendCls = recent < older ? 'pos' : (recent > older ? 'warn' : '');
        const freqPct = (v.total / total) * 100;
        return `<tr>
          <td>${esc(k)}</td>
          <td class="num">${v.total}</td>
          <td class="num">${freqPct.toFixed(1)}%</td>
          <td class="num ${trendCls}">${trend}</td>
          <td class="num ${v.pnl >= 0 ? 'pos' : 'warn'}">$${fmtNum(v.pnl)}</td>
        </tr>`;
      }).join('');
      $('#psy-mistake-table').innerHTML = `
        <div class="table-wrap">
          <table class="report-table align-table">
            <thead><tr><th>Mistake</th><th class="num">Times Logged</th><th class="num">% of Trades</th><th class="num">Trend</th><th class="num">Total PnL Impact</th></tr></thead>
            <tbody>${mistakeRows || `<tr><td colspan="5" class="muted">No mistakes logged yet — great discipline!</td></tr>`}</tbody>
          </table>
        </div>
      `;

      // Improvement suggestions
      const suggestions = [];
      if (mostCommonMistake) {
        suggestions.push(`Add "${esc(mostCommonMistake[0])}" to your Rules and review it before every session.`);
      }
      if (worstEmotion) {
        suggestions.push(`Reduce exposure when feeling ${esc(worstEmotion[0])} — your win rate drops to ${((worstEmotion[1].wins / worstEmotion[1].total) * 100).toFixed(0)}%.`);
      }
      if (mostCommonEmotion && bestEmotion && mostCommonEmotion[0] !== bestEmotion[0]) {
        const occ = ((mostCommonEmotion[1].total / total) * 100).toFixed(0);
        suggestions.push(`${occ}% of your trades are taken feeling ${esc(mostCommonEmotion[0])}, but you trade best feeling ${esc(bestEmotion[0])}. Pause before entries.`);
      }
      if (bestSession) {
        suggestions.push(`Your edge is strongest in ${esc(bestSession[0])} — schedule deep work there.`);
      }
      if (bestExec) {
        suggestions.push(`${esc(bestExec[0])} execution correlates with ${((bestExec[1].wins / bestExec[1].total) * 100).toFixed(0)}% wins — audit what makes execution feel that way.`);
      }
      if (t.filter(x => x.pnl < 0 && x.mistake).length >= 3) {
        suggestions.push(`${t.filter(x => x.pnl < 0 && x.mistake).length} losing trades had a logged mistake. Consider a pre-trade checklist.`);
      }
      if (suggestions.length === 0) {
        suggestions.push('Log emotions, execution quality, and mistakes on every trade to unlock personalized suggestions.');
      }
      $('#psy-suggestions').innerHTML = suggestions.map((s, i) => `
        <div class="suggestion-item">
          <span class="suggestion-num">${i + 1}</span>
          <span class="suggestion-text">${s}</span>
        </div>
      `).join('');
    }

    // Charts
    const emoMap = groupBy(t, 'emotion');
    const emoLabels = [...emoMap.keys()].filter(k => k && k !== '—');
    const emoFreq = emoLabels.map(l => emoMap.get(l).total);
    const emoWR = emoLabels.map(l => emoMap.get(l).total > 0 ? +((emoMap.get(l).wins / emoMap.get(l).total) * 100).toFixed(1) : 0);

    const eEl = $('#p-emo');
    if (eEl) {
      destroyChart('pEmo');
      charts.pEmo = new Chart(eEl, { type: 'bar', data: { labels: emoLabels, datasets: [{ label: 'Frequency', data: emoFreq, backgroundColor: c.cyan, borderRadius: 6 }] }, options: chartOpts() });
    }
    const ewrEl = $('#p-emo-wr');
    if (ewrEl) {
      destroyChart('pEmoWr');
      charts.pEmoWr = new Chart(ewrEl, { type: 'bar', data: { labels: emoLabels, datasets: [{ label: 'Win Rate (%)', data: emoWR, backgroundColor: c.blue, borderRadius: 6 }] }, options: chartOpts() });
    }
    const mMap = groupBy(t, 'mistake');
    const mLabels = [...mMap.keys()].filter(k => k && k !== '—');
    const mFreq = mLabels.map(l => mMap.get(l).total);
    const mEl = $('#p-mistake');
    if (mEl) {
      destroyChart('pMistake');
      charts.pMistake = new Chart(mEl, { type: 'bar', data: { labels: mLabels, datasets: [{ label: 'Frequency', data: mFreq, backgroundColor: c.amber, borderRadius: 6 }] }, options: chartOpts() });
    }
    const exMap = groupBy(t, 'execution');
    const exLabels = [...exMap.keys()].filter(k => k && k !== '—');
    const exFreq = exLabels.map(l => exMap.get(l).total);
    const exEl = $('#p-exec');
    if (exEl) {
      destroyChart('pExec');
      charts.pExec = new Chart(exEl, { type: 'doughnut', data: { labels: exLabels, datasets: [{ data: exFreq, backgroundColor: [c.cyan, c.blue, c.purple, c.amber, c.slate], borderColor: 'transparent' }] }, options: { ...chartOpts(), scales: {} } });
    }
    const exWR = exLabels.map(l => exMap.get(l).total > 0 ? +((exMap.get(l).wins / exMap.get(l).total) * 100).toFixed(1) : 0);
    const exwrEl = $('#p-exec-wr');
    if (exwrEl) {
      destroyChart('pExecWr');
      charts.pExecWr = new Chart(exwrEl, { type: 'bar', data: { labels: exLabels, datasets: [{ label: 'Win Rate (%)', data: exWR, backgroundColor: c.purple, borderRadius: 6 }] }, options: chartOpts() });
    }
    const sesMap = groupBy(t, 'session');
    const sesLabels = [...sesMap.keys()].filter(k => k && k !== '—');
    const sesWR = sesLabels.map(l => sesMap.get(l).total > 0 ? +((sesMap.get(l).wins / sesMap.get(l).total) * 100).toFixed(1) : 0);
    const sEl = $('#p-session-wr');
    if (sEl) {
      destroyChart('pSessWr');
      charts.pSessWr = new Chart(sEl, { type: 'bar', data: { labels: sesLabels, datasets: [{ label: 'Win Rate (%)', data: sesWR, backgroundColor: c.cyan, borderRadius: 6 }] }, options: chartOpts() });
    }
  }

  // ================== PLAYBOOK ==================
  let _editingPlaybookId = null;
  function initPlaybookForm() {
    initCombos($('#view-playbook'));
    $('#pb-save').addEventListener('click', savePlaybook);
    $('#pb-cancel').addEventListener('click', resetPlaybookForm);
  }
  async function savePlaybook() {
    const name = $('#pb-name').value.trim();
    if (!name) return toast('Setup name required', 'error');
    const entry = {
      id: _editingPlaybookId || null,
      name,
      strategy: getComboValue($$('.combo[data-combo]', $('#view-playbook'))[0]),
      screenshot: $('#pb-shot').value.trim(),
      entry: $('#pb-entry').value.trim(),
      exit: $('#pb-exit').value.trim(),
      risk: $('#pb-risk').value.trim(),
      notes: $('#pb-notes').value.trim(),
      createdAt: new Date().toISOString()
    };
    if (_editingPlaybookId) {
      if (window.DB && window.DB.playbook) {
        try { await window.DB.playbook.update(entry.id, entry); }
        catch (err) { console.error('Playbook update failed, saved locally only:', err); }
      }
      const idx = state.playbook.findIndex(p => p.id == _editingPlaybookId);
      if (idx >= 0) state.playbook[idx] = { ...state.playbook[idx], ...entry };
      toast('Setup updated');
    } else {
      if (window.DB && window.DB.playbook) {
        try {
          const saved = await window.DB.playbook.insert(entry);
          if (saved && saved.id) entry.id = saved.id;
        } catch (err) { console.error('Playbook insert failed, saved locally only:', err); }
      }
      if (!entry.id) entry.id = Date.now(); // offline fallback only
      state.playbook.push(entry);
      toast('Setup saved');
    }
    save();
    resetPlaybookForm();
    renderPlaybook();
  }
  function resetPlaybookForm() {
    _editingPlaybookId = null;
    $('#pb-name').value = '';
    $('#pb-shot').value = '';
    $('#pb-entry').value = '';
    $('#pb-exit').value = '';
    $('#pb-risk').value = '';
    $('#pb-notes').value = '';
    $$('.combo[data-combo]', $('#view-playbook')).forEach(c => setComboValue(c, ''));
    $('#pb-save').innerHTML = '<i class="fa-solid fa-floppy-disk"></i> Save Setup';
  }
  function editPlaybook(id) {
    const p = state.playbook.find(x => x.id == id);
    if (!p) return;
    _editingPlaybookId = id;
    $('#pb-name').value = p.name;
    $('#pb-shot').value = p.screenshot || '';
    $('#pb-entry').value = p.entry || '';
    $('#pb-exit').value = p.exit || '';
    $('#pb-risk').value = p.risk || '';
    $('#pb-notes').value = p.notes || '';
    setComboValue($$('.combo[data-combo]', $('#view-playbook'))[0], p.strategy || '');
    $('#pb-save').innerHTML = '<i class="fa-solid fa-floppy-disk"></i> Update Setup';
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }
  async function deletePlaybook(id) {
    if (!confirm('Move this setup to Recycle Bin?')) return;
    const p = state.playbook.find(x => x.id == id);
    if (!p) return;
    const recycleEntry = await syncRecycleInsert({ type: 'playbook', data: { ...p }, deletedAt: new Date().toISOString() });
    state.recycleBin.push(recycleEntry);
    state.playbook = state.playbook.filter(x => x.id != id);
    if (window.DB && window.DB.playbook) {
      try { await window.DB.playbook.remove(id); }
      catch (err) { console.error('Playbook delete failed, removed locally only:', err); }
    }
    save();
    renderPlaybook();
    renderRecycleBin();
    toast('Setup moved to Recycle Bin');
  }
  // Associates trades with a Playbook setup by matching either the trade's
  // Strategy field or its notes/pair against the setup's Strategy or Setup
  // Name (case-insensitive, trimmed) — so a setup named after its strategy,
  // or a custom strategy typed to match a setup name, both link up.
  function tradesForPlaybook(p) {
    const name = (p.name || '').trim().toLowerCase();
    const strat = (p.strategy || '').trim().toLowerCase();
    if (!name && !strat) return [];
    return getScopedTrades().filter(t => {
      const ts = (t.strategy || '').trim().toLowerCase();
      if (!ts) return false;
      return (strat && ts === strat) || (name && ts === name);
    });
  }

  function computePlaybookStats(p) {
    const matched = tradesForPlaybook(p);
    if (matched.length === 0) return null;
    const k = computeKPIs(matched);
    const totalRisk = matched.reduce((s, t) => s + (t.riskDollar || 0), 0);
    const lastTradeDate = matched.reduce((max, t) => (t.date && t.date > max ? t.date : max), matched[0].date || '');
    const pairCounts = new Map();
    matched.forEach(t => { const pr = t.pair || '—'; pairCounts.set(pr, (pairCounts.get(pr) || 0) + 1); });
    let mostTradedPair = '—', mostTradedCount = 0;
    pairCounts.forEach((count, pr) => { if (count > mostTradedCount) { mostTradedPair = pr; mostTradedCount = count; } });
    return {
      count: matched.length,
      winRate: k.winRate,
      lossRate: k.lossRate,
      avgRR: k.avgRR,
      netPnl: k.totalPnl,
      bestTrade: k.bestTrade,
      worstTrade: k.worstTrade,
      lastTradeDate,
      mostTradedPair,
      totalRisk,
      trendDir: k.trendDir
    };
  }

  function renderPlaybook() {
    const grid = $('#pb-grid');
    if (!grid) return;
    if (state.playbook.length === 0) {
      grid.innerHTML = `<p class="muted" style="grid-column:1/-1;">No setups yet. Document your first one above.</p>`;
      return;
    }
    grid.innerHTML = state.playbook.map(p => {
      const s = computePlaybookStats(p);
      const trendIcon = s ? (s.trendDir === 'up' ? 'fa-arrow-trend-up' : (s.trendDir === 'down' ? 'fa-arrow-trend-down' : 'fa-minus')) : '';
      const statsHtml = s ? `
        <div class="pb-perf">
          <div class="pb-perf-title">
            <strong>Performance (${s.count} trade${s.count === 1 ? '' : 's'})</strong>
            <span class="pb-trend ${s.trendDir}"><i class="fa-solid ${trendIcon}"></i> ${esc(s.trendDir)}</span>
          </div>
          <div class="pb-stat-grid">
            <div class="pb-stat"><span>Win Rate</span><b class="pos">${fmtPct(s.winRate)}</b></div>
            <div class="pb-stat"><span>Loss Rate</span><b class="neg">${fmtPct(s.lossRate)}</b></div>
            <div class="pb-stat"><span>Avg RR</span><b>${fmtNum(s.avgRR)}</b></div>
            <div class="pb-stat"><span>Net P/L</span><b class="${s.netPnl > 0 ? 'pos' : (s.netPnl < 0 ? 'neg' : '')}">${fmtMoney(s.netPnl)}</b></div>
            <div class="pb-stat"><span>Best Trade</span><b class="pos">${fmtMoney(s.bestTrade)}</b></div>
            <div class="pb-stat"><span>Worst Trade</span><b class="neg">${fmtMoney(s.worstTrade)}</b></div>
            <div class="pb-stat"><span>Total Risk</span><b>${fmtMoney(s.totalRisk)}</b></div>
            <div class="pb-stat"><span>Top Pair</span><b>${esc(s.mostTradedPair)}</b></div>
            <div class="pb-stat"><span>Last Trade</span><b>${esc(s.lastTradeDate || '—')}</b></div>
          </div>
        </div>
      ` : `<div class="pb-perf"><span class="pb-empty-stats">No trades logged with this Strategy / Setup Name yet.</span></div>`;
      return `
      <div class="playbook-card">
        ${p.screenshot ? `<img class="pb-img" src="${esc(p.screenshot)}" alt="setup image" />` : ''}
        <h4>${esc(p.name)}</h4>
        <div class="meta">${esc(p.strategy || '—')}</div>
        <div class="pb-section"><strong>Entry</strong><p>${esc(p.entry || '—')}</p></div>
        <div class="pb-section"><strong>Exit</strong><p>${esc(p.exit || '—')}</p></div>
        <div class="pb-section"><strong>Risk</strong><p>${esc(p.risk || '—')}</p></div>
        ${p.notes ? `<div class="pb-section"><strong>Notes</strong><p>${esc(p.notes)}</p></div>` : ''}
        ${statsHtml}
        <div class="pb-actions">
          <button data-pb-edit="${p.id}">Edit</button>
          <button data-pb-del="${p.id}">Delete</button>
        </div>
      </div>
    `;
    }).join('');
    $$('[data-pb-edit]').forEach(b => b.addEventListener('click', () => editPlaybook(b.dataset.pbEdit)));
    $$('[data-pb-del]').forEach(b => b.addEventListener('click', () => deletePlaybook(b.dataset.pbDel)));
  }

  // ================== RULES ==================
  function initRuleForm() {
    $('#r-add').addEventListener('click', addRule);
    const cat = $('#r-cat');
    const custom = $('#r-cat-custom');
    if (cat) {
      cat.addEventListener('change', () => {
        if (cat.value === '__custom__') custom.style.display = 'block';
        else custom.style.display = 'none';
      });
    }
  }
  async function addRule() {
    const catSel = $('#r-cat');
    const cat = catSel.value === '__custom__' ? $('#r-cat-custom').value.trim() : catSel.value;
    const text = $('#r-text').value.trim();
    if (!text) return toast('Rule text required', 'error');
    if (!cat) return toast('Category required', 'error');
    const rule = { id: null, category: cat, text, createdAt: new Date().toISOString() };
    if (window.DB && window.DB.rules) {
      try {
        const saved = await window.DB.rules.insert(rule);
        if (saved && saved.id) rule.id = saved.id;
      } catch (err) { console.error('Rule insert failed, saved locally only:', err); }
    }
    if (!rule.id) rule.id = Date.now(); // offline fallback only
    state.rules.push(rule);
    save();
    renderRules();
    $('#r-text').value = '';
    if (catSel) catSel.value = 'Strategy';
    if ($('#r-cat-custom')) $('#r-cat-custom').style.display = 'none';
    toast('Rule added');
  }
  async function deleteRule(id) {
    if (!confirm('Move this rule to Recycle Bin?')) return;
    const r = state.rules.find(x => x.id == id);
    if (!r) return;
    const recycleEntry = await syncRecycleInsert({ type: 'rule', data: { ...r }, deletedAt: new Date().toISOString() });
    state.recycleBin.push(recycleEntry);
    state.rules = state.rules.filter(x => x.id != id);
    if (window.DB && window.DB.rules) {
      try { await window.DB.rules.remove(id); }
      catch (err) { console.error('Rule delete failed, removed locally only:', err); }
    }
    save();
    renderRules();
    renderRecycleBin();
    toast('Rule moved to Recycle Bin');
  }
  function renderRules() {
    const list = $('#rules-list');
    if (!list) return;
    if (state.rules.length === 0) {
      list.innerHTML = `<p class="muted">No rules yet. Add your first one above.</p>`;
      return;
    }
    list.innerHTML = state.rules.map(r => `
      <div class="rule-item">
        <span class="rule-cat">${esc(r.category)}</span>
        <span class="rule-text">${esc(r.text)}</span>
        <div class="rule-actions">
          <button class="del" data-del-rule="${r.id}">Delete</button>
        </div>
      </div>
    `).join('');
    $$('[data-del-rule]').forEach(b => b.addEventListener('click', () => deleteRule(b.dataset.delRule)));
  }

  // ================== RECYCLE BIN ==================
  // Frees IndexedDB storage for a trade's screenshot once it's permanently
  // gone (i.e. no longer in the active journal or the recycle bin).
  function purgeShotIfOrphaned(screenshotRef) {
    if (!screenshotRef || screenshotRef.type !== 'upload' || !screenshotRef.shotId) return;
    const shotId = screenshotRef.shotId;
    const stillUsed =
      state.trades.some(t => t.screenshot && t.screenshot.shotId === shotId) ||
      state.recycleBin.some(item => item.type === 'trade' && item.data.screenshot && item.data.screenshot.shotId === shotId);
    if (!stillUsed) {
      shotCache.delete(shotId);
      ShotDB.del(shotId);
    }
  }
  function initRecycle() {
    $('#recycle-empty').addEventListener('click', async () => {
      if (state.recycleBin.length === 0) return;
      if (!confirm(`Permanently delete ${state.recycleBin.length} item(s)?`)) return;
      const removedTrades = state.recycleBin.filter(item => item.type === 'trade');
      const toRemove = state.recycleBin;
      state.recycleBin = [];
      await Promise.all(toRemove.map(item => syncRecycleRemove(item)));
      removedTrades.forEach(item => purgeShotIfOrphaned(item.data.screenshot));
      save();
      renderRecycleBin();
      toast('Recycle bin emptied');
    });
  }
  function recycleRow(item, idx) {
    const d = item.data;
    const deletedAt = new Date(item.deletedAt).toLocaleString();
    const typeLabel = item.type.charAt(0).toUpperCase() + item.type.slice(1);
    const actions = `
      <div class="row-actions">
        <button data-rec-restore="${idx}">Restore</button>
        <button class="del" data-rec-perm="${idx}">Delete</button>
      </div>
    `;
    if (item.type === 'trade') {
      return `
        <tr>
          <td><span class="rec-type trade">${typeLabel}</span><span class="rec-deleted-at">${deletedAt}</span></td>
          <td>${esc(d.date || '—')}</td>
          <td>${esc(d.pair || '—')}</td>
          <td>${esc(d.direction || '—')}</td>
          <td>${fmtNum(d.entry)}</td>
          <td>${fmtNum(d.exit)}</td>
          <td class="${d.pnl > 0 ? 'pos' : (d.pnl < 0 ? 'neg' : '')}">$${fmtNum(d.pnl)}</td>
          <td>${actions}</td>
        </tr>
      `;
    } else if (item.type === 'account') {
      return `
        <tr>
          <td><span class="rec-type account">${typeLabel}</span><span class="rec-deleted-at">${deletedAt}</span></td>
          <td colspan="3">${esc(d.name)} <span class="muted">(${esc(d.broker)})</span></td>
          <td colspan="2">${esc(d.type)}</td>
          <td>$${fmtNum(d.balance)}</td>
          <td>${actions}</td>
        </tr>
      `;
    } else if (item.type === 'transaction') {
      return `
        <tr>
          <td><span class="rec-type transaction">${typeLabel}</span><span class="rec-deleted-at">${deletedAt}</span></td>
          <td>${esc(d.date || '—')}</td>
          <td colspan="3">${esc(d.accountName || '—')}</td>
          <td>${esc(d.type)}</td>
          <td>$${fmtNum(d.amount)}</td>
          <td>${actions}</td>
        </tr>
      `;
    } else if (item.type === 'playbook') {
      return `
        <tr>
          <td><span class="rec-type playbook">${typeLabel}</span><span class="rec-deleted-at">${deletedAt}</span></td>
          <td colspan="5">${esc(d.name)} <span class="muted">· ${esc(d.strategy || '—')}</span></td>
          <td>${esc((d.notes || '').slice(0, 50))}</td>
          <td>${actions}</td>
        </tr>
      `;
    } else if (item.type === 'rule') {
      return `
        <tr>
          <td><span class="rec-type rule">${typeLabel}</span><span class="rec-deleted-at">${deletedAt}</span></td>
          <td colspan="6"><strong>${esc(d.category)}:</strong> ${esc(d.text)}</td>
          <td>${actions}</td>
        </tr>
      `;
    }
    return '';
  }
  function renderRecycleBin() {
    const body = $('#recycle-body');
    if (!body) return;
    if (state.recycleBin.length === 0) {
      body.innerHTML = `<tr><td colspan="8"><div class="empty-state">Recycle bin is empty. Deleted trades, accounts, transactions, playbook entries, and rules will appear here.</div></td></tr>`;
      return;
    }
    body.innerHTML = state.recycleBin.map((item, idx) => recycleRow(item, idx)).join('');
    $$('[data-rec-restore]', body).forEach(b => b.addEventListener('click', () => restoreFromBin(+b.dataset.recRestore)));
    $$('[data-rec-perm]', body).forEach(b => b.addEventListener('click', () => permDeleteFromBin(+b.dataset.recPerm)));
  }
  // Re-inserting into Supabase on restore always creates a NEW row (every
  // table's insert() strips any incoming id — see database.js toRow()), so
  // a restored item gets a fresh uuid rather than reusing its old one.
  // That's fine: the data is identical, only the row identity changes, and
  // it keeps this function using the exact same insert() path every other
  // "create" flow already uses instead of a second bespoke code path.
  async function restoreFromBin(idx) {
    const item = state.recycleBin[idx];
    if (!item) return;
    if (item.type === 'trade') {
      const t = item.data;
      // Don't resurrect a trade that's already back in the active list
      // (defends against a double-click firing restore twice).
      if (state.trades.some(x => x.id == t.id)) {
        state.recycleBin.splice(idx, 1);
        await syncRecycleRemove(item);
        save();
        refreshAll();
        return;
      }
      let acc = null;
      if (t.accountId) {
        acc = state.accounts.find(a => a.id == t.accountId);
        if (acc) {
          if (!t.open && t.pnl) acc.balance = +(acc.balance + t.pnl).toFixed(2);
          acc.tradesCount = (acc.tradesCount || 0) + 1;
        }
      }
      if (window.DB && window.DB.trades) {
        try { const saved = await window.DB.trades.insert(t); if (saved && saved.id) t.id = saved.id; }
        catch (err) { console.error('Trade restore-insert failed, restored locally only:', err); }
      }
      if (acc) await syncAccountBalance(acc);
      state.trades.push(t);
    } else if (item.type === 'account') {
      const acc = item.data;
      if (window.DB && window.DB.accounts) {
        try { const saved = await window.DB.accounts.insert(acc); if (saved && saved.id) acc.id = saved.id; }
        catch (err) { console.error('Account restore-insert failed, restored locally only:', err); }
      }
      state.accounts.push(acc);
    } else if (item.type === 'transaction') {
      const tx = item.data;
      const acc = state.accounts.find(a => a.id == tx.accountId);
      if (acc) {
        const delta = tx.delta != null ? tx.delta : transactionDelta(tx.type, tx.amount);
        acc.balance = +(acc.balance + delta).toFixed(2);
      }
      if (window.DB && window.DB.transactions) {
        try { const saved = await window.DB.transactions.insert(tx); if (saved && saved.id) tx.id = saved.id; }
        catch (err) { console.error('Transaction restore-insert failed, restored locally only:', err); }
      }
      if (acc) await syncAccountBalance(acc);
      state.transactions.push(tx);
    } else if (item.type === 'playbook') {
      const p = item.data;
      if (window.DB && window.DB.playbook) {
        try { const saved = await window.DB.playbook.insert(p); if (saved && saved.id) p.id = saved.id; }
        catch (err) { console.error('Playbook restore-insert failed, restored locally only:', err); }
      }
      state.playbook.push(p);
    } else if (item.type === 'rule') {
      const r = item.data;
      if (window.DB && window.DB.rules) {
        try { const saved = await window.DB.rules.insert(r); if (saved && saved.id) r.id = saved.id; }
        catch (err) { console.error('Rule restore-insert failed, restored locally only:', err); }
      }
      state.rules.push(r);
    }
    state.recycleBin.splice(idx, 1);
    await syncRecycleRemove(item);
    save();
    if (item.type === 'account') refreshGlobalAccountFilter();
    refreshAll();
    toast(`${item.type.charAt(0).toUpperCase() + item.type.slice(1)} restored`);
  }
  async function permDeleteFromBin(idx) {
    if (!confirm('Permanently delete this item? This cannot be undone.')) return;
    const item = state.recycleBin[idx];
    state.recycleBin.splice(idx, 1);
    if (item && item.type === 'trade') purgeShotIfOrphaned(item.data.screenshot);
    await syncRecycleRemove(item);
    save();
    renderRecycleBin();
    toast('Item permanently deleted');
  }

  // ================== SETTINGS ==================
  function renderSettings() {
    $('#s-name').value = state.settings.displayName;
    $('#s-pip').value = state.settings.pipPerLot;
    $('#s-balance').value = state.settings.defaultBalance;
    updateStorageStatus();
  }
  function initSettings() {
    $('#s-save').addEventListener('click', async () => {
      state.settings.displayName = $('#s-name').value.trim() || 'Newton';
      state.settings.pipPerLot = num($('#s-pip').value, 10);
      state.settings.defaultBalance = num($('#s-balance').value, 10000);
      if (window.DB && window.DB.profile) {
        try { await window.DB.profile.update(state.settings); }
        catch (err) { console.error('Profile sync failed, saved locally only:', err); }
      }
      save();
      tickClock();
      toast('Settings saved');
    });
    $('#s-seed').addEventListener('click', () => {
      seedSampleData();
      refreshGlobalAccountFilter();
      refreshAll();
      updateStorageStatus();
      toast('Sample data loaded');
    });
    $('#s-export').addEventListener('click', exportJSON);
    $('#s-reset').addEventListener('click', () => {
      if (!confirm('Erase ALL data? This cannot be undone.')) return;
      resetAllData();
    });
  }

  // Wipes every piece of persisted state (localStorage + IndexedDB) and
  // reloads into a clean app.
  //
  // Root cause of the old "sometimes instant, sometimes hangs" behavior:
  // indexedDB.deleteDatabase() was fired and then location.reload() was
  // called immediately, without waiting for the delete to finish. A delete
  // request can't actually complete while a connection to that database is
  // still open (ShotDB keeps one cached for the app's lifetime) — instead
  // of erroring, IndexedDB just parks the request and fires a 'blocked'
  // event that was never listened for. So the reload would race the
  // deletion: fast when no connection had been opened yet, slow/stuck (and
  // leaving stale screenshot data behind) whenever one had.
  //
  // Fix: explicitly close the open connection first, then properly await
  // success/blocked/error on the delete request before reloading, with a
  // safety-timeout fallback so a stuck 'blocked' state can never hang the
  // UI forever.
  function resetAllData() {
    const btn = $('#s-reset');
    if (btn) { btn.disabled = true; btn.textContent = 'Resetting…'; }

    // Stop save() from writing anything else to localStorage from this point
    // on (see the note on _resetting above), and clear every in-memory array
    // right away too, so even a stray render or listener that fires before
    // the reload completes has nothing left to show or persist.
    _resetting = true;
    state.settings = { displayName: 'Newton', pipPerLot: 10, defaultBalance: 10000 };
    state.accounts = [];
    state.trades = [];
    state.transactions = [];
    state.playbook = [];
    state.rules = [];
    state.recycleBin = [];
    state.accountFilter = '';
    shotCache.clear();

    const deleteShotDB = () => new Promise(resolve => {
      let done = false;
      const finish = () => { if (!done) { done = true; resolve(); } };
      try {
        const req = indexedDB.deleteDatabase('fx_journal_media');
        req.onsuccess = finish;
        req.onerror = finish;
        req.onblocked = finish; // don't let a lingering handle hang the reset
      } catch (e) { finish(); }
      // Absolute safety net: never wait more than 1.5s no matter what.
      setTimeout(finish, 1500);
    });

    // Wipe Supabase too — see backend/0004_reset_function.sql. Without this,
    // clearing localStorage only resets what this browser sees; the next
    // login (or the next loadFromSupabase() call) would pull all the
    // "deleted" data straight back down from Supabase.
    const resetSupabase = async () => {
      if (window.sb && window.Auth && window.Auth.user) {
        try { await window.sb.rpc('reset_all_user_data'); }
        catch (err) { console.error('Supabase reset failed:', err); }
      }
      // database.js mirrors each table into its own fx_db_cache_* key —
      // clear those too so a stale local mirror can't resurrect the data.
      ['accounts', 'trades', 'transactions', 'playbook', 'rules', 'goals', 'recycle_bin', 'profile']
        .forEach(t => LS.del('fx_db_cache_' + t));
    };

    ShotDB.closeConnection()
      .catch(() => {})
      .then(deleteShotDB)
      .then(resetSupabase)
      .then(() => {
        LS.del(KEY);
        LS.del('fx_theme');
        location.reload();
      });
  }

  // ================== SAMPLE DATA ==================
  function seedSampleData() {
    if (state.accounts.length === 0) {
      state.accounts = [
        { id: 1, name: 'FTMO Phase 1', broker: 'FTMO', type: 'funded', balance: 100000, startBalance: 100000, tradesCount: 0, createdAt: new Date().toISOString() },
        { id: 2, name: 'IC Markets', broker: 'IC Markets', type: 'real', balance: 5000, startBalance: 5000, tradesCount: 0, createdAt: new Date().toISOString() }
      ];
    }
    if (state.trades.length === 0) {
      const pairs = ['EURUSD', 'GBPUSD', 'USDJPY', 'XAUUSD', 'BTCUSD', 'NAS100'];
      const dirs = ['Buy', 'Sell'];
      const markets = ['Forex', 'Forex', 'Forex', 'Commodities', 'Crypto', 'Indices'];
      const strategies = ['Breakout', 'Supply & Demand', 'Trendline', 'Momentum', 'Reversal'];
      const sessions = ['London', 'New York', 'Asian', 'London/New York Overlap'];
      const emotions = ['Calm', 'Confident', 'FOMO', 'Fear', 'Disciplined', 'Greed'];
      const execs = ['Perfect', 'Good', 'Average', 'Poor'];
      const mistakes = ['', '', '', '', 'Early Entry', 'Late Exit', 'Overtrading', 'FOMO Entry'];
      const grades = ['A+', 'A', 'B', 'C', 'B', 'A'];
      const accounts = state.accounts;
      const now = Date.now();
      for (let i = 0; i < 25; i++) {
        const day = new Date(now - (25 - i) * 86400000 - Math.random() * 3600000);
        const idx = Math.floor(Math.random() * pairs.length);
        const pair = pairs[idx];
        const dir = dirs[Math.floor(Math.random() * 2)];
        const m = getPipMult(pair);
        const pipPerLot = getPipValuePerLot(pair);
        const entry = pair.includes('JPY') ? 150 + Math.random() * 4
                    : pair.includes('XAU') ? 2300 + Math.random() * 40
                    : pair.includes('BTC') ? 60000 + Math.random() * 1500
                    : pair.includes('NAS') ? 18000 + Math.random() * 200
                    : 1 + Math.random() * 0.6;
        const slDist = (5 + Math.random() * 12) * m;
        const tpDist = (10 + Math.random() * 30) * m;
        const sl = dir === 'Buy' ? entry - slDist : entry + slDist;
        const tp = dir === 'Buy' ? entry + tpDist : entry - tpDist;
        const win = Math.random() < 0.58;
        const exit = win ? tp : sl;
        const lot = +(0.1 + Math.random() * 1.5).toFixed(2);
        const priceMove = dir === 'Buy' ? (exit - entry) : (entry - exit);
        const pips = priceMove / m;
        const pnl = priceMove * lot * (pipPerLot / m);
        const riskPips = Math.abs(entry - sl) / m;
        const acc = accounts[i % accounts.length];
        const trade = {
          id: now + i,
          date: day.toISOString().slice(0, 10),
          time: now12(),
          pair, direction: dir,
          market: markets[idx],
          accountId: acc.id, accountName: acc.name,
          strategy: strategies[Math.floor(Math.random() * strategies.length)],
          session: sessions[Math.floor(Math.random() * sessions.length)],
          emotion: emotions[Math.floor(Math.random() * emotions.length)],
          execution: execs[Math.floor(Math.random() * execs.length)],
          mistake: mistakes[Math.floor(Math.random() * mistakes.length)],
          grade: grades[Math.floor(Math.random() * grades.length)],
          entry, sl, tp, exit, lot,
          notes: '',
          screenshot: null,
          pnl: +pnl.toFixed(2),
          pips: +pips.toFixed(1),
          pipRisk: +riskPips.toFixed(1),
          pipReward: +(Math.abs(tp - entry) / m).toFixed(1),
          pipsWon: Math.max(0, pips),
          pipsLost: Math.max(0, -pips),
          riskDollar: +(riskPips * lot * pipPerLot).toFixed(2),
          profitDollar: +(Math.max(0, pips) * lot * pipPerLot).toFixed(2),
          lossDollar: +(Math.max(0, -pips) * lot * pipPerLot).toFixed(2),
          pnlPct: +((pnl / acc.balance) * 100).toFixed(2),
          rr: +(Math.abs(tp - entry) / m / riskPips).toFixed(2),
          rMultiple: riskPips > 0 ? +(pnl / (riskPips * lot * pipPerLot)).toFixed(2) : 0,
          riskPct: +((riskPips * lot * pipPerLot) / acc.balance * 100).toFixed(2),
          profitPct: 0, lossPct: 0,
          open: false,
          createdAt: day.toISOString()
        };
        state.trades.push(trade);
        acc.balance = +(acc.balance + pnl).toFixed(2);
        acc.tradesCount = (acc.tradesCount || 0) + 1;
      }
    }
    if (state.playbook.length === 0) {
      state.playbook = [
        { id: Date.now() + 1, name: 'London Breakout', strategy: 'Breakout', screenshot: '', entry: 'Wait for 7-9am EST consolidation. Enter breakout of the range.', exit: 'Target 2R. Trail stop after 1R.', risk: 'Max 1% per trade. SL behind opposite side of range.', notes: 'Best in trending pairs.', createdAt: new Date().toISOString() }
      ];
    }
    if (state.rules.length === 0) {
      state.rules = [
        { id: 1, category: 'Risk Management', text: 'Max 1% risk per trade.' },
        { id: 2, category: 'Entry', text: 'No trading news releases ±15 min.' },
        { id: 3, category: 'Psychology', text: 'Stop after 2 consecutive losses.' },
        { id: 4, category: 'Exit', text: 'Always move stop to breakeven at 1R.' },
        { id: 5, category: 'Strategy', text: 'Only trade A+ setups during London/NY.' }
      ];
    }
    save();
  }

  // ================== REFRESH ==================
  function refreshAllButTrades() {
    renderDashboard();
    renderCalendar();
    renderAccounts();
    renderTransactions();
    renderScreenshots();
    renderReports();
    renderPsychology();
    renderAnalytics();
    renderPlaybook();
    renderRecycleBin();
  }
  function refreshAll() {
    refreshGlobalAccountFilter();
    renderAccounts();
    renderTrades();
    renderCalendar();
    renderTransactions();
    renderScreenshots();
    renderReports();
    renderPsychology();
    renderPlaybook();
    renderRules();
    renderRecycleBin();
    renderSettings();
    renderDashboard();
    renderAnalytics();
  }

  // ================== INIT ==================
  async function init() {
    load();                        // localStorage first, so the UI always has something instantly
    await loadFromSupabase();      // then Supabase, which overwrites state[...] as the source of truth
    await preloadShotCache();      // load screenshot bytes from IndexedDB first
    migrateInlineScreenshots();    // move any legacy inline screenshots out of localStorage
    tickClock();
    setInterval(tickClock, 1000);
    initTheme();
    initNav();
    initGlobalAccountFilter();
    initTradeForm();
    initCalendar();
    initAccountForm();
    initTransactionForm();
    initPlaybookForm();
    initRuleForm();
    initReports();
    initSettings();
    initRecycle();
    initFilters();
    initShotFilters();
    initModal();
    try {
      refreshAll();
    } catch (err) {
      // A rendering bug in one view must never block navigation or the
      // save-safety-net below from being wired up — those are what protect
      // the user's data. Log it, surface a toast, and keep going.
      console.error('A render step failed during startup:', err);
      toast('Something didn\'t render correctly — your data is safe, please refresh', 'error');
    }
    navigate(state.currentView || 'dashboard');
    updateStorageStatus();

    // Safety net: make sure the very latest in-memory state is flushed to
    // storage if the user closes the tab or switches away right after an
    // action, even if something upstream forgot to call save().
    window.addEventListener('beforeunload', save);
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') save(); });
  }

  window.onAuthReady = init;
})();
