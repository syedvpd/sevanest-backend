# 04 — Database, query and index audit (Phase 4)

## Status

**VERIFIED WITH LIMITATIONS.** Schema and index catalogue checked on a migrated database; statement counts measured for 212 route templates over 3,189 requests; search plan measured on 20,000 workers. Not measured: production-size data, `pg_stat_statements` over real traffic, lock contention under concurrent writes.

## Environment

- PostgreSQL 17 (Docker, localhost), migrated with all 45 migrations (59 tables, 199 indexes). Disposable databases `sevanest_bqa*_ci`.
- `sevanest_bqa3_ci`: synthetic 100,000 users, 20,000 workers (activated by hand, see F-006), 60,000 bookings, `ANALYZE` run.
- `sevanest_bqa5_ci`: fresh database for the sequential journeys (small data, 10 iterations). Statement counts come from `REQUEST_TIMING_LOG` (request context counter), not from the database server.

## Catalogue checks (read-only SQL on `sevanest_bqa3_ci`)

| Check | Result |
|---|---|
| Multi-column foreign keys without a covering index | **0** |
| Duplicate indexes (same table, same columns, same predicate) | **0** |
| Prefix-redundant non-unique indexes | **0** |
| Single-column foreign keys without a leading index | **17**, all audit/actor columns: `customer_notes.author_id`, `worker_profiles.{activated_by,blacklisted_by,verification_signed_off_by}_user_id`, `worker_verification_events.actor_user_id`, `bookings.cancelled_by_user_id`, `booking_events.actor_user_id`, `payments.refunded_by_user_id`, `attendance_records.recorded_by_user_id`, `attendance_events.actor_user_id`, `replacement_requests.decided_by_user_id`, `ratings.moderated_by_user_id`, `support_tickets.closed_by_user_id`, `support_ticket_events.actor_user_id`, `deletion_requests.rejected_by_user_id`, `worker_verification_notes.author_user_id`, `worker_payment_references.recorded_by_user_id` |

Reading of the 17: they are never filtered or joined on in the code paths measured. An index would only speed the referential check when a `users` row is deleted. Users are suspended and anonymised, not hard-deleted, in the flows tested. **No index recommended** (G-03); adding 17 indexes to high-write tables (`booking_events`, `attendance_events`) costs writes for no read benefit. Revisit only if hard deletion of users is introduced.

No unused-index report was produced: statistics from a synthetic, freshly created database cannot show which indexes production traffic needs, and dropping an index on that evidence would be speculative.

## Query-level findings

### Statements per request (N+1 check)

`04_query_counts_per_route.json` holds every route: calls, median statements, max, database time and wall time.

| Measure | Value |
|---|---|
| Route templates measured | 212 (3,189 requests) |
| Median statements per route | 7 (GET routes: 5) |
| Maximum | 41 (`POST /replacement-requests/:id/select`) |
| Routes whose statement count varied by more than 1.5× between calls | 1: `POST /bookings`, 7 to 26 (10 of its 20 calls in the journey were 422 rejections, which take the short path; 26 is the full create. It varies by branch, not by result size) |
| GET routes with 15 or more statements | 3: `GET /admin/replacement-requests/:id/candidates` 19, `GET /replacement-requests/:id/alternatives` 20, `GET /admin/dashboard` 26 |

Most expensive state-changing routes (statements, DB ms, wall ms, medians): replacement select 41/91/116, admin booking create 33/107/125, replacement reject 31/65/86, worker sign-off 30/57/60, admin booking action 30/60/72, worker activate 28/57/55, `POST /bookings` 26/58/69, payment verify 25/50/65. These are single transactions that lock a row, validate, write the new state, a timeline event, an audit row and an outbox event, so a high fixed count is expected. Statement count does not grow with data size in any route measured here, which is what N+1 looks like; none was observed on a measured route.

Read paths: search 4, shortlist 3, notifications list 4, customers/me 3, users/me 6, service categories and areas 2 to 3. One list is an N+1 candidate and stays open: `safety.listMine` (F-001). Unbounded reads: F-002, F-005.

### Search plan (20,000 workers)

Statement: category + area + engagement + time window + language, page 1 of 20, ordered by experience. 34.5 ms execution, 40.5 ms planning, 1,334 candidates filtered to 1,206 eligible. Plan: bitmap index scans on `worker_skills_category_id_idx` and `worker_preferred_areas_area_id_idx`, hash joins, primary-key lookups, `count(*) OVER ()` for the total in the same statement. No sequential scan on `worker_profiles` once workers are activated. **No index proposed.**

Observation, not a defect: planning time equals execution time. The statement is large (many `EXISTS` branches built per request). Candidate improvement for later: measure with a prepared statement; do nothing without a latency problem.

### Customer home (13 statements, runs in parallel)

Median wall 68 ms, median DB time 156 ms (parallel statements, so DB time exceeds wall time). It is the slowest GET in the journeys; see 05. It already answers `ETag`/304 (`homeEtag`). No change proposed; a plan for each of its 13 statements was not captured.

### Transactions and locks

- Mutations lock the owning row with `SELECT … FOR UPDATE` (bookings, payments, tickets, ratings, replacement requests, service categories, customer profiles, users, roles, fee configs, attendance records, deletion requests) and the outbox uses `FOR UPDATE SKIP LOCKED`. No `Serializable` isolation, so Prisma write-conflict errors (`P2034`) are not expected.
- Only one explicit long transaction timeout was found: notifications (60 s, max wait 10 s).
- Race tests (`qa.concurrency`, `qa.statemachine`, per-module "parallel" tests) show no deadlock in the cancellation/replacement/payment races they exercise. Lock order across modules was not formally analysed.

### Connection pool

`DATABASE_POOL_MAX` defaults to 10 and `render.yaml` does not set it; query timeout 10 s. At concurrency 100 on one process the pool queue grew until the readiness probe (same pool, 2 s timeout) answered 503 twice in 49 calls (F-012). Pool size versus the Supabase pooler limit was not checked.

### Reports

All reports run in one `READ ONLY` transaction regardless of range (asserted in `reports.api`). Exports are capped at 5,000 rows (413 beyond) and ranges at 366 days. `worker-utilization` showed the slowest report sample (p95 319 ms, p50 18 ms, n=10; one cold sample). Large-range timing on a big dataset was not measured here.

## Name search (F-013)

Admin list filters for customers, workers, the verification queue and bookings use `contains … mode: 'insensitive'` (`ILIKE '%x%'`). There is no trigram index (`pg_trgm` is not installed; the extension is available in the server image). Measured on `sevanest_bqa3_ci`:

| Query | Rows scanned | Time |
|---|---|---|
| customer name `ILIKE '%123%'`, order by `created_at desc`, limit 20 (80,000 customers) | sequential scan, 79,740 removed by filter | 66 to 108 ms warm (775 ms on the first, cold-cache run) |
| same filter, `count(*)` | sequential scan | 114 ms |
| worker name `ILIKE '%wor%'` (20,000 workers, 99.99% match) | sequential scan | 186 ms |

Cost grows linearly with the table. Acceptable at today's size; it would cross 1 s on the first cold query somewhere above several hundred thousand customers. Proposed, **not applied** (needs approval and a staging check that Supabase allows `CREATE EXTENSION pg_trgm`):

```sql
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE INDEX CONCURRENTLY customer_profiles_name_trgm_idx ON customer_profiles USING gin (name gin_trgm_ops);
CREATE INDEX CONCURRENTLY worker_profiles_name_trgm_idx   ON worker_profiles   USING gin (name gin_trgm_ops);
```

Validate with the same `EXPLAIN (ANALYZE, BUFFERS)` above on a dataset of at least 500,000 customers; expected: bitmap scan on the trigram index. Cost: GIN write overhead on a table written at signup only; storage roughly the size of the name column. Needs `CREATE INDEX CONCURRENTLY` outside a Prisma transaction migration.

## Index recommendations

None. Every proposed index in this audit lacked a measured query that needs it:

| Candidate | Decision | Reason |
|---|---|---|
| 17 actor/author FK indexes | not recommended | no read path; write cost on high-write tables |
| Extra search indexes | not recommended | measured plan already uses the category and area indexes; 34.5 ms at 20k workers |
| Trigram index on `customer_profiles.name`, `worker_profiles.name` | **proposed for later (F-013), not created** | admin name filters use `ILIKE '%x%'` (`contains` + `insensitive`) and no `pg_trgm` index exists; see below |

## Open items for a later pass

1. Re-run with a seeded dataset that includes realistic activation ratios and real booking history, and capture `EXPLAIN (ANALYZE, BUFFERS)` for each of the 13 home statements and the dashboard's 26.
2. Enable `pg_stat_statements` on a staging copy and rank by total time under the load script.
3. Fix the seed (F-006) and refresh `docs/qa/PERFORMANCE_REVIEW.md`, whose search numbers predate the activation gate.
