# Attendance - test results

**Result: PASS** - 12/12 tests passed, 0 failed (1 suite). Run date: 2026-10-08.

Environment: Node 24.21, PostgreSQL 17 and Redis 7 (Docker), dedicated test database `sevanest_test` (real database and Redis for integration tests), in-memory SMS and storage adapters. OTP/lockout limits in the tests are test values, not approved business values.

## Suites

| Kind | File | Passed | Failed |
|---|---|---|---|
| integration | `attendance.api.int-spec.ts` | 12 | 0 |

## Results by group

| Group | Passed | Failed |
|---|---|---|
| attendance.api › worker | 4 | 0 |
| attendance.api › customer | 3 | 0 |
| attendance.api › admin | 3 | 0 |
| attendance.api › listing and the database | 2 | 0 |

## Every test and its result

### `attendance.api.int-spec.ts`

- PASS - worker › records today's status once, repeats safely, and cannot change a recorded day
- PASS - worker › needs a note for an exception and rejects unknown statuses and a self-chosen date
- PASS - worker › works only on the worker own booking, and only while the service is active
- PASS - worker › records one entry when the same day is submitted many times at once, and lets one of two conflicting statuses win
- PASS - customer › sees exactly what the worker recorded, and nobody else does
- PASS - customer › raises an exception for a missed day, once, within the service period
- PASS - customer › cannot record attendance as a status other than an exception
- PASS - admin › records on behalf of the worker, corrects with a reason, and keeps the history
- PASS - admin › keeps view and manage separate and refuses everyone else
- PASS - admin › can still correct an entry after the service ended, but nobody can add one
- PASS - listing and the database › pages newest first, filters by date, and bounds the input
- PASS - listing and the database › rejects a second entry for a day, an unexplained exception, and any change to the history

## Not covered

- Configurable status list (Q-53); how far into the past a worker may record; dispute handling (support module not built).
