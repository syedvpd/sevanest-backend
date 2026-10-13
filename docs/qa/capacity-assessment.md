# Capacity assessment: can SevaNest support 100,000 registered users?

**Conclusion: not proven.** The measurements below are from one laptop (API and worker-less node process, Docker PostgreSQL 17 and Redis 7 on the same machine) with synthetic data. They show the design is not obviously limited at this data size and identify the bottleneck. They are not a capacity guarantee for a deployed environment.

## Workload
* Data: 100,001 users (80,000 customers, 20,000 workers), 20,000 submitted workers (70 percent verified), 60,000 bookings of mixed status, 5 areas, 6 categories (`scripts/load/seed.sql`, disposable database `sevanest_perf_ci`).
* Driver: `scripts/load/run.mjs`, signed tokens for 3,000 customers and 500 workers, mix: search 40, worker card 10, my bookings 15, my profile 10, unread count 10, worker feed 10, health 5 (percent).
* Server: `node dist/main` in production mode, one process, pool 10, `SEARCH_CACHE_TTL_SECONDS=15`, throttling raised so the test measures the application, providers disabled. Run date 2026-10-13, 60 seconds per stage, load driver on the same machine.

## Results (latest run)
| Concurrency | Requests | Req/s | Errors | p50 | p95 | p99 |
|---|---|---|---|---|---|---|
| 50 | 8,591 | 143 | 0 | 349 ms | 583 ms | 869 ms |
| 200 | 11,832 | 197 | 0 | 1,017 ms | 1,581 ms | 2,006 ms |
Node process memory about 640 MB at the end. Search at 50 concurrency: p50 391 ms, p95 697 ms; at 200: p50 1,204 ms, p95 1,810 ms.

## What the investigation found
1. **Worker search was the bottleneck.** Per-endpoint at 50 concurrency before any fix: unread count about 505 req/s, profile 425, my bookings 288, worker feed 246, search about 36 req/s. PostgreSQL ran at about 700 percent CPU: the page query and the separate count query each repeated the same eligibility filter, and each statement costs about 30 ms of planning plus 35 ms of execution on 20,000 workers.
2. **Fix 1 (verified):** the page and the total now come from one statement (`count(*) OVER ()`), halving the filter work. Mixed throughput rose about 15 percent.
3. **Fix 2 (verified, optional):** `SEARCH_CACHE_TTL_SECONDS` (default 0 = off) serves identical customer searches from a per-instance cache for customers with no blocks. With 15 seconds mixed throughput roughly doubled (about 95 to about 200 req/s). Booking confirmation still re-checks eligibility and busy hours, so a stale card cannot create a wrong booking. The trade-off is up to 15 seconds of staleness in lists.
4. A measurement artefact was found and removed: on Windows `localhost` resolved to IPv6 first and added 200 ms per request; the test uses `127.0.0.1`.

## Reasoning about 100,000 registered users (assumptions, not measurements)
If about 10 percent are active per day and 1,000 are active at the peak minute with one request every 10 seconds, demand is about 100 req/s, below the 143 to 197 req/s measured on this single laptop process. Real mobile traffic has bursts, larger result sets and uncached searches, so this is an indication only.

## Not measured, therefore not claimed
* Writes under load (booking creation, payments, webhooks, OTP login), multi-hour soak, several API replicas, PostgreSQL on dedicated hardware or Supabase/RDS limits, Redis outage behaviour, queue throughput with real providers, connection-pool exhaustion behaviour, real network latency.
* Monitoring, alerting, backups and a restore drill on the deployed environment (scripts exist in `scripts/db`; `docs/qa/OPERATIONS_RUNBOOK.md`).

## Recommended next steps
Run the same driver against a staging environment sized like production with two or more API replicas and the worker; add write scenarios; set `SEARCH_CACHE_TTL_SECONDS` to 10 to 30 after the client accepts the staleness; add a dedicated read index or materialised eligibility table if search remains the first bottleneck; set `DATABASE_POOL_MAX` from the database's connection limit divided by replicas.
