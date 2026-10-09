# Replacement - test results

**Result: PASS** - 18/18 tests passed, 0 failed (1 suite). Run date: 2026-10-08.

Environment: Node 24.21, PostgreSQL 17 and Redis 7 (Docker), dedicated test database `sevanest_test` (real database and Redis for integration tests), in-memory SMS and storage adapters. OTP/lockout limits in the tests are test values, not approved business values.

## Suites

| Kind | File | Passed | Failed |
|---|---|---|---|
| integration | `replacement.api.int-spec.ts` | 18 | 0 |

## Other verification

- The eligibility policy boundary is exercised by overriding the policy; the default only requires an ACTIVE booking (Q-09, Q-54).

## Results by group

| Group | Passed | Failed |
|---|---|---|
| replacement.api › requesting | 4 | 0 |
| replacement.api › reading | 1 | 0 |
| replacement.api › staff review | 4 | 0 |
| replacement.api › selecting the replacement | 5 | 0 |
| replacement.api › withdrawing and cancelling | 3 | 0 |
| replacement.api › database invariants | 1 | 0 |

## Every test and its result

### `replacement.api.int-spec.ts`

- PASS - requesting › moves an active booking to REPLACEMENT_REQUESTED and records the reason
- PASS - requesting › is only for the owner, only for an eligible booking, and needs a reason
- PASS - requesting › allows one open request per booking, even when asked many times at once
- PASS - requesting › asks the eligibility policy, which is the one place a future rule goes
- PASS - reading › shows a customer only their own requests
- PASS - staff review › approves once (repeat is harmless) and never after a rejection
- PASS - staff review › needs remarks to reject, and a rejection returns the booking to ACTIVE
- PASS - staff review › keeps view, manage and candidate permissions separate and keeps others out
- PASS - staff review › offers alternative workers for the booking requirement, never the worker being replaced, and audits the search
- PASS - selecting the replacement › creates the replacement booking, closes the old one as REPLACED, and notifies
- PASS - selecting the replacement › repeats safely with the same worker and refuses a different one afterwards
- PASS - selecting the replacement › lets only one of many parallel selections win
- PASS - selecting the replacement › needs approval first, a different worker, and an eligible one
- PASS - selecting the replacement › cannot be done by someone else's customer, and staff can do it on the customer behalf
- PASS - withdrawing and cancelling › lets the customer withdraw an open request, returning the booking to ACTIVE, and repeats safely
- PASS - withdrawing and cancelling › cannot withdraw a finished request
- PASS - withdrawing and cancelling › closes the open request when the booking itself is cancelled
- PASS - database invariants › refuses a second open request and an inconsistent completion

## Not covered

- Replacement plan / fee, whether a replacement needs a new interview, reason list.
