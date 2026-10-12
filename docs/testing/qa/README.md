# Final QA - test results

Recorded from real runs on 2026-10-09 (Windows 11, Docker PostgreSQL 17 + Redis 7). Evidence and analysis: `docs/qa/`.

## Final tree, CI command sequence (clean copy, clean `*_ci` database)

| Step | Result |
|---|---|
| npm ci, prisma validate, prisma migrate deploy (empty DB) | exit 0 |
| lint, format:check, typecheck, build | exit 0 |
| Unit | 18 suites, 187 tests passed |
| E2E | 2 suites, 27 tests passed |
| Integration | 29 suites, 594 tests passed |

## QA suites (all inside the integration run)
`qa.inventory`, `qa.access`, `qa.adversarial`, `qa.journeys`, `qa.statemachine` (297/297 state x action x actor combinations), `qa.concurrency`, `qa.reports`.

## Other runs
Real built server + separate worker process: 42/42 checks. Production Docker image (migrate, api, worker, PostgreSQL, Redis): 42/42 checks. Performance and statement-count measurements: `docs/qa/PERFORMANCE_REVIEW.md`.

## Not run
GitHub Actions; real payment/SMS/push/WhatsApp/storage providers; load or soak tests.
