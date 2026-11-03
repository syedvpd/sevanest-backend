# 08 — Findings and remediation register

Machine-readable copy: `08_FINDINGS_AND_REMEDIATION_REGISTER.csv`. No P0 or P1 finding. Classes follow the brief: confirmed defect, probable defect, design weakness, optimization, documentation gap, business decision, test hygiene.

| ID | Sev | Class | Status | Component | Summary |
|---|---|---|---|---|---|
| F-004 | P2 | confirmed defect | fixed (uncommitted) | common/errors/all-exceptions.filter.ts (AllExceptionsFilter.map) | Database unreachable, wrong DB credentials and query timeouts were answered 500 INTERNAL_ERROR and sent to Sentry per request. My first fix (from a raw-query probe, code P2010) was insufficient: real pg-adapter errors carry the errno as the Prisma error code (ECONNREFUSED) and transactions raise AggregateError. |
| F-011 | P2 | confirmed defect | fixed (uncommitted) | same filter; ioredis with enableOfflineQueue=false | With Redis stopped, POST /auth/otp/request returned 500 INTERNAL_ERROR (ioredis plain Error: Stream is not writeable and enableOfflineQueue options is false). |
| F-012 | P2 | probable defect (observed locally, not reproduced on Render) | fixed (uncommitted) | health.controller.ts (readiness uses the shared DB pool, 2 s timeout); render.yaml healthCheckPath=/health/ready; DATABASE_POOL_MAX default 10 | Under 100 concurrent clients on one Node process the readiness probe returned 503 twice in 49 calls because its SELECT 1 waited for a pool connection longer than 2 s. Render uses this endpoint as the health check, so load can make an instance look unhealthy and amplify the overload. |
| F-007 | P3 | confirmed defect | fixed (uncommitted) | common/csv/csv.ts csvCell | Negative numbers were exported as text with a leading apostrophe because the formula guard also prefixed numbers. |
| F-001 | P3 | design weakness | open | safety/safety.service.ts listMine | Unbounded userBlock.findMany and one findRefByUserId query per row for customers (N+1). |
| F-002 | P3 | optimization | open | customers.repository listAllAddresses; support.repository events() | findMany without take; bounded by per-owner volume. |
| F-003 | P3 | documentation | open | project briefing | Briefing says NestJS 12, TypeScript 6, 252 operations, 19 modules. Repo: NestJS 11.2.7, TypeScript 5.9.3, 303 API routes (+2 health), 31 modules. |
| F-005 | P3 | design weakness (needs business decision) | fixed (uncommitted); cap 20 is an engineering default | customer-addresses.service create/list | No cap on saved addresses; the list is unpaginated; each create without coordinates can trigger a geocode call. |
| F-006 | P3 | confirmed defect (test tooling) | open | scripts/load/seed.sql | Seed does not set activated_at / verification_signed_off_at, so seeded workers are invisible to search; old search timings in docs/qa/PERFORMANCE_REVIEW.md predate the gate. |
| F-008 | P3 | documentation gap | open | all 304 operations | No operation documents any error response (401/403/400/404/409/429/503) or the error envelope. |
| F-009 | P3 | documentation gap | open | 19 operations | 2xx responses without schema: audit-logs, password-reset, alerts summary, deletion-request, photo confirm x2, notifications health/read-all, receipt pdf, payments-export, payment exceptions x2, readiness, retention preview, reports x2, dashboard, health live. |
| F-010 | P3 | documentation defect | open | GET /admin/notification-events (notifications.controller.ts) | Documented as a page of TemplateView; the handler returns a plain array of EventView. |
| G-07 | P3 | design decision (D-B) | open | THROTTLE_STORAGE=redis | General rate limiter fails open when Redis is down (public requests answered 200 in 12-22 ms). OTP-specific limits fail closed with 503. |
| G-08 | P3 | business decision (D-C) | open | verification.service documentLink | Any admin with verification.document.view can open any worker KYC document without holding the review claim. Every view is audited and integrity-checked. |
| G-01 | P3 | test hygiene | open | test/integration (shared database and Redis) | Suites commit rows and default to Redis db 0: on a dirty database or with other sessions on the same Redis, six suites failed (verification queue 100-row page, template FK, queue jobs). All passed on a fresh database with a separate Redis index. |
| G-02 | P3 | test hygiene | open | test/integration/foundation.int-spec.ts | Imports dotenv/config only; fails (22 tests) without a .env. Passes 11/11 with a valid test env file. |
| F-013 | P3 | optimization opportunity | open - proposal in 04, not applied | Admin name filters (customers.repository, workers.repository, verification.repository, booking.repository) | Name filters use ILIKE %x% with no trigram index; sequential scan grows linearly: 66-108 ms warm at 80,000 customers, 186 ms at 20,000 workers. |

## Counts

- P0: 0. P1: 0. P2: 3 (F-004, F-011, F-012: all fixed). P3: 14.
- Fixed in the working tree (uncommitted): F-004, F-011, F-012, F-007, F-005, F-008, F-009, F-010 (8 of 17).
- Still open: F-001, F-002, F-003, F-006, F-013, G-01, G-02, and two business decisions: G-07 (D-B) and G-08 (D-C). The address cap in F-005 is 20, an engineering default the owner may change (D-A).
- Per finding: evidence, recommended fix and regression test are in the CSV columns `evidence`, `recommended_fix`, `regression_test`.
