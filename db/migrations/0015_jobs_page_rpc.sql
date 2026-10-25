-- Career Agent - server-side jobs page / id resolution (fixes oversized NOT IN URLs)
--
-- Clients used to exclude the user's saved + applied jobs by shipping every id in the
-- PostgREST URL (`id=not.in.(...)`). Past a few hundred applications the encoded URL exceeded
-- the API gateway's request-line limit and every Jobs-page load failed with a bare
-- `400 Bad Request`. These functions move the per-user exclusion (plus filtering, sorting and
-- pagination) into SQL, so the request URL stays tiny. They run as the caller
-- (`security invoker`), so the existing RLS policies still apply.

-- ---------------------------------------------------------------------------
-- 1. Jobs page (Jobs + Discarded lists)
-- ---------------------------------------------------------------------------
-- `p_decision` mirrors the clients: null = approved (KEEP + unscored), 'KEEP' = recommended
-- only, 'DISCARD' = discarded page, 'ANY' = no decision filter.
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
set search_path = public
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
set search_path = public
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
-- `p_exclude_actioned` matches the "waiting to apply" rule: a job with an application row whose
-- status is anything but 'saved' is not waiting (a saved job still counts as waiting).
create or replace function public.count_active_jobs(
  p_decision          text    default 'ANY',
  p_exclude_actioned  boolean default false
)
returns table (total bigint)
language sql
stable
set search_path = public
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

-- Let PostgREST pick up the new functions without waiting for its schema-cache timeout.
notify pgrst, 'reload schema';
