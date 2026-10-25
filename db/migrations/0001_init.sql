-- Career Agent - initial schema
-- Plain PostgreSQL, portable across Supabase / Neon / local Postgres.

-- ---------------------------------------------------------------------------
-- countries
-- ---------------------------------------------------------------------------
create table if not exists countries (
  id               text primary key,
  name             text not null,
  flag             text not null,
  indeed_domain    text not null,
  linkedin_location text not null,
  languages        text[] not null default '{}',
  priority         int not null default 0,
  enabled          boolean not null default true,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- companies
-- ---------------------------------------------------------------------------
create table if not exists companies (
  id              uuid primary key default gen_random_uuid(),
  name            text not null,
  normalized_name text not null unique,
  website         text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- jobs (normalized common representation)
-- ---------------------------------------------------------------------------
create table if not exists jobs (
  id                     uuid primary key default gen_random_uuid(),
  canonical_url          text unique,
  -- deterministic fuzzy key: lower(company) + lower(title_normalized) + country + city
  dedupe_key             text unique,
  title                  text not null,
  title_normalized       text not null,
  company_id             uuid references companies(id) on delete set null,
  -- denormalized for display and dedupe-key construction
  company_name           text not null,
  country_code           text references countries(id),
  city                   text,
  region                 text,
  remote                 boolean not null default false,
  employment_type        text,
  job_type_weight        int not null default 1,
  seniority              text,
  entry_level            boolean not null default true,
  experience_requirement text,
  description            text,
  snippet                text,
  language               char(2),
  posted_at              date,
  first_seen_at          timestamptz not null default now(),
  last_seen_at           timestamptz not null default now(),
  is_active              boolean not null default true,
  source_count           int not null default 1,
  -- reserved for future AI/relevance scoring; intentionally not computed yet
  relevance_score        numeric,
  raw                    jsonb,
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now()
);

create index if not exists jobs_country_posted_idx on jobs (country_code, posted_at desc);
create index if not exists jobs_entry_active_idx on jobs (entry_level, is_active);
create index if not exists jobs_title_normalized_idx on jobs (title_normalized);
create index if not exists jobs_active_posted_idx on jobs (is_active, posted_at desc);
create index if not exists jobs_company_idx on jobs (company_id);

-- ---------------------------------------------------------------------------
-- job_sources (one row per platform posting; several can map to one job)
-- ---------------------------------------------------------------------------
create table if not exists job_sources (
  id            uuid primary key default gen_random_uuid(),
  job_id        uuid not null references jobs(id) on delete cascade,
  source        text not null,
  source_job_id text not null,
  url           text not null,
  raw           jsonb,
  scraped_at    timestamptz not null default now(),
  unique (source, source_job_id)
);

create index if not exists job_sources_job_idx on job_sources (job_id);

-- ---------------------------------------------------------------------------
-- runs (ingestion / scraper logs)
-- ---------------------------------------------------------------------------
create table if not exists runs (
  id            uuid primary key default gen_random_uuid(),
  source        text not null,
  started_at    timestamptz not null default now(),
  finished_at   timestamptz,
  status        text not null default 'running'
                check (status in ('running', 'success', 'partial', 'failed')),
  jobs_fetched  int not null default 0,
  jobs_accepted int not null default 0,
  jobs_rejected int not null default 0,
  jobs_inserted int not null default 0,
  jobs_updated  int not null default 0,
  error_count   int not null default 0,
  stats         jsonb not null default '{}'::jsonb,
  errors        jsonb not null default '[]'::jsonb
);

create index if not exists runs_source_started_idx on runs (source, started_at desc);

-- ---------------------------------------------------------------------------
-- users
-- ---------------------------------------------------------------------------
create table if not exists users (
  id         uuid primary key default gen_random_uuid(),
  email      text unique,
  created_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- saved_jobs
-- ---------------------------------------------------------------------------
create table if not exists saved_jobs (
  user_id  uuid not null references users(id) on delete cascade,
  job_id   uuid not null references jobs(id) on delete cascade,
  saved_at timestamptz not null default now(),
  primary key (user_id, job_id)
);

-- ---------------------------------------------------------------------------
-- applications (application tracking)
-- ---------------------------------------------------------------------------
create table if not exists applications (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references users(id) on delete cascade,
  job_id     uuid not null references jobs(id) on delete cascade,
  status     text not null default 'saved'
             check (status in ('saved', 'applied', 'interviewing', 'offer', 'rejected', 'withdrawn')),
  notes      text,
  applied_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, job_id)
);

create index if not exists applications_user_status_idx on applications (user_id, status);
create index if not exists applications_job_idx on applications (job_id);

-- ---------------------------------------------------------------------------
-- alerts (data model only; notification logic is a later phase)
-- ---------------------------------------------------------------------------
create table if not exists alerts (
  user_id      uuid not null references users(id) on delete cascade,
  country_codes text[] not null default '{}',
  titles       text[] not null default '{}',
  job_types    text[] not null default '{}',
  frequency    text not null default 'every-3-days',
  created_at   timestamptz not null default now(),
  primary key (user_id, created_at)
);

-- ---------------------------------------------------------------------------
-- updated_at maintenance
-- ---------------------------------------------------------------------------
create or replace function set_updated_at()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

drop trigger if exists countries_set_updated_at on countries;
create trigger countries_set_updated_at
  before update on countries
  for each row execute function set_updated_at();

drop trigger if exists companies_set_updated_at on companies;
create trigger companies_set_updated_at
  before update on companies
  for each row execute function set_updated_at();

drop trigger if exists jobs_set_updated_at on jobs;
create trigger jobs_set_updated_at
  before update on jobs
  for each row execute function set_updated_at();

drop trigger if exists applications_set_updated_at on applications;
create trigger applications_set_updated_at
  before update on applications
  for each row execute function set_updated_at();
