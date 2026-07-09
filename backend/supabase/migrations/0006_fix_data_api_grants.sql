-- =========================================================
-- FIX: 42501 "permission denied for table X" on every table
-- -----------------------------------------------------------
-- ROOT CAUSE: 0001_init_schema.sql created every table but never
-- GRANTed SELECT/INSERT/UPDATE/DELETE to the `authenticated` role.
-- RLS policies (0002_rls_policies.sql) are correct and were never
-- the problem — GRANT and RLS are two separate permission layers.
-- GRANT decides whether a role may touch the table at all; RLS then
-- decides which *rows* it can see. Without the GRANT, Postgres
-- rejects the request before RLS policies ever run, which is why
-- this happened uniformly on every table, including profiles.
--
-- Safe to run multiple times.
-- =========================================================

-- Schema-level access — required before any per-table grant matters.
grant usage on schema public to authenticated;

-- Table-level grants. anon is deliberately NOT granted anything: every
-- table in this app requires auth.uid() = user_id, there are no public/
-- logged-out reads, so anon has no legitimate use for these tables.
grant select, insert, update, delete on public.profiles      to authenticated;
grant select, insert, update, delete on public.accounts      to authenticated;
grant select, insert, update, delete on public.trades        to authenticated;
grant select, insert, update, delete on public.transactions  to authenticated;
grant select, insert, update, delete on public.playbook      to authenticated;
grant select, insert, update, delete on public.rules         to authenticated;
grant select, insert, update, delete on public.goals         to authenticated;
grant select, insert, update, delete on public.recycle_bin   to authenticated;

-- Prevents this from happening again on any table you add later via SQL
-- Editor: new tables created by the role running this statement will
-- automatically pick up these grants instead of needing a manual GRANT
-- every time.
alter default privileges in schema public
  grant select, insert, update, delete on tables to authenticated;

-- Sanity check — run this after the above and confirm every row shows
-- the four privilege types for grantee 'authenticated'. If a table is
-- missing from this list, the grants above didn't take.
select table_name, grantee, privilege_type
from information_schema.role_table_grants
where table_schema = 'public'
  and grantee = 'authenticated'
order by table_name, privilege_type;
