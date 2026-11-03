# 11 — Final verification report

Date 2026-11-02 to 2026-11-03. Branch `claude/sevanest-backend-audit-59ab64`, base `6e94a74`, working tree: eight fixes in two rounds, `docs/backend-quality-audit/` untracked. Machine-readable copy: `test-execution-summary.json`.

## Commands and actual results

| Group | Command | Total | Passed | Failed | Skipped | Notes |
|---|---|---|---|---|---|---|
| Type check | `npm run typecheck` | n/a | exit 0 | 0 | 0 | |
| Lint | `npm run lint` | n/a | exit 0 | 0 errors | 0 | 3 warnings, not inspected |
| Format | `npm run format:check` | n/a | exit 0 | 0 | 0 | |
| Unit | `npm test` | 417 (43 suites) | 417 | 0 | 0 | baseline was 402; +15 from the fixes |
| E2E | `npm run test:e2e` | 27 (2 suites) | 27 | 0 | 0 | readiness stub updated for F-012 |
| Integration, after the second fix round | `npm run test:integration` on fresh db `sevanest_bqa6_ci`, Redis db 13, valid test env file | 1,079 (71 suites) | 1,073 (67 suites) | 6 (4 suites) | 0 | the 4 suites pass 38/38 when rerun alone on fresh db `sevanest_bqa7_ci`; no single uninterrupted green run |
| Contract + customers | `contract.openapi`, `customers.api` | 62 | 62 | 0 | 0 | includes the new completeness test and address-cap test |
| Integration, full | `npm run test:integration` on fresh db `sevanest_bqa4_ci`, Redis db 10 | 1,077 (71 suites) | 1,040 (68 suites) | 37 (3 suites) | 0 | see below |
| Integration, rerun of the 3 | `users.api`, `notifications.api` on fresh db | 39 | 39 | 0 | 0 | |
| Integration, rerun | `foundation.int-spec` with a valid test env file | 11 | 11 | 0 | 0 | |
| Integration, fix regression | `security.api`, `qa.adversarial` | 42 | 42 | 0 | 0 | after F-004 |
| Route inventory | `qa.inventory` | 9 | 9 | 0 | 0 | 305 routes |
| OpenAPI contract | `contract.openapi` (inside the full run) | included | passed | 0 | 0 | no external linter run |
| Dependency outage | `failure.mjs` against the real app and throwaway containers | 4 phases x 6 requests | see 06 | 0 after fixes | 0 | |
| Performance, sequential | `perf-journeys.perf-spec` (10 iterations) | 2,238 requests | 0 5xx | | | see 05 |
| Load | `scripts/load/run.mjs` local | 4,728 requests | | 2 (readiness 503 at c=100) | | see 05 |

Why 37 failures in the full run: the workstation was suspended while the run was going (one suite reported 54,219 s), so 13 + 13 tests in `users.api` and `notifications.api` failed on hook timeouts; `foundation.int-spec` failed all 11 of its tests for its missing `.env` (G-02). All three pass when run alone. That is evidence the failures are environmental, **not** a single uninterrupted green pass of the whole suite. Earlier runs on a shared database or Redis showed 25 and then 7 failing suites; those are recorded in `AUDIT_PROGRESS.md` and were caused by overlapping runs and committed rows (G-01).

Not executed: any call to a live Razorpay, SMS, FCM, Google Maps or S3; any run against Supabase or Render; `npm audit`; an external OpenAPI linter; a soak or multi-instance test; a restore or migration rehearsal on production-like data.

## Findings summary

17 findings: P0 0, P1 0, P2 3 (all fixed), P3 14 (F-007, F-005, F-008, F-009, F-010 fixed; 9 open). Full list: `08_FINDINGS_AND_REMEDIATION_REGISTER.md`.

## Readiness by area (evidence-based)

| Area | Status | Why |
|---|---|---|
| Functional | VERIFIED WITH LIMITATIONS | 71 suites cover the flows and the 297-combination booking state machine; no live providers; PRD not re-derived |
| API | VERIFIED | validation, envelope, status codes, authorization strong; OpenAPI documents success and error responses on all operations, enforced by a test |
| Data | VERIFIED WITH LIMITATIONS | constraints and indexes sound (04); name search lacks a trigram index at scale (F-013); backups not verified |
| Performance | VERIFIED WITH LIMITATIONS | local numbers meet the initial and mostly the stretch targets sequentially; concurrency and hosted behaviour not established; readiness starvation (F-012) fixed |
| Reliability | VERIFIED WITH LIMITATIONS | DB and Redis outage proven after two fixes; fail-open limiter is a decision; queues by tests only |
| Security | VERIFIED WITH LIMITATIONS | no critical or high finding; production config, real providers, dependency scan not verified |
| Operational | NOT VERIFIED | monitoring, alerting, backup and rollback not observable from the repository |

**Overall: VERIFIED WITH LIMITATIONS. Not declared production-ready.** The backend is in good condition: no P0/P1 defect was found, and the defects found were in outage handling (now fixed) and documentation. The gaps that stand between this and a production-ready claim are listed in 10: provider and storage integration tests with real accounts, a hosted performance and load test, the readiness-probe design (F-012), operational setup (worker process, alerts, backups), and four business decisions.

## Remaining risks, ranked

2. No live verification of S3 policy, Razorpay signatures, SMS and FCM; first real use will be the first test.
3. Single-process throughput observed locally was about 55 to 65 requests per second with 6 to 26 statements per request; pool size and instance count need a sizing run on the target hardware.
4. Worker process is mandatory for notifications, payment recovery, claim release and retention; if not deployed, those silently do nothing (readiness reports heartbeats).
5. General rate limiting fails open when Redis is down (G-07).
6. Pool size (default 10, not set in `render.yaml`) versus the Supabase connection limit was not reviewed.
