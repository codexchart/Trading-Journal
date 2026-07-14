/* =========================================================
   DATABASE.JS — data-access layer between script.js and Supabase
   Rewritten to match backend/0001_init_schema.sql EXACTLY.
   -----------------------------------------------------------
   Still not wired into script.js (that's Phase 2). Every function:
     1. Tries Supabase first (scoped to auth.uid() via user_id / RLS)
     2. Mirrors the result into a localStorage cache
     3. Falls back to that cache if Supabase fails (offline, not
        logged in yet, RLS rejects it) so the app keeps working.

   SCHEMA NOTES:
   - transactions.date / balance_before / balance_after and
     playbook.entry_notes / exit_notes / risk_notes come from
     backend/0005_close_schema_gaps.sql — run that migration
     before using this file, or these columns won't exist yet.
   - trades.screenshot_path is a single text path/URL. Only
     {type:'url'} screenshots can sync today; {type:'upload'}
     (local IndexedDB images) need the Storage bucket wired first.
   ========================================================= */

(function () {
  'use strict';

  const LS_PREFIX = 'fx_db_cache_';

  // ---------- local mirror (fallback) ----------

  function cacheGet(key) {
    try { return JSON.parse(localStorage.getItem(LS_PREFIX + key) || '[]'); }
    catch { return []; }
  }
  function cacheSet(key, rows) {
    try { localStorage.setItem(LS_PREFIX + key, JSON.stringify(rows)); }
    catch (err) { console.error('DB local cache write failed for', key, err); }
  }

  function currentUserId() {
    return (window.Auth && window.Auth.user) ? window.Auth.user.id : null;
  }
  function isOnline() {
    return !!(window.sb && currentUserId());
  }

  // ---------- screenshot transform (trades.screenshot_path) ----------
  // script.js screenshot ref: { type:'upload', shotId } (local IndexedDB image,
  // can't sync yet) or { type:'url', data } (external link, syncs fine).
  function screenshotToPath(ref) {
    if (!ref) return null;
    if (ref.type === 'url') return ref.data || null;
    return null; // upload-type: local-only until Storage bucket wiring (Phase 3)
  }
  function pathToScreenshot(path) {
    if (!path) return null;
    return { type: 'url', data: path };
  }

  // ============ TABLE CONFIG — column names match 0001_init_schema.sql ============
  const TABLES = {
    accounts: {
      map: {
        id: 'id', name: 'name', broker: 'broker', type: 'type',
        balance: 'balance', startBalance: 'start_balance',
        tradesCount: 'trades_count', createdAt: 'created_at'
      },
      orderBy: 'created_at', ascending: true
    },
    trades: {
      map: {
        id: 'id', accountId: 'account_id', accountName: 'account_name',
        date: 'date', time: 'time', pair: 'pair', direction: 'direction',
        market: 'market', lot: 'lot', entry: 'entry', sl: 'sl', tp: 'tp', exit: 'exit',
        pips: 'pips', pnl: 'pnl', rr: 'rr', rMultiple: 'r_multiple',
        riskDollar: 'risk_dollar', profitDollar: 'profit_dollar', lossDollar: 'loss_dollar',
        strategy: 'strategy', session: 'session', emotion: 'emotion',
        execution: 'execution', mistake: 'mistake', grade: 'grade', notes: 'notes',
        open: 'is_open', createdAt: 'created_at'
        // screenshot handled separately via screenshotToPath/pathToScreenshot
      },
      orderBy: 'created_at', ascending: true,
      toRowExtra(obj, row) { row.screenshot_path = screenshotToPath(obj.screenshot); },
      fromRowExtra(row, obj) { obj.screenshot = pathToScreenshot(row.screenshot_path); }
    },
    transactions: {
      map: {
        id: 'id', accountId: 'account_id', accountName: 'account_name',
        type: 'type', amount: 'amount', delta: 'delta', note: 'note',
        date: 'date', balanceBefore: 'balance_before', balanceAfter: 'balance_after',
        createdAt: 'created_at'
      },
      orderBy: 'created_at', ascending: true
    },
    playbook: {
      map: {
        id: 'id', name: 'name', strategy: 'strategy', notes: 'notes',
        screenshot: 'screenshot_path', entry: 'entry_notes', exit: 'exit_notes',
        risk: 'risk_notes', createdAt: 'created_at'
      },
      orderBy: 'created_at', ascending: true
    },
    rules: {
      map: { id: 'id', category: 'category', text: 'text', createdAt: 'created_at' },
      orderBy: 'created_at', ascending: true
    },
    goals: {
      map: {
        id: 'id', accountId: 'account_id', title: 'title', target: 'target',
        progress: 'progress', deadline: 'deadline', createdAt: 'created_at'
      },
      orderBy: 'created_at', ascending: true
    },
    recycle_bin: {
      map: { id: 'id', type: 'item_type', data: 'data', deletedAt: 'deleted_at' },
      orderBy: 'deleted_at', ascending: true
    }
  };

  // ---------- row <-> JS object mapping ----------

  // Never includes `id` in the outgoing row — every table's id is a uuid
  // that Postgres assigns via gen_random_uuid(); a client-generated
  // Date.now()-style id would make every insert fail outright.
  function toRow(tableName, obj) {
    const cfg = TABLES[tableName];
    const row = {};
    Object.keys(obj).forEach(k => {
      if (k === 'id') return;
      const col = cfg.map[k];
      if (col) row[col] = obj[k];
    });
    if (cfg.toRowExtra) cfg.toRowExtra(obj, row);
    const uid = currentUserId();
    if (uid) row.user_id = uid;
    return row;
  }

  function fromRow(tableName, row) {
    const cfg = TABLES[tableName];
    const obj = {};
    Object.keys(cfg.map).forEach(jsKey => {
      const col = cfg.map[jsKey];
      if (row[col] !== undefined) obj[jsKey] = row[col];
    });
    if (cfg.fromRowExtra) cfg.fromRowExtra(row, obj);
    return obj;
  }

  // ---------- generic CRUD builder (one per table) ----------

  function makeTable(tableName) {
    const cfg = TABLES[tableName];
    const idCol = cfg.map.id || 'id';

    return {
      async list() {
        if (isOnline()) {
          try {
            const { data, error } = await window.sb
              .from(tableName)
              .select('*')
              .eq('user_id', currentUserId())
              .order(cfg.orderBy, { ascending: cfg.ascending });
            if (error) throw error;
            const rows = data.map(r => fromRow(tableName, r));
            cacheSet(tableName, rows);
            return rows;
          } catch (err) {
            console.warn(`[DB] ${tableName}.list() failed, using local cache:`, err.message);
          }
        }
        return cacheGet(tableName);
      },

      // Returns the saved object. IMPORTANT: when online, the returned
      // object's `id` is the real Supabase uuid, NOT whatever id (if any)
      // was on the object passed in — callers must adopt this id.
      async insert(obj) {
        if (isOnline()) {
          try {
            const row = toRow(tableName, obj);
            const { data, error } = await window.sb.from(tableName).insert(row).select().single();
            if (error) throw error;
            const saved = fromRow(tableName, data);
            const cache = cacheGet(tableName);
            cache.push(saved);
            cacheSet(tableName, cache);
            return saved;
          } catch (err) {
            console.warn(`[DB] ${tableName}.insert() failed, saved locally only:`, err.message);
          }
        }
        const cache = cacheGet(tableName);
        const localObj = { ...obj, _pendingSync: true };
        cache.push(localObj);
        cacheSet(tableName, cache);
        return localObj;
      },

      async update(id, patch) {
        if (isOnline()) {
          try {
            const row = toRow(tableName, patch);
            const { data, error } = await window.sb
              .from(tableName).update(row)
              .eq(idCol, id).eq('user_id', currentUserId())
              .select().single();
            if (error) throw error;
            const saved = fromRow(tableName, data);
            const cache = cacheGet(tableName).map(r => (r.id === id ? saved : r));
            cacheSet(tableName, cache);
            return saved;
          } catch (err) {
            console.warn(`[DB] ${tableName}.update() failed, updated locally only:`, err.message);
          }
        }
        const cache = cacheGet(tableName).map(r => (r.id === id ? { ...r, ...patch, _pendingSync: true } : r));
        cacheSet(tableName, cache);
        return cache.find(r => r.id === id);
      },

      async remove(id) {
        if (isOnline()) {
          try {
            const { error } = await window.sb
              .from(tableName).delete()
              .eq(idCol, id).eq('user_id', currentUserId());
            if (error) throw error;
          } catch (err) {
            console.warn(`[DB] ${tableName}.remove() failed, removed locally only:`, err.message);
          }
        }
        const cache = cacheGet(tableName).filter(r => r.id !== id);
        cacheSet(tableName, cache);
        return true;
      }
    };
  }

  // ---------- profiles (singleton per user — not a list) ----------
  // Maps to state.settings { displayName, pipPerLot, defaultBalance }.
  // Row is auto-created by the on_auth_user_created trigger, so there's
  // no insert/delete — just get/update.
  const Profile = {
    async get() {
      if (isOnline()) {
        try {
          const { data, error } = await window.sb
            .from('profiles').select('*').eq('id', currentUserId()).single();
          if (error) throw error;
          const obj = { displayName: data.display_name, pipPerLot: data.pip_per_lot, defaultBalance: data.default_balance };
          cacheSet('profile', [obj]);
          return obj;
        } catch (err) {
          console.warn('[DB] profile.get() failed, using local cache:', err.message);
        }
      }
      const c = cacheGet('profile');
      return c[0] || null;
    },
    async update(patch) {
      if (isOnline()) {
        try {
          const row = {};
          if (patch.displayName !== undefined) row.display_name = patch.displayName;
          if (patch.pipPerLot !== undefined) row.pip_per_lot = patch.pipPerLot;
          if (patch.defaultBalance !== undefined) row.default_balance = patch.defaultBalance;
          const { data, error } = await window.sb
            .from('profiles').update(row).eq('id', currentUserId()).select().single();
          if (error) throw error;
          const obj = { displayName: data.display_name, pipPerLot: data.pip_per_lot, defaultBalance: data.default_balance };
          cacheSet('profile', [obj]);
          return obj;
        } catch (err) {
          console.warn('[DB] profile.update() failed, updated locally only:', err.message);
        }
      }
      const existing = cacheGet('profile')[0] || {};
      const merged = { ...existing, ...patch };
      cacheSet('profile', [merged]);
      return merged;
    }
  };

  // ---------- public API ----------

  window.DB = {
    accounts: makeTable('accounts'),
    trades: makeTable('trades'),
    transactions: makeTable('transactions'),
    playbook: makeTable('playbook'),
    rules: makeTable('rules'),
    goals: makeTable('goals'),
    recycleBin: makeTable('recycle_bin'),
    profile: Profile,

    // Loads every table in parallel, shaped for script.js's load()/state.
    async loadAll() {
      const [accounts, trades, transactions, playbook, rules, goals, recycleBin, profile] = await Promise.all([
        window.DB.accounts.list(),
        window.DB.trades.list(),
        window.DB.transactions.list(),
        window.DB.playbook.list(),
        window.DB.rules.list(),
        window.DB.goals.list(),
        window.DB.recycleBin.list(),
        window.DB.profile.get()
      ]);
      return { accounts, trades, transactions, playbook, rules, goals, recycleBin, profile };
    }
  };
})();
