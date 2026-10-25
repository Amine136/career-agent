# Architecture

## Scope

Career Agent is a scheduled backend workflow. It has no custom HTTP API and no UI in this
repository. The outputs are PostgreSQL rows, structured JSON logs, and the run report.

## Components

| Component | Entry point | Responsibility |
|---|---|---|
| Ingestion scheduler | `pnpm scheduler` → `src/scheduler/index.ts` | Run configured sources, then retention; exit non-zero on failed sources. |
| Ingestion CLI | `pnpm ingest` → `src/ingest/cli.ts` | One-off or targeted ingestion with source/country/query overrides. |
| Source adapters | `src/sources/` | LinkedIn guest search/detail parsing and Indeed via Bright Data. |
| Normalizer | `src/core/normalize.ts` | Canonical titles, employment types, internship detection, date parsing. |
| Filters | `src/core/filters.ts` | Entry-level, freshness, employment type, country, and remote hard filters. |
| Dedupe | `src/core/repository.ts`, `src/db.ts` | Canonical URL uniqueness plus fuzzy company/title/country/city key. |
| Budgets | `src/ingest/budget.ts`, `src/ingest/company-guard.ts` | Per-country/remote quotas and per-company diversity. |
| AI scorer | `pnpm score` → `src/ai/` | Gemini structured-JSON assessment with rate limits and fallback model. |
| Retention | `src/core/retention.ts` | Permanently delete untouched scraped jobs unseen for 14 days. |
| Reports | `pnpm report` → `scripts/run-report.ts` | Expected-vs-actual quota, source, and remote analysis. |
| Migrations | `pnpm migrate` → `db/migrate.ts` | Apply ordered SQL migrations and record them. |

## Runtime flow

```text
scheduler
  ├─ ingestAll()
  │   ├─ Indeed adapter (paid, bounded)
  │   │    → normalize → hard filters → company guard → upsert
  │   ├─ LinkedIn adapter (free, resumable)
  │   │    → normalize → hard filters → company guard → upsert
  │   └─ one `runs` row per source, shared invocation_id
  ├─ applyRetention() → one `runs` row
  └─ exit code 1 if any source failed; partial results are kept

score
  ├─ select active, unscored jobs within the scoring lookback
  ├─ per-model rate limit before every request
  ├─ Gemini structured JSON
  ├─ persist score, decision, confidence, reasoning, workplace, visa verdict
  └─ failed jobs remain pending
```

## Trust boundaries

- **Worker** uses `DATABASE_URL`, a privileged role that bypasses RLS. It owns ingestion,
  scoring, retention, and run logging.
- **Database** is the only shared state. There is no application server to secure.
- **Source credentials** (`BRIGHTDATA_TOKEN`, `GEMINI_API_KEY`) are server-only and must come
  from environment variables or a secret manager.
- **Client tables** exist for compatibility, but this repository ships no clients. RLS limits
  user-owned rows to `auth.uid()` and limits client-side job deletion to rows the caller created.

## Design decisions

1. **Idempotent ingestion.** Re-running is safe: source identity and canonical/fuzzy keys prevent
   duplicate jobs.
2. **Hard filters before writes.** Internships, stale postings, disallowed types, and failed
   entry-level checks are rejected before they reach the catalog or the scorer.
3. **Budgets are enforced before the write.** The company guard and per-country quotas avoid
   storing jobs that would immediately be discarded.
4. **Paid source first, bounded.** Indeed uses a rolling search budget; LinkedIn is swept with a
   resumable cursor so a long sweep can continue in the next invocation.
5. **Scoring is asynchronous and one-shot.** Ingestion never waits for a model. A failed or
   budget-exhausted scoring pass leaves jobs pending for the next run.
6. **The database enforces invariants.** Dedupe keys, check constraints, generated columns, and
   the removal log live in migrations rather than only in application code.
7. **No custom API.** For this workflow, PostgreSQL access from the worker is sufficient.
   Adding an API layer later should be a deliberate security and product decision.

## Failure model

- Source failures are isolated: one failed source does not stop the other.
- A partial run keeps successfully inserted jobs and records errors in `runs.errors`.
- LinkedIn checkpoints progress in `ingest_cursors`.
- Scoring failures stay pending; the next run retries them.
- The scheduler exits non-zero on failed sources so Cloud Monitoring can alert.
- Retention runs after ingestion and is independently logged.

## Scaling notes

- Postgres is the bottleneck for larger catalogs. The schema includes indexes for active-job
  filtering, company-window queries, AI scoring, and run grouping.
- Cloud Run Jobs run with `parallelism: 1` by default to avoid duplicate source sweeps. Scale out
  by partitioning countries/queries and using separate cursors rather than raising parallelism
  blindly.
- Rate limits are stored in `ai_request_log`, so multiple scoring invocations share the daily
  budget.
