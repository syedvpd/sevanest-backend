# 06 — Reliability and failure audit (Phases 7 and 8)

## Status

- Database and Redis outage behaviour: **VERIFIED** end to end on throwaway local containers, after two fixes (F-004, F-011).
- Queues and background jobs: **VERIFIED WITH LIMITATIONS** (code read and existing tests; no live worker-kill or backlog run).
- Storage, SMS, payment gateway, FCM, maps outages: **VERIFIED WITH LIMITATIONS** (in-memory/fake providers with injected failures in existing tests; no live provider).

## Method for the outage test

Isolated stack so no shared database was touched: two new Docker containers (`bqa-pg` PostgreSQL 17 on 55432, `bqa-redis` Redis 7 on 56379) migrated to the current schema, and the real built app (`node dist/main`, port 3300, memory providers, `EMBEDDED_WORKERS=true`) pointed at them. The script `failure.mjs` (scratchpad, not committed) logged in with the staging-style test OTP, then ran the same six requests in four phases while `docker stop` / `docker start` took each dependency away and back. Requests: `GET /health/live`, `GET /health/ready`, `GET /reference-data` (public, DB), `GET /service-categories` (authenticated, DB), `GET /customers/me` (authenticated, DB), `POST /auth/otp/request` (Redis + DB).

## Results (final build, with fixes)

| Phase | live | ready | public DB read | authenticated DB read | OTP request |
|---|---|---|---|---|---|
| Baseline | 200 | 200 | 200 | 200 / 404 (no profile) | 200 |
| **PostgreSQL stopped** | 200 | **503** | **503 SERVICE_UNAVAILABLE** | **503** | **503** |
| PostgreSQL restarted | 200 | 200 | 200 | 200 | 429 cooldown (state from before the outage) |
| **Redis stopped** | 200 | **503** | 200 | 200 | **503 SERVICE_UNAVAILABLE** |
| Redis restarted | 200 | 200 | 200 | 401 (see note) | 200 |

Latency during outages stayed in single/double-digit milliseconds (fail fast; no hang): PostgreSQL down 5–29 ms, Redis down 2–214 ms (OTP).

Note on the 401 after the Redis restart: the access token had expired because the workstation was suspended for hours during that run (jest in another process reported a 54,219 s suite). It is token expiry, not a recovery fault. The earlier run of the same script (before suspension) shows 404/200 after recovery.

### Before the fixes (same script, first build)

| Dependency down | Response | Why it was wrong |
|---|---|---|
| PostgreSQL | **500 INTERNAL_ERROR** on every DB request | an outage looked like a bug, clients could not retry safely, and each request was sent to Sentry |
| Redis | **500 INTERNAL_ERROR** on `otp/request` | login impossible with a misleading code |

Readiness was already correct (503 when either dependency is down) and liveness stays 200, as it should so the platform does not kill a healthy process.

### Root cause and fixes

- **F-004 (P2, fixed).** The filter only mapped Prisma P2002/P2003/P2025. My first fix was written from a probe that used `$queryRaw` (code `P2010`) and was **not sufficient**: the real errors from the `pg` adapter are a `PrismaClientKnownRequestError` whose `code` is the errno `ECONNREFUSED` (model and raw queries) and an `AggregateError` with `code: 'ECONNREFUSED'` (interactive transactions). The end-to-end run exposed this; the filter now treats any error whose `code` is a network errno (`ECONNREFUSED`, `ECONNRESET`, `ETIMEDOUT`, `EPIPE`, `ENOTFOUND`, `EAI_AGAIN`, `EHOSTUNREACH`, `ENETUNREACH`), the Prisma availability codes (`P1001`, `P1002`, `P1008`, `P1017`, `P2024`), raw-query errors with a PostgreSQL class 08/28/53/57P01-03 code, `PrismaClientInitializationError`, and four exact driver messages as an outage, and answers 503.
- **F-011 (P2, fixed).** `ioredis` is created with `enableOfflineQueue: false`, so while Redis is down a command fails with the plain `Error` messages `Stream isn't writeable and enableOfflineQueue options is false` or `Connection is closed.`. Those two exact messages are now mapped to 503.
- Deliberately **not** mapped: arbitrary text (a plain `Error('connect ECONNREFUSED …')` with no code stays 500), and a raw query that fails with a normal SQL error (for example `42601`). Those are defects and keep 500 + Sentry. The pre-existing unit test for a generic 500 still passes.

Proof: `src/common/errors/all-exceptions.filter.spec.ts` (25 tests, was 10), the end-to-end table above, `security.api` and `qa.adversarial` re-run green.

### Redis-down behaviour worth knowing (design, not a defect)

With Redis down the API keeps serving all reads (public and authenticated) because authorization is read from PostgreSQL, not Redis. What stops: OTP request/verify (state in Redis, now a clean 503), queue consumers, and the heartbeat. Rate limiting with `THROTTLE_STORAGE=redis` (the Render setting) **fails open**: a second run of the app with Redis-backed throttling and Redis stopped answered 200 to every public request in 12–22 ms (`throttle-down.mjs`), i.e. the general per-IP limiter is off while Redis is down; the OTP-specific limits are not (they 503). Whether to fail open or closed is a security/availability decision for the owner (recorded as gap G-07 in file 10). Readiness reports 503, which is the right signal for an orchestrator. Existing test `ops.hardening` confirms the security-event writer still records when Redis is unreachable.

## Health endpoints

`GET /health/live` is process-only (always 200 while the process runs). `GET /health/ready` checks PostgreSQL and Redis and returns 503 when either is down (verified above, 3–19 ms). It does **not** check storage, the SMS provider or the payment gateway (intentional: their outages are handled per request with 503 and stable codes). `GET /admin/system/readiness` reports launch prerequisites, provider modes and worker heartbeats for an admin.

## Phase 8 — background jobs

Read from `src/infrastructure/queue/queue.constants.ts`, `notifications.worker.ts`, the outbox service and the payment recovery loop; behaviour confirmed by named existing tests (`notifications.api`, `payments.recovery`, `qa.concurrency`, `ops.hardening`).

| Aspect | Finding |
|---|---|
| Queue | one BullMQ queue (`NOTIFICATION_QUEUE`) plus nine DB-polled loops (notifications, recheck-reminders, abandoned-uploads, claim-release, payment-recovery, booking-checks, support-sla, retention, security-events) each with a heartbeat. Business truth is in PostgreSQL; Redis holds only queue state. |
| Retries | 5 attempts, exponential 2 s with 0.5 jitter, failed jobs kept (`removeOnFail: false`) as a dead-letter set; completed kept 24 h / 1000 |
| Publication consistency | transactional outbox: an event is recorded only if the business transaction commits (`notifications.api`: "records an event only if the business transaction commits"); `FOR UPDATE SKIP LOCKED` dispatch; stale queued notifications are re-offered without creating a second job |
| Idempotency | delivery sends once even when attempted in parallel; repeated delivery sends nothing more; duplicate payment webhooks are acknowledged without re-applying (`payment.api`) |
| Provider failure | transient errors retry with backoff and fail after the last attempt; permanent rejection fails at once; provider messages are hidden from responses |
| Crash recovery | competing workers process a payment once and a crashed worker's claim is recovered (`payments.recovery`); abandoned uploads swept; idle verification claims released after 30 minutes |
| Shutdown | `enableShutdownHooks()` is on; loops clear their timers in `onModuleDestroy`; the worker process has its own health check script |

### Limits of this phase

- No live kill of the worker process mid-job, no queue backlog or throughput test, and no run with a stopped queue consumer were performed here. Existing tests simulate the crash by direct state setup.
- No live SMS, FCM, Google Maps, Razorpay or S3 call was made (rules 13/14 and the no-real-cost rule). Their adapters are verified only through the fake/memory providers and the `check:providers` script design.
- The `removeOnFail: false` policy means the failed set grows without bound until someone replays or clears it; `GET /admin/notifications/health` exposes it, but no alert rule was verified (operational gap, see 10).
