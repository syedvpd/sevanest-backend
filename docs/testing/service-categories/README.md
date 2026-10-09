# Service Categories - test results

**Result: PASS** - 27/27 tests passed, 0 failed (1 suite). Run date: 2026-10-08.

Environment: Node 24.21, PostgreSQL 17 and Redis 7 (Docker), dedicated test database `sevanest_test` (real database and Redis for integration tests), in-memory SMS and storage adapters. OTP/lockout limits in the tests are test values, not approved business values.

## Suites

| Kind | File | Passed | Failed |
|---|---|---|---|
| integration | `categories.api.int-spec.ts` | 27 | 0 |

## Manual verification (real running server)

- Real HTTP journey (test database): customer lists the categories, customer cannot create one (403); admin disables COOK, customer then gets 404 for it while the worker who holds it still sees `COOK` flagged disabled; admin re-enables it.

## Results by group

| Group | Passed | Failed |
|---|---|---|
| categories.api › reference data | 3 | 0 |
| categories.api › reading (customers, workers, admins) | 4 | 0 |
| categories.api › administration | 17 | 0 |
| categories.api › authorization | 3 | 0 |

## Every test and its result

### `categories.api.int-spec.ts`

- PASS - reference data › holds the categories defined by the project documents, stored in PostgreSQL
- PASS - reference data › never overwrites an admin's edits when the seed runs again
- PASS - reference data › lets the database refuse duplicates, bad codes and deletion of referenced categories
- PASS - reading (customers, workers, admins) › lists enabled categories, paginated and in a stable order, with only public fields
- PASS - reading (customers, workers, admins) › is readable by workers and admins too, and requires authentication
- PASS - reading (customers, workers, admins) › hides disabled categories from the public list and lookup
- PASS - reading (customers, workers, admins) › answers 404 for unknown ids and 400 for malformed ids or paging
- PASS - administration › creates a category, audited, and shows it to customers
- PASS - administration › prevents duplicate codes and names (names ignoring case)
- PASS - administration › creates exactly one category when the same request is sent in parallel
- PASS - administration › rejects lower-case code
- PASS - administration › rejects code with spaces
- PASS - administration › rejects one-letter code
- PASS - administration › rejects code starting with a digit
- PASS - administration › rejects name too short
- PASS - administration › rejects name too long
- PASS - administration › rejects description too long
- PASS - administration › rejects missing name
- PASS - administration › rejects missing code
- PASS - administration › ignores server-controlled fields on create (mass assignment)
- PASS - administration › updates name, description and enabled state; the code is immutable; before/after is audited
- PASS - administration › rejects renaming onto an existing name, empty updates, unknown ids and bad input
- PASS - administration › serialises parallel edits of one category (the result is exactly one of the submitted values)
- PASS - administration › lists everything for admins with filters and pagination, and reads one including disabled
- PASS - authorization › refuses every modification (and the admin list) to workers, customers and admins without category.manage
- PASS - authorization › lets an admin holding category.manage (and nothing else) administer categories
- PASS - authorization › applies a suspension or role removal on the very next request

## Not covered

- Localised names and ordering controls (undefined by the specification).
