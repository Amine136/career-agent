-- Career Agent - jobs page RPC: make the plan robust under PostgREST's cached generic plan
--
-- Migration 0016 removed `set search_path` so the planner could inline `get_jobs_page`, which
-- fixed the *custom-plan* case (~10ms). But PostgREST reuses a prepared statement per RPC, so
-- after a few calls PostgreSQL switches to a **generic plan** in which the argument values are
-- unknown. The optimizer can no longer prune the `p_search is null ...` / `p_source is null`
-- predicates, and combined with the per-user `not exists` anti-joins it again picks a
-- pathological nested-loop plan (~1s in Postgres, ~5s end-to-end).
--
-- Fix: split the query into two phases. The `candidates` CTE is MATERIALIZED, so the filtered
-- id set is computed once (parameters are applied at run time) and the anti-joins + sort then
-- run on that small set. The shape is stable no matter what plan the executor is committed to.
--
-- This also lets us restore `set search_path = public` (no longer needed for inlining), which
-- keeps the function safe against search_path hijacking.

create or replace function public.get_jobs_page(
  p_decision        text    default null,
  p_country_code    text    default null,
  p_employment_type text    default null,
  p_remote_only     boolean default false,
  p_sponsors_only   boolean default false,
  p_search          text    default null,
  p_location        text    default null,
  p_source          text    default null,
  p_sort            text    default 'newest',
  p_limit           integer default 10,
  p_offset          integer default 0
)
returns setof public.active_jobs
language sql
stable
security invoker
set search_path = public
as $$
  with candidates as materialized (
    select j.id
    from public.active_jobs j
    where (
        case
          when p_decision = 'KEEP' then j.ai_decision = 'KEEP'
          when p_decision = 'DISCARD' then j.ai_decision = 'DISCARD'
          when p_decision = 'ANY' then true
          else (j.ai_decision is null or j.ai_decision = 'KEEP')
        end
      )
      and (p_country_code is null or j.country_code = p_country_code)
      and (p_employment_type is null or j.employment_type = p_employment_type)
      and (not p_remote_only or j.is_remote)
      and (not p_sponsors_only or j.is_sponsored)
      and (
        p_search is null or p_search = ''
        or j.title ilike '%' || p_search || '%'
        or j.company_name ilike '%' || p_search || '%'
        or j.snippet ilike '%' || p_search || '%'
        or j.description ilike '%' || p_search || '%'
      )
      and (
        p_location is null or p_location = ''
        or j.city ilike '%' || p_location || '%'
        or j.region ilike '%' || p_location || '%'
      )
      and (
        p_source is null
        or exists (
          select 1 from public.job_sources s
          where s.job_id = j.id and s.source = p_source
        )
      )
  )
  select j.*
  from public.active_jobs j
  join candidates c on c.id = j.id
  where not exists (
      select 1 from public.saved_jobs sv
      where sv.job_id = j.id and sv.user_id = auth.uid()
    )
    and not exists (
      select 1 from public.applications a
      where a.job_id = j.id and a.user_id = auth.uid()
    )
  order by
    (case when p_sort = 'best_match' then j.ai_score end) desc nulls last,
    j.posted_at desc nulls last,
    j.first_seen_at desc nulls last
  limit greatest(p_limit, 0)
  offset greatest(p_offset, 0);
$$;

grant execute on function public.get_jobs_page(
  text, text, text, boolean, boolean, text, text, text, text, integer, integer
) to anon, authenticated;

notify pgrst, 'reload schema';
