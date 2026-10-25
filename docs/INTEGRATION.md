# Integration

## Sources

### LinkedIn guest API

- No authentication. The adapter uses the public guest search and job-detail endpoints.
- The sweep is checkpointed per country/query/page in `ingest_cursors`, so an invocation that
  exceeds its time budget resumes where it stopped.
- `LINKEDIN_FETCH_DETAILS=0` skips detail requests for a faster but less accurate pass.
- Request pacing is controlled by `LINKEDIN_REQUEST_DELAY_MS`.
- LinkedIn may change its guest endpoints at any time. Treat parser failures as expected
  operational events, not exceptional crashes.

### Indeed via Bright Data

- Bright Data Web Unlocker supplies the HTML; `BRIGHTDATA_TOKEN` and `BRIGHTDATA_ZONE` are
  server-side secrets.
- Indeed is paid per request. `INDEED_MAX_SEARCHES` is a rolling budget over
  `INDEED_BUDGET_WINDOW_DAYS`.
- A thin page stops pagination for that query. `INDEED_MIN_ACCEPTED` and `INDEED_MAX_PAGES`
  control adaptive paging.
- The parser first reads the embedded `mosaic-provider-jobcards` JSON model, with a card-DOM
  fallback.

## Processing stages

1. **Normalize** — canonical titles, employment type, seniority, location, dates, and remote
   signals.
2. **Hard filters** — entry-level only, 3-day freshness, allowed employment types, enabled
   countries, and internships excluded by title/type/seniority.
3. **Company guard** — skip a company after `INGEST_COMPANY_CAP` new inserts in the trailing
   `INGEST_COMPANY_WINDOW_DAYS`; staffing agencies and generic listings are exempt.
4. **Quotas** — split the run total across countries and each country target into
   remote/non-remote. A country at its target is skipped for the rest of the run.
5. **Dedupe** — `canonical_url` is unique; a fuzzy `dedupe_key` (company + normalized title +
   country + city) catches cross-source duplicates.
6. **Upsert** — create the job or add a `job_sources` row to the existing job and refresh
   `last_seen_at`.
7. **Run log** — one `runs` row per source with counts, status, and structured errors.

## Quotas

Defaults live in `config/quotas.ts`:

| Country | Share of run total |
|---|---:|
| DE | 25% |
| CA | 25% |
| NL | 20% |
| IE | 10% |
| GB | 10% |
| AE | 5% |
| SA | 5% |

Countries not listed default to a target of 0. Override with
`INGEST_COUNTRY_QUOTAS=DE=0.25,CA=0.25,...`, or set `INGEST_COUNTRY_QUOTAS=off` to use the
legacy flat `INGEST_MAX_JOBS_PER_COUNTRY` cap.

Each country target is split by `INGEST_REMOTE_SHARE` (default 0.5). Only jobs whose `remote`
flag is true consume the remote share, so unreliable source filters cannot exhaust the remote
quota.

## CLI overrides

```bash
pnpm ingest --source linkedin --countries DE,CA --pages 1
pnpm ingest --source indeed --countries DE
pnpm ingest --source linkedin --queries "AI Engineer|Junior AI Engineer"
```

Scheduler-level overrides use environment variables: `INGEST_SOURCES`, `INGEST_COUNTRIES`,
`INGEST_QUERIES`, `INGEST_PAGES`.

## Failure handling

- Each source is isolated. A failed source does not stop the others.
- A run with some failures is marked `partial`; all errors are stored in `runs.errors`.
- The scheduler exits non-zero when a source failed, so job execution monitoring can alert.
- LinkedIn progress is persisted, so retrying is cheap.
- Indeed paid budget is tracked in the database and shared across invocations.

## Compliance

LinkedIn and Indeed access is subject to their terms of service, robots policies, and applicable
law. Bright Data usage is subject to its own agreement. Validate that your intended use is
permitted before deploying this workflow commercially. This repository does not include source
credentials or grant any right to scrape a third-party service.
