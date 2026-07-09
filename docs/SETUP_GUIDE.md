# Setup guide

Follow these steps in order. No coding experience required beyond
copy/paste.

## 1. Open the folder

You already have it — this is the folder you're reading this file in.
`frontend/` is your working app; `backend/` is the database setup.

## 2. Set up Supabase

1. Go to https://supabase.com and sign in (free tier is enough to start).
2. Click **New Project**. Pick a name (e.g. `fx-journal-pro`), a strong
   database password (save it somewhere safe), and a region close to you.
3. Wait for the project to finish provisioning (~2 minutes).

## 3. Run the SQL

1. In your Supabase project, open **SQL Editor** in the left sidebar.
2. Click **New query**.
3. Open `backend/supabase/migrations/0001_init_schema.sql` in this project,
   copy its entire contents, paste into the SQL editor, and click **Run**.
4. Repeat for `0002_rls_policies.sql`, then `0003_storage_buckets.sql`,
   then `0004_reset_function.sql` — **in that exact order**, one file at a
   time, running each before pasting the next.
5. Confirm it worked: open **Table Editor** — you should see `profiles`,
   `accounts`, `trades`, `transactions`, `playbook`, `rules`, `goals`, and
   `recycle_bin`. Open **Storage** — you should see a `trade-screenshots`
   bucket.

## 4. Turn on authentication

1. In Supabase, go to **Authentication → Providers**.
2. Email sign-in is enabled by default — that's enough to get started.
   Turn on Google/Apple/etc. here too if you'd like social login.
3. Go to **Authentication → URL Configuration** and set your **Site URL**
   (e.g. `http://localhost:3000` while testing, your real domain later).

## 5. Add your keys

1. In Supabase, go to **Project Settings → API**.
2. Copy the **Project URL** and the **anon public** key.
3. In this project, copy `.env.example` to a new file named `.env` and
   paste those two values in:
   ```
   SUPABASE_URL=https://your-project-ref.supabase.co
   SUPABASE_ANON_KEY=your-anon-public-key
   ```
4. Leave `SUPABASE_SERVICE_ROLE_KEY` blank unless you're running an admin
   script yourself — it must never be used in frontend code.

## 6. Run the website

The frontend in `frontend/` runs exactly as it does today — it doesn't
require Supabase to function, since it still uses browser storage. Open
`frontend/index.html` directly, or serve the folder with any static file
server, e.g.:

```bash
cd frontend
python3 -m http.server 3000
```

Then visit `http://localhost:3000`.

## 7. Test

- Create an account, log a few trades, and confirm the top-bar account
  filter narrows the Dashboard/Analytics/Calendar/Psychology/Reports/
  Playbook to just that account, and "All Accounts" combines them again.
- Go to Settings → **Reset All Data**, confirm, and refresh the page —
  everything should come back empty.
- Your Supabase project (Table Editor) is now ready and waiting for the
  next phase: connecting the frontend's save/load calls to
  `supabase-js` instead of `localStorage`.

## What's not included yet

This delivery makes the **database** fully ready — schema, relationships,
security, and storage. The frontend (`script.js`) still reads and writes
`localStorage`/IndexedDB, unchanged, exactly as you asked ("do not rewrite
working code unnecessarily", "do not break existing functionality").

Rewiring `save()`/`load()` in `script.js` to call `supabase-js` instead of
`localStorage`, and adding a login screen, is a separate follow-up task —
happy to do that as a next phase whenever you're ready; the schema above
was designed so that step is a mechanical swap (same field names, same
shapes) rather than a redesign.
