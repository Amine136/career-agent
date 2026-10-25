# Operations

## Routine checks

After each ingestion cadence:

```bash
pnpm report --limit=3
pnpm report --strict
```

Review:

- `runs.status` per source: `success`, `partial`, or `failed`.
- Per-country inserts against quota targets.
- Remote share against `INGEST_REMOTE_SHARE`.
- Company-cap skips and the top capped companies.
- LinkedIn cursor progress and Indeed paid-search efficiency.

After scoring:

```sql
select ai_decision, count(*), avg(ai_score)
from jobs
where ai_scored_at >= now() - interval '1 day'
group by ai_decision;
```

## Alerts to configure

- Cloud Run Job execution failed.
- No new `runs.invocation_id` within the expected cadence window.
- `runs.status = 'failed'` or a high `runs.error_count`.
- `pnpm report --strict` exit code 2.
- Scoring pass analyzed fewer jobs than expected for several days.
- Database storage/connection saturation.

## Failure recovery

| Symptom | Action |
|---|---|
| One source failed | Inspect `runs.errors`; the other source is unaffected. Rerun the failed source only. |
| LinkedIn sweep incomplete | It is resumable. Run the job again; progress is in `ingest_cursors`. |
| Indeed budget exhausted | Wait for the rolling window or adjust `INDEED_MAX_SEARCHES`. |
| Scoring failures | Jobs stay pending. Check provider status, key validity, and rate-limit rows in `ai_request_log`. |
| Prompt changed | Bump `PROMPT_VERSION`, then requeue only affected rows. |
| Remote flags wrong | Run `pnpm repair:remote` (dry run), then `--apply` and optionally `--requeue`. |
| Too many jobs from one company | Tune `INGEST_COMPANY_CAP`/window; use dry-run first. |
| Need to delete untouched jobs now | `pnpm retention`; verify the 14-day rule first. |

## Database operations

- Apply migrations before deploying a new worker image.
- Back up before large schema changes or destructive repairs.
- Use a dedicated database for `TEST_DATABASE_URL`; the test helper truncates all tables.
- Keep `DIRECT_URL` set when `DATABASE_URL` uses a transaction pooler and migrations need a
  direct connection.
- Retention deletes rows permanently. Confirm backups and the untouched-job rule before
  shortening the window or running manual SQL.

## Secrets and rotation

- Store `DATABASE_URL`, `BRIGHTDATA_TOKEN`, and `GEMINI_API_KEY` in a secret manager.
- Do not bake credentials into images, CI logs, or repository files.
- Rotate a credential immediately if it is exposed, then redeploy the affected jobs.
- `pnpm check:secrets` scans tracked files for common patterns, but pair it with GitHub secret
  scanning or gitleaks.

## Reproducing a run locally

```bash
docker compose up -d db
pnpm migrate
pnpm ingest --source linkedin --countries DE --pages 1
pnpm report --limit=1
```

Use `TEST_DATABASE_URL` for destructive tests, never the production database.

## Deployment checklist

1. Build and push the worker image.
2. Create/update Secret Manager entries.
3. Apply migrations.
4. Create/update the Cloud Run Jobs.
5. Create/update the Cloud Scheduler triggers.
6. Execute each job manually once.
7. Confirm `runs` rows, logs, and `pnpm report` output.
8. Configure alerts and a backup/retention policy.
