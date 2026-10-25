# Data model

The schema is plain PostgreSQL and is applied through ordered migrations in `db/migrations/`.
`db/migrate.ts` records applied filenames in `schema_migrations`.

## Core tables

| Table | Purpose |
|---|---|
| `countries` | Enabled markets, LinkedIn location strings, Indeed domains, languages. |
| `companies` | Normalized company identity; `normalized_name` is unique. |
| `jobs` | Canonical job row, AI verdicts, remote/sponsorship generated columns. |
| `job_sources` | One row per source posting; unique on `(source, source_job_id)`. |
| `runs` | One row per source or retention pass, grouped by `invocation_id`. |
| `ingest_cursors` | LinkedIn sweep progress for resumable runs. |
| `ai_request_log` | Per-model request accounting for rate limiting. |
| `job_removals` | Cumulative deletion log written by the delete trigger. |

## Optional client tables

The schema includes tables used by Supabase-style clients: `users`, `saved_jobs`,
`applications`, `alerts`, and the legacy `hidden_jobs`. This repository has no clients, but the
tables are retained because the SQL RPCs and retention rules reference them. If you deploy a UI
later:

- `saved_jobs`, `applications`, and `alerts` are scoped to `auth.uid()`.
- `jobs` is publicly readable when `is_active = true`.
- Client-side hard deletion is limited to jobs whose `created_by = auth.uid()`. The scraped
  catalog is worker-managed.
- The worker connects with a privileged role and bypasses RLS.

## Jobs lifecycle

1. A source result is normalized and inserted with `canonical_url` and `dedupe_key`.
2. Re-sightings update `last_seen_at` and add a `job_sources` row rather than duplicating the job.
3. Hard filters set `is_active`; the AI scorer writes `ai_*` fields.
4. Retention permanently deletes scraped jobs that have no `saved_jobs`/`applications` row and
   have not been seen for 14 days.
5. Every deletion is recorded in `job_removals` by `log_job_removal()`.

## Key derived columns

| Column | Meaning |
|---|---|
| `is_remote` | Generated: `ai_workplace` wins; falls back to the ingestion `remote` flag only when unscored. |
| `is_sponsored` | Generated: true only when `ai_visa = 'sponsors'`. |
| `company_normalized` | Normalized company key used by the company diversity guard. |
| `dedupe_key` | Fuzzy cross-source duplicate key. |

## Indexes

Indexes cover active/country/date listing, entry-level filtering, title search, company lookups,
pending AI work, AI ranking, remote/sponsorship filters, company-window queries, and run
invocation grouping. The `active_jobs` view exposes active jobs and is re-created by later
migrations when columns are added.

## Migration rules

- Add a new numbered migration; never edit an applied migration in a deployed environment.
- Wrap changes in transactions where PostgreSQL permits it.
- Keep Supabase compatibility shims in `0003_rls.sql` if the target may be plain Postgres.
- Recreate dependent views when adding columns to `jobs`.
- Run migrations as a release step, not from application startup.
