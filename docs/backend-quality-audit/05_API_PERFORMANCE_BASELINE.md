# 05 — API performance baseline (Phase 5)

## Status

- Sequential latency of 206 of 304 operations: **VERIFIED WITH LIMITATIONS** (local, synthetic, one client).
- Concurrent throughput: **VERIFIED WITH LIMITATIONS** (one laptop runs client, API, PostgreSQL and Redis together; indicative only).
- Hosted (Render) latency, cold start, TLS and network: **NOT VERIFIED** (no authorization to load a public service).

These are local engineering measurements. They are not production numbers and do not predict mobile screen-render time.

## Method

| Item | Value |
|---|---|
| Harness | `test/perf/perf-journeys.perf-spec.ts` (existing): walks every module through its lifecycle, one request at a time, over a real HTTP port; `REQUEST_TIMING_LOG=true` records statements and DB time per request |
| Run | 10 iterations, 2,238 timed requests (3,189 including setup), fresh database `sevanest_bqa5_ci`, Redis db 11, 2026-11-03 |
| Machine | 11th Gen Intel i7-1185G7, 8 logical CPUs, 16 GB RAM, Windows 11, Node v24.21.0; PostgreSQL 17 and Redis 7 in Docker on the same machine |
| Providers | fake payment gateway, in-memory SMS and storage (no real cost or side effect) |
| Percentiles | nearest rank over 10 samples: p95 and p99 are the slowest sample. Treat them as "worst of 10", not a tail estimate. |
| Cold vs warm | `first_ms` is iteration 1 (cold process, caches, plans). p50 uses all 10 samples; the generated report also gives warm-only figures. |
| Raw data | `05_api_performance_baseline.csv` (206 operations: n, first, second, min, avg, p50, p95, p99, max, statuses), `04_query_counts_per_route.json`, `perf-out/perf-journeys-report.md`, `perf-out/timing-report.txt`, `perf-out/load-run.txt` |
| Caveat | `perf-out/perf-journeys-report.md` contains a narrative paragraph about a discarded earlier run that is fixed text in `scripts/perf/report.mjs`. It does not describe this run. |

## Summary (sequential)

| | Value |
|---|---|
| Operations in the API / exercised | 304 / 206 (67.8%). The other 98 need provider or time conditions the harness cannot create. |
| Requests timed | 2,238 |
| All requests p50 / p95 / p99 | 25.2 / 99.5 / 509 ms |
| Warm only (iteration 3+) p50 / p95 / p99 | 24.3 / 94.3 / 503 ms |
| Excluding password hashing operations | p50 / p95 / p99 = 24.7 / 83.9 / 151 ms |
| GET operations measured | 100; p95 above 100 ms: 7; above 200 ms: 3 |
| Any operation with p95 above 1,000 ms | 1: `POST /admin/account/password` (1,498 ms, intentional password hashing) |
| Operations with an unexpected status | 6 in the report; 16 operation rows carry 4xx statuses (see "Coverage caveat") |
| Error rate (5xx) | 0 |

## Against the requested targets (sequential, server-side, local)

| Category | Target (initial / stretch) | Measured | Verdict |
|---|---|---|---|
| Lightweight reads | 1 s / 200 ms | of 100 measured GETs, 93 have p95 under 100 ms (7 above, 3 above 200 ms: home, admin dashboard, one report); examples: `GET /customers/me` p50 9.3 / p95 11.8; `/users/me` 16.0 / 29.6; `/service-categories` 11.5 / 17.3; `/service-areas` 7.9 / 13.0; `/shortlist` 9.4 / 14.8; `/notifications` 13.4 / 32.6 | meets both |
| Customer home | 1 s / 100 ms | p50 **67.8**, p95 **261.6**, first call 156 ms, 13 statements, DB time 156 ms | meets initial; meets stretch at p50 only; the worst of 10 exceeds 200 ms |
| Worker home/dashboard | 1 s / 200 ms | no single worker home route exists. Worker reads: `/workers/me` p95 23.3, `/workers/me/onboarding` 32.1, `/workers/me/verification` 38.0, `/workers/me/availability` 82.4 (p50 15.0) | meets both for the routes that exist; gap noted |
| Search and worker listing | 1 s / 300 ms | journeys (small data): p50 33.6 / p95 74.1. **100,000-user dataset, concurrency 1**: search p50 102 / p95 180 / p99 256 ms (mixed filters, sorts and time windows); 20,000-worker EXPLAIN 34.5 ms exec | meets both |
| Worker detail / slots / ratings | 1 s / 200 ms | journeys: 404 (see caveat), not measured there. 100,000-user dataset, concurrency 1: worker card p50 14 / p95 19; slots p50 18 / p95 37 | meets both on the large dataset |
| Booking read / detail | 1 s / 200 ms | the journeys did not time customer booking reads (no `GET /bookings…` row). 100,000-user / 60,000-booking dataset, concurrency 1: my bookings p50 15 / p95 34 / p99 83; worker feed p50 14 / p95 20 | meets both for the list and feed; booking detail and history by id measured only inside the functional suites |
| Booking state change | under 1 s where practical | `POST /bookings/:id/:action` p50 55 / p95 95; `POST /bookings` p50 44 / p95 110; `POST /interviews` 34 / 62; `POST /admin/bookings` 108 / 479 | meets initial |
| Admin dashboard | 1 s / 300 ms | p50 53.0 / p95 201.3, 26 statements | meets both |
| Reports and exports | define limits | all measured reports p50 under 25 ms; worst `worker-utilization` p95 319 ms (single cold sample); export capped at 5,000 rows | meets initial on small data; large range not measured |
| Login | no target | `otp/request` p50 11.8 / p95 25.8; `otp/verify` 31.8 / 48.5; `token/refresh` 10.2 / 83.9; **admin password login p50 395 / p95 771 ms** | hashing cost is intentional |

Operations with p95 above 250 ms (all are writes or hashing, none is a read except home and one report): admin login 771; admin create user 724; password reset 618; `photo/confirm` 537 (storage read and hash in memory store); admin create booking 479; replacement select 336; `worker-utilization` 319; replacement reject 285; home 262; address delete 257; admin password change 1,498.

## Statements and database time

Median 7 statements per route (GET 5, max 41). Details and N+1 reading in 04. Highest DB time among reads: customer home (156 ms across 13 parallel statements) and replacement alternatives/candidates (85–90 ms, 19–20 statements).

## Sequential reads on the 100,000-user dataset (concurrency 1, 40 s, 834 requests, 0 errors)

`perf-out/load-run-sequential.txt`. Overall p50 17 / p95 139 / p99 231 ms. Search is the slowest scenario (p50 102, p95 180, p99 256); worker card 14/19; slots 18/37; my bookings 15/34; my profile 8/11; unread count 7/12; worker feed 14/20; health 4/5.

## Concurrent load (local, one Node process)

`scripts/load/run.mjs`, 100,000-user database `sevanest_bqa3_ci`, API on port 3100 with default pool 10, Redis db 12, stages of 25 s. Mix: search, worker card, slots, my bookings, my profile, unread count, worker feed, health.

| Concurrency | Requests | Req/s | Errors | p50 | p95 | p99 |
|---|---|---|---|---|---|---|
| 20 | 1,345 | 53.8 | 0 | 334 ms | 800 ms | 1,008 ms |
| 50 | 1,592 | 63.7 | 0 | 792 ms | 1,397 ms | 1,572 ms |
| 100 | 957 | 38.3 | 2 (0.21%, both `GET /health/ready` 503) | 2,370 ms | 7,108 ms | 9,304 ms |

Per scenario at concurrency 20: search p50 574 / p95 920; worker card 260 / 414; my profile 118 / 228; unread count 116 / 242; health 53 / 149.

Reading:

- One process on this machine saturates at roughly 55 to 65 requests per second. Beyond 50 clients throughput falls and latency queues up. The same lightweight route that takes 9 ms sequentially (`/customers/me`) takes 118 ms median at 20 concurrent clients, which shows queueing, not slow code.
- The numbers are dominated by the setup: the load client, Node, PostgreSQL and Redis share 8 cores with Docker Desktop. A production host will differ, in both directions. **Do not quote the req/s as production capacity.**
- At concurrency 100 the readiness probe returned 503 twice (49 calls). Render's health check is `/health/ready`, which used the shared 10-connection pool with a 2 s timeout (F-012). **Fixed afterwards** with a dedicated connection: two further 25 s stages at 100 clients gave 137 readiness calls, 0 errors, p50 15 to 16 ms (`perf-out/load-run-after-f012.txt`). Throughput and latency of the other routes did not change (about 57 req/s, p95 3.3 s at 100 clients).
- Search under load (p50 574 ms at 20 clients) is the first route to cross the 1 s initial target in this setup. At 50 clients nearly every scenario p95 is above 1 s.

## Coverage caveat

Several journey rows ended in 4xx statuses on every iteration because the harness does not create the preconditions: `GET /search/workers/{id}`, `/slots`, `/ratings` and `PUT /shortlist/{workerId}` (404), `GET /pricing/guidance` (404), slot proposal and replacement select (409), `POST /legal/accept` (409), `POST /safety/reports` (400), `PUT /admin/fees/{code}` (400). Their latency is the latency of the failure, not of the success path. Those paths are only covered functionally.

## What was not measured

p50/p95/p99 on a hosted deployment; cold start of a sleeping Render instance; behaviour with the real S3, Razorpay, SMS or maps providers; tuned pool sizes; multi-instance scaling; throughput of the background loops; memory and CPU of the process; a soak test.
