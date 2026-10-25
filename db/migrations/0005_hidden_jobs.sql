-- Career Agent - per-user job removal ("delete for me")
--
-- A user can remove any job from their own interface without touching the shared,
-- scraped catalog. Jobs the user added themselves are hard-deleted instead; this
-- table only records dismissals of shared jobs.
--
-- Rows cascade when the job is deleted (retention or manual) or the user is removed.

create table if not exists hidden_jobs (
  user_id   uuid not null references users(id) on delete cascade,
  job_id    uuid not null references jobs(id) on delete cascade,
  hidden_at timestamptz not null default now(),
  primary key (user_id, job_id)
);

create index if not exists hidden_jobs_user_idx on hidden_jobs (user_id);

alter table hidden_jobs enable row level security;

grant select, insert, delete on hidden_jobs to authenticated;

drop policy if exists hidden_jobs_select_own on hidden_jobs;
create policy hidden_jobs_select_own on hidden_jobs
  for select to authenticated using (user_id = auth.uid());

drop policy if exists hidden_jobs_insert_own on hidden_jobs;
create policy hidden_jobs_insert_own on hidden_jobs
  for insert to authenticated with check (user_id = auth.uid());

drop policy if exists hidden_jobs_delete_own on hidden_jobs;
create policy hidden_jobs_delete_own on hidden_jobs
  for delete to authenticated using (user_id = auth.uid());
