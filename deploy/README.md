# Deployment

These steps target Google Cloud Run Jobs plus Cloud Scheduler. Nothing is deployed
automatically, and the manifests contain placeholders that must be replaced.

## Prerequisites

- A Google Cloud project with Cloud Run, Artifact Registry, Secret Manager, and Cloud Scheduler
  enabled.
- `gcloud` authenticated for the target project.
- Docker available for the image build.
- A PostgreSQL database reachable from Cloud Run (Supabase, Neon, Cloud SQL, or self-hosted).
- Bright Data credentials for Indeed and a Gemini API key for scoring.

## 1. Build and push the image

```bash
export PROJECT_ID=your-project
export REGION=europe-west1
export REPO=career-agent
export IMAGE_URI="$REGION-docker.pkg.dev/$PROJECT_ID/$REPO/worker:latest"

gcloud artifacts repositories create "$REPO" \
  --repository-format=docker --location="$REGION" || true
gcloud auth configure-docker "$REGION-docker.pkg.dev"

docker build -t "$IMAGE_URI" .
docker push "$IMAGE_URI"
```

For a production rollout, deploy an immutable tag or digest instead of `latest`.

## 2. Store secrets

Create the secrets and grant the runtime service account
`roles/secretmanager.secretAccessor`:

```bash
printf '%s' "$DATABASE_URL"    | gcloud secrets create career-agent-database-url --data-file=-
printf '%s' "$BRIGHTDATA_TOKEN"| gcloud secrets create career-agent-brightdata-token --data-file=-
printf '%s' "$GEMINI_API_KEY"  | gcloud secrets create career-agent-gemini-api-key --data-file=-
```

If the secrets already exist, use `gcloud secrets versions add ... --data-file=-` instead.

## 3. Apply migrations

Run migrations once per release from a trusted environment with a direct database connection:

```bash
pnpm install --frozen-lockfile
pnpm migrate
```

Do not run migrations from the ingestion job itself; keep schema changes as an explicit release
step with a backup and rollback plan.

## 4. Replace placeholders and deploy the jobs

Edit both manifests and replace:

- `PROJECT_ID`
- `REGION`
- `IMAGE_URI`

Then:

```bash
gcloud run jobs replace deploy/cloud-run-ingest.yaml --region "$REGION"
gcloud run jobs replace deploy/cloud-run-score.yaml  --region "$REGION"
```

The runtime service account is expected to be
`career-agent-run@PROJECT_ID.iam.gserviceaccount.com`. Create it or change the manifest to match
your existing service account.

Manual smoke tests:

```bash
gcloud run jobs execute career-agent-ingest --region "$REGION" --wait
gcloud run jobs execute career-agent-score  --region "$REGION" --wait
```

## 5. Schedule ingestion

The LinkedIn sweep is resumable, so the deployment can run the ingestion job three times per
cadence to give it a longer cumulative sweep. Each invocation has its own time budget.

```bash
for HOUR in 6 7 8; do
  gcloud scheduler jobs create http "career-agent-ingest-0${HOUR}h" \
    --location "$REGION" \
    --schedule "0 $HOUR 2-31/3 * *" \
    --time-zone "UTC" \
    --uri "https://run.googleapis.com/v2/projects/$PROJECT_ID/locations/$REGION/jobs/career-agent-ingest:run" \
    --http-method POST \
    --oauth-service-account-email "career-agent-scheduler@$PROJECT_ID.iam.gserviceaccount.com"
done
```

The scheduler service account needs permission to run the job
(`roles/run.developer` on the job, or `roles/run.invoker` plus `run.jobs.run`).

The `2-31/3` day-of-month expression starts the cadence on day 2 and repeats every three days. It
is equivalent in frequency to `*/3`; adjust it if your scoring cadence crosses month boundaries.

## 6. Schedule scoring

Scoring runs as a separate job so a slow model never delays ingestion and each job keeps its own
timeout. The default schedule is daily at 09:00 UTC.

```bash
gcloud scheduler jobs create http career-agent-score-daily \
  --location "$REGION" \
  --schedule "0 9 * * *" \
  --time-zone "UTC" \
  --uri "https://run.googleapis.com/v2/projects/$PROJECT_ID/locations/$REGION/jobs/career-agent-score:run" \
  --http-method POST \
  --oauth-service-account-email "career-agent-scheduler@$PROJECT_ID.iam.gserviceaccount.com"
```

## 7. Monitor

- Alert on failed Cloud Run Job executions.
- Query `runs` for `status = 'failed'` and for a missing `invocation_id`.
- Run `pnpm report --strict` on a schedule or in CI and alert on exit code `2`.
- Watch Cloud Run duration, memory, database connections, and Gemini request budgets.

See [docs/OPERATIONS.md](../docs/OPERATIONS.md) for the runbook.

## Environment overrides

The manifests set production defaults. The full list of variables and defaults is in
[`.env.example`](../.env.example). Important knobs:

| Variable | Purpose |
|---|---|
| `INGEST_SOURCES` | Comma list, default `indeed,linkedin`. |
| `INGEST_COUNTRIES` | Comma list of ISO codes. |
| `INGEST_QUERIES` | `\|`-separated query overrides. |
| `INGEST_PAGES` | Pages per query for generic sources. |
| `INGEST_MAX_JOBS` | Hard cap on inserted jobs per invocation. |
| `INGEST_COUNTRY_QUOTAS` | Country shares, or `off` for the flat cap. |
| `INGEST_REMOTE_SHARE` | Remote share of each country target. |
| `INGEST_COMPANY_CAP` / `INGEST_COMPANY_WINDOW_DAYS` | Company diversity guard. |
| `SCHEDULER_TIME_BUDGET_MS` | Self-imposed budget below the Cloud Run timeout. |
| `AI_MODEL` / `AI_FALLBACK_MODEL` | Primary and fallback Gemini models. |
| `AI_MAX_REQUESTS_PER_MINUTE` / `AI_MAX_REQUESTS_PER_DAY` | Per-model budgets. |
| `SCORE_LOOKBACK_DAYS` | UTC days considered per scoring pass. |

## Rollback

- Keep the previous image digest and job revision.
- Revert the worker image before reverting schema changes.
- Additive migrations are preferred; write a forward fix rather than editing an applied
  migration.
- Restore the database from backup if a destructive change cannot be reversed safely.
