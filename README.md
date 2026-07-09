# FX Journal Pro

## Project structure

```
project/
├── frontend/                     ← your app, unchanged in layout/design
│   ├── index.html
│   ├── script.js
│   └── style.css
├── backend/
│   └── supabase/
│       ├── migrations/           ← run these in order in the SQL editor
│       │   ├── 0001_init_schema.sql
│       │   ├── 0002_rls_policies.sql
│       │   ├── 0003_storage_buckets.sql
│       │   └── 0004_reset_function.sql
│       └── config.toml           ← only needed for local `supabase start`
├── docs/
│   ├── SETUP_GUIDE.md            ← step-by-step: open folder → live site
│   ├── DATABASE_SCHEMA.md        ← tables, relationships, RLS explained
│   └── FIXES.md                  ← what was fixed in the frontend and why
├── .env.example
└── README.md                     ← you are here
```

## What's in this delivery

1. **Fixed frontend** (`frontend/`) — same UI, same layout, same features.
   Two bugs fixed: account-based data separation (a new "All Accounts /
   Account name" filter in the top bar now scopes Dashboard, Analytics,
   Calendar, Psychology, Reports, Playbook and the Trades list to whichever
   account is selected) and the Reset All Data button (it now actually
   clears everything). Details in `docs/FIXES.md`.

2. **Backend structure** (`backend/supabase/`) — a complete, ready-to-run
   Postgres schema, Row Level Security policies, and a Storage bucket for
   screenshots, matching the frontend's existing data model field-for-field.

3. **Docs** (`docs/`) — setup instructions and a plain-English schema
   reference.

## Quick start

The frontend works today exactly as it did before — open `frontend/index.html`
in a browser (or serve the folder) and nothing changes for you.

The `backend/` folder is prepared and ready for when you want to move off
browser storage and onto a real, multi-device database. See
**`docs/SETUP_GUIDE.md`** for the exact steps (open folder → set up Supabase →
run SQL → add keys → run the site → test).

> Note: this delivery gets the *database* fully ready. Rewiring
> `script.js` itself to call the Supabase API (instead of
> `localStorage`/IndexedDB) is a separate, larger follow-up step — see the
> "What's not included yet" section at the bottom of `docs/SETUP_GUIDE.md`.
