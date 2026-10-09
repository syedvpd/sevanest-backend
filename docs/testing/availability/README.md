# Availability - test results

**Result: PASS** - 74/74 tests passed, 0 failed (2 suites). Run date: 2026-10-08.

Environment: Node 24.21, PostgreSQL 17 and Redis 7 (Docker), dedicated test database `sevanest_test` (real database and Redis for integration tests), in-memory SMS and storage adapters. OTP/lockout limits in the tests are test values, not approved business values.

## Suites

| Kind | File | Passed | Failed |
|---|---|---|---|
| unit | `time-windows.spec.ts` | 23 | 0 |
| integration | `availability.api.int-spec.ts` | 51 | 0 |

## Defects found by the tests

- Defect found by these tests and fixed: the advisory lock was first issued with `$queryRaw`, which cannot read PostgreSQL's `void` result, so every availability update answered 500 (28 failures). Switched to `$executeRaw`; all 51 integration tests then passed.

## Mutation checks (tests proven to catch regressions)

- Making the advisory lock a no-op (valid SQL that never acquires it) fails the parallel window-set and parallel area-set tests; the code was restored.

## Manual verification (real running server)

- Real HTTP journey (test database): admin creates an area (duplicate in different case answers 409); customer can list areas but cannot create; overlapping windows rejected with a clear message; valid availability saved and returned sorted; submission lists the missing items and succeeds once complete; admin reads the worker's availability.

## Results by group

| Group | Passed | Failed |
|---|---|---|
| time-windows › TIME_OF_DAY | 13 | 0 |
| time-windows › toMinutes / toText | 1 | 0 |
| time-windows › normaliseTimeWindows | 9 | 0 |
| availability.api › service areas (master) | 12 | 0 |
| availability.api › worker availability | 32 | 0 |
| availability.api › ownership and role isolation | 4 | 0 |
| availability.api › submission journey (Workers + Categories + Availability together) | 2 | 0 |
| availability.api › readiness for future Search/Matching | 1 | 0 |

## Every test and its result

### `time-windows.spec.ts`

- PASS - TIME_OF_DAY › accepts 00:00
- PASS - TIME_OF_DAY › accepts 09:30
- PASS - TIME_OF_DAY › accepts 23:59
- PASS - TIME_OF_DAY › accepts 24:00
- PASS - TIME_OF_DAY › rejects "24:01"
- PASS - TIME_OF_DAY › rejects "25:00"
- PASS - TIME_OF_DAY › rejects "9:30"
- PASS - TIME_OF_DAY › rejects "09:60"
- PASS - TIME_OF_DAY › rejects "09:30:00"
- PASS - TIME_OF_DAY › rejects "0930"
- PASS - TIME_OF_DAY › rejects ""
- PASS - TIME_OF_DAY › rejects " 09:30"
- PASS - TIME_OF_DAY › rejects "ab:cd"
- PASS - toMinutes / toText › round-trips every minute of the day including the 24:00 end
- PASS - normaliseTimeWindows › returns minutes sorted by start
- PASS - normaliseTimeWindows › allows windows that only touch, and a window ending at midnight
- PASS - normaliseTimeWindows › rejects start equals end
- PASS - normaliseTimeWindows › rejects start after end
- PASS - normaliseTimeWindows › rejects overnight (crosses midnight)
- PASS - normaliseTimeWindows › rejects start at 24:00
- PASS - normaliseTimeWindows › rejects overlap
- PASS - normaliseTimeWindows › rejects contained window
- PASS - normaliseTimeWindows › rejects exact duplicate

### `availability.api.int-spec.ts`

- PASS - service areas (master) › lets an admin add an area (audited) that customers and workers can then read
- PASS - service areas (master) › keeps names unique within a city (ignoring case) but allows the same name in another city
- PASS - service areas (master) › creates exactly one area when the same request is sent in parallel
- PASS - service areas (master) › rejects name too short
- PASS - service areas (master) › rejects city too short
- PASS - service areas (master) › rejects name too long
- PASS - service areas (master) › rejects missing name
- PASS - service areas (master) › rejects missing city
- PASS - service areas (master) › ignores server-controlled fields (mass assignment) and audits before/after on update
- PASS - service areas (master) › rejects clashing renames, empty updates and unknown ids
- PASS - service areas (master) › hides disabled areas from customers and workers but not from admins
- PASS - service areas (master) › refuses modification to workers, customers and admins without area.manage
- PASS - worker availability › needs a profile first, then starts empty
- PASS - worker availability › saves preference, areas and windows; windows come back as sorted HH:mm
- PASS - worker availability › treats each part independently: only the parts sent are replaced
- PASS - worker availability › accepts windows that touch each other, a window ending at midnight, and whole-day coverage
- PASS - worker availability › rejects windows: single-digit hour
- PASS - worker availability › rejects windows: hour 25
- PASS - worker availability › rejects windows: minute 60
- PASS - worker availability › rejects windows: 24:01
- PASS - worker availability › rejects windows: start equals end
- PASS - worker availability › rejects windows: start after end
- PASS - worker availability › rejects windows: overnight window
- PASS - worker availability › rejects windows: start at 24:00
- PASS - worker availability › rejects windows: overlap
- PASS - worker availability › rejects windows: contained window
- PASS - worker availability › rejects windows: duplicate window
- PASS - worker availability › rejects windows: empty list
- PASS - worker availability › rejects windows: missing end
- PASS - worker availability › rejects windows: not an array
- PASS - worker availability › rejects windows: 25 windows
- PASS - worker availability › rejects unknown preference
- PASS - worker availability › rejects lower-case preference
- PASS - worker availability › rejects empty area list
- PASS - worker availability › rejects duplicate areas
- PASS - worker availability › rejects non-uuid area
- PASS - worker availability › rejects empty body
- PASS - worker availability › rejects server-only fields
- PASS - worker availability › is atomic: a failed request saves none of its parts
- PASS - worker availability › rejects a disabled area the worker does not hold (422) but lets a held one stay
- PASS - worker availability › audits what changed (counts and ids, no personal data) and nothing for rejected requests
- PASS - worker availability › stays consistent when different window sets are saved in parallel (exactly one wins, never overlapping)
- PASS - worker availability › stays consistent when different area sets are saved in parallel
- PASS - worker availability › lets the database itself refuse overlapping, inverted and out-of-range windows
- PASS - ownership and role isolation › keeps every worker's availability separate
- PASS - ownership and role isolation › is reserved for workers; the admin endpoints are reserved for admins with the right permission
- PASS - ownership and role isolation › enforces view vs manage on the admin endpoints and records the admin as actor for assisted edits
- PASS - ownership and role isolation › stops a suspended worker at once and changes nothing behind the rejected request
- PASS - submission journey (Workers + Categories + Availability together) › lists the availability items as missing, then submits once everything required is saved
- PASS - submission journey (Workers + Categories + Availability together) › submits exactly once when the request is repeated in parallel
- PASS - readiness for future Search/Matching › answers "workers in area X available 09:00-12:00" with plain SQL, and the area lookup can use its index

## Not covered

- Search itself and query plans at production data volume (only index usability was checked with `enable_seqscan = off`).
- Weekdays, effective dates and overnight windows (not specified).
