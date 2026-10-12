# CURRENT_STATE (keep compact; history lives in git/ADRs)

Updated: 2026-10-12 · Phase: **PHASE 1 PRODUCTION READINESS CODE DONE (providers/policies external) · previously BACKEND GAP REMEDIATION DONE - OVERALL STATUS: NOT READY FOR PRODUCTION (external/business blockers)** · Modules 1-19 implemented; user commit `93064cf`, HEAD `b976465`; all later work uncommitted on `main` (nothing staged).

## Toolchain
Node 24 · NestJS 11.2.7 · TypeScript 5.9.3 · Prisma 7.10.0 (exact) · Jest 30 · CommonJS · npm. Unchanged.

## Evidence (final tree, local; no GitHub CI run)
typecheck, lint, format:check OK · unit 194/194 (20 suites) · e2e 27/27 · integration 610/610 (32 suites) on a fresh `_ci` database · 8 migrations apply to an empty database, no schema drift · production Docker image builds; API and worker containers start, `/health/ready` 200 · real CLI bootstrap and production-mode HTTP smoke passed. Details: `docs/testing/remediation/README.md`, `docs/qa/backend-gap-remediation.md`.

## Phase 1 production readiness (latest, 2026-10-12)
Built (details `docs/qa/phase1-production-readiness.md`, decisions D-52..D-58, questions Q-76..Q-82): Twilio + MSG91 SMS adapters and Twilio WhatsApp; Razorpay payment adapter with lookup by order; booking-cancellation x payment consistency + durable `payment_exceptions` + admin list/resolve/recovery-summary; payment/refund recovery sweeper in the worker (claimed rows, backoff, UNKNOWN_ORDER replay); KYC whole-file validation, SHA-256, rejected-upload deletion, review-time integrity check, abandoned-upload sweeper; `TRUST_PROXY_HOPS` mandatory in production; Super Admin bootstrap with hidden prompt/secret file + strength check; `EMBEDDED_WORKERS`; `render.yaml`. 1 additive migration (`20261018090000`, 12 total).
Evidence (local, fresh `_ci` DB): typecheck, lint, format:check OK - unit 248/248 (24 suites) - e2e 27/27 - integration 672/672 (36 suites) - 12 migrations apply to an empty DB, no drift - production Docker image builds; API and worker containers start, `/health/ready` 200, production start refuses a missing `TRUST_PROXY_HOPS`, OTP answers an honest 503 with SMS disabled - real HTTP smoke of admin login and the new admin endpoints - bootstrap CLI run locally (refusals, concurrent runs, repeat).
NOT verified: any real provider (SMS, Razorpay, storage), Render deployment, GitHub CI. NOT built (decision needed): automatic refunds (Q-77), unpaid-booking expiry (Q-78), malware scan (Q-81), push provider.

## Phase 2
Built: customer-safe worker profile, shortlist, worker photo (off until `PROFILE_PHOTO_MAX_BYTES` set), outbox dead-lettering + retry, re-check reminder loop, production Redis throttle default, demo-seed guard. 3 more additive migrations (11 total). Evidence: unit 194, e2e 27, integration 629/630 on a fresh DB (1 transient timeout, passes alone), Docker API/worker smoke. NOT built (decision needed): worker earnings (Q-73), report/block (Q-74). See `docs/qa/OPEN_BLOCKERS.md` section 6.

## Done in remediation (phase 1)
`npm run bootstrap:admin` (one-time, audited) · admin self-service password change · opt-in Redis rate-limit store + production config warnings · KYC file-signature check · notification health + manual retry · 5 FK indexes (migration `20261014090000`).

## Blockers
No payment/SMS/push/WhatsApp vendor · booking state model unconfirmed (Q-55) · permission matrix unapproved (Q-70; proposal only) · admin reset/MFA undecided (Q-66) · KYC scan/retention/real bucket (Q-69) · missing features (shortlist, worker profile view, photo, earnings, report/block; Q-65) · `.env` points at a remote Supabase DB: never run migrations or the CLI there without a decision.

## NOT verified
GitHub Actions run, real providers, real bucket, reverse proxy/TLS, load/soak, backup restore, multi-replica Redis.
