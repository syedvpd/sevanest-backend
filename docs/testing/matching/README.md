# Matching - test results

**Result: PASS** - 11/11 tests passed, 0 failed (1 suite). Run date: 2026-10-08.

Environment: Node 24.21, PostgreSQL 17 and Redis 7 (Docker), dedicated test database `sevanest_test` (real database and Redis for integration tests), in-memory SMS and storage adapters. OTP/lockout limits in the tests are test values, not approved business values.

## Suites

| Kind | File | Passed | Failed |
|---|---|---|---|
| integration | `matching.api.int-spec.ts` | 11 | 0 |

## Mutation checks (tests proven to catch regressions)

- The same Search-condition mutation fails the Matching tests that prove unverified, draft and suspended workers never appear.

## Results by group

| Group | Passed | Failed |
|---|---|---|
| matching.api › candidate selection | 6 | 0 |
| matching.api › requirement validation | 2 | 0 |
| matching.api › authorization and audit | 3 | 0 |

## Every test and its result

### `matching.api.int-spec.ts`

- PASS - candidate selection › returns exactly the verified, active, submitted workers that meet every criterion, in a stable non-ranked order
- PASS - candidate selection › applies each criterion: engagement, timings, language and experience
- PASS - candidate selection › cannot be used to reach workers that are unverified, in draft, or suspended
- PASS - candidate selection › agrees with customer search for the same criteria
- PASS - candidate selection › pages deterministically and bounds the page size
- PASS - candidate selection › gives staff the worker identity needed to act, but no contact or private profile data
- PASS - requirement validation › needs the whole requirement and rejects malformed values
- PASS - requirement validation › answers 422 for a category or area that is not enabled
- PASS - authorization and audit › needs the matching.run permission and an admin account
- PASS - authorization and audit › audits each run with the requirement and the count, never with worker names or contact details
- PASS - authorization and audit › assigns, reserves and changes nothing: the workforce tables are identical before and after

## Not covered

- Scoring or ranking (none is defined; Q-46), assignment, booking, interview, trial, payment and notification (later modules).
