-- Career Agent - AI job interpretation (per-job scoring)
--
-- The scoring worker (`pnpm score`, Cloud Run Job `career-agent-score`) evaluates each scraped
-- job against a candidate profile and stores the verdict on the job row. Downstream UIs can
-- use KEEP for an approved list and DISCARD for a rejected list.
--
-- Scoring is idempotent and one-shot: a job is scored only while `ai_scored_at is null`.
-- On provider failure the row stays NULL so the next run retries it.
--
-- `jobs` is already publicly readable (RLS `jobs_public_read`, `grant select on jobs`), so
-- these additive columns need no new policy. `relevance_score` stays reserved and unused.

alter table jobs
  add column if not exists ai_score int,
  add column if not exists ai_decision text,
  add column if not exists ai_confidence int,
  add column if not exists ai_reason text,
  add column if not exists ai_missing_critical_requirements text[] not null default '{}',
  add column if not exists ai_model text,
  add column if not exists ai_prompt_version text,
  add column if not exists ai_scored_at timestamptz;

-- Canonical verdicts emitted by the worker after normalizing the model's output
-- (the model may say REJECT; we store DISCARD).
alter table jobs drop constraint if exists jobs_ai_decision_check;
alter table jobs add constraint jobs_ai_decision_check
  check (ai_decision is null or ai_decision in ('KEEP', 'DISCARD'));

-- Pending-scoring queue: active, unscored jobs in ingestion order.
create index if not exists jobs_ai_pending_idx on jobs (first_seen_at) where ai_scored_at is null and is_active = true;

-- Ranking / page partition: KEEP vs DISCARD, best score first.
create index if not exists jobs_ai_rank_idx on jobs (ai_decision, ai_score desc);
