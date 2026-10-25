# Changelog

## 0.1.0 - 2026-10-25

- Initial sanitized backend workflow release.
- LinkedIn and Bright Data/Indeed ingestion with normalization, hard filters, dedupe, quotas, and
  company diversity guard.
- Gemini scoring with structured output, model fallback, retries, and per-model rate limits.
- PostgreSQL schema with migrations, generated remote/sponsorship columns, RLS, and run logging.
- Retention, run reporting, remote repair, and secret-scanning utilities.
- Cloud Run Job manifests and Cloud Scheduler deployment guidance.
- CI for typecheck, tests, secret scanning, and image build.
