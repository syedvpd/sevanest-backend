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

## 2026-10-12 late: small backlog items, interim policy defaults and PRD audit
Built: attendance month summary, customer/booking list filters, report CSV export, admin-created booking and worker, generic Idempotency-Key, If-Match on two admin edits, start-date guard, customer auto-verification, Super Admin password reset, audited emergency-contact reads, optional ClamAV scanning (decisions D-59..D-62, questions Q-83..Q-91; migrations `20261020090000`, `20261020100000`).
Evidence (local, `_ci` databases): typecheck, lint, format OK - unit 270/270 - e2e 27/27 - integration 731 of 732 in one full run (the one failure fixed and re-run green; no second clean full run) - 15 migrations, no drift.
PRD audit (inspection only, no code changes): `docs/qa/prd-implementation-matrix.md` and the other audit documents; verdict NOT READY: 8 P0 rows (real SMS/payment never exercised, backups/monitoring, secrets exposed, worker loops) and 13 P1 rows. Apps and web admin are not in the workspace.

## 2026-10-12 closure of the PRD audit
Built: worker double-booking rule (D-63: overlap in dates and hours, free after the service ends, per-worker lock at confirmation, optional travel buffer), category engagement restrictions (D-64), worker opportunity feed (D-65), heartbeat TTL fix (the two "missing" loops were a false negative), worker list filters, complaint history filter. Migrations: `20261020110000_category_engagements` (16 in total).
Evidence: format, lint, typecheck clean; unit 270/270; e2e 27/27; integration 743/743 (40 suites, clean full run, fresh DB); no schema drift; Docker image builds and starts in production mode. Closure: `docs/qa/closure-register.md` (5 fixed and verified, 6 partially fixed, 20 blocked by a decision, 15 blocked by an external dependency, 3 not verified, 4 not fixed).
Verdict: NOT PRODUCTION READY - real SMS, payment gateway, push, storage, backups/monitoring, secret rotation and the client policy decisions remain.

## 2026-10-13 second closure run
Built: worker references (max 5), interview/trial time proposals with customer/staff answer, replacement-chain history, customer self-edit versioning (ETag/If-Match), If-Match on categories / areas / templates, admin worker filters (area, minimum rating), `npm run check:providers`, decision register Q-77..Q-93, runbook launch checks. Migration `20261021090000_references_slot_proposals` (17 in total). Closure register: 55 findings - 11 fixed and verified, 6 partially fixed, 20 blocked by a decision, 15 blocked by an external dependency, 3 not verified, 0 not fixed.
Still NOT PRODUCTION READY: real SMS, Razorpay sandbox, FCM, backups / monitoring, TLS and CI evidence, secret rotation, loops re-check after deploy, client decisions.

## Customer-app gap work (2026-10-13)
Built: worker reviews list for customers (`GET /search/workers/{id}/ratings`), `ratingScaleMax` in `/reference-data`, address `label/line2/state` (migration `20261018090000`), response schemas published for the customer-facing controllers. Answers to all 15 asks in `docs/qa/customer-app-api-gaps.md`. Not built (decisions): price guidance, budget search, area-from-coordinates, customer photo, `minRating`. Evidence: unit 270, integration 795/796 on a fresh DB (one untracked WIP `onboarding.int-spec.ts` failure), `appfeedback` 10/10.

## 2026-10-13 customer-app blockers
Built: `GET /pricing/guidance` (+ admin `PUT/GET/DELETE /admin/pricing-guidance`), `GET /locations/service-area` (+ optional centre/radius on service areas), `GET /search/workers/{id}/slots`, `GET /interviews`, `GET /customers/me/home`, `allowedActions`/`timeline` on interviews, typed schemas. Search returns page and total in one statement; `SEARCH_CACHE_TTL_SECONDS` (default 0) enables a per-instance page cache. Migrations `20261023090000`, `20261023100000`. See `docs/qa/customer-app-*.md`. Load test (100k users) partly run: search was the bottleneck (about 36 req/s alone on a laptop-class DB, about 200 req/s mixed after the fix); capacity assessment document still to be written.

## 2026-10-14 app payment blockers
Answered in `docs/qa/customer-app-integration-handoff.md` (fake gateway is backend-test only; Razorpay test keys reported set on staging Render by the user, not inspected; test OTP setup; receipt PDF waits for Q-100). Added `scripts/staging-payment-smoke.mjs` (manual live check of POST /payments, wrong-signature refusal and, with `--checkout`, a full Razorpay test-mode payment). Real Razorpay test-mode payment verified end to end on a local API with the staging test keys (14/14). Added `GET /payments/{id}/receipt/pdf` (plain receipt, not a GST invoice; Q-100 open) and config warnings for `PAYMENT_GATEWAY` / unused Razorpay keys. No schema change.

## 2026-10-14 external audit triage and photo pipeline
Audit verdicts in `docs/qa/antigravity-audit-triage.md`. Built: D-69 WebP photo renditions (sharp 0.34.4, migration `20261025090000_worker_photo_variants`, original deleted, EXIF stripped) and ClamAV scan of photos; D-70 test OTP refused in production; D-71 least-privilege starting permissions for the three non-Super roles (seed applies to empty roles only); D-72 readiness checks for Super Admin, empty roles, test OTP, plus readiness problems in the API startup log. Q-34 and Q-70 closed. Not changed by decision: OTP messages, booking fee and verification requirements (admin-configured).

## 2026-10-14 worker-app blockers
Verified and closed the five worker-app backend blockers (`docs/qa/worker-app-blockers-audit.md`, closure rows WAB-01..05): demo OTP is frontend-only and cannot authenticate server-side; opportunity detail = `GET /workers/me/bookings/{id}` (D-74); categories/areas stay behind login (D-75); optional ticket `subject` (D-73, migration `20261026090000`, 22 migrations in total).
