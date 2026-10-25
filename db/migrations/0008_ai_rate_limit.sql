-- Career Agent - AI request accounting for rate limiting
--
-- One row per model request (including retries). The scorer reserves a slot before each
-- Gemini call so it never exceeds the configured per-minute / per-day request budgets.
--
-- Worker-only: RLS is enabled with no policies and no grants to client roles, so only the
-- worker (which connects as the table owner) can read or write it.
--
-- Day boundaries use UTC (`date_trunc('day', now())`).

create table if not exists ai_request_log (
  id           bigint generated always as identity primary key,
  requested_at timestamptz not null default now()
);

create index if not exists ai_request_log_requested_idx on ai_request_log (requested_at desc);

alter table ai_request_log enable row level security;
