-- Career Agent - correct `is_remote` precedence
--
-- `is_remote` previously fell back to the ingestion heuristic (`jobs.remote`) whenever the AI
-- verdict was missing OR `unknown`. That heuristic was itself unreliable: LinkedIn's remote-only
-- search (`f_WT=2`) forced `remote = true` on every hit, including on-site roles whose text never
-- mentions an arrangement. The scorer then read `Remote: yes` back out of the prompt and echoed
-- `ai_workplace = 'remote'`, so a role with an on-site campus (Lely, NL) showed as Remote.
--
-- The remote-filter forcing is fixed at the source (`src/sources/linkedin.ts`) and the heuristic is
-- no longer injected into the AI prompt (`src/ai/prompt.ts`). Here we also stop `unknown` from
-- falling back to the (possibly stale) heuristic:
--
--   * ai_workplace is null        -> unscored: use the ingestion heuristic (`remote`).
--   * ai_workplace = 'remote'     -> true.
--   * hybrid / onsite / unknown   -> false.
--
-- A stored generated column cannot be altered in place, so drop and re-create it (and the
-- dependent `active_jobs` view, which expands `j.*`).

drop view if exists public.active_jobs;
alter table jobs drop column if exists is_remote;

alter table jobs
  add column is_remote boolean
    generated always as (
      case
        when ai_workplace is null then remote
        when ai_workplace = 'remote' then true
        else false
      end
    ) stored;

create index if not exists jobs_is_remote_idx on jobs (is_remote);

-- Re-create the view so `select j.*` picks up `is_remote` again (appended at the end).
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

-- Existing rows are repaired separately (it re-spends the Gemini daily budget), see:
--   pnpm repair:remote --apply
--   update jobs set ai_scored_at = null where is_active = true;  -- requeue for re-scoring
