-- =========================================================
-- reset_all_user_data() — server-side equivalent of the
-- frontend's Settings -> "Reset All Data" button.
-- Wipes every row owned by the calling user across every
-- table, in one transaction, so a partial reset is impossible.
-- Does NOT delete the user's auth account or profile row
-- (matches the frontend, which keeps the signed-in session but
-- clears accounts/trades/etc.). Screenshot files in Storage are
-- NOT deleted here since storage isn't transactional with SQL —
-- delete those from the client first (list + remove by the
-- user's own folder prefix) before/after calling this RPC.
-- =========================================================

create or replace function public.reset_all_user_data()
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  delete from public.recycle_bin  where user_id = auth.uid();
  delete from public.goals        where user_id = auth.uid();
  delete from public.rules        where user_id = auth.uid();
  delete from public.playbook     where user_id = auth.uid();
  delete from public.transactions where user_id = auth.uid();
  delete from public.trades       where user_id = auth.uid();
  delete from public.accounts     where user_id = auth.uid();

  update public.profiles
  set display_name = 'Trader', pip_per_lot = 10, default_balance = 10000
  where id = auth.uid();
end;
$$;

-- Only let a logged-in user call this for themselves — security
-- definer runs as the function owner, so this grant plus the
-- auth.uid() checks above are what keep it safe.
revoke all on function public.reset_all_user_data() from public;
grant execute on function public.reset_all_user_data() to authenticated;
