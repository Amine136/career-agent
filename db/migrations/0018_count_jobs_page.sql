-- Career Agent - total count for the Jobs / Discarded pagination UI
--
-- The clients can now show every page number instead of unlocking one page at a time. The
-- count uses the exact same filter + per-user exclusion as `get_jobs_page` (and the same
-- signature, so the clients reuse one params object), but it is computed with the same
-- MATERIALIZED candidates pattern so it stays fast under PostgREST's generic plan.
--
-- `p_sort`, `p_limit` and `p_offset` are accepted (for signature parity) but ignored.

create or replace function public.count_jobs_page(
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
returns table (total bigint)
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
  select count(*)::bigint as total
  from public.active_jobs j
  join candidates c on c.id = j.id
  where not exists (
      select 1 from public.saved_jobs sv
      where sv.job_id = j.id and sv.user_id = auth.uid()
    )
    and not exists (
      select 1 from public.applications a
      where a.job_id = j.id and a.user_id = auth.uid()
    );
$$;

grant execute on function public.count_jobs_page(
  text, text, text, boolean, boolean, text, text, text, text, integer, integer
) to anon, authenticated;

notify pgrst, 'reload schema';
