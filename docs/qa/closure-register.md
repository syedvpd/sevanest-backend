# Closure register

Updated 2026-10-13 (second remediation run). One entry per finding of the PRD audit that was not a clean PASS or that was changed by remediation. Dispositions: FIXED_VERIFIED (a runtime test proves it), PARTIALLY_FIXED, BLOCKED_BY_DECISION, BLOCKED_BY_EXTERNAL_DEPENDENCY, NOT_FIXED, NOT_VERIFIED, OUT_OF_V1_SCOPE.

| Finding | Requirement | Source | Priority | Root cause / blocker | Fix or preparation | Changed files / migrations | Tests executed | Remaining limitation | Disposition |
|---|---|---|---|---|---|---|---|---|---|
| AC-01 | Customer registers by OTP and creates a valid profile | PRD 19 | P0 | Needs real SMS | see AUTH-02 | - | - | Owner | BLOCKED_BY_EXTERNAL_DEPENDENCY |
| AC-06 | Payment success/failure reflected on booking | PRD 19 | P0 | Needs the real gateway | see PAY-01 | - | - | Owner | BLOCKED_BY_EXTERNAL_DEPENDENCY |
| AC-11 | UAT on Android/iOS devices and browsers | PRD 19 | P1 (product) | No apps to run UAT on | - | - | - | Provide apps | BLOCKED_BY_EXTERNAL_DEPENDENCY |
| AD-02 | Customer list/filters, detail, status, notes, history | PRD 7 | - | Customer history needed filtered lists | Customer filters + booking customerUserId and ticket creatorUserId filters | customers, booking, support modules | small.items.int-spec, scheduling.int-spec | - | FIXED_VERIFIED |
| AD-03 | Worker list/detail, categories, status | PRD 7 | P2 | Few admin worker filters | Name, account status, registration date, service area, minimum rating | workers repository/service/dto | scheduling.int-spec, remaining.int-spec | Blacklist as its own state is undefined (decision) | PARTIALLY_FIXED |
| AD-10 | Plans (subscription/replacement plan) configuration | PRD 7, 10 | P2 | Plans / subscriptions: PRD 10 names them as options; none chosen | Configurable fee codes exist (PUT /admin/fees/{code}) | - | gap.closing.int-spec | Client chooses revenue models | BLOCKED_BY_DECISION |
| AD-14 | Stale-write protection on admin edits | PRD 7 | P2 | No stale-write protection on admin edits | ETag/If-Match on workers, customer status, categories, areas, notification templates | workers, customers, service-categories, availability, notifications modules; src/common/concurrency | small.items.int-spec, remaining.int-spec | Fees, support categories, tickets, role changes rely on locks / state machines | PARTIALLY_FIXED |
| AUTH-02 | OTP is delivered by a real SMS provider | PRD 5.1 | P0 | No SMS account / sender / DLT template | Twilio and MSG91 adapters, fail-safe OTP, staging test OTP; npm run check:providers verifies Twilio credentials read-only | src/check-providers.ts; sms adapters (earlier) | sms-providers.spec; auth.api; check:providers run: SMS_PROVIDER=disabled locally -> NOT_CONFIGURED | Owner: provider account, sender, DLT template, real delivery test | BLOCKED_BY_EXTERNAL_DEPENDENCY |
| AUTH-08 | Rate limiting on OTP/API with shared Redis store and trusted proxy | PRD 13 | P1 | Multi-instance and Redis-outage runs were not performed | Redis-backed throttle + trusted proxy tested on one instance | - | remediation.throttle | Run two API instances against one Redis; stop Redis mid-test | NOT_VERIFIED |
| AUTH-11 | Admin password change and reset | PRD 13 | P2 | MFA method and self-service reset undecided (Q-87) | Super Admin temporary password; own password change | users.service, users.controller | small.items.int-spec | Client chooses MFA / reset method | BLOCKED_BY_DECISION |
| BK-11 | Unpaid PENDING_PAYMENT booking expiry | PRD 5.4 | P2 | Expiry period undefined (Q-78) | Auto-cancel rule exists and releases the worker hold; off until configured | booking-sweep.service | scheduling.buffer.int-spec: auto-cancel releases the worker | Client sets PENDING_PAYMENT_AUTO_CANCEL_HOURS | BLOCKED_BY_DECISION |
| BK-12 | A worker already booked for a time cannot be booked for an overlapping time (same dates, overlapping hours); free again after the service ends; other hours/other workers stay bookable | PRD 5.4, user rule | - | No rule stopped one worker being confirmed for overlapping times | Overlap rule in dates and hours, per-worker lock at confirmation, search/matching consistency, optional travel buffer | src/common/scheduling/worker-busy.ts; booking.service/repository; search.repository | scheduling.int-spec (11), scheduling.buffer.int-spec (5): boundaries, buffer, concurrent confirm, cancel/payment races, auto-cancel release, failed payment keeps hold | Unpaid booking holds the worker until paid/cancelled/expired (Q-78, Q-92) | FIXED_VERIFIED |
| BK-13 | Worker can propose another interview/trial time; customer accepts or keeps the original | PRD 6.3, FRD schedule conflict | - | Worker could not ask for another interview/trial time | Proposal workflow with customer/staff answer, audit, notifications | booking.service/controller/repository; migration 20261021090000; notification events + templates | remaining.int-spec (4): accept, reject, staff answer, wrong state/actor/time, parallel answers | - | FIXED_VERIFIED |
| BK-14 | Replacement history is traceable as one chain | PRD 8.3 | - | Replacement history was not traceable as one chain | GET replacement-chain for customer (own) and staff | booking.service/controller/repository | remaining.int-spec: chain from any link, privacy, 404/403/401 | - | FIXED_VERIFIED |
| CAT-03 | Each category stores its allowed engagement types | PRD 4, 5.2 | P2 | No table or validation for category engagement types | category_engagements, PUT /admin/service-categories/{id}/engagements, enforced in booking, search and matching | prisma/migrations/20261020110000_category_engagements; service-categories module; booking.service; search.service; src/common/validation/engagements.ts | scheduling.int-spec (engagement restriction, validation, audit) | No default lists: the client must supply them (Q-93) | PARTIALLY_FIXED |
| CAT-05 | Engagement type "Monthly" (Driver, Cook) | PRD 4 | P2 | "Monthly" has no value in the vocabulary (Q-38/Q-93) | Not invented | - | - | Client defines monthly vs full-time | BLOCKED_BY_DECISION |
| CAT-06 | A worker can choose only engagement types allowed for the category | PRD 4 | P2 | A worker holds one engagement preference across several categories | Customer-side enforcement done; matching already needs preference == request | as CAT-03 | scheduling.int-spec | Validating the worker preference against category lists needs a client rule (Q-93) | PARTIALLY_FIXED |
| CAT-07 | A customer can request only allowed category/engagement combinations | PRD 4 | - | Booking validated the engagement enum only | Engagement checked against the category list (422 ENGAGEMENT_NOT_OFFERED) | booking.service.ts, search.service.ts | scheduling.int-spec: booking, search, matching refuse; list lifted when emptied | Applies to configured categories only | FIXED_VERIFIED |
| CP-05 | Address validated against enabled service area/pincode | PRD 5.1 | P2 | No pincode-to-area coverage master | Booking checks address city equals area city | - | gap.closing.int-spec | Client supplies coverage rule | BLOCKED_BY_DECISION |
| CP-06 | Basic customer verification (mobile, address, profile checks) | PRD 5.1 | P2 | Customer verification rule undefined (Q-85) | Interim auto-verification with staff override | customer-addresses.service; migration 20261020100000 | small.items.int-spec | Client defines the rule | BLOCKED_BY_DECISION |
| CP-08 | Concurrent profile/address edits are safe | PRD 5.1 | - | Customer self-edit had no version check | ETag + If-Match on profile and address, profile locked during the edit | customers.service, customer-addresses.service, customers.controller | remaining.int-spec: stale 412, current 200, no header 200, parallel edits one 200 + one 412, foreign address 404 | - | FIXED_VERIFIED |
| JB-01 | Worker process runs 6 loops and heartbeats | PRD 15 | P0 | Heartbeat lived 180 s but two loops tick every 5 and 15 minutes (false "missing") | TTL follows each loop interval | infrastructure/cache/heartbeat.service.ts; verification.worker.ts | tsc/lint; not unit-tested; the deployed service has not been re-checked | Deploy, wait 15 minutes, read GET /admin/system/readiness | PARTIALLY_FIXED |
| JW-01 | Receive job opportunities | PRD 6.3 | - | Worker saw offers only inside the generic booking list | GET /workers/me/opportunities | booking.controller/service/repository | scheduling.int-spec: feed, answered jobs leave, isolation, 403/401 | One matched worker per booking (parallel offers would need a decision) | FIXED_VERIFIED |
| JW-04 | Interview/trial schedule visible, slot proposal by worker | PRD 6.3 | - | Worker could not request another slot | See BK-13 | as BK-13 | remaining.int-spec | - | FIXED_VERIFIED |
| NF-01 | HTTPS for all traffic | PRD 13 | P0 | TLS terminated by the host | No check made | - | - | Owner: confirm HTTPS redirect / HSTS on the live URL | NOT_VERIFIED |
| NF-02 | Encryption at rest | PRD 13 | P1 | Provider-managed encryption at rest | No evidence | - | - | Owner: confirm in Supabase | NOT_VERIFIED |
| NF-06 | Data retention/deletion policy | PRD 13 | P2 | Retention / erasure undefined (Q-88) | Requests recorded only | - | gap.closing.int-spec | Client policy | BLOCKED_BY_DECISION |
| NF-07 | Terms, privacy, consent flows | PRD 13 | P2 | Legal texts pending review | Consent mechanism exists | - | gap.closing.int-spec | Legal | BLOCKED_BY_DECISION |
| NT-01 | Push notifications (FCM) | PRD 2.1 | P1 | Firebase service account missing | FCM adapter (mocked) | - | fcm.provider.spec | Owner | BLOCKED_BY_EXTERNAL_DEPENDENCY |
| NT-02 | SMS notifications (transactional) | PRD 2.1 | P1 | SMS provider / DLT templates missing | see AUTH-02 | - | - | Owner | BLOCKED_BY_EXTERNAL_DEPENDENCY |
| NT-03 | WhatsApp (optional) | PRD 2.1 | P2 | WhatsApp provider (optional) | Twilio WhatsApp adapter | - | sms-providers.spec | Owner | BLOCKED_BY_EXTERNAL_DEPENDENCY |
| ON-04 | Service history (completed, cancelled, active) and replacement chain | PRD 5.5 | - | No history view of a replacement chain | See BK-14 | as BK-14 | remaining.int-spec | - | FIXED_VERIFIED |
| ON-06 | Support resolution SLA with due dates and breach alert | PRD 5.5, 7 | P2 | SLA hours undefined (Q-59) | Rule exists and is off | support.worker | gap.closing.int-spec | Client sets SUPPORT_SLA_HOURS_* | BLOCKED_BY_DECISION |
| ONW-03 | Earnings/payment reference | PRD 6.4 | P2 | Earnings model undefined | Worker sees budget and start date | - | - | Client | BLOCKED_BY_DECISION |
| PAY-01 | UPI/cards/net banking via the gateway | PRD 5.6 | P0 | No authorized sandbox session; local PAYMENT_PROVIDER=disabled | Adapter + recovery tested with fakes; npm run check:providers creates and looks up a Rs 1 TEST order when test keys are configured | src/check-providers.ts | check:providers run locally: NOT_CONFIGURED (no keys in the local environment) | Owner: run check:providers with test keys, then one manual checkout + webhook + refund | BLOCKED_BY_EXTERNAL_DEPENDENCY |
| PAY-02 | Payment receipts | PRD 5.6 | P2 | Receipt / tax-invoice format undefined | receiptNumber and data | - | - | Finance defines the format | BLOCKED_BY_DECISION |
| PAY-04 | Refund status | PRD 5.6 | P1 | Partial / automatic refunds undecided (Q-77, Q-83) | Manual full refund + exception queue | - | payment.api, payments.recovery | Client policy | BLOCKED_BY_DECISION |
| RK-01 | Provider abstraction for payment/SMS/maps/OTP | PRD 20 | P2 | Maps provider undecided (Q-90) | Interface only | - | - | Client | BLOCKED_BY_DECISION |
| RV-02 | Placement fee, subscription, verification fee, replacement plan, B2B | PRD 10 | P2 | Revenue models undecided | Configurable fee codes | - | - | Client | BLOCKED_BY_DECISION |
| SC-01 | Customer Android/iOS application | PRD 2.1 | P1 (product) | No customer app repository in the workspace | API contract documented (OpenAPI at /docs); app audit needs the repository | - | - | Provide the repository | BLOCKED_BY_EXTERNAL_DEPENDENCY |
| SC-02 | Worker Android/iOS application | PRD 2.1 | P1 (product) | No worker app repository | as SC-01 | - | - | Provide the repository | BLOCKED_BY_EXTERNAL_DEPENDENCY |
| SC-03 | Web Admin Panel | PRD 2.1 | P1 (product) | No admin web repository | as SC-01 | - | - | Provide the repository | BLOCKED_BY_EXTERNAL_DEPENDENCY |
| SC-05 | Cloud deployment | PRD 2.1, 11 | P0 | Free hosting plan; no staging/production split; no CI run recorded | Runbook written; Docker image builds and starts in production mode locally | Dockerfile unchanged; docs/qa/OPERATIONS_RUNBOOK.md | docker build (exit 0); container start: app-config 200, admin route 401 | Owner: paid plan, second environment, run CI | BLOCKED_BY_EXTERNAL_DEPENDENCY |
| SC-06 | Production monitoring and error alerts | PRD 2.1, 13 | P1 | Error-tracking tool is a dependency choice (Q-91) | Health endpoints, admin alerts, structured logs and runbook exist | docs/qa/OPERATIONS_RUNBOOK.md | - | Choose a tool; configure an uptime monitor | BLOCKED_BY_DECISION |
| SC-07 | Automated database backups | PRD 2.1, 13 | P0 | Backups live in Supabase | Backup + restore-drill procedure written | docs/qa/OPERATIONS_RUNBOOK.md | - | Owner: enable backups and run a restore drill | BLOCKED_BY_EXTERNAL_DEPENDENCY |
| SD-02 | Choose engagement type (full, part, daily, hourly, live-in) | PRD 5.2 | P1 | Engagement was not category-specific | See CAT-03/CAT-07 | as CAT-03 | scheduling.int-spec | Lists pending (Q-93) | PARTIALLY_FIXED |
| TS-06 | Complaint history per user | PRD 9.1 | - | No creator filter on tickets | creatorUserId filter | support module | scheduling.int-spec | - | FIXED_VERIFIED |
| TS-07 | Emergency-contact visibility by policy | PRD 9.1 | P2 | Reveal policy undecided (Q-86) | Reads audited | workers.service | small.items.int-spec | Client policy | BLOCKED_BY_DECISION |
| WD-02 | Profile photo on the card | PRD 5.3 | P1 | Photo upload disabled until PROFILE_PHOTO_MAX_BYTES is set on the service | Code and tests exist | worker-photo module | modules.workforce | Owner: set the variable; real-bucket photo test | BLOCKED_BY_EXTERNAL_DEPENDENCY |
| WD-04 | Verification badge | PRD 5.3 | P2 | Per-check badge design undefined | Card shows verified only | - | - | Client defines badges | BLOCKED_BY_DECISION |
| WK-02 | Profile photo upload, confirm, signature check, moderation | PRD 6.1 | P1 | Disabled by configuration (see WD-02) | as WD-02 | - | - | Owner action | BLOCKED_BY_EXTERNAL_DEPENDENCY |
| WK-04 | Malware scanning of documents | PRD 9 | P2 | Scanner requirement undecided (Q-89) | ClamAV adapter, fail-safe; check:providers scans the EICAR string when CLAMAV_HOST is set | integrations/malware; src/check-providers.ts | malware-scanner.spec; small.items.int-spec | Decide, deploy clamd, set CLAMAV_HOST | BLOCKED_BY_DECISION |
| WK-06 | Previous employer/reference captured (one or several) | PRD 6.1 | - | Only one previous employer could be stored | worker_references (max 5, unique mobile, audited staff read) | prisma migration 20261021090000; workers module | remaining.int-spec (2): set/replace/clear, duplicates, own number, >5, isolation, staff audited read, 401/403/404 | Contacting references is not specified | FIXED_VERIFIED |
| WP-04 | Expected salary (and period) | PRD 6.2 | P2 | Salary period undefined (Q-39) | Stored as an amount | - | - | Client | BLOCKED_BY_DECISION |
| WP-07 | Local-language readiness (data) | PRD 6.4 | P2 | Translated names are client content | Language reference + template language | - | - | Client supplies translations | BLOCKED_BY_DECISION |

## Totals

| Disposition | Findings |
|---|---|
| BLOCKED_BY_DECISION | 20 |
| BLOCKED_BY_EXTERNAL_DEPENDENCY | 15 |
| FIXED_VERIFIED | 11 |
| NOT_VERIFIED | 3 |
| PARTIALLY_FIXED | 6 |
| (total) | 55 |

## By audit priority

| Priority | BLOCKED_BY_DECISION | BLOCKED_BY_EXTERNAL_DEPENDENCY | FIXED_VERIFIED | NOT_VERIFIED | PARTIALLY_FIXED |
|---|---|---|---|---|---|
| P0 | 0 | 6 | 0 | 1 | 1 |
| P1 | 2 | 4 | 0 | 2 | 1 |
| P1 (product) | 0 | 4 | 0 | 0 | 0 |
| P2 | 18 | 1 | 0 | 0 | 4 |
| WAB-01 | Demo OTP session cannot authenticate server-side | Worker-app blockers 2026-10-14 | P0 | Fallback is frontend-only; server needs signed JWT + live session | Negative-path tests; test OTP refused in production (D-70) | env.validation.spec, worker.app.blockers.int-spec | worker.app.blockers (18) | Frontend must keep demo session out of release builds | FIXED_VERIFIED |
| WAB-02 | Authenticated worker flows verified over HTTP | same | P1 | Only 401s had been observed | HTTP walk with persistence, ownership, errors; attendance repeat documented as 201 | attendance.controller (doc), worker.app.blockers.int-spec | worker.app.blockers | - | FIXED_VERIFIED |
| WAB-03 | Opportunity detail route | same | P1 | Detail already exists as the booking detail | Canonical route documented (D-74); equality and privacy tests | booking.controller (OpenAPI text) | worker.app.blockers | - | FIXED_VERIFIED |
| WAB-04 | Categories and areas need login | same | P2 | Onboarding runs after OTP (D-75) | Kept protected; access matrix tests | controllers (OpenAPI text) | worker.app.blockers | - | FIXED_VERIFIED |
| WAB-05 | Support ticket subject | same | P2 | Contract had no subject | Optional `subject` (D-73), additive migration 20261026090000 | support dto/repository/service, schema, migration | support.api (subject block), worker.app.blockers | - | FIXED_VERIFIED |

## Found and fixed during remediation (not in the first audit)

* Heartbeat TTL bug (JB-01).
* Test-order dependency in `payment.api` (second fee code): assertion made order-independent.
* Module-boundary violation introduced by an engagement import: moved to `src/common/validation/engagements.ts`.
* Documentation exposed a weak admin password in the matrix: removed.

## Customer-app blockers (2026-10-13, round two)
Source: the customer app team's request list. Full table: `customer-app-api-blockers.md`; routes and examples: `customer-app-integration-handoff.md`; evidence: `customer-app-contract-test-results.md`.
* FIXED_VERIFIED: worker reviews + `ratingScaleMax`; typed success schemas (146 nullable types corrected, `app-config` and `reference-data` documented, real responses validated against the published OpenAPI); Home aggregate; address label/line2/state; interview list/detail/actions with `allowedActions` and `timeline`; worker slots.
* PARTIALLY_FIXED: price guidance (endpoint built, no approved price data, 404 until an admin enters bands); coordinates to area (admin-set centre and radius, no polygons); start date (used) but weekdays not stored; test customer (local seed only).
* BLOCKED_BY_DECISION: budget filter (Q-39), customer profile photo (not in FR-CUS), weekday availability, price-band owner.
* NOT_VERIFIED: Flutter integration, staging with real providers, Docker runtime pass for this round.
