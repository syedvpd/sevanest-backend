# Performance review - final QA

No numeric performance target exists in any source document (SRS 5.2: "responsive", "results returned quickly with pagination"; Q-06 open). This review therefore
reports **measured evidence and concrete risks**, not a pass against an invented SLA.

## 1. Method

* A disposable database (`sevanest_qa_perf3`, created by `prisma migrate deploy`, never the project databases) filled with synthetic but production-shaped data by one SQL script.
* The real built server (`node dist/main`), real HTTP, one customer and one worker chosen because they own the most bookings, a Super Admin. 15 sequential requests per endpoint after a warm-up; p50/p95 of
  wall-clock time as seen by the client (includes JSON serialisation and the ~10 statements of authentication and permission lookups every request makes).
* Machine: a Windows 11 developer PC, PostgreSQL 17 and Redis 7 in Docker on the same host, so network latency is ~0 and absolute numbers are **optimistic**. Relative shapes are what matter.
* Query counts: PostgreSQL's transaction counter before/after a single request, for page sizes 1, 20 and 100.

| Table | Rows |
|---|---|
| users | 90,000 (60,000 customers, 30,000 workers) |
| worker profiles / skills / preferred areas | 30,000 / 40,000 / 88,200 |
| bookings / booking events | 164,500 / 304,000 |
| payments | 90,000 |
| audit log | 600,000 |
| notifications | 200,000 |
| support tickets / ratings | 20,000 / 40,000 |

## 2. Latency of the hot paths (milliseconds, client-side)

| Endpoint | HTTP | p50 | p95 | Response |
|---|---|---|---|---|
| customer search: category+area | 200 | 33.3 | 55.8 | 10 KB |
| customer search: +engagement+time window+language, page 1 | 200 | 59.7 | 62.7 | 0 KB |
| customer search: sort asc, page 20 | 200 | 22.6 | 28.4 | 0 KB |
| admin matching | 200 | 78.4 | 132.5 | 0.1 KB |
| customer: my bookings | 200 | 18 | 21.2 | 2.5 KB |
| worker: my bookings | 200 | 22.9 | 30.8 | 3.5 KB |
| admin: bookings (newest, limit 100) | 200 | 118 | 256 | 48.2 KB |
| admin: bookings status=ACTIVE | 200 | 28.5 | 34.6 | 52.8 KB |
| admin: bookings by customer | 200 | 24.8 | 30.5 | 2.5 KB |
| admin: bookings page 1000 | 200 | 223 | 285.9 | 52 KB |
| admin: payments | 200 | 76.5 | 82.8 | 58.4 KB |
| admin: payments status=SUCCEEDED | 200 | 26 | 31.9 | 58.4 KB |
| admin: users | 200 | 73.5 | 102.2 | 20.3 KB |
| admin: workers | 200 | 54.2 | 63.2 | 45.6 KB |
| admin: customers | 200 | 17.9 | 20.2 | 0 KB |
| admin: audit log newest | 200 | 62.2 | 71.8 | 26.6 KB |
| admin: audit log by action prefix | 200 | 84 | 135.9 | 21.7 KB |
| admin: audit log by entity type | 200 | 31.8 | 40.9 | 21.4 KB |
| admin: audit log deep page | 200 | 561 | 722.5 | 23.8 KB |
| admin: notifications FAILED | 200 | 30.9 | 41.2 | 24.7 KB |
| admin: notifications all | 200 | 102.1 | 134.8 | 24.5 KB |
| admin: support tickets | 200 | 53.8 | 142.9 | 42.7 KB |
| admin: ratings | 200 | 66 | 91 | 34.5 KB |
| admin: dashboard | 200 | 331.2 | 455.4 | 0.6 KB |
| report new-customers (60 days) | 200 | 62.7 | 84.1 | 2.5 KB |
| report worker-registrations (60 days) | 200 | 133.7 | 183.6 | 5.5 KB |
| report booking-funnel (60 days) | 200 | 337.6 | 437.6 | 5.1 KB |
| report demand-by-category (60 days) | 200 | 55.1 | 60.5 | 0.9 KB |
| report demand-by-area (60 days) | 200 | 105.8 | 114.2 | 2.3 KB |
| report interview-conversion (60 days) | 200 | 57.4 | 89.6 | 0.5 KB |
| report cancellation-rate (60 days) | 200 | 32.5 | 34.9 | 0.5 KB |
| report replacement-rate (60 days) | 200 | 106.5 | 150 | 0.5 KB |
| report payment-collections (60 days) | 200 | 88.3 | 121.6 | 7.8 KB |
| report support-tickets (60 days) | 200 | 38.6 | 46.1 | 2.6 KB |
| report repeat-customers (60 days) | 200 | 115.9 | 125.2 | 1.9 KB |
| report worker-utilization | 200 | 101.2 | 119.3 | 0.3 KB |
| report top-rated-workers | 200 | 27.9 | 32.9 | 5.7 KB |

## 3. N+1 and statement counts

Statements per request (transactions counted by PostgreSQL), for page sizes 1 / 20 / 100:

| Endpoint | limit 1 | limit 20 | limit 100 |
|---|---|---|---|
| customer bookings | 13 stmts / 1 rows | 10 stmts / 5 rows | 8 stmts / 5 rows |
| worker bookings | 17 stmts / 1 rows | 11 stmts / 9 rows | 11 stmts / 9 rows |
| admin bookings | 23 stmts / 1 rows | 14 stmts / 20 rows | 14 stmts / 100 rows |
| admin payments | 11 stmts / 1 rows | 13 stmts / 20 rows | 12 stmts / 100 rows |
| admin users | 20 stmts / 1 rows | 12 stmts / 20 rows | 12 stmts / 100 rows |
| admin workers | 24 stmts / 1 rows | 14 stmts / 20 rows | 14 stmts / 100 rows |
| admin customers | 22 stmts / 0 rows | 10 stmts / 0 rows | 10 stmts / 0 rows |
| admin audit logs | 18 stmts / 1 rows | 10 stmts / 20 rows | 10 stmts / 100 rows |
| admin notifications | 22 stmts / 1 rows | 14 stmts / 20 rows | 14 stmts / 100 rows |
| admin support tickets | 19 stmts / 1 rows | 11 stmts / 20 rows | 11 stmts / 100 rows |
| admin ratings | 19 stmts / 1 rows | 10 stmts / 20 rows | 10 stmts / 100 rows |
| customer payments | 14 stmts / 0 rows | 6 stmts / 0 rows | 6 stmts / 0 rows |
| search (category+area) | 14 stmts / 1 rows | 16 stmts / 20 rows | 12 stmts / 100 rows |

**No endpoint shows N+1 behaviour**: the number of statements does not grow with the page size (the first call of a series is higher because of connection warm-up; the steady
figure is 6-16, of which about 8 are the authentication, session and permission lookups every authenticated request performs). Search runs a constant 6 statements (asserted in `search.api.int-spec.ts`);
each report uses exactly one READ ONLY transaction whatever the range (asserted in `reports.api.int-spec.ts`).

## 4. Query plans (EXPLAIN ANALYZE on the same data)

| Query | Plan | Time |
|---|---|---|
| Customer search (category + area + engagement + time window + verified) | starts from `worker_skills_category_id_idx` and `worker_preferred_areas_area_id_idx` (hash join, ~300 candidates), then primary-key lookups; the verification check is an anti-join on `worker_verification_checks_worker_id_check_type_key` and the window test uses the exclusion-constraint index; the sort is on the already-filtered rows | 7.6 ms |
| My bookings (customer) | bitmap index scan on the customer's rows, sort of 5 rows | 44 ms (the figure includes picking the busiest customer in the same statement) |
| Admin bookings by status (`ACTIVE`) | `bookings_status_created_at_idx` backward scan, no sort | 0.4 ms |
| Admin bookings, newest first, no filter | parallel sequential scan with top-N sort | 20 ms at 164,500 rows |
| Audit log newest / by action prefix | `audit_logs_created_at_idx` backward scan; incremental sort | 4 ms |
| Notifications `status = FAILED` | `notifications_status_created_at_idx` | 15 ms |

## 5. Concrete risks (evidence, not speculation)

| ID | Severity | Risk | Evidence | Mitigation |
|---|---|---|---|---|
| P-1 | P3 | **Deep offset pages on the audit log.** `OFFSET` makes the database walk the skipped rows. | page 5000 of 100: 561 ms p50 (420 ms in the query), 600,000 rows | acceptable for an admin screen; use keyset pagination if auditors page deeply |
| P-2 | P3 | **Unfiltered "newest bookings" is a sequential scan** (no index on `created_at` alone). | 20 ms at 164,500 rows, scales linearly | add `bookings(created_at DESC, id DESC)` when volume reaches the millions |
| P-3 | P3 | Dashboard and the booking-funnel report are the slowest reads. | dashboard 331 ms, booking-funnel (60 days) 338 ms p50 | fine for an admin; cache the dashboard if it is polled |
| P-4 | P3 | 17 foreign-key columns have no covering index (API_SECURITY_AUDIT S-12). | `pg_constraint` / `pg_index` query | add only if a filter on them is introduced |
| P-5 | P2 | Per-process throttler (S-04) and ~10 authentication/permission statements per request: under load the first scaling limit is the database connection count, not the queries. | statement counts above | connection pooler (PgBouncer) and a session/permission cache when traffic grows; Redis throttler storage |
| P-6 | P3 | The notification dispatch loop polls every 5 seconds from one worker process; `FOR UPDATE SKIP LOCKED` allows more workers. | `notifications.worker.ts`, notifications.api concurrency test | scale workers horizontally; the interval is an engineering default |

## 6. What was not done

* No load test (sustained concurrency, soak, spike). The environment is one developer machine; the numbers above are single-client latency on large data, not throughput.
* No measurement against a managed cloud database or a remote Redis (network latency will add to every statement; ~10 statements per request makes that visible).
* Search ranking cost is not an issue because no ranking exists (Q-46).
