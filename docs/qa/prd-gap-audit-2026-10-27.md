| NOT_APPLICABLE_TO_BACKEND (reason in each row) | 5 || BLOCKED (decision or external dependency named in section 5) | 12 || NOT_IMPLEMENTED | 0 || PARTIALLY_IMPLEMENTED | 15 || IMPLEMENTED_UNVERIFIED | 11 || IMPLEMENTED_AND_VERIFIED (local, fake providers) | 133 |# PRD-wide backend gap audit (negative-first), 2026-10-27

Source of truth: `docs/project-specifications/SevaNest_PRD.pdf` as supplied in the audit request (23 sections, Appendix A). Repository: `main`, started at `eecec52`; the other session committed `e45dc5f` and `9246c66` during the audit (see section 1). Everything below is **local verification** on disposable databases with fake providers. Nothing here proves staging or production behaviour, a real provider, or a mobile/web client.

Statuses (strict): `IMPLEMENTED_AND_VERIFIED` (code present, wired, and a runtime test in this repository passed in this audit), `IMPLEMENTED_UNVERIFIED` (code present, no runtime proof possible locally), `PARTIALLY_IMPLEMENTED`, `NOT_IMPLEMENTED`, `BLOCKED` (exact decision or dependency named), `NOT_APPLICABLE_TO_BACKEND` (reason given).

## 1. Starting state and preservation

* Branch `main`, HEAD `eecec52`. Working tree at the start already held someone else's uncommitted work: `docs/audit/FIX_REPORT.md` deleted; `src/modules/service-categories/*` (opt-in engagement seed, `engagements` response alias), `src/seed.ts`, `src/modules/verification/README.md`, untracked `category-seed.service.spec.ts`, `categories.six.int-spec.ts`, `.agents/`, `skills-lock.json`. A second Claude session (`SevaNest customer app a`) was editing the same tree during this audit. None of that was reverted or restaged. That session has since committed its category work (`e45dc5f`, `9246c66`). I messaged it about the one conflict (F-4).
* Not committed, pushed, merged or deployed. No migration was run against the remote database (`.env` points at a remote Supabase database; every database command used a local disposable database `sevanest_audit_ci` / `sevanest_audit2_ci` on the Docker PostgreSQL).

## 2. Findings of this audit (things that were wrong)

| # | Finding | Root cause | Status |
|---|---|---|---|
| F-1 | Error responses of the two CSV exports (`GET /admin/payments-export`, `GET /admin/reports/export/{report}`) were sent with `Content-Type: text/csv` and `Content-Disposition: attachment`; the public `GET /app-config` and `/reference-data` errors carried `Cache-Control: public, max-age=60`. A client expecting the standard error envelope got a CSV download or a cacheable error. | NestJS `@Header()` values are applied before the handler runs, so a thrown error inherits them; `AllExceptionsFilter` only wrote the body. | **Fixed** in `src/common/errors/all-exceptions.filter.ts` (an error is always `application/json`, `no-store`, never an attachment). Unit test added; new all-routes sweep proves it. |
| F-2 | `users.api.int-spec.ts` (D-71 least-privilege test) failed on HEAD. | D-90 added the `VERIFICATION_SUPERVISOR` role; the test's role list was not updated. | **Fixed** (test only). |
| F-3 | `categories.six.int-spec.ts` failed: compared engagements in alphabetical order, the API returns them in its canonical order. | Test assumption. | Found in the baseline; the file belongs to the other session, which has committed it. See the verification run for its current result. |
| F-4 | `worker.app.blockers.int-spec.ts:394` failed: it expected the exact category keys without `engagements`. | The other session's uncommitted `engagements` alias changed the response shape. | **Resolved by that session** (commits `e45dc5f`, `9246c66`). Not touched by this audit. |
| F-5 | No route-level negative coverage existed for malformed ids, unusable bodies and abusive paging across all callers. | Gap in test strategy, not in a handler. | **Added** `test/integration/qa.robustness.int-spec.ts`: every published route x unknown id / malformed id / `%00` / empty / unknown-field / array / string body / `page=0&limit=100000` / `limit=abc` x admin, customer (no profile), worker (no profile), anonymous. Result after F-1: 0 responses of 5xx, every 4xx in the standard envelope and JSON, no list over the page cap. |

| F-6 | `ops.hardening` access-denied flush tests failed when the shared Redis held other entries. | `flushSuppressed` handled only the oldest 200 due entries per call and one unwritable entry (actor missing) aborted the whole run, dropping the rest. Real in production too: a poisoned or very large backlog starved newer counts. | **Fixed** in `src/common/audit/security-events.service.ts`: batches until nothing is due, one failing entry is logged and skipped. |
| F-7 | `qa.journeys` and `verification.decisions` failed on HEAD. | `qa.journeys` still asserted that a worker card shows no name (cards now show the display name, D-91); `verification.decisions` crashed on outbox rows without a payload left by other suites. | **Fixed** (tests only). |
| F-8 | Values the apps receive were fixed in code or the environment, so changing them needed a deployment: the rating tag catalogue (nine tags in `common/rating/rating-tags.ts`) and every `GET /app-config` value (update policy, maintenance, support contact, policy text). | Design: constants and environment variables. | **Fixed**: new `platform-config` module, tables `app_settings` and `rating_tags` (migration `20261112090000`), admin APIs under `config.manage`; see section 3a. |
| F-9 | `docker compose --profile app up` loaded fake people ("Lakshmi Devi" and 11 others) into the database by default (`SEED_DEMO` defaulted to true). | Convenience default. | **Fixed**: default is now false; `SEED_DEMO=true` opts in. Existing databases that already hold demo rows were not touched (nothing is deleted by this audit). |

No other defect was found by the adversarial passes listed in section 3. This is a statement about what was probed, not a claim that nothing else exists.

## 3. What was probed (negative-first) and the result

| Probe | Method | Result |
|---|---|---|
| Untested routes | All 296 published operations matched against every spec file | Every operation is referenced by at least one integration or unit test. |
| 5xx / envelope / paging on every route | `qa.robustness.int-spec.ts` (above) | Passed after F-1. |
| Authentication and permission on every route | Existing `qa.inventory` (permission or user-type on every admin route, no unreviewed public route), `qa.access` (cross-customer 404, cross-worker 404, customer cannot act as worker or staff, session isolation) | Run in the full integration pass (section 6). |
| Eligibility drift | Grepped every use of the "verified" and "active" SQL conditions | One definition (`verification-eligibility.ts`); search, matching, replacement alternatives and booking `assertEligible` all go through `SearchService.findEligible`/`activeWorkerCondition`. Reports use the verification-only definition by design (documented in the report response). |
| Webhook trust | Read `handleWebhook` | Signature checked on the raw body before the body is parsed; unsigned -> 401; replay and out-of-order covered by `payments.recovery`. |
| Silent zeros in reports | Read `rate()` | Returns `null` (not 0) when the denominator is 0. |
| Log and audit leakage | Read pino config and `redactSensitive` | Path only (no query), no headers or bodies, redaction list; audit metadata redacted on write and on read. |
| Placeholder/mock code in production paths | Grep for TODO/FIXME/mock/hardcode | None in non-test source (placeholder wording appears only in seeded neutral template text, labelled as such). |
| TLS/HSTS | `helmet()` default in `app.setup.ts` | HSTS header is sent; whether TLS is terminated correctly is deployment evidence (BLOCKED, SC-05/NF-01). |

## 3a. Static and demo data audit (what the apps receive)

Request: every value the apps and the Admin Portal receive must come from the database; static or demo values such as "Lakshmi D." must be flagged.

**"Lakshmi D." and the other names.** At runtime a worker's customer-facing name is computed from `worker_profiles.name` by `src/common/worker-display.ts` (first name and last initial). No name is stored or returned from code. The demo names exist in exactly three places: (1) `src/seed-demo.ts`, a local-only script that refuses production and hosted databases and now runs only with `SEED_DEMO=true` (F-9); (2) OpenAPI `example:` strings in `search.dto.ts`, `booking.dto.ts`, `workers.dto.ts` (documentation only, never returned); (3) test fixtures. A guard test (`src/common/no-static-data.spec.ts`) now fails if any seed-demo person appears in other source as data. **If you saw "Lakshmi D." in an app, it came from demo rows already in that database**, loaded earlier by the old compose default or `seed:demo`; this audit did not delete anything.

| Class | What | Where it comes from | Verdict |
|---|---|---|---|
| Business data | workers, customers, bookings, payments, tickets, ratings, reports, search results, categories, areas, fees, price guidance, notification templates, roles, verification requirements, wage entries | PostgreSQL on every request | Dynamic |
| Configuration the business owns | app start-up settings (min versions, store links, maintenance, support phone/e-mail, cancellation and refund text/links); rating tags | **Now database** (`app_settings`, `rating_tags`), environment only as the default for settings | Fixed in this audit (F-8) |
| Environment configuration (left) | supported languages, legal document versions/links, rating scale and review length, SLA and timer hours, feature flags | environment variables, validated at start-up | Deployment configuration, not content. Languages are checked on every profile write; moving them needs a profile-validation redesign. Legal versions belong to the legal-review process. Flagged, not changed. |
| Code-defined vocabularies (left) | engagement types, budget periods, report reasons, ticket priorities, replacement reasons with labels, booking and interview status labels, report catalogue text | TypeScript constants / database enums | Tied to state machines and enums; the values are the contract. The two label lists (`statusLabels`, `replacementReasons`) are display text in code: flagged; a database-editable label master is a possible follow-up if the client wants to rename statuses without a release. |
| Constants | currency `INR` in earnings and history totals | single currency enforced by validation (`currency must be INR`, PRD 2.2 excludes multi-country) | Intentional |
| Seeded starter content | five pilot areas and 32 neutral in-app templates (`seed-launch`, existing rows never overwritten, labelled placeholders for business review); nine rating tags (migration) | become ordinary database rows editable by staff | Acceptable starter data; flagged |
| Demo data | 12 workers, 6 customers, reviews | `seed-demo`, opt-in | Off by default |
| Hard-coded person, phone, e-mail, price, fee in runtime code | none found | grep of non-test source plus the guard test | Clean |

## 4. Requirement coverage matrix

IDs continue the earlier inventory (`prd-requirement-inventory.md`) so the history stays traceable; the status here is re-derived from the current code, not copied. "Tests" name the integration (`int`) or unit (`unit`) specs under `test/integration` and `src`. Authorisation and business rules sit in the cited module README and decision records.

### 4.1 Scope, platform and operations (PRD 2, 11, 13, 15, 18)

| ID | PRD | Requirement | Implementation | Tests | Status | Gap / dependency |
|---|---|---|---|---|---|---|
| SC-01 | 2.1 | Customer Android/iOS app | none in repo | none | NOT_APPLICABLE_TO_BACKEND | Separate repository; backend exposes the customer API (`customer-app-integration-handoff.md`). |
| SC-02 | 2.1 | Worker Android/iOS app | none in repo | none | NOT_APPLICABLE_TO_BACKEND | As above. |
| SC-03 | 2.1 | Web Admin Panel | none in repo | none | NOT_APPLICABLE_TO_BACKEND | 155 admin operations exist; the UI is a separate repository. |
| SC-04 | 11, 11.1 | NestJS API with the 12 components | 29 modules under `src/modules`, 56 Prisma models | all | IMPLEMENTED_AND_VERIFIED | - |
| SC-05 | 2.1, 15 | Cloud deployment config | `Dockerfile`, `docker-compose.yml`, `render.yaml`, `.github/workflows/ci.yml` | Docker build/start recorded earlier | IMPLEMENTED_UNVERIFIED | No production environment evidence; free-tier hosting; CI run not observed in this audit. |
| SC-06 | 2.1, 13 | Monitoring and error alerts | Sentry hook (`common/observability`), `/health/live`, `/health/ready`, admin alerts, worker heartbeat | `ops.hardening`, `remediation2.operations` | IMPLEMENTED_UNVERIFIED | `SENTRY_DSN` and external uptime alerts not configured/observed. |
| SC-07 | 2.1, 13 | Automated database backups | runbook only | none | BLOCKED | Needs the database owner to enable backups and run a restore drill (Supabase). |
| NF-01 | 13 | HTTPS everywhere | helmet HSTS; `TRUST_PROXY_HOPS` mandatory in production | `ops.hardening` | IMPLEMENTED_UNVERIFIED | TLS termination and redirect are host settings; not checked on a live URL here. |
| NF-02 | 13 | Encryption at rest where appropriate | none in app code (storage/database provider-managed) | none | BLOCKED | Needs provider confirmation: database encryption and S3 bucket default encryption (presigned uploads cannot carry per-request encryption headers without changing the app contract). |
| NF-03 | 13 | Masked sensitive data in routine screens | `maskMobile` in admin lists; document numbers kept as last four; emergency contact redacted until a reasoned, audited reveal | `small.items`, `worker.blacklist`, `verification.decisions` | IMPLEMENTED_AND_VERIFIED | - |
| NF-04 | 13 | Secrets stored securely | scrypt admin hashes, env-only secrets, config validation, no secrets in logs | `security.api`, `auth.api` | IMPLEMENTED_AND_VERIFIED | Rotation of secrets pasted in chat earlier is an operator task. |
| NF-05 | 13 | Audit for verification, payment, user-status changes | `AuditService` in those flows, append-only, keyset viewer | `admin.api`, `remediation.admin`, `ops.hardening` | IMPLEMENTED_AND_VERIFIED | No tamper-evidence chain (not required by PRD). |
| NF-06 | 13 | Retention/deletion policy | deletion request + cooling-off + anonymisation, notification/outbox/KYC retention, all OFF until `RETENTION_ENABLED` | `retention` | BLOCKED | PRD says the policy is "to be defined before launch": periods and legal sign-off are the owner's (Q-02/Q-88). Mechanism is built and tested. |
| NF-07 | 13 | Terms, privacy, consent | `legal` module: versions, acceptance record, optional enforcement | `gap.closing` | BLOCKED | Legal texts and versions not supplied; enforcement flag stays off until then. |
| NF-08 | 13.1 | Graceful failure and retry of integrations | `ProviderError` classes, outbox retry/dead-letter, payment recovery sweeper, honest 503 when SMS/payment is off | `remediation.notifications`, `payments.recovery`, `auth.api` | IMPLEMENTED_AND_VERIFIED | Fakes only; no real provider outage was exercised. |
| NF-09 | 13.1 | Search paginated and fast | server paging cap 100, single-statement page+total, optional cache | `search.api`, sweep, `docs/qa/capacity-assessment.md` | IMPLEMENTED_AND_VERIFIED | No numeric target exists (Q-06); capacity is a laptop measurement only. |
| NF-10 | 13.1 | Concurrent admin operations | `If-Match`/ETag on admin edits, row locks, per-worker advisory lock | `admin.concurrency`, `qa.concurrency` | IMPLEMENTED_AND_VERIFIED | - |
| NF-11 | 15 | Database schema and migrations delivered | 41 migrations, CI guard for order | CI step, `check:migrations` | IMPLEMENTED_AND_VERIFIED | Applied to two empty local databases in this audit without error. |

### 4.2 Service categories (PRD 4)

| ID | PRD | Requirement | Implementation | Tests | Status | Gap / dependency |
|---|---|---|---|---|---|---|
| CAT-01 | 4 | Six V1 categories exist | `INITIAL_CATEGORIES` idempotent seed (boot, `npm run seed`) | `categories.api`, `categories.six` (WIP) | IMPLEMENTED_AND_VERIFIED | - |
| CAT-02 | 4, 7 | Admin creates/edits/enables/disables categories | `/admin/service-categories` (audited, If-Match) | `categories.api` | IMPLEMENTED_AND_VERIFIED | - |
| CAT-03 | 4 | Each category stores its engagement types | `category_engagements`, `PUT /admin/service-categories/{id}/engagements`; PRD defaults available as OPT-IN seed (`SEED_CATEGORY_ENGAGEMENTS`, commit `e45dc5f`) | `scheduling`, `categories.six` | PARTIALLY_IMPLEMENTED | PRD table says "typical", so lists stay opt-in until the client confirms (Q-93). |
| CAT-04 | 4, 5.2 | Engagement vocabulary (full, part, live-in, hourly, daily, shift, one-time) | `ENGAGEMENTS` / enum | `search.api` | IMPLEMENTED_AND_VERIFIED | - |
| CAT-05 | 4 | "Monthly" engagement (Driver, Cook) | none; interim reading FULL_TIME in the seed | none | BLOCKED | Client must say whether "Monthly" is a separate value or FULL_TIME (Q-38/Q-93). Smallest action: one sentence from the client. |
| CAT-06 | 4 | Worker chooses only allowed engagement | worker has one preference across categories; customer side enforced | `scheduling` | PARTIALLY_IMPLEMENTED | Worker-side check needs a client rule for a single preference across several categories. |
| CAT-07 | 4 | Customer requests only allowed combinations | booking, search, matching: 422 `ENGAGEMENT_NOT_OFFERED` once a list is set | `scheduling` | IMPLEMENTED_AND_VERIFIED | Applies to categories with a list. |
| CAT-08 | 4 | Disabled category refuses new bookings | `CATEGORY_NOT_AVAILABLE` | `categories.api` | IMPLEMENTED_AND_VERIFIED | - |
| CAT-09 | 4 | Categories and areas as app reference data | `/service-categories`, `/service-areas`, `/reference-data`, `/app-config` | `appgaps2`, `contract.openapi` | IMPLEMENTED_AND_VERIFIED | - |
| CAT-10 | 4 | New services via admin masters without app change | category CRUD, areas, templates | `categories.api` | IMPLEMENTED_AND_VERIFIED | - |
| CAT-11 | 4, 6.2 | Worker selects and persists one or more services | `PUT /workers/me/categories` -> `worker_skills` | `modules.workforce`, `categories.six` | IMPLEMENTED_AND_VERIFIED | - |

### 4.3 Authentication, profiles, permissions (PRD 3, 5.1, 6.1, 9, 13)

| ID | PRD | Requirement | Implementation | Tests | Status | Gap / dependency |
|---|---|---|---|---|---|---|
| AUTH-01 | 5.1, 6.1 | OTP request for an Indian mobile | `POST /auth/otp/request` | `auth.api` | IMPLEMENTED_AND_VERIFIED | - |
| AUTH-02 | 5.1 | OTP delivered by a real SMS provider | Twilio and MSG91 adapters; fail-safe 503 | adapters unit-tested with mocked HTTP | BLOCKED | Needs an SMS account, sender and DLT template (Q-76). `npm run check:providers` verifies Twilio credentials read-only once configured. |
| AUTH-03 | 5.1, 13 | OTP hashed, expiring, single use, limited attempts/resend | `OtpService` | `auth.api`, `security.api` | IMPLEMENTED_AND_VERIFIED | Limits are configuration values pending client approval (Q-12/Q-28). |
| AUTH-04 | 13 | Provider failure never leaves a usable code or fake success | 503 path, code discarded | `auth.api` | IMPLEMENTED_AND_VERIFIED | - |
| AUTH-05 | 5.1 | First login creates the account once | `findOrCreateByMobile` with unique-violation re-read | `auth.api`, `qa.concurrency` | IMPLEMENTED_AND_VERIFIED | - |
| AUTH-06 | 5.1 | Token sessions, single-use refresh rotation, replay revoke | `SessionService` | `auth.api` | IMPLEMENTED_AND_VERIFIED | - |
| AUTH-07 | 9.1 | Suspended user blocked at once, sessions revoked | guard + session event | `users.api`, `qa.access` | IMPLEMENTED_AND_VERIFIED | - |
| AUTH-08 | 13 | OTP/API rate limiting and abuse protection | per-IP throttle, per-mobile and per-IP OTP limits, lockouts, Redis store | `remediation.throttle`, `security.api` | IMPLEMENTED_UNVERIFIED | Multi-replica Redis behaviour and production proxy depth not exercised (Q-67/Q-82). |
| AUTH-09 | 3, 13 | Admin email/password login with lockout | `/auth/admin/login` | `auth.api`, `admin.session.permissions` | IMPLEMENTED_AND_VERIFIED | - |
| AUTH-10 | 13 | First Super Admin created safely | `npm run bootstrap:admin` | `remediation.admin` | IMPLEMENTED_AND_VERIFIED | - |
| AUTH-11 | 13 | Admin password change/reset | self change, Super Admin temporary password | `small.items` | PARTIALLY_IMPLEMENTED | MFA and self-service forgot-password are undecided (Q-66/Q-87). |
| AUTH-12 | 3, 7 | Role-based admin access (Super Admin, Operations, Verification Executive, Support Executive) | permission catalogue, default role sets (D-71), supervisor role (D-90) | `users.api`, `qa.access`, `qa.inventory` | IMPLEMENTED_AND_VERIFIED | Matrix still needs the owner's sign-off for production. |
| CP-01 | 5.1 | Name, email, preferred language | `/customers/me` | `customers.api` | IMPLEMENTED_AND_VERIFIED | - |
| CP-02 | 5.1 | Validation, no mass assignment | whitelist pipe | `customers.api`, `qa.adversarial` | IMPLEMENTED_AND_VERIFIED | - |
| CP-03 | 5.1 | Saved addresses | `/customers/me/addresses`, one default | `customers.api` | IMPLEMENTED_AND_VERIFIED | - |
| CP-04 | 5.1 | Addresses private to the owner | scoped by profile | `qa.access` | IMPLEMENTED_AND_VERIFIED | - |
| CP-05 | 5.1 | Address checked against service coverage | booking compares address city to area city | `gap.closing` | PARTIALLY_IMPLEMENTED | No pincode-to-area master: coverage rule needed from the client. |
| CP-06 | 5.1, 9 | Basic customer verification (mobile, address, profile) | interim auto-verification + staff decision | `small.items` | PARTIALLY_IMPLEMENTED | Rule is interim (Q-85). |
| CP-07 | 5.1, 9 | Admin decides customer verification | `PATCH /admin/customers/{id}/verification-status` | `customers.api` | IMPLEMENTED_AND_VERIFIED | - |
| CP-08 | 5.1 | Concurrent profile edits safe | ETag + If-Match | `remaining` | IMPLEMENTED_AND_VERIFIED | - |
| CP-09 | 7 | Customer notes and history for admin | notes API, list filters | `customers.api` | IMPLEMENTED_AND_VERIFIED | - |

### 4.4 Discovery, worker cards, shortlist (PRD 5.2, 5.3)

| ID | PRD | Requirement | Implementation | Tests | Status | Gap / dependency |
|---|---|---|---|---|---|---|
| SD-01 | 5.2 | Category selection | `category` filter | `search.api` | IMPLEMENTED_AND_VERIFIED | - |
| SD-02 | 5.2 | Engagement type choice | `engagement` filter | `search.api` | IMPLEMENTED_AND_VERIFIED | - |
| SD-03 | 5.2 | Location | `areaId`/`addressId`, service-area lookup, optional geocoding and `DISTANCE_ASC` | `search.api`, `maps` | IMPLEMENTED_AND_VERIFIED | Google geocoding itself never called live. |
| SD-04 | 5.2 | Preferred timings | time-window intersection | `availability.api`, `search.api` | IMPLEMENTED_AND_VERIFIED | Weekdays are not modelled (Q-37). |
| SD-05 | 5.2 | Start date | `requestedStartDate`, past rejected | `booking.api` | IMPLEMENTED_AND_VERIFIED | - |
| SD-06 | 5.2 | Salary/budget range | stored on the booking, price guidance endpoint | `booking.api`, `appgaps2` | PARTIALLY_IMPLEMENTED | Search/matching ignore budget; period and price bands undecided (Q-39, Q-76/77). |
| SD-07 | 5.2 | Eligibility revalidated at booking | `assertEligible` | `booking.api`, `qa.statemachine` | IMPLEMENTED_AND_VERIFIED | - |
| WD-01 | 5.3 | Worker cards, paged, sorted, filtered | `/search/workers` | `search.api`, `remediation2.discovery` | IMPLEMENTED_AND_VERIFIED | - |
| WD-02 | 5.3 | Photo on card | worker-photo module (WebP renditions, scan) | `modules.workforce`, `worker.photo.required` | IMPLEMENTED_UNVERIFIED | Off until `PROFILE_PHOTO_MAX_BYTES` and a real bucket exist. |
| WD-03 | 5.3 | Experience, skills, language, area, availability, display name | card allow-list | `search.api`, `customer.home` | IMPLEMENTED_AND_VERIFIED | - |
| WD-04 | 5.3, 9 | Verification badge | only fully verified and activated workers are listed | `search.api` | PARTIALLY_IMPLEMENTED | Per-check badge design undefined. |
| WD-05 | 5.3 | Rating and review summary | summary join, `GET /search/workers/{id}/ratings` | `appfeedback`, `ratings.api` | IMPLEMENTED_AND_VERIFIED | - |
| WD-06 | 5.3, 9 | No private data on cards | allow-listed DTO | `qa.adversarial`, `search.api` | IMPLEMENTED_AND_VERIFIED | - |
| WD-07 | 5.3 | Shortlist/favourites | `/shortlist` | `search.api` | IMPLEMENTED_AND_VERIFIED | - |
| WD-08 | 5.3 | Shortlist cannot bypass eligibility | booking re-check | `booking.api` | IMPLEMENTED_AND_VERIFIED | - |
| WD-09 | 5.3 | Consistent contracts across list, detail, home, shortlist | published OpenAPI validated against real responses | `contract.openapi`, `customer.home` | IMPLEMENTED_AND_VERIFIED | Alias `engagements` (other session) is not yet in `docs/openapi.json`. |

### 4.5 Booking, interview/trial, replacement (PRD 5.4, 6.3, 8)

| ID | PRD | Requirement | Implementation | Tests | Status | Gap / dependency |
|---|---|---|---|---|---|---|
| BK-01 | 5.4 | Booking request | `POST /bookings` | `booking.api` | IMPLEMENTED_AND_VERIFIED | - |
| BK-02 | 5.4 | Interview/trial request with preferred time | `/interviews` + schedule actions | `interview`, `booking.api` | IMPLEMENTED_AND_VERIFIED | Trial vs interview share one state (Q-05). |
| BK-03 | 5.4 | Reschedule | reschedule routes | `interview` | IMPLEMENTED_AND_VERIFIED | - |
| BK-04 | 6.3 | Worker accept/decline with deadline | worker actions, `respondBy` (4 h default) | `booking.api`, `scheduling` | IMPLEMENTED_AND_VERIFIED | Default is interim (DEC-01 owner sign-off). |
| BK-05 | 5.4 | Confirm worker | `confirm-worker` | `booking.api` | IMPLEMENTED_AND_VERIFIED | - |
| BK-06 | 5.4, 5.6 | Pay booking fee, server-side amount | `POST /payments` | `payment.api`, `payment.appfields` | IMPLEMENTED_AND_VERIFIED | Fake gateway locally; one real Razorpay test-mode payment was reported verified earlier (not repeated here). |
| BK-07 | 5.4 | Status timeline | `BookingEvent` timeline | `booking.api` | IMPLEMENTED_AND_VERIFIED | - |
| BK-08 | 5.4, 7 | Valid transitions only, concurrency-safe | state machine | `qa.statemachine`, `qa.concurrency` | IMPLEMENTED_AND_VERIFIED | Final state list awaits client confirmation (Q-05/Q-55). |
| BK-09 | 5.4 | No start before the agreed date | `BOOKING_START_EARLY_DAYS` | `scheduling` | IMPLEMENTED_AND_VERIFIED | Tolerance undecided (Q-84). |
| BK-10 | 7 | Admin books on behalf of a customer | `POST /admin/bookings` | `admin.api` | IMPLEMENTED_AND_VERIFIED | - |
| BK-11 | 5.4 | Unpaid booking expiry | auto-cancel (12 h) + alert (1 h) defaults | `scheduling.buffer` | IMPLEMENTED_AND_VERIFIED | Interim default, owner sign-off pending (DEC-02, Q-78). |
| BK-12 | 5.4 | No double booking of one worker | worker-busy rule, advisory lock | `scheduling.buffer`, `qa.concurrency` | IMPLEMENTED_AND_VERIFIED | - |
| BK-13 | 6.3 | Worker proposes another interview time | slot proposal, answer | `remaining`, `interview` | IMPLEMENTED_AND_VERIFIED | - |
| BK-14 | 8.3 | Replacement chain history | `/replacement-chain` | `remaining` | IMPLEMENTED_AND_VERIFIED | - |
| BK-15 | 7 | Admin: match, interview, trial, confirm, cancel, replace | `/admin/bookings`, `/admin/matching/candidates`, `/admin/interviews` | `admin.api`, `matching.api`, `interview` | IMPLEMENTED_AND_VERIFIED | - |
| BK-16 | 6.3 | Worker opportunity feed and requirement summary without PII | `/workers/me/opportunities`, `/workers/me/bookings` | `scheduling`, `worker.app.blockers` | IMPLEMENTED_AND_VERIFIED | F-4 above affects one assertion in `worker.app.blockers`, not this behaviour. |
| RPL-01 | 8.3 | Customer replacement request with reason/notes | `POST /replacement-requests` | `replacement.api` | IMPLEMENTED_AND_VERIFIED | - |
| RPL-02 | 8.3 | Admin reviews eligibility | approve/reject | `replacement.api` | IMPLEMENTED_AND_VERIFIED | Eligibility rule minimal (Q-09/Q-54). |
| RPL-03 | 8.3 | Alternatives, selection, new worker confirmed, history kept | candidates/alternatives/select | `replacement.api` | IMPLEMENTED_AND_VERIFIED | - |

### 4.6 Verification, trust, safety (PRD 6.1, 9, 9.1)

| ID | PRD | Requirement | Implementation | Tests | Status | Gap / dependency |
|---|---|---|---|---|---|---|
| VER-01 | 6.1, 9 | KYC document upload, whole-file validation, hash | presigned upload + confirm | `verification.api`, `kyc.integrity` | IMPLEMENTED_AND_VERIFIED | In-memory storage; real bucket untested. |
| VER-02 | 9 | Identity, address, emergency contact, employment reference, police tracking | check types + references (max 5) + criminal self-declaration | `verification.api`, `remaining` | IMPLEMENTED_AND_VERIFIED | Tracking only: no external check occurs. |
| VER-03 | 9 | Reviewer approve/reject with remarks, audited | review/approve/reject/notes/assignment | `verification.decisions`, `verification.assignment` | IMPLEMENTED_AND_VERIFIED | - |
| VER-04 | 9 | Not "verified" until configured checks pass and are approved | `verifiedWorkerCondition`, sign-off and activation (D-90) | `verification.decisions`, `search.api` | IMPLEMENTED_AND_VERIFIED | Which checks are mandatory is admin configuration (Q-04). |
| VER-05 | 7 | Expiry and re-check | `recheckAt`, reminder loop, search exclusion | `verification.api`, `ops.hardening` | IMPLEMENTED_AND_VERIFIED | - |
| VER-06 | 9.1 | Document access limited by role, short-lived audited links | admin link route, 404/409 separation | `qa.access`, `verification.api` | IMPLEMENTED_AND_VERIFIED | - |
| VER-07 | 9 | External/partner verification | provider interface exists, unused | none | BLOCKED | No partner chosen (Q-04/Q-51); manual workflow is the PRD fallback. |
| VER-08 | 9 | Malware scanning of documents | optional ClamAV adapter | unit | BLOCKED | Requirement and scanner undecided (Q-89). |
| VER-09 | 9.1 | Emergency contact visibility by policy | redacted by default, reasoned audited reveal | `worker.blacklist` | PARTIALLY_IMPLEMENTED | Role/time policy undecided (Q-86). |
| TS-04 | 9.1 | Report/block | `/safety/*` | `module10.support-safety-notifications` | IMPLEMENTED_AND_VERIFIED | Effect on a live booking undecided (Q-74). |
| TS-05 | 9.1 | Customer/worker suspension | `PATCH /admin/users/{id}/status` | `users.api` | IMPLEMENTED_AND_VERIFIED | - |
| TS-06 | 9.1 | Complaint history | `creatorUserId` ticket filter | `scheduling` | IMPLEMENTED_AND_VERIFIED | - |
| TS-07 | 7 | Worker blacklist | `POST /admin/workers/{id}/blacklist` and lift | `worker.blacklist` | IMPLEMENTED_AND_VERIFIED | - |
| TS-08 | 9.1 | Audit of critical admin actions | audit log + viewer | `admin.api` | IMPLEMENTED_AND_VERIFIED | - |

### 4.7 Worker app (PRD 6)

| ID | PRD | Requirement | Implementation | Tests | Status | Gap / dependency |
|---|---|---|---|---|---|---|
| WK-01 | 6.1 | OTP registration, role separation | `findOrCreateByMobile`, `MOBILE_IN_USE` | `auth.api` | IMPLEMENTED_AND_VERIFIED | - |
| WK-02 | 6.1 | Profile photo | see WD-02 | `worker.photo.required` | IMPLEMENTED_UNVERIFIED | As WD-02. |
| WK-03 | 6.1 | Address and emergency contact | all-or-none groups | `workers.api` | IMPLEMENTED_AND_VERIFIED | - |
| WK-04 | 6.1 | Previous employer/references | `worker_references` | `remaining` | IMPLEMENTED_AND_VERIFIED | - |
| WK-05 | 7 | Admin-assisted worker creation | `POST /admin/workers` | `workers.api` | IMPLEMENTED_AND_VERIFIED | - |
| WP-01 | 6.2 | Roles/services | see CAT-11 | `categories.six` | IMPLEMENTED_AND_VERIFIED | - |
| WP-02 | 6.2 | Experience, languages | profile | `workers.api` | IMPLEMENTED_AND_VERIFIED | - |
| WP-03 | 6.2 | Preferred locations, available timings | availability module | `availability.api` | IMPLEMENTED_AND_VERIFIED | - |
| WP-04 | 6.2 | Expected salary | stored amount | `workers.api` | PARTIALLY_IMPLEMENTED | Period undefined (Q-39). |
| WP-05 | 6.2 | Full/part/live-in preference | single enum | `workers.api` | IMPLEMENTED_AND_VERIFIED | Single value only (Q-38). |
| WP-06 | 6.2 | Submit gate; searchable only after approval | `missingForSubmission` | `onboarding` | IMPLEMENTED_AND_VERIFIED | - |
| WP-07 | 6 | Local-language readiness | language preference + per-language templates | `notifications.api` | PARTIALLY_IMPLEMENTED | No translated master data supplied (client content). |
| JW-01..05 | 6.3 | Opportunities, summary, accept/decline, schedule, confirmation | worker booking routes | `scheduling`, `booking.api` | IMPLEMENTED_AND_VERIFIED | - |
| ONW-01 | 6.4 | Attendance/status | `/workers/me/attendance/...` incl. check-in/out | `attendance.api` | IMPLEMENTED_AND_VERIFIED | - |
| ONW-02 | 6.4 | Current job details | `/workers/me/bookings` | `booking.api` | IMPLEMENTED_AND_VERIFIED | - |
| ONW-03 | 6.4 | Earnings/payment reference | append-only `worker_payment_references`, `GET /workers/me/earnings`, admin entry/correct/void | `earnings.api` | IMPLEMENTED_AND_VERIFIED | Records what staff enter; it is not payroll (out of scope). |
| ONW-04 | 6.4 | Ratings received | `/workers/me/ratings` | `ratings.api` | IMPLEMENTED_AND_VERIFIED | - |
| ONW-05 | 6.4 | Support and complaints | support routes | `support.api` | IMPLEMENTED_AND_VERIFIED | - |

### 4.8 Ongoing service, ratings, support (PRD 5.5)

| ID | PRD | Requirement | Implementation | Tests | Status | Gap / dependency |
|---|---|---|---|---|---|---|
| ON-01 | 5.5 | Attendance visible to customer | `/attendance/bookings/{id}` | `attendance.api`, `customer.active-service` | IMPLEMENTED_AND_VERIFIED | - |
| ON-02 | 5.5 | Month summary | `/summary` | `attendance.api` | IMPLEMENTED_AND_VERIFIED | - |
| ON-03 | 5.5 | Exceptions with history | exception + admin correction + events | `customer.active-service` | IMPLEMENTED_AND_VERIFIED | - |
| ON-04 | 5.5 | Service history | `/customers/me/booking-history` (+ summary) | `customer.history-rating` | IMPLEMENTED_AND_VERIFIED | - |
| ON-05 | 5.5, 7 | Support tickets: create, thread, assign, escalate, close | support routes | `support.api`, `module10.*` | IMPLEMENTED_AND_VERIFIED | No attachments or reopen (Q-59). |
| ON-06 | 7 | Resolution SLA | due date + breach escalation (24/48/72 h defaults) | `gap.closing`, `support.api` | IMPLEMENTED_AND_VERIFIED | Interim defaults, owner sign-off pending (DEC-03). |
| ON-07 | 5.5, 19 | Rating tied to eligible engagement, aggregates, hide/restore | `ratings` | `ratings.api`, `customer.history-rating` | IMPLEMENTED_AND_VERIFIED | "Otherwise eligible" beyond COMPLETED is open (Q-58/Q-102). |

### 4.9 Payments and commercial configuration (PRD 5.6, 7, 10)

| ID | PRD | Requirement | Implementation | Tests | Status | Gap / dependency |
|---|---|---|---|---|---|---|
| PAY-01 | 5.6 | UPI/cards/net banking through the gateway | Razorpay adapter, checkout payload | `payment.api` (fake), staging smoke script | IMPLEMENTED_UNVERIFIED | Not exercised against the real gateway in this audit; live account set-up open (Q-79). |
| PAY-02 | 5.6 | Receipts | receipt data + plain PDF | `payment.api` | PARTIALLY_IMPLEMENTED | Tax-invoice format undecided (Q-100). |
| PAY-03 | 5.6 | Transaction history | `GET /payments` | `payment.api` | IMPLEMENTED_AND_VERIFIED | - |
| PAY-04 | 5.6 | Refund status | status fields, admin full refund, gateway polling | `payment.api`, `payments.recovery` | PARTIALLY_IMPLEMENTED | Partial/automatic refund rules undecided (Q-77/Q-83). |
| PAY-05 | 13 | Webhook signature, replay, out of order | adapter signature on raw body | `payments.recovery` | IMPLEMENTED_AND_VERIFIED | Real Razorpay webhook never received here. |
| PAY-06 | 13.1 | Lost callbacks recovered | recovery sweeper | `payments.recovery` | IMPLEMENTED_AND_VERIFIED | Fake gateway only. |
| PAY-07 | 13 | Duplicate-payment protection, cancel vs pay consistency | idempotency + exceptions queue | `payments.recovery`, `payment.api` | IMPLEMENTED_AND_VERIFIED | - |
| PAY-08 | 7 | Fee records, refunds, invoice/reference export | `/admin/payments`, `payments-export` CSV | `payment.api`, robustness sweep | IMPLEMENTED_AND_VERIFIED | Error-header defect F-1 fixed. |
| PAY-09 | 10 | Admin-configurable fees (booking, placement, verification, replacement plan) | `fee_configs`, `/admin/fees`, `POST /fee-payments` | `fees.catalogue` | IMPLEMENTED_AND_VERIFIED | Values are the owner's; none invented. |
| PAY-10 | 10 | Customer subscription plan | `SUBSCRIPTION` fee kind is catalogued only; no plan entity, term, entitlement or purchase flow | none | BLOCKED | Owner must define what a plan grants and for how long (monthly/quarterly, what support it unlocks). Proposed once decided: `plans` master (code, term, price via `fee_configs`) plus a customer entitlement row created by a verified payment. |
| PAY-11 | 7 | "Plans" configuration master | see PAY-10 | none | BLOCKED | As PAY-10. |
| PAY-12 | 10 | Apartment partnership and employer/bulk services | none | none | NOT_APPLICABLE_TO_BACKEND | PRD 2.2 and 21 defer the community dashboard, corporate and bulk workforce module; pricing models are not V1 backend scope. Revisit with Phase 2. |

### 4.10 Notifications and integrations (PRD 2.1, 11, 12)

| ID | PRD | Requirement | Implementation | Tests | Status | Gap / dependency |
|---|---|---|---|---|---|---|
| NT-01 | 2.1 | Push (FCM) | FCM HTTP v1 adapter, dead-token cleanup, route data | `module10.*`, unit | IMPLEMENTED_UNVERIFIED | No Firebase credentials; never sent live. |
| NT-02 | 2.1 | SMS notifications | SMS adapters shared with OTP | `remediation.notifications` | BLOCKED | Needs SMS vendor/DLT templates (Q-76). SMS/push templates are admin-created content; only neutral in-app starters are seeded. |
| NT-03 | 2.1 | Optional WhatsApp | Twilio WhatsApp adapter | unit | BLOCKED | Optional; provider/config not decided. |
| NT-04 | 2.1 | In-app inbox | `/notifications` | `notifications.api` | IMPLEMENTED_AND_VERIFIED | - |
| NT-05 | 12 | Delivery status, retry, duplicate protection, admin retry | outbox, dedupe key, dead-letter, `/admin/notifications/health` | `remediation.notifications` | IMPLEMENTED_AND_VERIFIED | - |
| NT-06 | 7 | Notification templates master | `/admin/notification-templates` (placeholder-checked, If-Match) | `notifications.api` | IMPLEMENTED_AND_VERIFIED | - |
| NT-07 | 11 | E-mail channel (TRD) | Brevo adapter, per-user preference | `email.channel` | IMPLEMENTED_UNVERIFIED | Off unless a provider key is set. |
| INT-01 | 11 | Maps provider | Google geocoding adapter (disabled/memory/google) | `maps` | IMPLEMENTED_UNVERIFIED | Needs a Maps key; never called live. |
| INT-02 | 11 | Object storage | S3 adapter + in-memory + disabled | `s3-storage.provider.spec` | IMPLEMENTED_UNVERIFIED | No real bucket tested. |

### 4.11 Admin portal, reports (PRD 7, 14)

| ID | PRD | Requirement | Implementation | Tests | Status | Gap / dependency |
|---|---|---|---|---|---|---|
| AD-01 | 7 | Dashboard (bookings, active workers, pending KYC, complaints, replacements, collections) | `/admin/dashboard`, permission-scoped sections | `reports.api` | IMPLEMENTED_AND_VERIFIED | - |
| AD-02 | 7 | Customer management | list/detail/status/notes | `customers.api` | IMPLEMENTED_AND_VERIFIED | - |
| AD-03 | 7 | Worker management incl. documents, skills, rating, status | `/admin/workers*` | `workers.api` | IMPLEMENTED_AND_VERIFIED | - |
| AD-04 | 7 | Verification module | queue, requirements, sign-off, activation | `verification.*` | IMPLEMENTED_AND_VERIFIED | - |
| AD-05 | 7 | Booking management | `/admin/bookings*` | `admin.api` | IMPLEMENTED_AND_VERIFIED | - |
| AD-06 | 7 | Payments | `/admin/payments*`, exceptions, reconcile | `payment.api` | IMPLEMENTED_AND_VERIFIED | - |
| AD-07 | 7 | Support | `/admin/support/*` | `support.api` | IMPLEMENTED_AND_VERIFIED | - |
| AD-08 | 7 | Configuration: categories, areas, fees, notification templates, roles | admin masters (see CAT-02, PAY-09, NT-06, AUTH-12, CFG-01/02) | respective specs | PARTIALLY_IMPLEMENTED | "Plans" is BLOCKED (PAY-11): the one named configuration master that does not exist. |
| CFG-01 | 7, 11 | App start-up settings editable without a deployment | `app_settings`, `PUT /admin/app-settings/{key}`, read by `GET /app-config` | `platform.config` | IMPLEMENTED_AND_VERIFIED | New in this audit. |
| CFG-02 | 7 | Rating tag catalogue managed by staff | `rating_tags`, `/admin/rating-tags`, validated by `POST /ratings` | `platform.config`, `customer.devrequests`, `customer.history-rating` | IMPLEMENTED_AND_VERIFIED | New in this audit; wording awaits the client (Q-121). |
| AD-09 | 7 | Alerts for stuck work | `/admin/alerts` | `ops.hardening` | IMPLEMENTED_AND_VERIFIED | - |
| RP-01 | 14 | New customers by day/week/month | `/admin/reports/new-customers` | `reports.api`, `qa.reports` | IMPLEMENTED_AND_VERIFIED | Definitions proposed (Q-61). |
| RP-02 | 14 | Worker registrations and verification conversion | `worker-registrations` | `reports.api` | IMPLEMENTED_AND_VERIFIED | - |
| RP-03 | 14 | Requests vs confirmed bookings | `booking-funnel` | `reports.api` | IMPLEMENTED_AND_VERIFIED | - |
| RP-04 | 14 | Demand by category / area | `demand-by-category`, `demand-by-area` | `reports.api` | IMPLEMENTED_AND_VERIFIED | - |
| RP-05 | 14 | Worker utilisation | `worker-utilization` | `reports.api` | IMPLEMENTED_AND_VERIFIED | - |
| RP-06 | 14 | Interview-to-confirmation | `interview-conversion` | `reports.api` | IMPLEMENTED_AND_VERIFIED | - |
| RP-07 | 14 | Cancellation / replacement rate | two routes | `reports.api` | IMPLEMENTED_AND_VERIFIED | Rate is `null`, never 0, when nothing happened. |
| RP-08 | 14 | Payment collections | `payment-collections` | `reports.api` | IMPLEMENTED_AND_VERIFIED | - |
| RP-09 | 14 | Support volume and resolution time | `support-tickets` | `reports.api` | IMPLEMENTED_AND_VERIFIED | - |
| RP-10 | 14 | Top-rated workers, repeat customers | two routes | `reports.api` | IMPLEMENTED_AND_VERIFIED | - |
| RP-11 | 14 | Report export | `/admin/reports/export/{report}` | `reports.api`, sweep | IMPLEMENTED_AND_VERIFIED | Error-header defect F-1 fixed. |

### 4.12 Launch, delivery and acceptance (PRD 15-22)

| ID | PRD | Requirement | Implementation | Tests | Status | Gap / dependency |
|---|---|---|---|---|---|---|
| LM-01 | 22 | Hyderabad pilot areas | `seed-launch` (HITEC City, Madhapur, Kondapur, Gachibowli, Kukatpally; idempotent) | manual: run twice on a local database in this audit (5 created, then 0); no automated spec | IMPLEMENTED_AND_VERIFIED | No regression test exists for the script; operator-managed data is never overwritten. |
| LM-02 | 22 | Initial worker pool 100+ | operational | none | NOT_APPLICABLE_TO_BACKEND | Business onboarding target, not a backend capability. |
| DL-01 | 18 | API/integration documentation | OpenAPI at `/docs`, `docs/openapi.json`, Postman collection, handoff docs | `contract.openapi` | IMPLEMENTED_AND_VERIFIED | Export must be regenerated after the pending category-alias decision. |
| DL-02 | 18 | Admin user guide, operational workflow, UAT closure report | partial (`OPERATIONS_RUNBOOK`, `END_TO_END_JOURNEYS`) | none | PARTIALLY_IMPLEMENTED | No admin user guide or UAT closure report in the repository; UAT needs the apps. |
| AC-01..11 | 19 | Sample acceptance criteria | see the rows above | `qa.journeys` (end-to-end across modules) | PARTIALLY_IMPLEMENTED | Criteria 1 and 6 need a real SMS and gateway; criterion 11 needs devices (client-side). |

## 5. Blocked items: smallest decision or action

| Item | Exact missing input | Why code cannot proceed safely | Smallest action | Proposed once unblocked |
|---|---|---|---|---|
| AUTH-02, NT-02, NT-03 | SMS account, sender, DLT-registered templates | A real send cannot be tested or approved without them | Owner opens an SMS account | Set `SMS_PROVIDER`, run `npm run check:providers` |
| PAY-01 | Live-mode gateway account, webhook secret | Money paths need the real provider | Owner finishes Razorpay set-up | Run `scripts/staging-payment-smoke.mjs --checkout` |
| PAY-10/11 | What a subscription/replacement plan grants and its term | Inventing entitlements would invent commercial policy | Owner defines a plan in two lines | `plans` master + entitlement row |
| CAT-05, CAT-03 | Meaning of "Monthly"; confirm the six engagement lists | PRD says "typical" | One sentence from the client | Apply with `SEED_CATEGORY_ENGAGEMENTS=true` |
| SD-06 | Budget period and price bands | Matching on budget needs units | Owner states the unit | Budget filter in search |
| NF-06, NF-07 | Retention periods, legal text | Legal decisions | Legal review | Set `RETENTION_*`, `LEGAL_*` |
| SC-07, NF-01, NF-02, SC-06 | Host/database settings and evidence | Not visible from code | Operator enables and records evidence | Fill the runbook evidence section |
| VER-07, VER-08 | Verification partner, scanner | Vendor choice | Owner chooses | Adapter behind the existing interface |
| AUTH-11 | MFA method, forgotten-password process | Security policy | Owner chooses | Implement the chosen flow |

## 6. Verification run (actual results)

Environment: Node v24.21.0, local Docker PostgreSQL 17 and Redis 7, fresh databases `sevanest_audit4_ci` (final run) and earlier `_audit_ci`, `_audit2_ci`, `_audit3_ci`; fake SMS, payment, storage; no real provider; the remote Supabase database in `.env` was never used.

| Check | Command | Result |
|---|---|---|
| Typecheck | `npm run typecheck` | pass |
| Lint | `npm run lint` | 0 errors, 3 pre-existing warnings (unused eslint-disable in `test/perf`) |
| Format | `npm run format:check` | pass |
| Prisma | `npx prisma validate`; `migrate deploy` on empty databases; `migrate diff` | valid; 42 migrations apply; no drift |
| Unit | `npm test` | 43 suites, 401 tests, all pass |
| End to end | `npm run test:e2e` | 2 suites, 27 tests, all pass |
| Integration, one suite per process on a fresh database | loop over `test/integration/*.int-spec.ts` | 70 suites: 1062 tests passed, 2 failed |
| The 2 failures | `modules.workforce` (module-boundary map lacked the new module) and `qa.robustness` (PATCH `/admin/rating-tags/%00` answered 500 because a NUL byte reached PostgreSQL) | both are defects in this audit's own new code; fixed; re-run: `modules.workforce` 10/10, `qa.robustness` + `platform.config` 10/10 |

Notes: (1) A first single-process run of the whole integration suite stalled after 3 suites and was killed; the per-suite loop replaced it. The cause was not established; it may have been shared Redis/database use by concurrent runs. (2) Before the fixes in F-2, F-3, F-6, F-7 the baseline had 8 failing tests in 7 suites on HEAD. (3) The integration suites share one database and one Redis; several are order-sensitive (e.g. global outbox counts, templates referenced by notifications). They pass on a fresh database and in the per-suite loop here, but a re-run on a used database can fail for reasons unrelated to the code. (4) A complete single-process integration run after the last two fixes was not repeated (about 45 minutes); the two fixed suites and the affected suites were re-run.

## 7. Coverage count

Counted by atomic requirement row in section 4 (the acceptance-criteria summary row AC-01..11 counts once; JW-01..05 counts five).

| Status | Count |
|---|---|
| Total atomic requirements | 176 |
| IMPLEMENTED_AND_VERIFIED (local, fake providers) | 133 |
| IMPLEMENTED_UNVERIFIED | 11 |
| PARTIALLY_IMPLEMENTED | 15 |
| NOT_IMPLEMENTED | 0 |
| BLOCKED (decision or external dependency named in section 5) | 12 |
| NOT_APPLICABLE_TO_BACKEND (reason in each row) | 5 |

Only IMPLEMENTED_AND_VERIFIED counts as complete: 133 of 171 applicable requirements (78%). Blocked, unverified and partial rows are not counted as done. The verified count is local evidence only.

## 8. Deployment and migration notes

One additive migration, `20261112090000_platform_config` (two new tables, nine inserted rating tags, nothing existing touched; reverse by dropping the two tables). Deploy with the usual non-destructive `npx prisma migrate deploy` before the new code starts; the new code reads the tables on every request. Then give the Super Admin (who holds every permission automatically) or another role `config.manage` as needed. Behaviour changes to tell the app teams: `GET /app-config` and `GET /reference-data` now reflect staff changes immediately; `POST /ratings` answers 422 `RATING_TAG_INVALID` (was 400) for a well-formed code that is not an active tag; error responses of every endpoint are `application/json` and `Cache-Control: no-store`. Not touched: the nine rating tags keep their codes and labels. `docs/openapi.json` and the Postman collection were regenerated.

## 9. Final readiness assessment

Version 1 backend feature scope is implemented and locally verified except the items marked above. It is **not production ready**: real SMS, payment gateway, push, object storage, backups, monitoring evidence, TLS evidence, legal text, retention periods and the client policy decisions remain. The mobile apps and admin web client were not available, so no client integration is verified. Local tests prove behaviour with fake providers only.
