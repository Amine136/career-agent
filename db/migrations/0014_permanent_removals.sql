-- Career Agent - permanent removals, day-scoped retention & cumulative stats
--
-- This replaces two old behaviours:
--   * per-user "hidden_jobs" dismissal -> removing a job now deletes the shared row;
--   * the 14-day deactivate + 90-day delete retention -> the worker deletes scraped jobs that
--     have not been touched from the apps for 14 days.
--
-- Two Home counters must keep their history even after a job row disappears:
--   * "Deleted content": every deletion is appended to `job_removals` (by a trigger), so the
--     count is cumulative and never decreases.
--   * "Applied": an application outlives its job (`job_id` becomes NULL). The job's country is
--     snapshotted on the application row so the applied-by-country chart still resolves.

-- ---------------------------------------------------------------------------
-- 1. Applications survive their job
-- ---------------------------------------------------------------------------
alter table applications
  add column if not exists country_code text;

update applications a
   set country_code = j.country_code
  from jobs j
 where a.job_id = j.id
   and a.country_code is null;

alter table applications alter column job_id drop not null;

alter table applications drop constraint if exists applications_job_id_fkey;
alter table applications
  add constraint applications_job_id_fkey
  foreign key (job_id) references jobs(id) on delete set null;

-- ---------------------------------------------------------------------------
-- 2. Deletion log (cumulative "Deleted content" counter)
-- ---------------------------------------------------------------------------
-- The trigger records who/why: clients connect as `authenticated` (auth.uid() is set) and are
-- logged as a user removal; the worker uses the privileged role (auth.uid() is null) and is
-- logged as retention. The row intentionally has no FK to jobs (the job is gone).
create table if not exists job_removals (
  id              uuid primary key default gen_random_uuid(),
  job_id          uuid not null,
  user_id         uuid references users(id) on delete set null,
  reason          text not null default 'user' check (reason in ('user', 'retention')),
  country_code    text,
  employment_type text,
  ai_decision     text,
  removed_at      timestamptz not null default now()
);

create index if not exists job_removals_removed_idx on job_removals (removed_at desc);
create index if not exists job_removals_user_idx on job_removals (user_id);

alter table job_removals enable row level security;
grant select on job_removals to authenticated;

drop policy if exists job_removals_select on job_removals;
create policy job_removals_select on job_removals
  for select to authenticated
  using (user_id = auth.uid() or user_id is null);

create or replace function public.log_job_removal()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.job_removals
    (job_id, user_id, reason, country_code, employment_type, ai_decision)
  values (
    old.id,
    auth.uid(),
    case when auth.uid() is null then 'retention' else 'user' end,
    old.country_code,
    old.employment_type,
    old.ai_decision
  );
  return old;
end;
$$;

drop trigger if exists jobs_log_removal on jobs;
create trigger jobs_log_removal
  after delete on jobs
  for each row execute function public.log_job_removal();

-- ---------------------------------------------------------------------------
-- 3. Clients may hard-delete only rows they created
-- ---------------------------------------------------------------------------
-- The scraped catalog is worker-managed. Client-side deletion is limited to user-added jobs,
-- so an authenticated user cannot remove shared, scraped postings or affect other users.
-- The legacy `hidden_jobs` table stays for backwards compatibility.
drop policy if exists jobs_delete_authenticated on jobs;
create policy jobs_delete_authenticated on jobs
  for delete to authenticated using (created_by = auth.uid());
