-- =========================================================
-- FX JOURNAL PRO — INITIAL SCHEMA
-- Mirrors the existing localStorage data model 1:1 so the
-- frontend can be pointed at Supabase later with minimal
-- field renaming (camelCase -> snake_case only).
-- =========================================================

create extension if not exists "pgcrypto"; -- gen_random_uuid()

-- ---------------------------------------------------------
-- PROFILES (1 row per auth user — app-level settings)
-- Mirrors state.settings { displayName, pipPerLot, defaultBalance }
-- ---------------------------------------------------------
create table if not exists public.profiles (
  id              uuid primary key references auth.users (id) on delete cascade,
  display_name    text not null default 'Trader',
  pip_per_lot     numeric not null default 10,
  default_balance numeric not null default 10000,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

-- ---------------------------------------------------------
-- ACCOUNTS (Demo / Funded / Real / etc.)
-- Mirrors state.accounts[]
-- ---------------------------------------------------------
create table if not exists public.accounts (
  id             uuid primary key default gen_random_uuid(),
  user_id        uuid not null references auth.users (id) on delete cascade,
  name           text not null,
  broker         text not null,
  type           text not null check (type in ('demo', 'funded', 'real')),
  balance        numeric not null default 0,
  start_balance  numeric not null default 0,
  trades_count   integer not null default 0,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);
create index if not exists idx_accounts_user on public.accounts (user_id);

-- ---------------------------------------------------------
-- TRADES — the single source of truth, same as state.trades[]
-- account_id is nullable, exactly like the frontend's "— No account —"
-- option, and ON DELETE SET NULL so removing an account never
-- deletes its trades (matches the existing app's own behaviour).
-- ---------------------------------------------------------
create table if not exists public.trades (
  id             uuid primary key default gen_random_uuid(),
  user_id        uuid not null references auth.users (id) on delete cascade,
  account_id     uuid references public.accounts (id) on delete set null,
  account_name   text,                       -- denormalized snapshot, mirrors trade.accountName
  date           date not null,
  time           text,
  pair           text not null,
  direction      text not null check (direction in ('Buy', 'Sell')),
  market         text,
  lot            numeric,
  entry          numeric,
  sl             numeric,
  tp             numeric,
  exit           numeric,
  pips           numeric,
  pnl            numeric not null default 0,
  rr             numeric,
  r_multiple     numeric,
  risk_dollar    numeric,
  profit_dollar  numeric,
  loss_dollar    numeric,
  strategy       text,
  session        text,
  emotion        text,
  execution      text,
  mistake        text,
  grade          text,
  notes          text,
  screenshot_path text,                      -- Storage object path (see storage bucket below)
  is_open        boolean not null default false,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);
create index if not exists idx_trades_user on public.trades (user_id);
create index if not exists idx_trades_account on public.trades (account_id);
create index if not exists idx_trades_user_account on public.trades (user_id, account_id);
create index if not exists idx_trades_date on public.trades (date);
create index if not exists idx_trades_pair on public.trades (pair);
create index if not exists idx_trades_strategy on public.trades (strategy);

-- ---------------------------------------------------------
-- TRANSACTIONS (deposits / withdrawals / adjustments per account)
-- Mirrors state.transactions[]
-- ---------------------------------------------------------
create table if not exists public.transactions (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references auth.users (id) on delete cascade,
  account_id    uuid references public.accounts (id) on delete set null,
  account_name  text,
  type          text not null, -- e.g. deposit / withdrawal / adjustment
  amount        numeric not null,
  delta         numeric,       -- signed effect actually applied to balance
  note          text,
  created_at    timestamptz not null default now()
);
create index if not exists idx_transactions_user on public.transactions (user_id);
create index if not exists idx_transactions_account on public.transactions (account_id);

-- ---------------------------------------------------------
-- PLAYBOOK (trading setups) — trades are linked by matching
-- strategy/name text, same rule the frontend already uses in
-- tradesForPlaybook(), so no extra join table is required.
-- ---------------------------------------------------------
create table if not exists public.playbook (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references auth.users (id) on delete cascade,
  name        text not null,
  strategy    text,
  rules       text,
  notes       text,
  screenshot_path text,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create index if not exists idx_playbook_user on public.playbook (user_id);

-- ---------------------------------------------------------
-- RULES (trading discipline checklist)
-- Mirrors state.rules[]
-- ---------------------------------------------------------
create table if not exists public.rules (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references auth.users (id) on delete cascade,
  category    text,
  text        text not null,
  created_at  timestamptz not null default now()
);
create index if not exists idx_rules_user on public.rules (user_id);

-- ---------------------------------------------------------
-- GOALS (present in requirements; not required by current UI,
-- included so the schema doesn't need another migration later)
-- ---------------------------------------------------------
create table if not exists public.goals (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references auth.users (id) on delete cascade,
  account_id  uuid references public.accounts (id) on delete set null,
  title       text not null,
  target      numeric,
  progress    numeric not null default 0,
  deadline    date,
  created_at  timestamptz not null default now()
);
create index if not exists idx_goals_user on public.goals (user_id);

-- ---------------------------------------------------------
-- RECYCLE BIN — generic tagged-item store, mirrors
-- state.recycleBin[] = [{ type, data, deletedAt }]
-- Keeping the deleted record as jsonb (rather than one column
-- per entity type) matches the frontend's existing generic
-- restore/permanent-delete logic exactly.
-- ---------------------------------------------------------
create table if not exists public.recycle_bin (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references auth.users (id) on delete cascade,
  item_type   text not null check (item_type in ('trade', 'account', 'transaction', 'playbook', 'rule')),
  data        jsonb not null,
  deleted_at  timestamptz not null default now()
);
create index if not exists idx_recycle_user on public.recycle_bin (user_id);
create index if not exists idx_recycle_type on public.recycle_bin (item_type);

-- ---------------------------------------------------------
-- updated_at auto-touch trigger (shared by all mutable tables)
-- ---------------------------------------------------------
create or replace function public.set_updated_at()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

create trigger trg_profiles_updated before update on public.profiles
  for each row execute function public.set_updated_at();
create trigger trg_accounts_updated before update on public.accounts
  for each row execute function public.set_updated_at();
create trigger trg_trades_updated before update on public.trades
  for each row execute function public.set_updated_at();
create trigger trg_playbook_updated before update on public.playbook
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------
-- Auto-create a profile row whenever a new auth user signs up
-- ---------------------------------------------------------
create or replace function public.handle_new_user()
returns trigger as $$
begin
  insert into public.profiles (id, display_name)
  values (new.id, coalesce(new.raw_user_meta_data->>'display_name', 'Trader'));
  return new;
end;
$$ language plpgsql security definer set search_path = public;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();
