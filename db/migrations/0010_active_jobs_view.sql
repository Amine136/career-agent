-- Career Agent - per-user active job view (scalable "hidden" exclusion)
--
-- Clients used to fetch the user's hidden job ids and send them back as a `not id in (...)`
-- filter. That breaks once a user hides hundreds of jobs (usually after a bulk cleanup): the
-- id list exceeds the HTTP URL limit and PostgREST rejects the request. This view pushes the
-- exclusion into Postgres so the client sends no id list at all.
--
-- `security_invoker = true` (Postgres 15+, used by Supabase) keeps the caller's RLS policies
-- in force:
--   * jobs_public_read       limits rows to is_active = true
--   * hidden_jobs_select_own limits the anti-join to the caller's own hidden rows
-- anon sees every active job (auth.uid() is null and no hidden rows are visible to anon).

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

-- anon needs SELECT on hidden_jobs for the anti-join even though RLS returns no rows for it.
grant select on public.hidden_jobs to anon;
grant select on public.active_jobs to anon, authenticated;
