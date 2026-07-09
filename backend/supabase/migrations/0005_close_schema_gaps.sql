-- =========================================================
-- OPTIONAL — closes two gaps found while matching database.js
-- to 0001_init_schema.sql. Safe to run any time; database.js
-- works without this (with graceful degradation noted in its
-- comments), but these columns make the data lossless.
-- =========================================================

-- transactions: script.js stores a user-picked date and a
-- before/after balance snapshot per transaction; none of these
-- exist yet (only created_at, which is "row inserted at", not
-- the transaction's effective date).
alter table public.transactions
  add column if not exists date date not null default current_date,
  add column if not exists balance_before numeric,
  add column if not exists balance_after numeric;

-- playbook: script.js stores separate Entry / Exit / Risk notes;
-- only a single generic `rules` text column exists today. If you
-- run this, tell Claude so database.js can switch from the
-- JSON-packed-into-`rules` stopgap to these real columns.
alter table public.playbook
  add column if not exists entry_notes text,
  add column if not exists exit_notes text,
  add column if not exists risk_notes text;
