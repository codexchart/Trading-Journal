-- =========================================================
-- STORAGE — trade & playbook screenshots
-- Replaces the frontend's current IndexedDB screenshot store.
-- Files are kept PRIVATE and served through signed URLs; access
-- is enforced by requiring every object's path to start with
-- the owning user's own auth uid, e.g.
--   trade-screenshots/<user_id>/<trade_id>.png
-- =========================================================

insert into storage.buckets (id, name, public)
values ('trade-screenshots', 'trade-screenshots', false)
on conflict (id) do nothing;

-- SELECT (view/download) own files only
create policy "screenshots_select_own"
  on storage.objects for select
  using (
    bucket_id = 'trade-screenshots'
    and auth.uid()::text = (storage.foldername(name))[1]
  );

-- INSERT (upload) — must upload into your own uid folder
create policy "screenshots_insert_own"
  on storage.objects for insert
  with check (
    bucket_id = 'trade-screenshots'
    and auth.uid()::text = (storage.foldername(name))[1]
  );

-- UPDATE (overwrite/replace) own files only
create policy "screenshots_update_own"
  on storage.objects for update
  using (
    bucket_id = 'trade-screenshots'
    and auth.uid()::text = (storage.foldername(name))[1]
  )
  with check (
    bucket_id = 'trade-screenshots'
    and auth.uid()::text = (storage.foldername(name))[1]
  );

-- DELETE own files only
create policy "screenshots_delete_own"
  on storage.objects for delete
  using (
    bucket_id = 'trade-screenshots'
    and auth.uid()::text = (storage.foldername(name))[1]
  );
