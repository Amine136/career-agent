# Career Agent

Backend workflow for collecting entry-level AI/ML job postings, normalizing and deduplicating
them, scoring them against a candidate profile, and reporting on every ingestion pass.

This repository is the **workflow only**: ingestion integrations, AI scoring, database schema,
tests, and deployment templates. It intentionally does not contain the Android/Desktop clients,
personal configuration, or historical deployment data.

## Pipeline

```mermaid
flowchart LR
  LI[LinkedIn guest API] --> N[Normalize]
  BD[Bright Data / Indeed] --> N
  N --> F[Hard filters]
  F --> D[Dedupe + company guard]
  D --> DB[(PostgreSQL)]
  DB --> S[Gemini scorer]
  S --> DB
  DB --> R[Run report]
  DB --> T[Retention]
```

The worker is stateless apart from PostgreSQL and the source cursors. Each invocation writes one
`runs` row per source plus a retention row, all linked by `invocation_id`.

## Included

- LinkedIn ingestion with resumable cursors and a bounded sweep budget.
- Indeed ingestion through Bright Data with a rolling paid-search budget.
- Normalization, entry-level/type/freshness filters, internship exclusion, remote detection.
- Deduplication by canonical URL and fuzzy key.
- Per-country and remote/non-remote ingestion quotas.
- Per-company diversity guard with a self-expiring window.
- Gemini structured-JSON scoring with per-model rate limits, fallback model, retries, and a
  wall-clock budget.
- PostgreSQL schema, row-level security policies, and migration runner.
- Post-run report with quota, source, and anomaly checks.
- Retention: delete scraped jobs that were never saved/applied and unseen for 14 days.
- Dockerfile, Cloud Run Job manifests, Cloud Scheduler guidance, and CI.

## Requirements

- Node.js 20+ (22 recommended)
- pnpm 11
- PostgreSQL 14+ (Supabase or local Docker)
- Bright Data credentials for Indeed (optional if you only run LinkedIn)
- A Google AI Studio key for scoring (optional for ingestion-only runs)

## Quickstart

```bash
# 1. Local PostgreSQL (creates the main and test databases)
docker compose up -d db

# 2. Configure the worker
cp .env.example .env
# Set at minimum:
#   DATABASE_URL=postgresql://career_agent:career_agent@127.0.0.1:5434/career_agent
#   TEST_DATABASE_URL=postgresql://career_agent:career_agent@127.0.0.1:5434/career_agent_test

# 3. Install and migrate
pnpm install
pnpm migrate

# 4. Verify
pnpm typecheck
pnpm test
pnpm check:secrets
```

LinkedIn ingestion needs no credentials:

```bash
pnpm ingest --source linkedin --countries DE --pages 1
```

Indeed and scoring:

```bash
# BRIGHTDATA_TOKEN must be set in .env
pnpm ingest --source indeed --countries DE

# GEMINI_API_KEY must be set in .env
pnpm score --limit=10
```

Inspect the result:

```bash
pnpm report --limit=3
pnpm report --strict  # exit code 2 when an anomaly is found
```

## Commands

| Command | Purpose |
|---|---|
| `pnpm migrate` | Apply pending SQL migrations. |
| `pnpm ingest [--source=...] [--countries=...] [--pages=...]` | Run one ingestion pass. |
| `pnpm scheduler` | Ingestion followed by retention; Cloud Run entry point. |
| `pnpm score [--limit=N] [--since=YYYY-MM-DD]` | Score pending jobs. |
| `pnpm retention` | Run the 14-day untouched-job cleanup only. |
| `pnpm report [--limit=N] [--json] [--strict]` | Analyze the last N invocations. |
| `pnpm repair:remote [--apply] [--requeue]` | Recompute remote flags and optionally rescore. |
| `pnpm stats:descriptions` | Report stored description length/token statistics. |
| `pnpm check:secrets` | Scan tracked files for common credential patterns. |
| `pnpm test` / `pnpm typecheck` | Test and type-check the worker. |

## Configuration

All worker configuration is environment-driven. See [`.env.example`](./.env.example) for the
complete list and defaults.

Key groups:

- **Database**: `DATABASE_URL`, `DIRECT_URL`, `TEST_DATABASE_URL`.
- **LinkedIn**: request delay, per-invocation budget, page cap, detail fetching.
- **Indeed / Bright Data**: token, zone, paid-search budget, adaptive paging.
- **Ingestion quotas**: total cap, per-country shares, remote share, company diversity cap.
- **Gemini**: API key, primary/fallback model, per-minute/per-day limits, retries, time budget,
  scoring lookback.
- **Scheduling**: source/country/query overrides and the scheduler time budget.

The candidate profile used by the scorer lives in `config/candidate-profile.ts` and is a
generic example. Replace it with the profile you are evaluating against before production
scoring; do not commit personal data.

Secrets must never be committed. Use a secret manager in production.

## Database

Migrations live in `db/migrations/` and are applied in filename order, tracked in
`schema_migrations`. The schema is plain PostgreSQL with Supabase compatibility shims, so it runs
on local Postgres, Supabase, Neon, or another managed Postgres.

See [docs/DATA_MODEL.md](./docs/DATA_MODEL.md) for the tables and lifecycle.

## Deployment

The included templates target Google Cloud Run Jobs plus Cloud Scheduler. See
[deploy/README.md](./deploy/README.md) and [docs/OPERATIONS.md](./docs/OPERATIONS.md).

Nothing is deployed automatically. Replace the `PROJECT_ID`, `REGION`, and image placeholders in
the manifests before applying them, and keep credentials in Secret Manager.

## Architecture and behavior

- [ARCHITECTURE.md](./ARCHITECTURE.md) — components, trust boundaries, and design decisions.
- [docs/INTEGRATION.md](./docs/INTEGRATION.md) — source integrations, filters, quotas, and dedupe.
- [docs/SCORING.md](./docs/SCORING.md) — AI prompt, verdicts, rate limiting, and requeueing.
- [docs/DATA_MODEL.md](./docs/DATA_MODEL.md) — tables, indexes, lifecycle, and retention.
- [docs/OPERATIONS.md](./docs/OPERATIONS.md) — runbook, monitoring, and failure recovery.

## Testing

`pnpm test` runs unit tests without external services. DB-backed tests run only when
`TEST_DATABASE_URL` is set, because they truncate every table. The suite refuses to run
destructive tests when `DATABASE_URL` and `TEST_DATABASE_URL` are not the same value.

`pnpm check:secrets` is a lightweight guardrail, not a replacement for GitHub secret scanning or
a dedicated scanner such as gitleaks.

## Current limitations

- Source runs can finish `partial` when a source or an individual page fails; the other source
  continues and the failure is recorded in `runs`.
- The remote share is a target, not a guarantee. Source coverage and search yield vary by market.
- Indeed requires a paid Bright Data account. LinkedIn is a guest endpoint and may change without
  notice.
- Scoring is one-shot per job; failures remain pending for the next run. Requeueing is manual
  when the prompt changes.
- The deployment templates are a starting point, not a managed production service. Alerting,
  backup policy, and secret rotation remain deployment responsibilities.
- Scraping is subject to each source's terms and local law. Validate usage rights before
  deploying this workflow commercially.

## Security

Do not open issues containing credentials or personal data. See [SECURITY.md](./SECURITY.md).

## License

Proprietary — shared for evaluation only. See [LICENSE](./LICENSE).
