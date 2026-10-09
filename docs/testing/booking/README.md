# Booking - test results

**Result: PASS** - 23/23 tests passed, 0 failed (1 suite). Run date: 2026-10-08.

Environment: Node 24.21, PostgreSQL 17 and Redis 7 (Docker), dedicated test database `sevanest_test` (real database and Redis for integration tests), in-memory SMS and storage adapters. OTP/lockout limits in the tests are test values, not approved business values.

## Suites

| Kind | File | Passed | Failed |
|---|---|---|---|
| integration | `booking.api.int-spec.ts` | 23 | 0 |

## Other verification

- Covered: create (with/without worker, idempotency key, duplicate protection), the full lifecycle through every FRD section 4 state, worker decline, staff match, cancellation, ownership (404), role limits (403), invalid transitions (409), repeated and parallel actions, re-check of worker eligibility at confirmation, database invariants and the append-only timeline.

## Results by group

| Group | Passed | Failed |
|---|---|---|
| booking.api › creating a booking | 8 | 0 |
| booking.api › lifecycle | 6 | 0 |
| booking.api › rules on every action | 4 | 0 |
| booking.api › concurrency and idempotent repeats | 2 | 0 |
| booking.api › admin | 2 | 0 |
| booking.api › database invariants | 1 | 0 |

## Every test and its result

### `booking.api.int-spec.ts`

- PASS - creating a booking › starts as NEW_REQUEST without a worker, with a timeline, and is listed for the customer only
- PASS - creating a booking › starts as MATCHED when an eligible worker is chosen, and offers the worker only a requirement summary
- PASS - creating a booking › refuses a worker who is not eligible, whatever the reason, with one answer
- PASS - creating a booking › validates the requirement
- PASS - creating a booking › is for customers only
- PASS - creating a booking › answers the same request with the same key once, and refuses the key for a different request
- PASS - creating a booking › creates exactly one booking when the same keyed request arrives in parallel
- PASS - creating a booking › refuses a second open booking with the same worker and service, and allows it after a cancellation
- PASS - lifecycle › walks the whole state model: schedule, interview done, confirm, paid, start, complete
- PASS - lifecycle › lets the worker decline: MATCHED returns to NEW_REQUEST without the worker, a scheduled one returns to MATCHED
- PASS - lifecycle › lets the customer reopen matching after a schedule or an interview
- PASS - lifecycle › lets staff match an eligible worker onto a NEW_REQUEST and refuses an ineligible one
- PASS - lifecycle › cancels from the permitted states with a reason, records who and why, and is final
- PASS - lifecycle › does not let an active service be cancelled, and completes only from ACTIVE
- PASS - rules on every action › requires the fields each action needs and rejects past dates
- PASS - rules on every action › rejects an invalid action name and a malformed id
- PASS - rules on every action › tells apart "never allowed for you" (403) from "not now" (409) and "not yours" (404)
- PASS - rules on every action › re-checks the worker before the customer commits: a worker who stopped being verified cannot be confirmed
- PASS - concurrency and idempotent repeats › applies one of many parallel conflicting actions, never two
- PASS - concurrency and idempotent repeats › records a repeated confirmation once
- PASS - admin › needs booking.view to read and booking.manage to act, and keeps other callers out
- PASS - admin › lists and filters bookings with bounded pages
- PASS - database invariants › refuses impossible states and any change to the timeline

## Not covered

- Booking state model is PROPOSED (FRD section 4, conflict C-02 / Q-05); cancellation fee and refund rules (Q-21); worker acceptance as a separate state; interview outcome values.
