-- Career Agent - group the runs of one scheduler invocation
--
-- One scheduled invocation writes several `runs` rows (indeed, linkedin, retention) and a
-- cadence runs the job three times. `invocation_id` links those rows so the post-run report can
-- analyze one invocation (and detect a missing one) without guessing from timestamps.
--
-- Legacy rows keep a null `invocation_id` and are ignored by the report.

alter table runs add column if not exists invocation_id uuid;

create index if not exists runs_invocation_idx on runs (invocation_id, started_at);

notify pgrst, 'reload schema';
