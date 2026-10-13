# SevaNest backend: V1 acceptance report (2026-10-13)

## Verdict: NOT ACCEPTANCE READY
The backend implements and tests every mandatory V1 workflow on a local database with fake providers. Acceptance is not reached because real providers, the mobile and admin clients, the deployed environment, client policy decisions and operational evidence are still outstanding (list below). No requirement is reported complete on the strength of a route or model alone.

## Evidence base
Full local run 2026-10-13, disposable PostgreSQL 17 and Redis 7, fake SMS/payment/push adapters: integration 47 suites / 818 tests, unit 29 suites / 270 tests, e2e 2 suites / 27 tests, all passed; lint, typecheck and prettier clean; fresh-database migrations apply and `prisma migrate diff` reports no drift; Docker image builds and the compose stack starts, migrates, seeds and answers health and authenticated requests. Load test: `capacity-assessment.md`.

## Requirements assessed
* Customer app §5.1 to §5.6: 46 individual rows, `customer-screen-api-traceability.md`.
* Worker app §6.1 to §6.4: 32 individual rows, `worker-screen-api-traceability.md`.
* Total screen-level rows: **78**.

| Status | Customer | Worker | Total |
|---|---|---|---|
| PASS_VERIFIED | 34 | 21 | **55** |
| PARTIAL | 3 | 3 | 6 |
| BLOCKED_BY_DECISION | 5 | 3 | 8 |
| BLOCKED_BY_EXTERNAL_DEPENDENCY | 4 | 4 | 8 |
| NOT_VERIFIED | 0 | 1 | 1 |
| MISSING / FAILING | 0 | 0 | 0 |
PASS_VERIFIED means: implemented, exercised by an automated API test with the named test title, and passing, against fake providers. It does not mean the Flutter screen works.

## Shared V1 scope items (PRD 2.1)
| # | Item | Code | Automated and API tests | Real provider / deployed | Status |
|---|---|---|---|---|---|
| 1 | OTP authentication | yes | yes | real SMS never run | PARTIAL (SMS BLOCKED_BY_EXTERNAL_DEPENDENCY) |
| 2 | Customer and worker profiles, multi-step onboarding with progress endpoints | yes | yes | n/a | PASS_VERIFIED |
| 3 | Service-category selection, per-category engagement types | yes | yes | n/a | PASS_VERIFIED |
| 4 | Location and availability filtering (time, start date, busy hours) | yes | yes | weekdays not stored | PARTIAL (BLOCKED_BY_DECISION Q-96) |
| 5 | Worker KYC upload and verification | yes | yes | S3 bucket reachable once; malware scanner never run live | PARTIAL |
| 6 | Search and matching | yes | yes | load-tested locally | PASS_VERIFIED |
| 7 | Interview / trial request | dedicated entity and workflow | yes (18 interview tests plus scheduling) | n/a | PASS_VERIFIED |
| 8 | Booking and confirmation, double-booking rule | yes | yes | n/a | PASS_VERIFIED |
| 9 | Payment gateway integration | Razorpay adapter built | fake gateway only | sandbox never run, no keys | BLOCKED_BY_EXTERNAL_DEPENDENCY |
| 10 | Attendance and status tracking | yes | yes | n/a | PASS_VERIFIED |
| 11 | Ratings and reviews, moderation | yes | yes | n/a | PASS_VERIFIED |
| 12 | Replacement workflow | yes | yes | n/a | PASS_VERIFIED |
| 13 | Support and complaint tickets | yes | yes | n/a | PASS_VERIFIED |
| 14 | Push, SMS, optional WhatsApp | adapters built (FCM, MSG91, Twilio, WhatsApp) | fakes and unit tests | FCM credentials authenticate with Google; no real device delivery; SMS and WhatsApp never run | BLOCKED_BY_EXTERNAL_DEPENDENCY |
| 15 | Dashboards and reports | 12 reports, CSV | yes | n/a | PASS_VERIFIED |
| 16 | Role-based admin access | yes | yes | n/a | PASS_VERIFIED |
| 17 | Cloud deployment, TLS, monitoring, backups, recovery | Render blueprint, Docker, Sentry error reporting, backup and restore scripts | restore tested locally | TLS verified (1.3, HSTS, redirect); Sentry project and uptime monitor live; DSN not yet on Render; Supabase backup schedule and a Supabase restore drill not verified | PARTIAL |

## Journeys exercised end to end (API level, separate customer, worker and admin identities)
* **Customer:** OTP login, profile and addresses, search, shortlist, booking, interview or trial, worker confirmation, booking fee through the fake gateway, start, attendance, rating, replacement, support ticket. (`booking.api` whole-state-model test, `interview.int-spec`, `onboarding.int-spec`, `appgaps2`, `contract.openapi`.)
* **Worker:** OTP registration, step-by-step profile and availability, KYC upload and submission, admin approval, opportunity feed, accept, decline or propose a slot, interview, confirmation, attendance, ratings, support.
* **Admin:** verification queue approve, reject and recheck, booking and interview operations, matching, payments and reconciliation views, attendance correction, rating moderation, support handling, reports, audit log, configuration masters.
None of these was run through the Flutter or React clients (they are not in this repository): screen-to-network integration is **NOT_VERIFIED**.

## Remaining acceptance blockers
1. **External dependencies:** real SMS, WhatsApp, Razorpay (sandbox then live), FCM delivery to devices (needs the apps and the APNs key), storage and malware scanner exercised for real; operational TLS, monitoring, alerting, scheduled backups and a restore drill.
2. **Client decisions:** Q-77 to Q-99 in `docs/project-intelligence/OPEN_QUESTIONS.md` (price bands, budget filter, weekday availability, customer photo, map boundaries, interview length and horizon, refund and cancellation-fee policy, retention periods, emergency-contact reveal, MFA and erasure).
3. **Clients:** Flutter customer and worker apps and the React admin are separate repositories; their integration is unverified.
4. **Owner actions:** rotate the Firebase service-account key that was pasted into a chat; replace the weak Super Admin password set during testing; set the support contact values; rotate any secrets that were shared.
5. **Capacity:** not proven beyond the local test (`capacity-assessment.md`); write paths and multi-replica behaviour unmeasured.

## Deliverables and where they are
Inventory `prd-requirement-inventory.md`, matrix `prd-implementation-matrix.md`, workflows `end-to-end-workflow-matrix.md`, traceability `customer-screen-api-traceability.md`, `worker-screen-api-traceability.md`, `data-api-traceability.md`, negative paths `negative-path-register.md`, `customer-negative-path-results.md`, `worker-negative-path-results.md`, results `phase-verification-results.md`, `customer-app-contract-test-results.md`, readiness `production-readiness-matrix.md`, closure `closure-register.md`, `remaining-gap-backlog.md`, capacity `capacity-assessment.md`, app-team handoff `customer-app-integration-handoff.md`.

## Status vocabulary
Older documents use FIXED_VERIFIED, PARTIALLY_FIXED and NOT_FIXED. Mapping: FIXED_VERIFIED = PASS_VERIFIED, PARTIALLY_FIXED = PARTIAL, NOT_FIXED = MISSING or FAILING; the blocked and not-verified names are unchanged.
