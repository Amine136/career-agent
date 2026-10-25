-- Career Agent - AI visa-sponsorship verdict
--
-- Some postings explicitly state whether the employer will sponsor a work visa. That is rare but
-- decisive for candidates who need work authorization, so the scorer emits a tri-state verdict
-- instead of leaving it to the reader:
--
--   * `ai_visa = 'sponsors'`        - the posting clearly offers visa sponsorship.
--   * `ai_visa = 'no_sponsorship'`  - the posting clearly refuses it (e.g. "must have the right
--                                     to work", "no visa sponsorship").
--   * `ai_visa = 'unknown'`         - the posting does not state anything about sponsorship
--                                     (the default; most rows).
--
-- There is no ingestion heuristic for sponsorship, so `is_sponsored` is simply true when the AI
-- explicitly says `sponsors` and false otherwise (including NULL/unscored rows). Clients filter
-- on the stored generated column so the "Sponsors visa only" toggle works via PostgREST.

alter table jobs
  add column if not exists ai_visa text;

alter table jobs drop constraint if exists jobs_ai_visa_check;
alter table jobs add constraint jobs_ai_visa_check
  check (ai_visa is null or ai_visa in ('sponsors', 'unknown', 'no_sponsorship'));

-- Stored so PostgREST can filter on it directly. Conservative: only an explicit "sponsors"
-- matches; unknown / no_sponsorship / unscored are false. `coalesce` keeps the column non-null
-- (`ai_visa = 'sponsors'` is NULL when `ai_visa` is NULL, i.e. unscored jobs).
alter table jobs
  add column if not exists is_sponsored boolean
    generated always as (coalesce(ai_visa = 'sponsors', false)) stored;

create index if not exists jobs_is_sponsored_idx on jobs (is_sponsored);

-- Re-create the view so `select j.*` picks up the two new columns (appended at the end).
create or replace view public.active_jobs
with (security_invoker = true) as
select j.*
from public.jobs j
where j.is_active = true
  and not exists (
    select 1
    from public.hidden_jobs h
    where h.job_id = j.id
      and h.user_id = auth.uid()
  );

grant select on public.hidden_jobs to anon;
grant select on public.active_jobs to anon, authenticated;

-- Optional one-shot requeue so every job gets an AI `ai_visa` verdict. This re-spends the
-- daily Gemini budget (15/min, 500-1000/day), so run it deliberately:
--   update jobs set ai_scored_at = null where is_active = true;
