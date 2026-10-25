-- Career Agent - authoritative remote/workplace classification
--
-- The `jobs.remote` boolean was set at ingestion only from the search-card location text, which
-- meant almost no real remote jobs were flagged (clicking "Remote only" returned ~0 while the
-- search box, which scans the description, returned hundreds). This migration adds:
--
--   * `ai_workplace` - the AI scorer's authoritative verdict (remote|hybrid|onsite|unknown)
--     written by `saveJobScore` on each scoring pass.
--   * `is_remote` - a stored generated column the clients filter on. It prefers the AI verdict
--     when present and falls back to the ingestion heuristic (`remote`) for unscored jobs.
--
-- The ingestion heuristic is backfilled here so the filter works immediately; re-scoring the
-- existing catalog refines it. To force that, bump PROMPT_VERSION and requeue (commented below).

alter table jobs
  add column if not exists ai_workplace text;

alter table jobs drop constraint if exists jobs_ai_workplace_check;
alter table jobs add constraint jobs_ai_workplace_check
  check (ai_workplace is null or ai_workplace in ('remote', 'hybrid', 'onsite', 'unknown'));

-- Backfill the deterministic heuristic from title/city/region. The scorer overrides this once a
-- job carries an `ai_workplace` value, so a conservative match here is safe.
update jobs
set remote = true,
    updated_at = now()
where remote = false
  and lower(coalesce(title, '') || ' ' || coalesce(city, '') || ' ' || coalesce(region, ''))
      ~ '(remote|home[ -]?office|telearbeit|mobiles arbeiten|work from home|wfh|telework|telecommut)'
  and lower(coalesce(title, '') || ' ' || coalesce(city, '') || ' ' || coalesce(region, ''))
      !~ '(no remote|not remote|not a remote|remote not possible|remote work not|no home[ -]?office|kein home|keine remote|kein remote|nicht remote|onsite only|on-site only|on site only)';

-- Stored so PostgREST can filter/sort on it directly.
alter table jobs
  add column if not exists is_remote boolean
    generated always as (
      case
        when ai_workplace is null or ai_workplace = 'unknown' then remote
        else ai_workplace = 'remote'
      end
    ) stored;

create index if not exists jobs_is_remote_idx on jobs (is_remote);

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

-- Optional one-shot requeue so every job gets an AI `ai_workplace` verdict. This re-spends the
-- daily Gemini budget (15/min, 500-1000/day), so run it deliberately:
--   update jobs set ai_scored_at = null where is_active = true;
