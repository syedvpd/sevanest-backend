# Production readiness matrix

Audit date 2026-10-12. Overall verdict: **NOT READY FOR PRODUCTION**. The code paths are built and locally tested; the items below are what stands between the current deployment (Render free plan, Supabase, test keys) and a launch.

| Area | Evidence | Status | Action |
|---|---|---|---|
| API deployment | Render service responds: `/health/ready` 200 with database and Redis up (checked 2026-10-12) | PARTIAL | Free plan sleeps; use a paid instance or a pinger |
| Worker loops | Root cause of the two "missing" loops found and fixed in code: heartbeat lived 180 s but those loops tick every 5 and 15 minutes. Not yet re-checked on the deployed service | PARTIAL | Deploy, wait 15 minutes, re-run `GET /admin/system/readiness` |
| Migrations | 15 migrations apply to an empty database with no drift (`prisma migrate diff`) | PASS (local) | Run `migrate deploy` on each release; backups first |
| Config validation | Production refuses fake/memory adapters and missing `TRUST_PROXY_HOPS` | PASS (unit tests) | Live service runs `NODE_ENV` other than production (staging) |
| SMS / OTP | Twilio and MSG91 adapters mocked; test OTP for allow-listed numbers on staging | NOT_VERIFIED | Provider account, sender, DLT template, real delivery test |
| Payments | Razorpay adapter; unsigned webhook correctly refused (401) on the live service; `check:providers` prepared (test order + lookup) but the local environment has no Razorpay keys | BLOCKED_BY_EXTERNAL_DEPENDENCY | Run the sandbox session in the runbook with your test keys |
| Push | FCM adapter mocked | NOT_VERIFIED | Firebase service account |
| Storage | S3 adapter configured. `npm run check:providers` (2026-10-13, local .env): bucket reachable with these credentials. Not checked: the bucket is private, signed-URL expiry at the provider, photo upload (disabled by configuration) | PARTIAL | Confirm the bucket is private in Supabase; set the photo size limit; upload and read back a test document |
| Malware scan | Optional ClamAV adapter; none deployed | MISSING | Decide requirement (Q-89) |
| Rate limiting | Redis store supported; production default redis | PARTIAL | Multi-instance and Redis outage tests |
| Secrets | Env only. Scan of tracked files and git history (2026-10-13): no `.env`, no key or token patterns, only placeholders. Live secrets were pasted in chat and the admin password is weak | FAIL until the owner rotates them | Rotate everything (runbook section 4); set a strong admin password |
| TLS / HTTPS | Terminated by Render | NOT_VERIFIED | Confirm HSTS/redirect behaviour |
| Monitoring and alerts | Health endpoints, admin alerts, structured logs | MISSING | Uptime monitor, log shipping, error tracking (Q-91) |
| Backups and restore | Not configured by this repo | NOT_VERIFIED | Enable Supabase backups, run a restore drill (runbook) |
| CI | Workflow files exist; no recorded run for the current tree | NOT_VERIFIED | Run on the pushed commit |
| Docker image | `docker build` succeeds (exit 0); the container starts in production mode with disabled providers, `GET /api/v1/app-config` 200, an admin route 401, log "API listening on port 3000 (production)" (2026-10-12, local Docker) | PASS (local) | A development-mode container fails because pino-pretty is a dev dependency: always run the image with `NODE_ENV=production` |
| Handover docs | README, runbook, API docs at `/docs` | PARTIAL | Admin user guide not in repository |
| Business policies | Cancellation fee, refund, expiry, SLA, retention, MFA, plans | BLOCKED_BY_DECISION | See OPEN_QUESTIONS Q-77..Q-91 |
