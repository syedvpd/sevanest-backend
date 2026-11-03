# 03 — Negative test report

## Batch 1 — Platform foundation (auth, users, guards, validation, error handling)

Status: **VERIFIED WITH LIMITATIONS**. Method: code read plus mapping of existing tests, plus one new runtime probe. No new test file was added: the existing suites already cover almost every negative case in the brief.

### Existing coverage found (test names read from `test/integration`)

| Area | Suite | Covered |
|---|---|---|
| OTP | `auth.api` | cooldown, per-mobile and per-IP limits, attempt lockout, parallel-guess limit, single use, expiry, suspended and wrong-app accounts answered like unknown numbers (DEC-15), SMS provider failure gives 503 `SMS_NOT_CONFIGURED` / `SMS_DELIVERY_FAILED`, stored as keyed hash with TTL |
| Tokens | `auth.api`, `qa.adversarial` | tampered, expired, unsigned, re-algorithmed tokens; refresh-as-access; rotation; replay = theft with revoke and audit; parallel refresh has one winner |
| Admin login | `auth.api`, `qa.adversarial` | same answer for unknown email and wrong password, lockout per account and per IP, parallel failures counted atomically, suspended admin revealed only after correct password |
| Authorization | `security.api` | every route: anonymous 401, forged token 401, wrong user type 403, no permission 403, partial permission 403, suspended admin 403; public list and "any signed-in user" list are asserted |
| Users/RBAC | `users.api` | duplicate email 409, parallel create makes one account, mass assignment ignored, self-status change refused, parallel suspensions make one audit record, role change applies on next request |
| Validation / errors | `qa.adversarial`, `qa.robustness`, `security.api` | malformed ids 400, SQL/traversal/null-byte input is data, prototype-pollution keys, oversized fields and bodies, no stack/SQL/path in errors, standard envelope with request id |

All of these passed on an isolated database (see AUDIT_PROGRESS for the run history).

### New runtime probe (this audit)

Script ran `PrismaClient` + `PrismaPg` against (a) a closed port, (b) a wrong password, (c) a 100 ms `query_timeout` with `pg_sleep(2)`, on the local test db only.

| Case | Error that reaches the exception filter |
|---|---|
| Database unreachable | `PrismaClientKnownRequestError`, code `P2010` |
| Bad credentials | `PrismaClientKnownRequestError`, code `P2010` (pg code `28P01`) |
| Query exceeds `query_timeout` | plain `Error: Query read timeout` |

`AllExceptionsFilter.mapPrismaError` handles only P2002, P2003, P2025. All three cases above fall through to **500 `INTERNAL_ERROR`**, and each is reported to Sentry as an unhandled exception. See finding F-004.

### Gaps and limitations

- `forbidNonWhitelisted` is off: unknown JSON fields are silently dropped, never rejected. A client typo is invisible. Contract choice; changing it would break lenient clients. Not a defect.
- Not exercised at runtime in this batch: Redis down during `otp/request` and `token/refresh`; PostgreSQL pool exhaustion; behaviour after the DB comes back. Needs a dedicated, isolated infra to stop, so deferred to Phase 7.
- The 20 "any signed-in user" routes are asserted as a reviewed list by `security.api`, but per-route ownership logic (for example `DELETE /auth/sessions/:sessionId`, `/me/deletion-request`) is covered only where a test names it. Sessions have an explicit cross-user test; the rest are queued for their own batches.
- `foundation.int-spec` was not run with a valid test environment.

## Batch 2 — Customer and worker profiles (customers, workers, addresses, categories association, availability)

Status: **VERIFIED WITH LIMITATIONS**. Method: route/test mapping, DTO limit scan, one runtime probe.

### Existing coverage found

| Suite | Covered |
|---|---|
| `customers.api` | 404 before profile, one profile under parallel create (409), mass assignment ignored, cross-customer isolation, IDOR on address ids (404 for every operation), exactly one default address under racing creates and default changes, soft delete, DB constraints, admin list/detail/notes with masked mobile, per-capability permissions |
| `workers.api` | one profile under parallel create, step-wise onboarding, parallel language/role replacement (one winner, no merged set), no lost update across steps, category role rules (unknown 400, disabled 422, kept if disabled later), PROFILE_INCOMPLETE 422, no KYC fields in responses, assisted onboarding audited with admin as actor |
| `availability.api` | area CRUD with case-insensitive unique name per city, parallel create, atomic multi-part save, overlap/inverted windows refused by the DB, parallel window and area saves consistent, one submit under parallel repeats, suspended worker blocked |
| `qa.access`, `worker.app.blockers` | cross-worker 404s, forged tokens, role confusion |

### Static checks

- Every array DTO in customers, workers and availability has `ArrayMaxSize` (windows 50, areas 24, languages/roles 20, references capped). No unbounded array input found.

### Runtime probe

- **F-005 (P3, design weakness, confirmed):** 120 `POST /customers/me/addresses` all returned 201 and `GET /customers/me/addresses` returned all 120 in one unpaginated response. No per-customer cap. Each create without coordinates also triggers one geocode call to the maps provider. Production throttle (`render.yaml`: 120 requests / 60 s) limits the rate, not the total. Fixing it needs a business decision on the cap (and a 422 code), so it is not changed. Probe spec deleted after the run to avoid pinning unbounded behaviour; the result is recorded here.

### Gaps and limitations

- Profile photo upload (`customer-photo`, `worker-photo`) and public image URLs are not in this batch's tests; they belong to the image pipeline review.
- No concurrent-load or query-plan check yet (Phase 4/5). `findMany` without `take` on `listAllAddresses` is the same pattern as F-002.
- Worker search eligibility (activated + verified + available) is Batch 3.

## Batch 3 — Discovery (service categories, search, matching, shortlist, worker detail)

Status: **VERIFIED WITH LIMITATIONS**. Method: code read, existing-test mapping (`search.api`, `matching.api`, `categories.api`, `categories.six`, `remediation2.discovery`), local `EXPLAIN ANALYZE`, one runtime probe.

### Findings from reading and running

- Six PRD categories: a fresh migrated database booted once has **6** `service_categories` rows (`category-seed.service.ts`, `categories.six.int-spec`). Seeding is idempotent per the existing test.
- Search is one parameterised SQL statement with `count(*) OVER ()` for the total; hydration is 4 batched queries; no per-row queries (constant statement count is asserted in `search.api`). Eligibility reuses Verification's own SQL fragment (`activeWorkerCondition`), so "verified" cannot drift. Blacklist (DEC-06) and customer blocks in both directions are applied. Category and area must be enabled (`requireEnabledByCode`, `requireEnabled`).
- **Probe:** `page` values up to `9007199254740993` with `limit=100` on six admin list routes (users, customers, workers, audit-logs, support tickets, bookings) all answered 200 with an empty page; no 500. Probe spec deleted after the run.

### Query plan (local, synthetic data, not production)

Database `sevanest_bqa3_ci`: 100,000 users, 20,000 submitted workers (all set activated and signed off after the seed), 60,000 bookings, ANALYZE run. Existing script `scripts/load/explain-search.cjs`, scenario `timeWindow` (category + area + engagement + time window + language, page 1, 20 rows):

| Metric | Value |
|---|---|
| Candidates after skill+area join | 1,334 |
| Eligible after all filters | 1,206 |
| Execution time | **34.5 ms** |
| Planning time | **40.5 ms** |
| Access paths | `worker_skills_category_id_idx` and `worker_preferred_areas_area_id_idx` bitmap scans, hash joins, primary-key lookups; no seq scan on `worker_profiles` once workers are activated |

Reading: execution is well inside the 300 ms stretch target. Planning time is as large as execution time (complex statement, raw SQL is planned on every call). It is a small fixed cost, not a defect; no index was added.

Before activation was set, the same script returned 0 rows and planned a `Seq Scan on worker_profiles aw` for the activation check (20,000 rows removed by filter). With real data activation is common, so the seq scan disappears; if activation is rare (early launch, few active workers) the check is a scan of a small table. No index recommended without evidence on production-like activation ratios.

### New finding

- **F-006 (P3, tooling, confirmed):** `scripts/load/seed.sql` does not set `activated_at` / `verification_signed_off_at`, so on the current schema every seeded worker is invisible to search and the load/EXPLAIN scripts measure an empty result. The older numbers in `docs/qa/PERFORMANCE_REVIEW.md` (for example 7.6 ms search) predate the activation gate and are not comparable. The local `sevanest_qa_perf*` databases are on 7 of 44 migrations and cannot run the current search SQL (`wp.blacklisted_at does not exist`).

### Gaps and limitations

- Matching ranking and shortlist limits were read only through their existing tests; no new negative probes were run.
- No HTTP latency percentiles for search yet (Phase 5).
- Behaviour with stale/missing worker data (for example a worker with no rating summary) relies on `NULLS LAST` ordering; confirmed in SQL, not exercised at runtime.

## Batch 4 — Trust and verification (KYC documents, review, approval, storage)

Status: **VERIFIED WITH LIMITATIONS**. Method: code read of `verification.service.ts` (upload, confirm, link, reject/discard paths), route/permission table from `endpoint-inventory.csv`, mapping of `verification.api`, `verification.decisions`, `verification.assignment`, `kyc.integrity`. No new probe was needed: no gap found that an existing test does not already pin.

### Controls confirmed in code and in existing tests

| Control | Where | Test |
|---|---|---|
| Content type allow-list, size cap, `sizeBytes` 1..2^31-1 | `requestDocumentUpload`, DTO | `verification.api` |
| Unguessable key `kyc/<workerId>/<uuid>`, no personal data | `requestDocumentUpload` | `verification.api` ("without revealing any storage path") |
| Storage failure writes nothing (key created before any row) | same | `verification.api` (503 and nothing written) |
| Max 10 open documents per check | `MAX_OPEN_DOCUMENTS_PER_CHECK` | `verification.api` |
| Signed PUT cannot cap size, so confirm enforces exact declared size, real bytes match declared type (magic bytes), optional malware scan fails closed (503, never accepted unscanned) | `confirmDocument` | `kyc.integrity` |
| Rejected or oversized object deleted; failed delete leaves it for the sweeper; a rejected slot cannot be revived | `rejectUpload`, `purgeAbandonedUploads` | `kyc.integrity` |
| Another worker's document answers 404 exactly like an unknown id | `confirmDocument` | `verification.api` |
| SHA-256 recorded at confirm and re-checked before every admin link; mismatch refuses and audits | `documentLink` | `kyc.integrity` |
| Link needs `verification.document.view`; the view is audited BEFORE the link is returned; storage failure returns no link and writes no audit row | `documentLink` | `verification.api`, `verification.assignment` |
| State machine SUBMITTED, IN_REVIEW, APPROVED/REJECTED, everything else 409 | repository + service | `verification.api` ("every other move is 409") |
| Parallel decisions: one winner; parallel claims: one winner; parallel submits: one | row lock `lockCheck` | `verification.api`, `verification.assignment` |
| Only the claiming reviewer or a supervisor decides; reassign only to eligible reviewer; idle claim released after 30 min | service | `verification.decisions` |
| Verified requires every required check APPROVED and not past re-check; fails closed when no check is required | `verifiedWorkerCondition` | `verification.api` |
| Sign-off and activation are separate steps and permissions; verified, signed off, active are all needed for matching | service | `verification.decisions` |
| Audit log: no remarks or storage keys; append-only | audit service, DB trigger | `verification.api`, `foundation` |
| Disqualifying rejection codes are final | policy | `verification.decisions` |
| Public bucket (`pub/` prefix, separate bucket) never receives KYC or customer photos; env validation requires both public-bucket settings or neither | `public-media.storage.ts`, `env.validation.ts` | read in code; no test named |

### Route permissions (from the live route dump)

Worker routes: user type WORKER only. Admin routes: queue and requirements `verification.review`; decide, recheck `verification.decide`; reassign `verification.reassign`; document link `verification.document.view`; configure `verification.configure`; sign-off `verification.signoff`. No verification route lacks a gate.

### Limitations and residual risks (not defects)

- **Real S3/Supabase storage not exercised.** All integration runs use the in-memory provider. Signed PUT/GET behaviour, the object-size check against real `HeadObject`, and the private/public bucket policy are NOT VERIFIED here and need a staging bucket test by an authorised operator.
- **Oversized upload exists until confirm or sweep.** Because a signed PUT cannot limit size, an attacker-controlled worker account can upload a large object to its signed URL; it is removed at confirm or by the abandoned-upload sweeper. Exposure is bounded by 10 open documents per check and the signed-URL lifetime. The sweeper's loop (`abandoned-uploads`) must run (worker process), which readiness already reports.
- **Link issuance cost:** each admin link reads the whole stored file to verify the hash (bounded by `VERIFICATION_DOCUMENT_MAX_BYTES`). Fine at current limits; it makes link latency proportional to file size.
- Any admin holding `verification.document.view` can open any worker's document; there is no per-reviewer assignment restriction on viewing. Every view is audited. Whether viewing should require claiming the case is a business decision.
- Malware scanning is optional (`scanner.enabled`); whether it is enabled in staging/production was not checked.

## Batches 5 to 10 — method note

Batches 5 to 9 were audited by reading the services and mapping every route group to the existing integration suites by test name, then probing the gaps that the maps exposed (CSV export, OpenAPI contract, outage behaviour, name-search plan). **No new per-endpoint negative test suite was written** for these batches: the repository already holds 71 integration suites with adversarial, state-machine, concurrency and access matrices, and all of them pass (see 11). The evidence is therefore "existing test passes and covers it", plus the fresh probes listed. Where the suites do not reach (real providers), the batch says so.

## Batch 5 — Booking lifecycle (bookings, interviews/trials, cancellation, rescheduling, history)

Status: **VERIFIED WITH LIMITATIONS.** 8 customer booking routes, 8 interview routes and 6 admin booking routes in the live dump (43 in the static decorator count, which includes sub-routes of other controllers).

| Control | Test |
|---|---|
| State model for **every state, action and actor** (297 combinations) behaves as the FRD says | `qa.statemachine` |
| One transition wins when every party tries at once; two conflicting transitions leave one consistent state | `qa.statemachine` |
| Idempotency: same key and same request answers once, same key with a different request is refused, parallel keyed requests create one booking | `booking.api` |
| One open booking per worker and service; allowed again after cancel | `booking.api` |
| Eligibility is re-checked at confirm (a worker who stopped being verified cannot be confirmed) | `booking.api`, `qa.concurrency` |
| 403 (never allowed for you) vs 409 (not now) vs 404 (not yours) | `booking.api`, `qa.access` |
| Double booking: overlapping times refused, adjacent allowed, other day or worker allowed, only one of two customers can confirm the same worker for overlapping times, travel buffer applied in booking and search, unpaid holds keep the worker until paid or expired | `scheduling`, `scheduling.buffer` |
| Cancellation racing payment, replacement withdrawal, staff decision | `qa.concurrency` |
| Timeline append-only, impossible states refused by the database | `booking.api` |
| Interview/trial create, reschedule, slot proposal, cancel, complete | `interview.int-spec`, `scheduling` |

Probe results: the journeys ran 40 `POST /interviews`, 20 `POST /bookings` and 10 admin booking actions without a 5xx. Statement counts 26 to 33 for the write paths (04). Gap: slot-proposal and replacement-select answered 409 in the performance harness because it does not build the precondition; those paths are covered functionally only.

## Batch 6 — Money and attendance (payments, webhooks, refunds, reconciliation, attendance)

Status: **VERIFIED WITH LIMITATIONS** (fake gateway only).

| Control | Test |
|---|---|
| Amount and currency come from the fee configuration, never the client; FEE_NOT_CONFIGURED 422 until set | `payment.api` |
| Owner-only payment; one open payment per booking; resume instead of duplicate, also in parallel | `payment.api` |
| Gateway outage gives 503, payment kept, next call opens the order | `payment.api` |
| A client "verify" cannot mark success: it needs gateway evidence; forged or unknown report changes nothing | `payment.api`, `payments.recovery` ("not fooled by a pending or unconfirmed payment") |
| Webhook: unsigned, wrongly signed, tampered refused; authentic applied once; duplicate and parallel duplicates acknowledged without re-applying; wrong amount refused with a mismatch exception; unknown order and malformed signed body acknowledged with no side effect; success never moves a finished payment backwards; late success on a failed one accepted | `payment.api` |
| Late success for a cancelled booking is a financial exception, not an ordinary payment; duplicate charge flagged | `payments.recovery` |
| Refund: full, audited, repeatable; auto refund on cancel once; gateway refusal goes to the exception queue and the customer is told; pending refund never called complete; lost response adopted rather than duplicated; crash recovery; stuck refund escalated | `payment.api`, `payments.recovery` |
| Gateway outage in recovery: bounded backoff then escalation, without consuming the budget on a provider outage | `payments.recovery` |
| Competing workers process a payment once; crashed claim recovered | `payments.recovery` |
| Webhook cannot be called with a user session | `payment.api` |
| Attendance: one entry per day, repeat safe, history append-only, correction with reason, worker's own active booking only, exceptions need a note, parallel same-day submit records one | `attendance.api` |

Fresh probes: the payment CSV export is capped at 5,000 rows and 366 days and is audited; negative numbers fixed (F-007). Amounts are integers in minor units (`amountMinor`), not floats. **Not verified:** real Razorpay signatures, refunds and timing; attendance across midnight beyond the India-date helper (`indiaToday`) the code uses.

## Batch 7 — Engagement management (replacement, ratings, support)

Status: **VERIFIED WITH LIMITATIONS.**

| Area | Controls and tests |
|---|---|
| Replacement | one open request per booking even when asked many times at once; fixed reason codes; old booking closed as REPLACED, new booking created, repeats safe, a different worker refused afterwards; one of many parallel selections wins; approval first; alternatives never include the replaced worker; withdraw returns the booking to ACTIVE; cancelling the booking closes the request (`replacement.api`, `qa.concurrency`) |
| Ratings | only after the engagement is completed; worker comes from the booking; one per booking even when sent many times at once; no edit or delete (Q-60); totals equal the visible ratings under parallel moderation; customer identity hidden from the worker (`ratings.api`) |
| Support | creator sees only own tickets, never staff notes or identities; a ticket may point only at a booking the creator is party to; lifecycle OPEN, IN_PROGRESS, ESCALATED, CLOSED with history; assign only to an active admin with manage permission; one close wins under concurrency; history append-only (`support.api`) |

Gap: review moderation is hide/restore only; there is no text screening feature in the code.

## Batch 8 — Admin, dashboard, reports, exports, platform configuration

Status: **VERIFIED WITH LIMITATIONS.**

| Control | Evidence |
|---|---|
| Every `/admin` route has a permission or role (two reviewed exceptions) | `security.api` and the route dump |
| Dashboard shows only the sections the caller may see | `dashboard.controller.ts`; `admin.api`, `admin.session.permissions` |
| Reports need `report.view`; reversed, malformed and over-long ranges rejected; empty period gives zeros and null rates; GET only; one READ ONLY transaction per report; definitions match the tables; no row changes after running all reports | `reports.api`, `qa.reports` |
| Exports: 5,000-row cap with 413, formula-safe cells, audited | code, `csv.spec.ts`, payment export test |
| Platform configuration and fee changes: permission, validation, before/after audit | `platform.config.int-spec`, `payment.api` |
| Concurrent admin edits: If-Match / ETag (428 `PRECONDITION_REQUIRED`, stale-version conflict) | `admin.concurrency` |
| Audit log: Super Admin only, keyset pagination without gaps, malformed cursor refused | `ops.hardening` |

Probes: all measured admin lists answered 200 for pages up to 9007199254740993; report latencies in 05. Large-range reports on big data not measured.

## Batch 9 — Async and integrations (notifications, queue, storage, SMS, FCM, maps)

Status: **VERIFIED WITH LIMITATIONS** (details in 06, Phase 8). Outbox consistency, retry and dead-letter policy, idempotent delivery, provider-outage mapping (SMS 503 codes, storage 503, gateway 503), permanent vs transient failures and recovery of stale or crashed work are asserted by `notifications.api`, `kyc.integrity`, `payments.recovery`, `auth.api`, `email.channel` and `maps.int-spec`. Real providers: not exercised.

## Batch 10 — Full-system regression

- Full integration suite (71 suites, 1,077 tests): 1,040 pass in one run; the other 37 pass in isolated reruns (see 11).
- Cross-module journeys: `qa.journeys`, `modules.journey`, `customer.*`, `worker.app.blockers` pass.
- Concurrency: `qa.concurrency`, `qa.statemachine`, `admin.concurrency` pass.
- Dependency failures: PostgreSQL and Redis stopped and restarted against the real app (06).
- Security regression: `security.api`, `qa.access`, `qa.adversarial` pass.
- Performance regression: baseline recorded in 05. No earlier comparable baseline exists for the current schema (F-006), so no before/after delta is claimed.
