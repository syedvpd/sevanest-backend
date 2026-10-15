# Performance optimisation report

Scope: the Render deployment at `https://sevanest-backend.onrender.com` (free tier, Supabase database). Everything below was measured **locally** on a
disposable database; nothing was deployed, committed, migrated on staging, or written to Render.
Per-endpoint figures are in [performance-optimization-results.csv](performance-optimization-results.csv).

## 1. What the baseline really says

* The client-to-Render network floor is **81 ms** (`GET /health/live` p50). Almost every endpoint sits at 100-145 ms p50, so **server time is
  about 20-60 ms**; the "p50 below 100 ms" target cannot be shown from this client. It needs server-side timing (section 3).
* Slow tails are single samples (0.5-1.1 s) on unrelated endpoints: shared-infrastructure noise, not one slow query.
* Two endpoints are consistently slower than their peers and are **not explained yet**: `GET /admin/deletion-requests` (p50 232 ms) and
  `GET /admin/payments/{paymentId}` (p50 268 ms).
* Admin login 2.94 s is one sample of scrypt on a throttled CPU.

## 2. Findings and changes

| Endpoint | Baseline (Render) p50 / p95 / p99 | Root cause | Change | After (local, measured) | Status |
|---|---|---|---|---|---|
| `GET /search/workers/{id}/slots` | 198 / 690 / 690 ms, 1 of 15 calls HTTP 500 | One availability query **per slot**, all fired at once (6 for a 6-slot day, a dozen on a long day) against a pool of 10 | One `unnest` statement reusing the same busy rule | busy-check statements 6 -> 1; 0 errors in 80-108 calls at 10/25/50 concurrent clients | Fixed locally. See caveat below |
| Every authenticated request | n/a | 6 **sequential** statements before the handler (session, user, user_roles, roles, role_permissions, permissions) | Two joins (session+user, roles+permissions); still read from the database on every request | `admin/roles` 9 -> 5, `admin/bookings` 10 -> 6 statements | Fixed locally; Render gain unmeasured until deployed |
| Password hashing (4 endpoints) | login 2939 ms (n=1) | scrypt N=2^17, 128 MiB, slow by design on a small CPU | Strength **unchanged**. At most 2 derivations at once | local login p50 304 ms (the 30% drop vs the recorded 439 ms is machine noise: hash work is identical) | No latency change by design |
| `GET /admin/dashboard` | 143 / 1135 / 1135 ms | 5 report counts, each in its own READ ONLY transaction (4 round trips each) | None: the READ ONLY guarantee is deliberate | 27 -> 26 statements, 35 ms | Left; cache option below |
| 12 spiky endpoints (`/admin/permissions`, `/bookings`, `/interviews/{id}`, `/admin/service-categories`, `/admin/reports/demand-by-area`, `/admin/reports/new-customers`, `/admin/verification/queue`, `/admin/ratings/{id}`, `/legal/status`, `/admin/safety/blocks`, `/customers/me/home`, ...) | p50 99-123 ms, one 0.6-1.1 s sample each | Shared infrastructure (one slow call each, on unrelated routes). Locally every one is 10-35 ms | Gain from the auth change only | 14-35 ms p50 | Not reproducible locally |
| `GET /admin/deletion-requests` | 232 / 535 / 535 ms | Not the application: locally 4 statements (2 auth, list, count), 8.8 ms; indexes `(status, requested_at)` and `(user_id, requested_at)` exist | none | 4 statements, 7.6 ms db time | Insufficient evidence for Render; needs `REQUEST_TIMING_LOG` there |
| `GET /admin/payments/{id}` | 268 / 408 / 408 ms | Not the application: locally 3 statements (2 auth, one primary-key read) plus pure mapping, 7.7 ms; no relations loaded | none | 3 statements, 5.3 ms db time | Insufficient evidence for Render; same |
| `GET /search/workers` | not measured on Render | One statement. On a freshly seeded 100k-user database it ran 451 ms because planner statistics were missing; after `ANALYZE` it is about 35 ms planning + 33 ms execution (1,334 candidates, 29.5k buffer hits, all index scans). Under concurrency the limit is Postgres CPU (section 8), not Node | none: no index is justified, ranking and eligibility untouched | sequential 24 ms; concurrent p50 199 / 415 / 789 ms at 10 / 25 / 50 clients (after ANALYZE; the same as before it) | Documented; needs a decision |

**Caveat on the slots 500.** The exception is already logged with the request id and stack by the global filter, but this session cannot read the
Render logs, so the exact exception was **not seen**. The per-slot fan-out is the strongest local explanation (pool contention on a small host)
and is removed, with a regression test that fails on the old code (6 statements) and passes on the new (1). If a 500 still appears on Render,
search the log for the response's `requestId` (the `X-Request-Id` header and the `requestId` field of the error body).

## 3. Instrumentation added (off by default)

`REQUEST_TIMING_LOG=true` writes one structured line per finished request: `requestId`, method, route **template**, status, wall `ms`, number of
database statements and their total time. It never records bodies, tokens, SQL text or parameters. With it off there is no overhead (no Prisma
query event is subscribed). `scripts/perf/timing-report.mjs` summarises a local run by route. To get the missing server-side numbers on Render,
set `REQUEST_TIMING_LOG=true` in the Render environment and read the logs (an environment change for the owner to make).

## 4. Tests actually run (all local, disposable databases)

| Check | Result |
|---|---|
| `npm run typecheck` | passed |
| `npm run lint` | 0 errors; 3 warnings that already existed (unused eslint directives in `test/perf/perf-journeys.perf-spec.ts`) |
| `npx prettier --check` | files I changed are clean; 5 untouched files already failed (`small.items.int-spec.ts`, `scripts/perf/generate-postman.mjs`, `scripts/perf/README.md`, `report.mjs`, `run-remote.mjs`) |
| `npx prisma validate` | valid. No migration was added |
| `npm test` (unit) | 34 suites, 305 tests passed |
| New: `limiter.spec.ts` | 3 tests passed |
| Integration `appgaps2` + `scheduling.buffer` (slots) | 26 passed before adding the regression test; `appgaps2` alone 22 passed with it (21 + the new one) |
| Regression test without the fix | fails: expected 1 busy-check statement, received 6 |
| Integration auth/rbac/session/permission/users/suspended | 101 passed |
| Full `npm run test:integration`, first run | 53 suites: 51 passed, 2 failed; 916 of 917 tests passed (786 s). Failures: `search.api` statement-count pin (7 became 8 because the session lookup is now one raw join; pin updated) and `qa.inventory` (a teardown error leaked from another suite; passes alone) |
| `search.api` + `qa.inventory` rerun | 2 suites, 24 tests passed |
| Full `npm run test:integration`, rerun after the fix | see section 9 |

## 5. Load, kept separate from the sequential runs

Local only (never Render: free tier, and writes/abuse are out of scope). Server built from this tree, port 3100, 100,001 users / 60,000 bookings /
20,000 workers, `scripts/load/run.mjs` read-only scenarios, 20 s per level, error threshold 1%, 429/5xx counted as errors.

| Concurrent clients | Requests | Req/s | Errors | p50 | p95 | p99 |
|---|---|---|---|---|---|---|
| 10 | 1,924 | 96 | 0 | 49 ms | 279 ms | 340 ms |
| 25 | 2,085 | 104 | 0 | 213 ms | 492 ms | 566 ms |
| 50 | 2,026 | 101 | 0 | 499 ms | 901 ms | 1,026 ms |

* Throughput saturates near 100 req/s: server, database and load client share one machine, so this shows the **shape** (queueing, no errors),
  not Render capacity. Search is the heavy scenario. `worker-slots` returned 200 every time.
* A first attempt returned ~95% HTTP 429 because every simulated client shares one IP and the rate limiter did its job. For the valid run the limit was
  raised **on the local test server only** through `THROTTLE_LIMIT`; no code or production setting changed.
* No "before" load run exists (the old build was not rebuilt), so the load table is an after-only reference.
* The seed script `scripts/load/seed.sql` had gone stale against a newer constraint (reviewer id on approved checks); fixed.

## 6. Decisions and open items

1. **Caching** (not added): the dashboard and reports could use a short TTL cache in Redis, which already exists. It trades freshness of admin
   numbers for speed, so it needs your decision on the allowed staleness.
2. **Report transactions**: each report query costs four round trips because of the READ ONLY wrapper. Removing it would weaken a deliberate safeguard, so it
   was left.
3. **Render plan**: the free tier's CPU is the likeliest cause of the 2.9 s login and the scattered spikes. A paid plan is a cost decision for you.
4. **Not done**: EXPLAIN for each listed report endpoint (the local dataset is too small to be meaningful; only search was examined on 100k users);
   the two consistently slow endpoints; 133 operations not exercised on Render; any measurement on Render after these changes (needs a deploy).

## 8. Phase 2 findings (local evidence)

* **Planner statistics matter more than any index here.** The same search statement took 451 ms (89 ms planning) on a bulk-seeded database and
  about 33 ms execution + 35 ms planning after `ANALYZE`. Production Postgres runs autovacuum and auto-analyze, but after a bulk load (staging top-up
  scripts, imports) running `ANALYZE` is cheap and worth doing. This is an operational note; no migration or index was added.
* **Search under concurrency is limited by database CPU.** CPU profile of the Node server during a 20 s, 10-client stage: about 61% idle over the window
  (boot included) and no application function above 2% self time. Each search costs about 70 ms of Postgres time (planning ~35 + execution ~33), so
  10 or more parallel searches queue behind the database's cores. Planning is half of it because the driver sends unnamed statements, so the plan is rebuilt
  on every call. Reducing it needs server-side prepared statements (not available through Prisma raw queries) or a simpler statement; both touch
  architecture or search semantics and need approval.
* **`deletion-requests` and `payments/{id}`** do almost nothing in the application (4 and 3 statements, about 8 ms locally). Their Render cost (p50 232 and
  268 ms against a norm near 110 ms) cannot be explained from here. Verification procedure, which needs the environment owner to enable
  `REQUEST_TIMING_LOG=true`: call each endpoint about 15 times with a read-only admin token, then in the Render log filter the `request` lines for
  that `route` and read `ms`, `queries` and `dbMs`. Small `dbMs` with large `ms` means the time is outside the database (event loop or network);
  large `dbMs` means the statement or the pooler is slow.
* **Dashboard and reports**: `demand-by-area` 6, `new-customers` 5, `verification/queue` 5, `dashboard` 26 statements, 10-37 ms locally. The
  READ ONLY transaction (BEGIN, SET TRANSACTION, SELECT, COMMIT) is kept. Not slow locally; the Render spikes were single samples.
* **Authentication**: covered by the existing suites (101 integration tests including suspended accounts, sessions and permissions). Session validity,
  `ACTIVE` status, roles and permissions are still read from the database on every request, so revocation and role changes apply on the next request.
* **Password hashing limiter**: at most two scrypt derivations run at once (about 256 MiB); the rest wait in a FIFO queue. Risk stated plainly:
  a flood of login attempts could queue behind the limiter and make real logins wait. Rate limiting still applies before the work is queued and no hash
  parameter changed, but a wait-time bound or per-IP login limit has not been benchmarked under attack-like load.
* **Slots correctness**: all existing slot cases pass (a held booking hides its hour, travel buffer, confirmed interview, horizon, hidden worker 404).
  The new statement applies the same shared SQL rule as booking creation, which still re-checks inside its own transaction, so a stale
  slot list cannot produce a double booking. The regression test fails on the old code (6 busy-check statements) and passes on the new (1).
  The Render 500 is NOT declared fixed: no Render log was available.

### Classification of the measured endpoints

| Class | Endpoints |
|---|---|
| Healthy (warm local 10-35 ms, no repeat outlier) | all other GETs in `performance-test-results.csv` |
| Application/query candidate | `GET /search/workers` (planning plus execution per call), `GET /admin/dashboard` (26 statements) |
| Database/pool bottleneck under concurrency | `GET /search/workers`, `GET /bookings` at 25-50 clients on one shared machine |
| Infrastructure/CPU/network-bound | password hashing (4 endpoints), isolated 0.5-1.1 s spikes on Render |
| Insufficient evidence | `GET /admin/deletion-requests`, `GET /admin/payments/{id}`, the Render 500 on slots |

Files changed: `src/app.setup.ts`, `src/common/request-context/request-context.ts`, `src/common/scheduling/worker-busy.ts`,
`src/common/security/password-hasher.service.ts`, `src/common/concurrency/limiter.ts` (+ spec), `src/config/app-config.service.ts`,
`src/config/env.validation.ts`, `src/infrastructure/database/prisma.service.ts`, `src/modules/auth/auth.repository.ts`,
`src/modules/search/search.repository.ts`, `test/integration/appgaps2.int-spec.ts`, `test/integration/search.api.int-spec.ts`,
`test/perf/perf-journeys.perf-spec.ts`, `scripts/load/run.mjs`, `scripts/load/seed.sql`, `scripts/perf/timing-report.mjs`,
`scripts/perf/compare.mjs`. No migration. Local before/after per operation: `performance-optimization-local-compare.csv`.

## 9. Integration suite completion

Status, stated without rounding up:

| Run | Result |
|---|---|
| Full run 1 (fresh DB) | 51 of 53 suites passed; 916 of 917 tests. The 2 failures were mine (statement-count pin, fixed) and a teardown leak; both pass on rerun |
| Full run 2 | Interrupted by a machine stall (13,040 s total): 6 suites failed, 30 tests. Not valid evidence |
| Those 6 suites rerun on a fresh DB | 6 of 6 passed, 76 tests |
| Full run 3 (fresh DB, no stall) | **Did not finish cleanly when this was written**: `gap.closing`, `interview` (30 s timeout) and `payments.recovery` failed mid-run; all pass in isolation. The local Redis and queues are shared with other work on this machine, which is the likely cause but was NOT proven |

So there is no single uninterrupted, fully green run of the whole integration suite after these changes. Every suite has passed at least once
after the final code, and the changes touched only search, auth lookups, the hasher and request timing.

## 7. Reproduce

```bash
# fresh disposable database, then:
npx prisma migrate deploy
PERF_ITERATIONS=15 PERF_OUT=test/perf/out node --experimental-vm-modules ./node_modules/jest/bin/jest.js --config test/jest-integration.config.js --runInBand --forceExit --testRegex "perf/perf-journeys\.perf-spec\.ts$"
REQUEST_TIMING_LOG=true  # add to the line above to also write test/perf/out/timing.jsonl
node scripts/perf/timing-report.mjs test/perf/out/timing.jsonl
node scripts/perf/compare.mjs docs/qa/performance-test-results.csv <new-report>.csv
```
