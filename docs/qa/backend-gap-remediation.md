# Backend gap remediation and negative-path hardening

Date: 2026-10-09 · Branch `main` (HEAD `b976465`), **nothing committed or pushed** · Scope: backend only (NestJS modular monolith).
Baseline: the QA phase's uncommitted work (`docs/qa/*`, `scripts/`, config/S3/booking/replacement fixes, `qa.concurrency.int-spec.ts`) was preserved untouched; this phase adds to it.

## 1. Verdict

**NOT READY for production.** Safe to continue in development/staging. Blockers that remain after this phase (all external or business decisions, none a known code defect):

1. No payment gateway, SMS vendor, push or WhatsApp adapter (Q-08): nobody can receive an OTP or pay, so nobody can log in or confirm a booking in production.
2. Booking state model is the PROPOSED FRD model (Q-55); admin permission matrix unapproved (only Super Admin holds permissions, Q-70).
3. KYC: no malware scan, retention policy or bucket-side size cap, and the S3 adapter has never touched a real bucket (Q-69, Q-50).
4. Admin password reset and MFA are undecided and unbuilt (Q-66).
5. Required product features still missing: shortlist, customer worker-profile view, worker photo, worker earnings view, report/block (Q-65).
6. Never exercised: GitHub Actions, real reverse proxy/TLS, load, backup restore.

## 2. Baseline facts established

* `.env` in the working tree points `DATABASE_URL` at a **remote Supabase** database. No migration, bootstrap or test was ever run against it. Integration tests use the local `sevanest_test` database by the project's own `*_test|*_ci` guard; this phase's final runs used fresh disposable local databases `sevanest_remediation_ci` and `sevanest_bootstrap_ci`.
* `docs/project-intelligence/` was hidden by `.git/info/exclude` (a local, uncommitted exclude), not by `.gitignore`. That line was removed so the folder can be version-controlled; `governance/`, `.env*`, keys and logs stay ignored. Nothing was staged.
* Working-tree line endings were CRLF while the index is LF (`core.autocrlf=false`); files edited here were kept/normalised to LF, so diffs show only real changes.

## 3. Findings and traceability

Classes: CD confirmed defect · CM confirmed missing · PI partially implemented · CR configuration required · BD business decision required · EP external provider blocked · AI already implemented · NV not verifiable here.

| # | Requirement / risk | Existing behaviour found | Gap | Class | Remediation | Evidence |
|---|---|---|---|---|---|---|
| 1 | First production Super Admin (B-5, S-06) | Seed bootstrap was dev-only and refused production; the check was a non-atomic count | No safe production path; race possible | CM | `npm run bootstrap:admin`: env credentials, no default, production confirmation phrase, advisory lock, refuses once any Super Admin exists, audits both outcomes with no credentials | unit 3, integration 3, real CLI run (section 6) |
| 2 | Admin password change | none | missing | CM | `POST /admin/account/password`, current-password re-check feeding the lockout, min length, other sessions revoked atomically, audited | integration 4, real HTTP smoke |
| 3 | Admin password reset, MFA | none | needs channel and decision | BD | not built; Q-66, R-34 | n/a |
| 4 | Admin login lockout, refresh rotation and replay revoke, suspension, expiry | implemented | none found | AI | unchanged; re-run in full suite | `auth.api`, `security.api`, `users.api`, `qa.adversarial` |
| 5 | Role-permission matrix | roles seeded, only SUPER_ADMIN mapped; audited role/permission API; takes effect next request | matrix unapproved | BD | proposal in section 4, **not applied**; Q-70 | `admin.api`, RBAC_MATRIX |
| 6 | Negative authorization (401/403 wrong type/role/permission, suspended, IDOR 404, mass assignment, admin via customer routes) | implemented across every route (the inventory test enumerates them); global `whitelist` strips unknown fields | none found; new route added to the reviewed-exception lists | AI | route inventory now lists the password route as a reviewed no-permission exception (acts on own account only) | `security.api`, `qa.access`, `qa.inventory`, `qa.adversarial` |
| 7 | Global rate limit with several API instances (S-04) | in-memory per process; OTP/admin lockouts already in Redis | limit multiplied by replicas | CD (config) | opt-in `THROTTLE_STORAGE=redis` atomic Lua store with in-memory fallback; production start-up warns on `memory` and on `TRUST_PROXY_HOPS=0` | integration 3, env spec |
| 8 | Proxy depth / trusted headers (S-05) | `TRUST_PROXY_HOPS` default 0 | depends on real deployment | CR | warning only; value must come from infrastructure (Q-67) | env spec |
| 9 | KYC: trust of client MIME | size checked, type was whatever the client declared | content never inspected | CD | confirm reads first bytes; must match PDF/JPEG/PNG signature; mismatch 422, audited, stays unconfirmed; `readObjectHead` on the provider boundary | unit 3, integration 1 |
| 10 | KYC: private bucket, signed short-lived links, audit before link, ownership 404, append-only history, required-set empty = nobody verified | implemented | none found | AI | unchanged | `verification.api`, `qa.access` |
| 11 | KYC malware scan, retention, bucket size cap, real bucket | absent | vendor/policy | BD, EP | Q-69, Q-50, R-35 | n/a |
| 12 | Booking/payment/replacement state machines, idempotency, concurrency, webhook signature + replay | implemented; QA found and fixed lock-order deadlock S-01 | final state model unconfirmed | AI, BD | none; Q-55 | `qa.statemachine` 297, `qa.concurrency`, `payment.api` |
| 13 | Provider boundaries: real adapters | interfaces + `disabled` + test-only fakes; fakes refused in production by env validation | no vendors chosen | EP | none; nothing claimed live | env spec |
| 14 | Outbox atomic with business change, durable, stale re-offer, idempotent delivery, bounded backoff | implemented | operators had no health view or way to retry FAILED | PI | `GET /admin/notifications/health`, `POST /admin/notifications/{id}/retry` (FAILED only, audited) | integration 5 |
| 15 | Alerting on queue lag / failures / provider outage | none | no monitoring stack | CR | health endpoint provides numbers; R-37 | n/a |
| 16 | FK indexes (S-12) | 17 FKs uncovered | joined FKs slow at volume | CD (minor) | migration adds 5 covering indexes; other 12 are audit-style `*_user_id` on Restrict relations, left | fresh-DB migrate + `migrate diff` no drift |
| 17 | Raw SQL safety (Search, Reports, Audit) | tagged templates; the only `Prisma.raw` is guarded by a column-name regex | none found | AI | none | code review |
| 18 | Body size, validation, error envelope without secrets, Helmet, CORS allow-list, x-powered-by off, Swagger off by default | implemented | `.env.example` has `SWAGGER_ENABLED=true`, so a copied file exposes docs | CR | production start-up already warns; set false in real environments (S-10) | observed during the production-mode smoke run |
| 19 | Shortlist, customer worker-profile view, worker photo, worker earnings, report/block, receipts/exports | none | privacy/scope/shape undecided (Q-42, Q-52, Q-59, Q-14) | CM, BD | **not built** to avoid inventing rules; Q-65 | n/a |
| 20 | Verification expiry / recheck | `RECHECK_DUE` derived from date, no scheduler | no job; notification producer absent | PI | not changed; Q-51, Q-57 | `verification.api` |
| 21 | Reports definitions, ranges, permission, read-only | implemented, definitions PROPOSED | confirmation | AI, BD | none; Q-61 | `reports.api`, `qa.reports` |
| 22 | Worker and API as separate processes, graceful shutdown, liveness vs readiness | implemented (`enableShutdownHooks`, `/health/live`, `/health/ready`) | none found | AI | Docker build verified (section 6) | health e2e |
| 23 | Backups, restore, SLOs, GitHub CI, TLS | none in repo | infrastructure | CR, NV | R-32, QA R-4/R-5 | n/a |

## 4. Proposed admin permission matrix — PROPOSAL ONLY, NOT APPLIED, PENDING APPROVAL (Q-70)

Principle: least privilege from the 32 existing permission codes; Super-Admin-only codes (`role.manage`, `audit.view`, `admin.manage_users`) stay with SUPER_ADMIN (enforced in code). The FRD matrix contradicts itself on who approves verification (matrix says Verification Executive cannot; FM-05 says they approve), so `verification.decide` is shown as a decision point.

| Permission group | Operations Admin | Verification Executive | Support Executive |
|---|---|---|---|
| booking.view, booking.manage | yes | no | view only |
| customer.view / customer.manage | yes / yes | no | view / no |
| worker.view / worker.manage | yes / yes | view / no | view / no |
| matching.run, replacement.view/manage, attendance.view/manage | yes | no | no |
| payment.view; payment.manage; payment.refund | view; no; **decision (Q-17)** | no | no; no; no |
| verification.review, verification.document.view | no | yes | no |
| verification.decide | **decision** | **decision (FRD conflict)** | no |
| verification.configure | no | no | no |
| support.view / support.manage / support.category.manage | view / no / no | no | yes / yes / no |
| rating.view / rating.moderate | view / yes | no | view / no |
| report.view | yes | no | no |
| notification.manage, category.manage, area.manage, user.view, user.status.manage | yes, yes, yes, view, no | no | no |

Nothing above was written to the database or seed. To apply after approval: `PUT /api/v1/admin/roles/{code}/permissions` (audited, effective on the next request) or a seed change.

## 5. Fixed, with files and regression tests

**Fixed and verified**

| Item | Files | Regression tests |
|---|---|---|
| Production Super Admin bootstrap | `src/bootstrap-admin.ts`, `src/modules/users/users.service.ts`, `users.repository.ts`, `rbac-seed.service.ts`, `src/seed.ts`, `package.json`, `README.md` | `src/modules/users/users.bootstrap.spec.ts`, `test/integration/remediation.admin.int-spec.ts`, `users.api.int-spec.ts` (existing second-bootstrap case) |
| Admin password change | `src/modules/auth/admin-account.controller.ts`, `auth.service.ts`, `session.service.ts`, `session.repository.ts`, `auth.errors.ts`, `dto/auth.dto.ts`, `auth.module.ts`, `users.service.ts` | `remediation.admin.int-spec.ts`; `security.api`/`qa.inventory` exception lists |
| Distributed rate limiting + production warnings | `src/infrastructure/cache/redis-throttler.storage.ts`, `src/app.module.ts`, `src/config/env.validation.ts`, `app-config.service.ts`, `.env.example` | `remediation.throttle.int-spec.ts`, `env.validation.spec.ts` |
| KYC file-signature check | `src/modules/verification/document-signature.ts`, `verification.service.ts`, `src/integrations/storage/*` | `document-signature.spec.ts`, `verification.api.int-spec.ts` |
| Notification health and retry | `src/modules/notifications/*`, `src/common/outbox/outbox.service.ts` | `remediation.notifications.int-spec.ts` |
| FK covering indexes | `prisma/schema.prisma`, `prisma/migrations/20261014090000_fk_covering_indexes/` | migration reproducibility run |

Severity: item 1 and item 9 are the critical/high fixes (no production admin path; unchecked upload content). Items 2, 7, 14 high/medium. Item 16 low.

**Fixed but not fully verified**: S3 `readObjectHead` (ranged GET) is unit-reasoned and type-checked only; no real bucket exists to run it against. Redis throttler was proven against the local Redis, not a cluster/managed Redis.

## 6. Verification actually run (local; this is not GitHub CI)

See `docs/testing/remediation/README.md` for the recorded outputs. Summary:

| Check | Result |
|---|---|
| `npm run typecheck`, `npm run lint`, `npm run format:check` | exit 0 |
| `prisma validate`; `prisma migrate deploy` on a fresh empty database (8 migrations); `prisma migrate diff` migrations vs schema | valid; all applied; no difference |
| Unit tests | see test record |
| e2e | see test record |
| Integration on a fresh `_ci` database | see test record |
| Real CLI bootstrap (production env) on a disposable database | refused without confirmation; created with confirmation; repeat refused; seed with credentials in production refused; 1 user, scrypt hash, no password or email in any audit row |
| Real HTTP smoke against `node dist/main` with `NODE_ENV=production`, providers disabled | health live/ready 200; admin login 200; dashboard 200; wrong current password 422; change 200 revoking 1 other session; other session 401; old password 401; new password 200; OTP request 503 (SMS disabled); unauthenticated admin 401; password not present in API log |
| Docker production image | see test record |

## 7. Migration impact

One additive migration, `20261014090000_fk_covering_indexes` (five `CREATE INDEX`). Deploy: normal `prisma migrate deploy`; brief write locks on `bookings`, `payment_events`, `notifications` while indexes build (small tables at launch; for large tables create concurrently by hand first). Rollback: `DROP INDEX` the five names; no data touched, no application code depends on them. No existing migration was edited.

## 8. Remaining by category

* **Business decision**: Q-55 booking model; Q-70/Q-62 permission matrix; Q-66 reset/MFA/bootstrap approval; Q-69 KYC scan/retention; Q-17/Q-21 refunds and fees; Q-65 missing-feature scope; Q-02/Q-63 retention.
* **External provider / credential**: payment, SMS (and sender registration), push, WhatsApp; real private bucket.
* **Infrastructure**: reverse proxy/TLS and `TRUST_PROXY_HOPS`; Redis topology and `THROTTLE_STORAGE`; backups/restore; monitoring and alerting; GitHub Actions run; SLOs.
* **Confirmed code gaps**: shortlist, customer worker-profile view, worker photo, worker earnings view, report/block, receipts/exports, verification re-check scheduler/producer, audit-log offset pagination cost (P-1), 503 logged as ERROR (S-13).
* **Not verifiable here**: anything needing a real vendor, bucket, managed database, proxy or load.


---

# Phase 2 - remaining gap closure (2026-10-09)

Continues the section above. Still nothing committed, pushed, staged, reset or cleaned; the remote Supabase database in `.env` was never contacted (every run passed an explicit local `DATABASE_URL`).

## P2.1 Candidate gaps verified against the specs

Evidence: SRS 3.4 (FR-WD-001..007), FR-WON-002, FR-WJ-008, FR-SUP report/block, FR-VER-010; FRD FM-03, FM-04, FM-08, FM-12, section 5 (status model) and section 6 (notification matrix).

| # | Candidate | Finding | Class | Action |
|---|---|---|---|---|
| 1 | Customer-safe worker profile | Spec: customer opens a worker profile (FRD FM-03 step 6, FR-WD-007 no identity data). Only list cards existed | CONFIRMED_MISSING | **Built** `GET /search/workers/{workerId}` |
| 2 | Shortlist / favourites | FR-WD-005 Must; no table or route | CONFIRMED_MISSING | **Built** `/shortlist` |
| 3 | Worker profile photo | FR-WON-002 Must, FRD field "Profile photo, Yes, size limit applies"; only a `profile_photo_ref` column and `hasProfilePhoto` existed | CONFIRMED_MISSING | **Built** `/workers/me/photo*` |
| 3b | Photo and rating on cards | FR-WD-001/003 | PARTIALLY_IMPLEMENTED | **Added** rating aggregate and photo link to cards |
| 4 | Worker earnings / payments | FR-WJ-008 says "earnings/payment reference where applicable". The platform records only the customer booking fee; there is no wage, price or payout data and no definition of the reference | BUSINESS_DECISION_REQUIRED | Not built (Q-73); nothing derived or invented |
| 5 | Report / block | FR-SUP-006 / FM-12 "Report/Block is available to customers and workers"; effect, symmetry, review and abuse limits are not defined | BUSINESS_DECISION_REQUIRED | Not built (Q-74) |
| 6 | Verification expiry + scheduled re-check | Rule is explicit (FRD s5: "Recheck Due: expiry/recheck date reached"). Searchability already excludes a check once its date is reached (single SQL definition) and tests existed; the "Recheck due" notification had no producer | PARTIALLY_IMPLEMENTED | **Built** reminder loop; **added** regression tests; expiry exclusion unchanged |
| 7 | Customer verification lifecycle | PENDING/VERIFIED, admin-controlled, audited (D-19). Further states undefined (Q-26) | ALREADY_IMPLEMENTED / BD for more | No change |
| 8 | Booking cancel / refund / replacement edges | State matrix 297/297, concurrency, late payment success after cancel (money kept and flagged), duplicate refunds, replacement races all covered by existing suites; fees and refund authority undefined | ALREADY_IMPLEMENTED / BD | No change; re-run in full suite |
| 9 | Support reopen / assignment / escalation / privacy | assignment, escalation, privacy implemented and tested; reopen/SLA/attachments undefined (Q-59) | ALREADY_IMPLEMENTED / BD | No change |
| 10 | Reports | 13 endpoints, READ ONLY transactions, bounded ranges, permission-guarded, definitions returned; FRD definitions PROPOSED | ALREADY_IMPLEMENTED | No change |
| 11 | Failed outbox events | **Defect found:** the dispatcher handled 50 events in ONE transaction, so one poison event (malformed payload) rolled back the batch every 5 s forever and blocked every event behind it, invisibly | CONFIRMED_DEFECT | **Fixed** (below) |
| 12 | Production-safe configuration | (a) global throttle silently defaulted to per-process memory in production; (b) `scripts/seed-demo` loads `.env` and would write demo accounts to whatever `DATABASE_URL` says, i.e. the remote database | CONFIRMED_DEFECT (config) | **Fixed** (below) |

## P2.2 What was built

* **Worker photo** (`src/modules/worker-photo`, shared `src/integrations/storage/storage.module.ts`): request a short-lived upload link (JPEG/PNG, size cap from `PROFILE_PHOTO_MAX_BYTES`), upload, confirm. Confirm checks the real size and the file signature server-side, writes an audit row, serialises per worker with an advisory lock, and sets the current-photo reference. Randomised keys `photos/<workerId>/<uuid>`. 503 `PHOTO_NOT_CONFIGURED` while the size limit is unset (feature is off by default; the business owns the number). At most 5 unconfirmed uploads per worker (technical guard). **No malware scanning exists and none is claimed.**
* **Profile and cards** (`src/modules/search`): one visibility definition (active worker, submitted, fully verified incl. re-check date); unknown, draft, unverified, suspended and re-check-due workers answer 404 identically. Cards and profile add `rating` (average, count; no reviewer, no text) and `photo` (signed link) in two batched look-ups.
* **Shortlist** (`src/modules/shortlist`): owned by the token's customer, never by a request id; only visible workers can be added (identical 404 otherwise); idempotent add/remove; per-customer advisory lock; 100-entry cap as a technical guard (Q-72); entries whose worker is no longer visible stay listed as `available:false` with no worker data.
* **Outbox recovery**: one event per transaction; failure recorded outside the rolled-back transaction with exponential backoff; dead-lettered after 5 attempts; `deadLettered` count in `/admin/notifications/health`; `POST /admin/outbox-events/{id}/retry` (`notification.manage`, audited, 409 unless dead-lettered).
* **Re-check reminder** (`verification.worker.ts`, in the worker process): `RECHECK_DUE` to the worker once per due date (`recheck_notified_for`), `FOR UPDATE SKIP LOCKED`, never changes a check.
* **Config**: production `THROTTLE_STORAGE` defaults to `redis`; explicit `memory` is allowed with a warning; `seed-demo` refuses a non-local database.

## P2.3 Step 4 review of Phase 1 security items

| Item | Result | Evidence |
|---|---|---|
| Bootstrap cannot repeat or race | Holds | advisory-lock transaction; 6 concurrent attempts create nobody; real CLI run |
| No silent demo credentials in production | Holds: no default password exists anywhere; seed refuses production; production image contains no scripts; demo seed now refuses non-local DB | `seed` run in production refused; guard check |
| Password change invalidates other sessions | Holds (current session kept by design) | `remediation.admin.int-spec` |
| Rate limiting across replicas | Holds with `redis`; now the production default | `remediation.throttle.int-spec`, env spec |
| Missing Redis cannot weaken security | OTP requests and admin login FAIL CLOSED (5xx, no SMS, no token) when Redis is unreachable; the global throttle degrades to per-process counting and logs | `remediation2.operations.int-spec` |
| Admin permissions follow an approved matrix | **Not approved** -> stays blocked (Q-70). Decision needed: approve, amend or replace the proposal in section 4 (the open points are `payment.refund`, `verification.decide` for Operations Admin and the Verification Executive, and whether Support Executive may see payments) | unchanged seed |
| KYC private and audited | Holds: private bucket boundary, signed links issued only after permission checks and audited before returning, signature check on confirm | `verification.api`, `qa.access` |
| No secrets or document data in logs | Holds: logger serialises only id, method, path (no query, headers or bodies) and redacts configured paths; audit redaction by key and value; password and tokens verified absent from the production API log in the smoke run | smoke run, `audit.service.spec` |

## P2.4 Migrations (all additive, none edited, none destructive)

| Migration | Change | Rollback |
|---|---|---|
| `20261015090000_outbox_dead_letter` | 4 nullable/default columns + 1 index on `outbox_events` | drop index and columns |
| `20261016090000_recheck_due_reminder` | 1 nullable column on `worker_verification_checks` | drop column |
| `20261017090000_worker_photo_shortlist` | enum `PhotoStatus`; tables `worker_profile_photos`, `customer_shortlist_items` (+ indexes, Restrict FKs) | drop the two tables and the enum |

Applied to empty disposable databases; `prisma migrate diff` migrations-vs-schema reports no difference.

## P2.5 Negative-path tests added and verification results

New integration tests: `test/integration/remediation2.discovery.int-spec.ts` (15: profile 4, shortlist 7, photo 4) and `remediation2.operations.int-spec.ts` (5: poison outbox, retry authorization, re-check reminder, Redis-down OTP, Redis-down admin login). Existing contract tests were updated for the new card fields, query count (6 -> 8 statements, still constant) and the module dependency map. `file-signature.ts` moved to `src/integrations/storage/` (shared by KYC and photos).

| Check (local, final tree) | Result |
|---|---|
| `npm run typecheck`, `npm run lint`, `npm run format:check`, `npm run build` | exit 0 |
| `prisma validate`; 11 migrations applied to an empty database; `prisma migrate diff` | valid; applied; no difference |
| `npm test` | 20 suites, 194 tests passed |
| `npm run test:e2e` | 2 suites, 27 tests passed |
| `npm run test:integration`, clean fresh database, nothing else running | **33 of 34 suites, 629 of 630 tests passed**; the one failure (`matching.api` "needs the matching.run permission", a 30 s timeout) is a transient stall unrelated to the change: the same file passes alone (11/11, 10 s) |
| Docker production image build; API + worker containers (production env) | built; `/health/ready` 200; unauthenticated shortlist, photo, profile -> 401; worker process up with no errors; missing `JWT_ACCESS_SECRET` aborts start-up with a clear message; no config warnings (Redis throttle is the production default) |

Honest caveat on stability: earlier full runs in this phase stalled (suite hooks timing out at 30-280 s, one suite taking about an hour) while other jest processes of mine were still running against the same Redis and database, and once with no other test running. Targeted reruns of every stalled suite passed, and the clean run above had a single transient timeout. The cause was not isolated; treat the integration suite as needing a quiet machine, and CI (fresh service containers) as the real judge. No GitHub Actions run occurred.

Not run / blocked: GitHub Actions; any real provider, bucket (including the S3 ranged read used for the signature check), proxy/TLS, load, backup restore; shortlist 100-entry cap (would need 100 workers, covered by code review only).

## P2.6 What still prevents release

See `docs/qa/OPEN_BLOCKERS.md` section 6 (14 items, each with requirement, current evidence, risk and the needed action). In short: vendors and credentials (payment, SMS, push, WhatsApp, real bucket), five client decisions (booking model, permission matrix, earnings, report/block, KYC scan/retention), and infrastructure proof. Production readiness has improved (admin bootstrap, discovery features, KYC/photo content checks, outbox recovery, safer defaults) but the verdict remains NOT READY.
