-- Career Agent - denormalized company key for ingestion diversity
--
-- `jobs.company_normalized` is the same `normalizeText(company)` key stored in
-- `companies.normalized_name`, copied onto the job so the per-company ingest guard can count
-- recently stored jobs with a single indexed group-by instead of joining `companies` (and so it
-- still works for orphaned jobs whose company row was deleted).
--
-- Existing rows are backfilled from `companies`; any orphan gets the rough lower/trim fallback.

alter table jobs add column if not exists company_normalized text;

update jobs j
set company_normalized = c.normalized_name
from companies c
where c.id = j.company_id
  and j.company_normalized is distinct from c.normalized_name;

update jobs
set company_normalized = lower(btrim(company_name))
where company_normalized is null;

create index if not exists jobs_company_normalized_seen_idx
  on jobs (company_normalized, first_seen_at desc);

notify pgrst, 'reload schema';
