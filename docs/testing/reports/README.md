# Reports - test results

**Result: PASS** - 15/15 integration tests passed, 0 failed (1 suite, `reports.api.int-spec.ts`). Run date: 2026-10-12.

Environment: Node 24.21, PostgreSQL 17 and Redis 7 (Docker), dedicated database `sevanest_test`, which holds rows from earlier suites, so assertions are deltas around controlled data plus independent SQL oracles.

## Results by group

| Group | Passed | Failed |
|---|---|---|
| access and parameters | 4 | 0 |
| aggregation is correct | 7 | 0 |
| read-only behaviour | 4 | 0 |

## What was proved

- **Authorization**: `report.view` is required on every report; another permission or a customer: 403; anonymous: 401. The catalog lists all 13 endpoints with definitions, and responses carry the same definition and notes.
- **Parameters**: missing/malformed/impossible dates (`2026-02-30`), reversed range, more than 366 days, unknown interval, `minRatings=0`, `limit=101`: all 400 `VALIDATION_FAILED`; exactly 366 days is accepted.
- **Empty data**: a 2020 period returns zeros, empty series and `null` rates (never 0%, never invented); `demand-by-category` still lists every category with zero.
- **Correctness**: new customers match an independent SQL count for today and are identical across day/week/month buckets. Four controlled bookings (two stay MATCHED, one cancelled, one confirmed, one active with a replacement request) move requests +4, confirmed +2, cancelled +1, interviews held +2 with confirmed +2, replacement cohort +1 with requests +1, HOUSE_MAID demand +4; the repeat customer shows exactly 4 bookings; the request total equals an independent count. Payment collections +50000 minor for one paid fee and equal to a direct SQL sum. Support volume +3, closed +1, OPEN +2, average resolution a non-negative number. Top-rated: 5.0 ranks above 1.0, ordering is non-increasing, `minRatings=2` filters. A verified registered worker moves registered +1 and verified +1; utilization equals the stated ratio.
- **Pagination and ordering**: area demand is ordered by requests, then name, then id; pages 1 and 2 with `limit=1` return the first and second rows; `meta.total` equals the full row count; a page beyond the end is empty.
- **Read-only**: POST/PUT/PATCH/DELETE on a report are 404; a write attempted inside the repository's transaction (UPDATE and INSERT) fails with PostgreSQL's read-only error; running all 13 reports leaves the row counts of users, bookings, payments and audit logs unchanged. A static test forbids any writing statement or Prisma model access in the module.
- **No per-row queries**: each report opens exactly one READ ONLY transaction whatever the range (asserted for three reports over a year-long range).

## Not tested

Performance on large data (no volume data set and no numeric target exists), CSV export (not built), time-zone edge cases around midnight beyond the half-open range construction.
