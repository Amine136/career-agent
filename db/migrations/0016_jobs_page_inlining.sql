-- Career Agent - jobs page RPC performance fix (function inlining)
--
-- Symptom: the Jobs / Discarded lists took ~1s in Postgres and ~5s end-to-end through
-- PostgREST for authenticated users, while the exact same SQL run inline was ~10ms.
--
-- Cause: `get_jobs_page` (and its siblings) are `language sql`, `security invoker`
-- functions declared with `set search_path = public`. PostgreSQL refuses to *inline* a
-- SQL function that carries a `SET` clause, so it ran as a black-box Function Scan. Under
-- RLS the planner then picked a pathological plan for the per-user `not exists` anti-joins
-- combined with the parameterized filter predicates (~1s per call; the reusable prepared
-- plan PostgREST uses made it worse).
--
-- Fix: drop the `SET search_path` clause so the planner inlines the queries and optimizes
-- the whole statement at the call site (~80ms). Every relation/function in these bodies is
-- already schema-qualified (`public.*`, `auth.uid()`), so behaviour is unchanged. They stay
-- `security invoker`, so RLS still applies.

-- ---------------------------------------------------------------------------
-- 1. Jobs page (Jobs + Discarded lists)
-- ---------------------------------------------------------------------------
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
as $$
  select j.*
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
    and not exists (
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

-- ---------------------------------------------------------------------------
-- 2. Id resolution (bulk-remove preview + Discarded "select all")
-- ---------------------------------------------------------------------------
create or replace function public.get_job_ids(
  p_decision         text    default null,
  p_score_min        integer default null,
  p_score_max        integer default null,
  p_country_codes    text[]  default null,
  p_employment_types text[]  default null,
  p_remote_only      boolean default false,
  p_sponsors_only    boolean default false,
  p_keyword          text    default null,
  p_limit            integer default 1000,
  p_offset           integer default 0
)
returns setof uuid
language sql
stable
security invoker
as $$
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
    and (p_score_min is null or j.ai_score >= p_score_min)
    and (p_score_max is null or j.ai_score <= p_score_max)
    and (p_country_codes is null or j.country_code = any(p_country_codes))
    and (p_employment_types is null or j.employment_type = any(p_employment_types))
    and (not p_remote_only or j.is_remote)
    and (not p_sponsors_only or j.is_sponsored)
    and (
      p_keyword is null or p_keyword = ''
      or j.title ilike '%' || p_keyword || '%'
      or j.company_name ilike '%' || p_keyword || '%'
    )
    and not exists (
      select 1 from public.saved_jobs sv
      where sv.job_id = j.id and sv.user_id = auth.uid()
    )
    and not exists (
      select 1 from public.applications a
      where a.job_id = j.id and a.user_id = auth.uid()
    )
  order by j.id asc
  limit greatest(p_limit, 0)
  offset greatest(p_offset, 0);
$$;

grant execute on function public.get_job_ids(
  text, integer, integer, text[], text[], boolean, boolean, text, integer, integer
) to anon, authenticated;

-- ---------------------------------------------------------------------------
-- 3. Stat counts (never ships the user's id list in a URL)
-- ---------------------------------------------------------------------------
create or replace function public.count_active_jobs(
  p_decision          text    default 'ANY',
  p_exclude_actioned  boolean default false
)
returns table (total bigint)
language sql
stable
security invoker
as $$
  select count(*)::bigint as total
  from public.active_jobs j
  where (
      case
        when p_decision = 'KEEP' then j.ai_decision = 'KEEP'
        when p_decision = 'DISCARD' then j.ai_decision = 'DISCARD'
        else true
      end
    )
    and (
      not p_exclude_actioned
      or not exists (
        select 1 from public.applications a
        where a.job_id = j.id
          and a.user_id = auth.uid()
          and a.status <> 'saved'
      )
    );
$$;

grant execute on function public.count_active_jobs(text, boolean) to anon, authenticated;

-- Let PostgREST pick up the recreated functions without waiting for its schema-cache timeout.
notify pgrst, 'reload schema';
