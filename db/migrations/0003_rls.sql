-- Career Agent - Supabase Auth + Row Level Security
--
-- This schema supports Supabase-compatible clients that talk to PostgREST directly
-- (Auth + RLS). The worker itself uses a privileged connection.
--
-- Roles:
--   * anon / authenticated  -> API clients; governed by the policies below.
--   * the ingestion worker  -> connects to Postgres with a privileged role (Supabase
--     `postgres` / `service_role`) that owns the tables and therefore bypasses RLS.
--     Service-only credentials never leave the worker.
--
-- The compatibility shims make the migration safe to apply to plain Postgres (tests/CI)
-- as well as Supabase, where the `auth` schema and roles already exist.

-- ---------------------------------------------------------------------------
-- Compatibility shims (no-op on Supabase)
-- ---------------------------------------------------------------------------
do $$
begin
  if not exists (select 1 from pg_namespace where nspname = 'auth') then
    execute 'create schema auth';
    execute 'create or replace function auth.uid() returns uuid language sql stable as ''select null::uuid''';
  end if;
  if not exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'create role anon noinherit';
  end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then
    execute 'create role authenticated noinherit';
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- Mirror Supabase auth users into public.users so user-scoped foreign keys
-- (saved_jobs, applications, alerts) always resolve.
-- ---------------------------------------------------------------------------
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.users (id, email)
  values (new.id, new.email)
  on conflict (id) do update set email = excluded.email;
  return new;
end;
$$;

do $$
begin
  if exists (
    select 1 from information_schema.tables
    where table_schema = 'auth' and table_name = 'users'
  ) then
    execute 'drop trigger if exists on_auth_user_created on auth.users';
    execute 'create trigger on_auth_user_created after insert or update on auth.users
             for each row execute function public.handle_new_user()';
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- Enable RLS on every table. Tables without policies (runs) are reachable only
-- by the privileged worker role.
-- ---------------------------------------------------------------------------
alter table countries     enable row level security;
alter table companies     enable row level security;
alter table jobs          enable row level security;
alter table job_sources   enable row level security;
alter table runs          enable row level security;
alter table users         enable row level security;
alter table saved_jobs    enable row level security;
alter table applications  enable row level security;
alter table alerts        enable row level security;

-- ---------------------------------------------------------------------------
-- Data API grants (PostgREST honours both GRANTs and RLS policies)
-- ---------------------------------------------------------------------------
grant usage on schema public to anon, authenticated;

grant select on countries, companies, jobs, job_sources to anon, authenticated;
grant select, update on users to authenticated;
grant select, insert, update, delete on saved_jobs, applications, alerts to authenticated;

-- ---------------------------------------------------------------------------
-- Public catalog: anyone can read enabled reference data and the active jobs.
-- ---------------------------------------------------------------------------
drop policy if exists countries_public_read on countries;
create policy countries_public_read on countries
  for select to anon, authenticated using (true);

drop policy if exists companies_public_read on companies;
create policy companies_public_read on companies
  for select to anon, authenticated using (true);

drop policy if exists jobs_public_read on jobs;
create policy jobs_public_read on jobs
  for select to anon, authenticated using (is_active = true);

drop policy if exists job_sources_public_read on job_sources;
create policy job_sources_public_read on job_sources
  for select to anon, authenticated
  using (exists (
    select 1 from jobs j where j.id = job_sources.job_id and j.is_active = true
  ));

-- ---------------------------------------------------------------------------
-- User-owned rows: a user can only see and mutate their own records.
-- Rows are keyed by `auth.uid()` (= Supabase auth user id).
-- ---------------------------------------------------------------------------
drop policy if exists users_select_self on users;
create policy users_select_self on users
  for select to authenticated using (id = auth.uid());

drop policy if exists users_update_self on users;
create policy users_update_self on users
  for update to authenticated using (id = auth.uid()) with check (id = auth.uid());

drop policy if exists saved_jobs_select_own on saved_jobs;
create policy saved_jobs_select_own on saved_jobs
  for select to authenticated using (user_id = auth.uid());

drop policy if exists saved_jobs_insert_own on saved_jobs;
create policy saved_jobs_insert_own on saved_jobs
  for insert to authenticated with check (user_id = auth.uid());

drop policy if exists saved_jobs_delete_own on saved_jobs;
create policy saved_jobs_delete_own on saved_jobs
  for delete to authenticated using (user_id = auth.uid());

drop policy if exists applications_select_own on applications;
create policy applications_select_own on applications
  for select to authenticated using (user_id = auth.uid());

drop policy if exists applications_insert_own on applications;
create policy applications_insert_own on applications
  for insert to authenticated with check (user_id = auth.uid());

drop policy if exists applications_update_own on applications;
create policy applications_update_own on applications
  for update to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());

drop policy if exists applications_delete_own on applications;
create policy applications_delete_own on applications
  for delete to authenticated using (user_id = auth.uid());

drop policy if exists alerts_select_own on alerts;
create policy alerts_select_own on alerts
  for select to authenticated using (user_id = auth.uid());

drop policy if exists alerts_insert_own on alerts;
create policy alerts_insert_own on alerts
  for insert to authenticated with check (user_id = auth.uid());

drop policy if exists alerts_update_own on alerts;
create policy alerts_update_own on alerts
  for update to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());

drop policy if exists alerts_delete_own on alerts;
create policy alerts_delete_own on alerts
  for delete to authenticated using (user_id = auth.uid());
