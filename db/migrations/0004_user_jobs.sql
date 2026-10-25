-- Career Agent - user-added jobs
--
-- Signed-in users may add their own jobs and delete only the rows they created.
-- Scraped jobs (created_by is null) stay read-only for clients; the privileged
-- worker bypasses RLS and manages those.

alter table jobs
  add column if not exists created_by uuid references users(id) on delete cascade;

create index if not exists jobs_created_by_idx on jobs (created_by);

-- Clients have no table privileges on `jobs` beyond read until this point.
grant insert, delete on jobs to authenticated;

-- A user may only insert a row they own...
drop policy if exists jobs_insert_own on jobs;
create policy jobs_insert_own on jobs
  for insert to authenticated with check (created_by = auth.uid());

-- ...and may only delete rows they own. Updates are intentionally not allowed:
-- scraped rows are read-only and user-added rows are immutable after creation.
drop policy if exists jobs_delete_own on jobs;
create policy jobs_delete_own on jobs
  for delete to authenticated using (created_by = auth.uid());
