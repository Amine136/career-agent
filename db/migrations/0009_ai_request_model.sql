-- Career Agent - per-model AI request accounting
--
-- Each model gets its own daily request budget (e.g. Gemini 3.5 Flash Lite 500/day, then
-- Gemini 3.1 Flash Lite another 500/day on the same key). Requests are attributed to the
-- model that served them so the scorer can switch models when one hits its daily cap.
--
-- Existing rows predate per-model accounting; attribute them to the previous default model so
-- a same-day run on that model still respects the cap.

alter table ai_request_log add column if not exists model text;

update ai_request_log set model = 'gemini-3.5-flash-lite' where model is null;

alter table ai_request_log alter column model set not null;

create index if not exists ai_request_log_model_idx on ai_request_log (model, requested_at desc);
