# Contributing

## Required checks

Before opening a pull request:

```bash
pnpm install --frozen-lockfile
pnpm typecheck
pnpm test
pnpm check:secrets
```

DB-backed tests require `TEST_DATABASE_URL`. They truncate every table and refuse to run unless
`DATABASE_URL` points at the same dedicated test database.

## Rules

- Never commit credentials, personal data, or real candidate profiles.
- Keep the example profile in `config/candidate-profile.ts` generic.
- Add migrations as new numbered files; do not edit applied migrations.
- Bump `PROMPT_VERSION` when scoring behavior or the candidate profile changes materially.
- Update the relevant document under `docs/` when behavior or configuration changes.
- Keep source-specific parsing and rate limits inside `src/sources/` and `src/ingest/`.

## Commit and pull request style

- Use a short imperative subject.
- Explain the operational impact, migration requirements, and any new environment variables.
- Include the commands used to verify the change.
- Call out changes that spend paid API quota or require a production requeue.
