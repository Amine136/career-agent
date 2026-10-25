-- Career Agent - ingestion resume cursors
--
-- The LinkedIn sweep is exhaustive (free) and can take longer than a single Cloud Run
-- invocation. The worker stores where it stopped here so the next run resumes instead of
-- restarting from the first country/query/page.
--
-- Internal worker table: RLS is enabled with no policies and no grants to client roles,
-- so only the worker (which connects as the table owner) can read or write it.

create table if not exists ingest_cursors (
  source     text primary key,
  cursor     jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

alter table ingest_cursors enable row level security;

drop trigger if exists ingest_cursors_set_updated_at on ingest_cursors;
create trigger ingest_cursors_set_updated_at
  before update on ingest_cursors
  for each row execute function set_updated_at();
