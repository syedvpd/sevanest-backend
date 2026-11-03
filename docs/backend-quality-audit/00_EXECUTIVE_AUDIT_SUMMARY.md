# 00 — Executive audit summary

SevaNest backend, branch `claude/sevanest-backend-audit-59ab64`, base commit `6e94a74`. Audit period 2026-11-02 to 2026-11-03. Evidence for every statement below is in files 01 to 11 and the CSV/JSON artifacts in this folder.

## Overall condition

**Good, with no critical or high defect found. Not declared production-ready.** The reasons are what could not be verified (real providers, hosted performance, operations), not defects found.

- 305 HTTP routes are registered (303 API + 2 health) and 304 are in the OpenAPI document; the only difference is the hidden payment webhook. The brief's "252 operations / 19 modules / NestJS 12 / TypeScript 6" does not match the repository (303 API routes, 31 modules, NestJS 11.2.7, TypeScript 5.9.3).
- Quality gates on the unchanged tree: typecheck, lint (0 errors), format pass; 402 unit tests pass. After the fixes: 417 unit tests, 27 e2e tests pass.
- 71 integration suites (1,077 tests) already existed and cover validation, state machines, concurrency, authorization, payments and recovery. In the final full run 68 suites passed; the other 3 passed when rerun alone (the run was disturbed by a workstation suspend and one suite needed a `.env` it does not load). There is no single uninterrupted green run; see 11.
- 17 findings: P0 0, P1 0, P2 3, P3 14. Eight were fixed in two rounds: F-004, F-011, F-012 (all P2), F-007, F-005, F-008, F-009, F-010. See 09.

## What the audit actually found

| Result | Finding |
|---|---|
| **Fixed, P2** | Database or Redis outage returned **500 INTERNAL_ERROR** (and a Sentry event per request). Proven end to end by stopping real containers; now **503 SERVICE_UNAVAILABLE** and the app recovers on restart without a restart of the API. My first fix was not enough and the end-to-end test caught it (F-004, F-011; 09). |
| **Fixed, P3** | CSV export wrote negative numbers as text (F-007). |
| **Fixed, P2** | The readiness probe, which Render uses as its health check, shared the 10-connection database pool and answered 503 twice in 49 calls at 100 clients. It now has its own connection: 137 calls, 0 errors (F-012). |
| **Fixed, P3** | OpenAPI now documents success and error responses on every operation (303 of 304; the liveness probe cannot fail) with a shared `ApiError` schema, the 19 untyped responses have schemas, and a contract test enforces it (F-008 to F-010). Saved addresses are capped at 20 with 422 `ADDRESS_LIMIT_REACHED` (F-005; the number is an engineering default). |
| Open, P3 | Admin name search is a sequential `ILIKE '%x%'` scan with no trigram index: 66 to 108 ms warm at 80,000 customers, grows linearly (F-013, migration proposed not applied). One unbounded N+1-style list (F-001). Stale load seed (F-006). |
| Decisions needed | Confirm the address cap of 20 (D-A), rate limiter fail-open when Redis is down (D-B), whether viewing a KYC document needs the review claim (D-C), strict rejection of unknown JSON fields (D-D). |

## Module status

| Module group | Status | Basis |
|---|---|---|
| Platform: auth, users, guards, validation, errors | VERIFIED WITH LIMITATIONS | OTP, token, admin login, authorization and error envelope tested; outage handling fixed |
| Customers, workers, addresses, availability | VERIFIED WITH LIMITATIONS | ownership, races, mass assignment tested; F-005 |
| Categories, search, matching, shortlist | VERIFIED WITH LIMITATIONS | 6 categories; search 34.5 ms exec at 20k workers, p50 102 ms at 100k users |
| Verification / KYC | VERIFIED WITH LIMITATIONS | upload checks, hashing, audited links; real storage not tested |
| Booking, interviews | VERIFIED WITH LIMITATIONS | 297-combination state machine, idempotency, double-booking, races |
| Payments, refunds, attendance | VERIFIED WITH LIMITATIONS | signature, amount, duplicate, recovery, refund tests; fake gateway only |
| Replacement, ratings, support | VERIFIED WITH LIMITATIONS | uniqueness, ownership, concurrency tests |
| Admin, dashboard, reports, exports | VERIFIED WITH LIMITATIONS | permission matrix, read-only reports, capped exports |
| Notifications, queues, integrations | VERIFIED WITH LIMITATIONS | outbox, retry, dead-letter by tests; no live provider or worker-kill |

Detail per batch: `03_MODULE_NEGATIVE_TEST_REPORT.md`.

## API inventory

Route totals, public/authenticated/permission classes and the OpenAPI diff are in 01, 02 and `endpoint-inventory.csv` (305 rows with method, path, controller, handler, user types, permissions, roles, OpenAPI presence). 20 authenticated routes carry no user-type gate (self-service reads); 10 are public.

## Performance summary (local, synthetic, not production)

- Sequential, 2,238 requests over 206 operations: p50 25 ms, p95 99.5 ms, p99 509 ms (hashing operations dominate the tail). 93 of 100 GETs have p95 under 100 ms.
- Targets: lightweight reads, search, worker reads, booking list, admin dashboard meet initial and stretch targets sequentially; customer home meets the initial target and the stretch target at p50 only (p50 68, worst of 10 262 ms).
- Concurrency (one laptop, one Node process, 10-connection pool): about 55 to 65 requests per second; p95 above 1 s from 50 clients; readiness 503 at 100. This is a local saturation point, not a production capacity figure.
- No hosted (Render) measurement was made; no authorization was given.

## Reliability and security summary

- PostgreSQL stopped: readiness 503, liveness 200, all DB routes 503 in 5 to 29 ms, full recovery on restart. Redis stopped: reads keep working, OTP 503, readiness 503, recovery on restart. The general rate limiter fails open (decision D-B).
- No finding allows authentication bypass, cross-user data access, privilege escalation or payment tampering. KYC files are in a private bucket with audited, hash-checked, short-lived links. The test-OTP shortcut cannot run in production.

## Production readiness gate

See `10_PRODUCTION_READINESS_GAP_REGISTER.md` and `11_FINAL_VERIFICATION_REPORT.md`. Functional, API, data, performance, reliability and security: VERIFIED WITH LIMITATIONS. Operational: NOT VERIFIED. **Overall: VERIFIED WITH LIMITATIONS.**

Before a real launch: run the S3, Razorpay, SMS and FCM tests with real test accounts; run a hosted and a load test with an authorized plan; confirm the worker process, alerts, backups and rollback; take the four decisions; review the eight fixes.

## Files in this folder

`00` this summary, `01` inventory, `02` API contract, `03` negative test report by batch, `04` database and query audit (+ `04_query_counts_per_route.json`), `05` performance (+ `05_api_performance_baseline.csv`, `perf-out/`), `06` reliability, `07` security, `08` findings (`.md` and `.csv`), `09` fixes, `10` readiness gaps, `11` final verification, `AUDIT_PROGRESS.md`, `endpoint-inventory.csv`, `openapi-validation-report.json`, `test-execution-summary.json`.
