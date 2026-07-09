-- =========================================================
-- ROW LEVEL SECURITY
-- Every table is user-scoped: a user can only ever see, insert,
-- update, or delete their OWN rows. This is what keeps account
-- separation (and user separation) enforced at the database
-- level, not just in frontend filtering logic.
-- =========================================================

alter table public.profiles      enable row level security;
alter table public.accounts      enable row level security;
alter table public.trades        enable row level security;
alter table public.transactions  enable row level security;
alter table public.playbook      enable row level security;
alter table public.rules         enable row level security;
alter table public.goals         enable row level security;
alter table public.recycle_bin   enable row level security;

-- ---------- PROFILES ----------
create policy "profiles_select_own" on public.profiles
  for select using (auth.uid() = id);
create policy "profiles_update_own" on public.profiles
  for update using (auth.uid() = id) with check (auth.uid() = id);
-- No insert policy needed: handle_new_user() runs as SECURITY DEFINER.
-- No delete policy: profile is removed automatically via the
-- `on delete cascade` from auth.users.

-- ---------- ACCOUNTS ----------
create policy "accounts_select_own" on public.accounts
  for select using (auth.uid() = user_id);
create policy "accounts_insert_own" on public.accounts
  for insert with check (auth.uid() = user_id);
create policy "accounts_update_own" on public.accounts
  for update using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "accounts_delete_own" on public.accounts
  for delete using (auth.uid() = user_id);

-- ---------- TRADES ----------
create policy "trades_select_own" on public.trades
  for select using (auth.uid() = user_id);
create policy "trades_insert_own" on public.trades
  for insert with check (auth.uid() = user_id);
create policy "trades_update_own" on public.trades
  for update using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "trades_delete_own" on public.trades
  for delete using (auth.uid() = user_id);

-- ---------- TRANSACTIONS ----------
create policy "transactions_select_own" on public.transactions
  for select using (auth.uid() = user_id);
create policy "transactions_insert_own" on public.transactions
  for insert with check (auth.uid() = user_id);
create policy "transactions_update_own" on public.transactions
  for update using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "transactions_delete_own" on public.transactions
  for delete using (auth.uid() = user_id);

-- ---------- PLAYBOOK ----------
create policy "playbook_select_own" on public.playbook
  for select using (auth.uid() = user_id);
create policy "playbook_insert_own" on public.playbook
  for insert with check (auth.uid() = user_id);
create policy "playbook_update_own" on public.playbook
  for update using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "playbook_delete_own" on public.playbook
  for delete using (auth.uid() = user_id);

-- ---------- RULES ----------
create policy "rules_select_own" on public.rules
  for select using (auth.uid() = user_id);
create policy "rules_insert_own" on public.rules
  for insert with check (auth.uid() = user_id);
create policy "rules_update_own" on public.rules
  for update using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "rules_delete_own" on public.rules
  for delete using (auth.uid() = user_id);

-- ---------- GOALS ----------
create policy "goals_select_own" on public.goals
  for select using (auth.uid() = user_id);
create policy "goals_insert_own" on public.goals
  for insert with check (auth.uid() = user_id);
create policy "goals_update_own" on public.goals
  for update using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "goals_delete_own" on public.goals
  for delete using (auth.uid() = user_id);

-- ---------- RECYCLE BIN ----------
create policy "recycle_select_own" on public.recycle_bin
  for select using (auth.uid() = user_id);
create policy "recycle_insert_own" on public.recycle_bin
  for insert with check (auth.uid() = user_id);
create policy "recycle_update_own" on public.recycle_bin
  for update using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "recycle_delete_own" on public.recycle_bin
  for delete using (auth.uid() = user_id);
