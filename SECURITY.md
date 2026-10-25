# Security

## Reporting a vulnerability

Do not open a public issue for a suspected vulnerability or exposed credential.

Use GitHub's private vulnerability reporting / security advisory flow for this repository. If
that is unavailable, contact the repository owner through the private channel used to share this
repository.

Include:

- A description of the issue and its impact.
- Steps to reproduce.
- Affected files, migrations, or deployment components.
- Any suggested mitigation.

## Credential policy

- Never commit `.env`, database URLs, API keys, service-account keys, or passwords.
- Load production secrets from a secret manager.
- The worker uses a privileged database role; keep that connection string server-side.
- Client applications, if added later, may receive only a publishable/anon key.
- Rotate a credential immediately if it is exposed, then redeploy any affected job.

## Repository guardrails

```bash
pnpm check:secrets
```

This is a lightweight scan for common patterns. Enable GitHub secret scanning and push
protection, and consider a dedicated scanner such as gitleaks in CI and locally.

## Database security

- RLS is enabled on user-facing tables.
- Client-side job deletion is restricted to rows created by the caller
  (`created_by = auth.uid()`).
- The worker bypasses RLS with a privileged connection; do not expose that connection to clients.
- Keep migrations reviewed and applied as a release step.

## Third-party services

LinkedIn, Indeed, Bright Data, and Gemini are external services with their own security and
usage terms. This repository does not grant permission to scrape or process their data. Validate
compliance before production use.

## Supported versions

Security fixes are applied to the current `main` branch. There is no long-term support branch in
this repository.
