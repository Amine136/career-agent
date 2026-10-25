# Scoring

## Purpose

The scorer evaluates each pending job against a configurable candidate profile and stores a
structured assessment. It is a separate CLI (`pnpm score`) so a slow model never delays
ingestion.

## Inputs

- Job title, company, location, description (truncated), employment type, and source metadata.
- The candidate profile in `config/candidate-profile.ts` (a generic example by default).
- `PROMPT_VERSION` (`2026-10-25.1`) stored with every result.

## Output

Each scored job gets:

| Column | Meaning |
|---|---|
| `ai_score` | Numeric match score. |
| `ai_decision` | `KEEP` or `DISCARD`. |
| `ai_confidence` | Model confidence. |
| `ai_reason` | Short explanation. |
| `ai_workplace` | `remote`, `hybrid`, `onsite`, or `unknown`. |
| `ai_visa` | `sponsors`, `unknown`, or `no_sponsorship`. |
| `ai_missing_critical_requirements` | Missing must-haves. |
| `ai_model` | Model that produced the verdict. |
| `ai_prompt_version` | Prompt version. |
| `ai_scored_at` | Completion time. |

Stored generated columns derive `is_remote` (prefers the AI workplace verdict) and
`is_sponsored` (only explicit sponsorship). Deterministic remote detection is the fallback for
unscored jobs.

## Scheduling and budget

- `pnpm score` selects active, unscored jobs whose `first_seen_at` falls inside the lookback
  window (`SCORE_LOOKBACK_DAYS`, default 3 UTC days), oldest first.
- `AI_MAX_JOBS_PER_RUN` is a safety cap; the wall-clock budget
  (`AI_TIME_BUDGET_MS`, default 70 minutes) can stop a pass earlier.
- Rate limits are enforced before every request and shared through `ai_request_log`:
  `AI_MAX_REQUESTS_PER_MINUTE` (default 15) and `AI_MAX_REQUESTS_PER_DAY` (default 500 per
  model).
- When the primary model reaches its daily budget, the scorer continues with
  `AI_FALLBACK_MODEL` on the same key.
- Failures are retried with exponential backoff (`AI_MAX_RETRIES`) and remain pending if they
  still fail.

## Requeueing

A job is scored only while `ai_scored_at` is null. After changing the prompt or fixing a
classification bug, requeue affected rows:

```sql
update jobs set ai_scored_at = null where ...;
```

`pnpm repair:remote --apply --requeue` demonstrates the pattern for stale remote verdicts.

## Prompt and model changes

- Replace the example candidate profile before production scoring. Keep the profile generic in
  the repository and load real personal data from a private, non-committed source if needed.
- Bump `PROMPT_VERSION` whenever the prompt semantics or profile change materially.
- Keep `ai_prompt_version` on old rows so mixed-version catalogs are visible.
- Requeue deliberately; scoring consumes paid model quota.
- Test prompt/output changes with `pnpm test` and a small `pnpm score --limit=10` pass first.

## Limitations

- The profile is static and encoded in the prompt; it is not user-configurable at runtime.
- Scoring is one job per request, not batched.
- Provider outages or quota exhaustion leave jobs pending rather than failing the whole run.
- The prompt may classify ambiguous workplace/visa statements conservatively; verify high-impact
  decisions before acting on them.
