# Database schema reference

All SQL lives in `backend/supabase/migrations/`, run in numeric order. This
document explains what each piece is for in plain English.

## Tables

| Table          | Purpose                                              | Key relationship |
|----------------|-------------------------------------------------------|-------------------|
| `profiles`     | One row per user — display name, pip/lot, default balance (mirrors `state.settings`) | `id` = `auth.users.id` |
| `accounts`     | Demo / Funded / Real accounts a user creates          | `user_id` → `auth.users` |
| `trades`       | Every trade — the single source of truth, same role it has in the current app | `user_id` → `auth.users`, `account_id` → `accounts` (nullable) |
| `transactions` | Deposits/withdrawals/adjustments against an account   | `user_id`, `account_id` → `accounts` |
| `playbook`     | Saved trading setups. Trades are matched to a setup the same way the frontend already does it (by comparing `trades.strategy` to `playbook.strategy`/`playbook.name`) — no join table needed | `user_id` → `auth.users` |
| `rules`        | Personal trading rules checklist                       | `user_id` → `auth.users` |
| `goals`        | Optional goal-tracking (not yet in the UI, schema is ready for it) | `user_id`, optional `account_id` |
| `recycle_bin`  | Soft-deleted items of any type, stored as `jsonb` in a `data` column — mirrors the frontend's existing `{ type, data, deletedAt }` shape exactly | `user_id` → `auth.users` |

## Account separation

This is the same idea as the frontend's new "All Accounts / [Account name]"
filter, enforced one layer deeper:

- Every `trades` row carries `account_id`. Filtering "Funded Account only"
  is simply `select * from trades where account_id = '<funded-account-uuid>'`.
- Filtering "All Accounts" is simply omitting that `where` clause (or
  `where user_id = auth.uid()` only).
- Deleting an account does **not** delete its trades — `account_id` is set
  to `null` (`on delete set null`), matching the current frontend behaviour
  where a trade "keeps the name but account stats are removed."

## Row Level Security (RLS)

Every table has RLS **enabled**, with one policy per operation
(select/insert/update/delete) that requires `auth.uid() = user_id`
(or `= id` for `profiles`). In practice this means:

- A user can only ever query their own rows — there is no way, even with a
  bug in frontend code, for User A to read or modify User B's accounts or
  trades.
- All account separation happens *within* a single user's own rows — RLS
  doesn't need to know about the "selected account" concept at all; that's
  a client-side filter on top of data that's already scoped to the
  logged-in user.

## Storage

One bucket, `trade-screenshots`, created **private** (not public). Files
must be uploaded under a path starting with the uploader's own user id,
e.g.:

```
trade-screenshots/<user_id>/<trade_id>.png
```

Storage policies check that prefix against `auth.uid()`, so a user can only
upload, view, update, or delete files inside their own folder. To display an
image, generate a signed URL (`createSignedUrl`) rather than a public one.

## Indexes

`user_id` and `account_id` are indexed on every table that has them (most
importantly `trades`, since that's the largest and most frequently filtered
table), plus `date`, `pair`, and `strategy` on `trades` for fast
Calendar/Analytics/Playbook lookups.

## Reset All Data (server-side)

`0004_reset_function.sql` adds `reset_all_user_data()`, a Postgres function
you can call via `supabase.rpc('reset_all_user_data')` once the frontend is
wired up to Supabase. It deletes every row owned by the calling user across
every table in a single transaction (so it can't partially fail), and resets
`profiles` back to defaults — the same guarantee the fixed frontend button
now provides for browser storage.
