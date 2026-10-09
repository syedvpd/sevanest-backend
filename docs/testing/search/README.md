# Search - test results

**Result: PASS** - 16/16 tests passed, 0 failed (2 suites). Run date: 2026-10-08.

Environment: Node 24.21, PostgreSQL 17 and Redis 7 (Docker), dedicated test database `sevanest_test` (real database and Redis for integration tests), in-memory SMS and storage adapters. OTP/lockout limits in the tests are test values, not approved business values.

## Suites

| Kind | File | Passed | Failed |
|---|---|---|---|
| unit | `search.card.spec.ts` | 1 | 0 |
| integration | `search.api.int-spec.ts` | 15 | 0 |

## Mutation checks (tests proven to catch regressions)

- Replacing the verified condition in the Search query with TRUE fails 13 tests across Search and Matching (unverified workers appear); the code was restored.

## Other verification

- Query shape: a test counts the SQL statements per request: 6 for one result and for 100 results (page, count, four batched look-ups), 2 when nothing matches - no per-row queries. A test also checks that the planner can use the partial ordering index when sequential and bitmap scans are disabled; no plans were measured at production data volume.

## Results by group

| Group | Passed | Failed |
|---|---|---|
| search.card › toCard | 1 | 0 |
| search.api › eligibility | 7 | 0 |
| search.api › ordering and pagination | 3 | 0 |
| search.api › authorization and privacy | 3 | 0 |
| search.api › query shape and indexes | 2 | 0 |

## Every test and its result

### `search.card.spec.ts`

- PASS - toCard › copies an explicit allow-list, so extra worker fields can never reach a customer

### `search.api.int-spec.ts`

- PASS - eligibility › returns only active, submitted, fully verified workers for the category and area
- PASS - eligibility › finds the cook only under COOK and the other-area worker only in the other area
- PASS - eligibility › applies the engagement, availability, language and experience filters, alone and together
- PASS - eligibility › follows verification changes at once: a re-check removes the worker, approval adds one back
- PASS - eligibility › lists nobody while no check is required, and follows the required set
- PASS - eligibility › stops listing a worker when the account is suspended and lists them again when reactivated
- PASS - eligibility › answers 422 for a disabled or unknown category and area, and shows disabled categories nowhere on a card
- PASS - ordering and pagination › orders by experience with a stable tie-break, ascending or descending, identically on every call
- PASS - ordering and pagination › pages without gaps or repeats and reports the total
- PASS - ordering and pagination › bounds the page size and rejects malformed input
- PASS - authorization and privacy › is for customers only
- PASS - authorization and privacy › returns an exact allow-list of card fields and nothing private
- PASS - authorization and privacy › does not disclose why a worker is missing: an unverified worker looks exactly like a non-existent one
- PASS - query shape and indexes › runs a constant number of statements however many workers are returned
- PASS - query shape and indexes › has the indexes the search relies on, and the planner can use them

## Not covered

- Relevance ranking, salary/budget filtering, start date, geographic radius, rating summary and profile photo (not specified or not built; Q-46..Q-48, Q-52).
- Load and production-volume query plans.
