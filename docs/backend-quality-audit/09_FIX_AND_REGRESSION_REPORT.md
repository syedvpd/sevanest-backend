# 09 — Fix and regression report

Eight fixes in two rounds, all in the working tree of branch `claude/sevanest-backend-audit-59ab64` (base `6e94a74`). **Nothing is committed.** First-round files: `src/common/errors/all-exceptions.filter.ts` and spec, `src/common/csv/csv.ts` and spec. Second-round files are listed in the second section. No schema, migration, dependency or configuration change in either round.

## F-004 — database outage answered 500 instead of 503 (P2)

**Change.** `AllExceptionsFilter` now answers **503 `SERVICE_UNAVAILABLE`** (message "Service temporarily unavailable", no internals) when the thrown error is an outage rather than a defect:

- any error whose `code` is a network errno: `ECONNREFUSED`, `ECONNRESET`, `ETIMEDOUT`, `EPIPE`, `ENOTFOUND`, `EAI_AGAIN`, `EHOSTUNREACH`, `ENETUNREACH` (Prisma wraps model and raw queries as `PrismaClientKnownRequestError` with this code; interactive transactions raise an `AggregateError` with it);
- Prisma `P1001`, `P1002`, `P1008`, `P1017`, `P2024`;
- raw-query `P2010` whose PostgreSQL code is `N/A` or class 08, 28, 53, or 57P01/02/03;
- `PrismaClientInitializationError`;
- the exact pg driver messages `Query read timeout`, `timeout exceeded when trying to connect`, `Connection terminated unexpectedly`, `Connection terminated due to connection timeout`.

It is logged as one handled warning (no stack, not sent to Sentry), like the existing provider-outage 503. Everything else stays 500 + Sentry, including a raw query that fails with a normal SQL error (`42601`) and a plain `Error` whose text merely mentions `ECONNREFUSED`.

**Correction to my own earlier report.** The first version of this fix covered only `P2010`, based on a probe that used `$queryRaw`. It passed its unit tests but did **not** fix the real outage: the end-to-end run still returned 500 for every database request. The real error shapes (errno code on a `PrismaClientKnownRequestError`; `AggregateError` for transactions) were found by stopping a real database, and the filter was extended. The end-to-end result below is the evidence that counts.

**Consumers.** Only failure paths change status (500 to 503), same envelope and `requestId`. A client that retries on 5xx is unaffected; a client that special-cases 500 should also handle 503.

**Evidence.**

| Check | Result |
|---|---|
| Real app, PostgreSQL container stopped | before: 500 on public read, authenticated read, `customers/me`, OTP request; after: 503 `SERVICE_UNAVAILABLE` on all four, in 5 to 29 ms; `/health/ready` 503, `/health/live` 200 |
| PostgreSQL restarted | all routes back to 200 without restarting the app |
| `all-exceptions.filter.spec.ts` | 25 tests (was 10), including the errno-coded Prisma error, the AggregateError, `ECONNRESET`, pg and ioredis messages, and the negative cases |
| `security.api`, `qa.adversarial` | 42/42 pass |

## F-011 — Redis down answered 500 on login (P2)

**Change.** Same filter. `ioredis` is created with `enableOfflineQueue: false`, so a command sent while Redis is down or reconnecting throws a plain `Error` with the exact message `Stream isn't writeable and enableOfflineQueue options is false` or `Connection is closed.`. Those two messages are now 503.

**Evidence.** Real app, Redis container stopped: `POST /auth/otp/request` was 500 INTERNAL_ERROR, is 503 SERVICE_UNAVAILABLE (214 ms); reads that do not need Redis stay 200; readiness 503; after restart OTP request 200. Unit tests for both messages.

## F-007 — negative numbers exported to CSV as text (P3)

**Change.** `csvCell` no longer prefixes numeric values with the formula-guard apostrophe; strings that start with `= + - @ tab CR` are still neutralised.

**Evidence.** Before: `csvCell(-5)` returned an apostrophe-prefixed string (probe on the built code). After: `csv.spec.ts` asserts `csvCell(-5) === '-5'`, `csvCell('-5')` and `csvCell('=1+1')` still guarded. 3 tests pass.

## Regression evidence for all three

| Gate | Result |
|---|---|
| `npm run typecheck` | exit 0 |
| `npm run lint` | exit 0, 0 errors, 3 warnings (not inspected, same count as baseline) |
| `npm run format:check` | exit 0 |
| `npm test` | 43 suites, **417 tests pass** (baseline 402) |
| Full integration run on a fresh database | 68 of 71 suites pass; the other 3 pass when rerun (see 11) |

## Still open after both rounds

F-001, F-002, F-003, F-006, F-013, G-01, G-02 (engineering, queued in 08); G-07 and G-08 (decisions D-B and D-C). The address cap number (20) and unknown-field rejection (D-D) may still be changed by the owner.

## Second round of fixes (requested after the first report)

Files: `src/infrastructure/database/prisma.service.ts`, `src/infrastructure/observability/health/health.controller.ts`, `src/common/swagger/api-schema-responses.ts` (new), `src/common/swagger/error-responses.ts` (new), `src/app.setup.ts`, 13 controllers (response decorators only), `src/modules/customers/customer-addresses.service.ts`, `customers.repository.ts`, `customers.controller.ts`, `docs/openapi.json` (regenerated), and tests `test/e2e/foundation.e2e-spec.ts`, `test/support/test-app.ts`, `test/integration/customers.api.int-spec.ts`, `test/integration/contract.openapi.int-spec.ts`. No schema migration, no dependency change.

### F-012 — readiness probe starved by traffic (P2)

**Change.** `PrismaService.ping()` runs `SELECT 1` on its own single-connection `pg` pool (2 s connect and query timeout, error listener so an idle drop cannot crash the process). `DependencyHealth.database()` calls it instead of `$queryRaw` on the shared 10-connection pool. A dead database still fails the probe; a busy pool no longer does.

**Evidence.**

| Check | Before | After |
|---|---|---|
| Concurrency 100, two 25 s stages on the 100,000-user dataset: readiness calls | 49 calls, **2 returned 503**, health p50 557 ms | 137 calls, **0 errors**, health p50 15 and 16 ms, p95 311 and 114 ms |
| PostgreSQL container stopped | 503 | 503 (200 ms), 200 again after restart |
| `test:e2e` | | 27/27 (the stub gained `ping`; the failing-database test now rejects `ping`) |

The load numbers for the other routes are unchanged (about 57 requests per second at 100 clients, p95 3.3 s): F-012 fixed the probe, not the capacity of one process on this laptop.

### F-005 — no cap on saved addresses (P3)

**Change.** `POST /customers/me/addresses` answers **422 `ADDRESS_LIMIT_REACHED`** when the customer already holds 20 active addresses (`MAX_ACTIVE_ADDRESSES`, an engineering default; the owner can change the number). The count runs inside the existing transaction that locks the customer row, so parallel creates cannot exceed it. Deleted (inactive) addresses do not count. The 422 is documented on the operation. The list endpoint is bounded by the same cap (at most 20 rows).

**Evidence.** New test in `customers.api.int-spec.ts`: 19 addresses, then three parallel creates give exactly one 201 and two 422 `ADDRESS_LIMIT_REACHED`; the database holds 20; after a delete a new create succeeds; the list returns 20. Before the change the probe created 120 of 120.

**Client impact.** A customer at 20 addresses now gets 422 instead of 201. No existing client creates that many; the Customer app should show the message ("delete one to add another").

### F-008, F-009, F-010 — OpenAPI completeness (P3)

**Change.**
- `addStandardErrorResponses()` (applied in `configureApp` to the generated document) adds to every operation, without overwriting anything an operation declares: **400** when it takes input (body, query or path), **401 and 403** when it is protected, **404** when it addresses a resource by id, **429** and **500** on every API operation, **503** on every operation except the liveness probe. All carry the shared `ApiError` schema (`code`, `message`, `details[]`, `requestId`), registered once in `components.schemas`. Errors an operation declares itself (for example the new 422) get the same body.
- 19 operations that had a 2xx without a schema now have one: audit-log search (page of `AuditLogView`), admin password reset, alert summary, own deletion request (nullable model), admin password change, worker and customer photo confirm, notification health, mark-all-read, receipt PDF and the two CSV exports (file responses), payment exceptions list and resolve, system readiness, retention preview, report catalog, dashboard, and the liveness probe.
- `GET /admin/notification-events` is now documented as `EventView[]` (it returned an array but was documented as a page of `TemplateView`).
- `docs/openapi.json` was regenerated from the running app.

**Evidence.**

| Check | Before | After |
|---|---|---|
| Operations | 304 | 304 (302 API + 2 health; the payment webhook stays hidden) |
| Operations documenting an error response | 0 | 303 (all but `GET /health/live`, which cannot fail) |
| Documented responses | 2xx only | 200 ×251, 201 ×37, 204 ×16, 400 ×258, 401 ×295, 403 ×295, 404 ×155, 422 ×1, 429 ×302, 500 ×302, 503 ×303 |
| 2xx without a body schema (excluding 204) | 19 | 0 |
| `contract.openapi.int-spec` | 2 tests | 3 tests: new test fails if any operation lacks a success body schema or 204, a 500/503, 401/403 on protected routes, 404 on id routes, or an error body schema |

Limit: the generic statuses say what an operation can return. Domain-specific codes (for example `INVALID_TRANSITION`, `OTP_INVALID`) are listed in the `ApiError.code` description, not per operation; documenting each per operation would be a per-endpoint product task.

### Regression evidence for the second round

| Gate | Result |
|---|---|
| `npm run typecheck` | exit 0 |
| `npm run lint` | 0 errors, 3 warnings (same as baseline) |
| `npm test` | 43 suites, 417 tests pass |
| `npm run test:e2e` | 27 pass |
| `contract.openapi` + `customers.api` | 62 pass (includes the new address-cap and completeness tests) |
| Full integration run on a fresh database | see 11 |
