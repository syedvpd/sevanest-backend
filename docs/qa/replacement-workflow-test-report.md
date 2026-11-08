# Replacement workflow test report

Date: 2026-11-08

## Final approved-decision verification (2026-11-09)

**Unit:** `npm test -- --runInBand --runTestsByPath src/modules/booking/booking.find-another-worker.spec.ts src/modules/payment/payment.order-recovery.spec.ts` — 2 suites passed, 8 tests passed.

**Focused integration, dedicated `_test` database:**

- Completed-interview successor/audit persistence: 1 passed, 25 skipped by test-name filter.
- Enabled reason, OTHER description, notes length, customer-only submission and scheduled reopen: 3 passed, 23 skipped by filter.
- Explicit refund approval, gateway recovery, approval audit, gateway-result audit, same-key replay, and changed-payload rejection: 4 passed across 2 suites, 49 skipped by filter.

The first broader run reproduced a PostgreSQL `23514` on `bookings_start_date_chk` because pre-service `REPLACED` rows lacked `start_date`. Migration `20261120110000_replaced_booking_before_start` and the marker update fixed that root cause; the focused failing scenario passed afterward. The broader three-suite run was not repeated after the fix. It had 4 failures/75 passes: the constraint failure (fixed and retested) plus three unrelated failures documented in `CURRENT_STATE.md`.

**Schema and static checks:** Prisma validation, Prisma client generation, typecheck, build, lint and full Prettier check passed. `docs/openapi.json` was regenerated from the built Nest module (273 paths).

**Live schema status:** user-authorized migration status reported 52 migrations and no pending migrations. A read-only ledger/schema check confirmed the new audit table, enabled RLS, the pre-service replacement marker and its constraint. No production application code was deployed.

## D-109 / D-110 implementation coverage

Added unit cases for Find Another Worker reason requirements, `OTHER` description validation, disabled reason rejection, saved request data, and preserved successor lifecycle. Integration assertions now cover API validation, enabled-reason enforcement, 500/501 notes boundary, durable request row, customer response, Admin booking-detail visibility, notification note confidentiality, and the explicit refund approval request/audit/gateway outcome with same-key replay and changed-payload rejection. These integration assertions remain NOT verified until the PostgreSQL/Redis-backed suites run successfully.

## Test coverage added

`test/integration/replacement.api.int-spec.ts` now covers replacement create, cancel and selection idempotency replay; changed-payload/key-reuse rejection; concurrent keyed creates and cancels; Admin selection replay; and the existing selection concurrency race, which asserts exactly one successor booking is linked to the original. `test/integration/booking.api.int-spec.ts` covers the Find Another Worker successor response and database link, original worker and completed interview retention, outbox/audit rows, same-key replay, duplicate successor rejection, scheduled interview behavior, and customer/Admin authorization.

Related unit tests run:

```text
npm test -- --runInBand --runTestsByPath src/modules/booking/booking.find-another-worker.spec.ts src/modules/booking/worker.opportunity-adversarial.spec.ts src/modules/payment/payment.order-recovery.spec.ts
```

Result: **3 suites passed, 33 tests passed, 0 failed**. The new `booking.find-another-worker.spec.ts` suite checks successor creation, original worker retention, transaction-client use for audit/alert/outbox, and duplicate successor rejection. The adjacent booking opportunity/payment recovery suites do not exercise replacement HTTP persistence or idempotency semantics.

## Results observed

Static/source checks: `npm run typecheck`, `npm run build`, `npm run lint`, `npm run prisma:validate`, and `npm run check:migrations` all exited 0. The Nest Swagger document was generated through `SwaggerModule.createDocument` into `docs/openapi.json` (273 paths). Node assertions parsed the generated file and verified 10 required replacement/Find Another Worker/Admin reason paths, `ReplacementDetailView.timeline`, `CreateReplacementDto.notes.maxLength = 500`, idempotency headers on create/cancel/select/reopen-matching, bearer security and standard 401/403/500 schemas on 11 operations, and pagination parameters on alternatives. This verifies generated local source metadata, not a live HTTP response or deployed specification.

Command run:

```text
npm run test:integration -- --runTestsByPath test/integration/replacement.api.int-spec.ts test/integration/booking.api.int-spec.ts test/integration/fees.catalogue.int-spec.ts test/integration/qa.statemachine.int-spec.ts
```

Result: **NOT verified**. Jest reported `Test Suites: 4 failed, 4 total` and `Tests: 68 failed, 68 total`. The failures occurred during app/database setup before workflow assertions. Docker Compose was unavailable (`permission denied` connecting to `npipe:////./pipe/dockerDesktopLinuxEngine`); Redis connections returned `EACCES` to both `::1:6379` and `127.0.0.1:6379`; Prisma `role.upsert()` failed in `RbacSeedService.ensureReferenceData`. Teardown also emitted failed Redis/Prisma connection errors. These are setup failures, not passing workflow evidence.

## Not run / not verified

- Integration tests were not successfully run against disposable PostgreSQL and Redis.
- No unit test suite exists under `src/modules/replacement`; the new booking-service unit tests do not exercise the replacement HTTP workflow or its persisted idempotency semantics. The repository has no unit spec for `IdempotencyService` either.
- Endpoint-level same-key replay, changed-payload rejection, concurrent request, and duplicate selection assertions are **not verified** until the integration suites run successfully.
- The actual `/api/v1/reference-data` HTTP response was not exercised. Source maps enabled database-backed reason settings to the public `replacementReasons` array.
- Notification outbox persistence is asserted by the blocked booking integration test; no live push/SMS delivery was attempted.
- No live API, staging API, or payment provider was accessed. In a subsequent user-authorized database follow-up, the single pending reason-settings migration was applied to the supplied Supabase database and a read-only query verified its six seeded catalogue rows; no other production data was queried or modified.

