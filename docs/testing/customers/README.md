# Customers - test results

**Result: PASS** - 67/67 tests passed, 0 failed (2 suites). Run date: 2026-10-08.

Environment: Node 24.21, PostgreSQL 17 and Redis 7 (Docker), dedicated test database `sevanest_test` (real database and Redis for integration tests), in-memory SMS and storage adapters. OTP/lockout limits in the tests are test values, not approved business values.

## Suites

| Kind | File | Passed | Failed |
|---|---|---|---|
| unit | `customer.rules.spec.ts` | 9 | 0 |
| integration | `customers.api.int-spec.ts` | 58 | 0 |

## Mutation checks (tests proven to catch regressions)

- Removing the profile-row lock fails both default-address race tests (the database unique index then rejects the loser); the code was restored.

## Manual verification (real running server)

- Real HTTP journey (test database): profile creation with a forbidden `verificationStatus` field ignored (stays PENDING), duplicate profile 409, address validation, default address replaced, soft removal, customer B gets 404 on customer A's address (read and delete), admin finds a customer by mobile (masked), sets VERIFIED, adds a note, suspends. Log and audit scans found no secrets or personal data.

## Results by group

| Group | Passed | Failed |
|---|---|---|
| customer.rules › assertCoordinatePair | 9 | 0 |
| customers.api › profile | 18 | 0 |
| customers.api › addresses | 26 | 0 |
| customers.api › admin customer management | 14 | 0 |

## Every test and its result

### `customer.rules.spec.ts`

- PASS - assertCoordinatePair › accepts undefined / undefined
- PASS - assertCoordinatePair › accepts null / null
- PASS - assertCoordinatePair › accepts 17.4 / 78.3
- PASS - assertCoordinatePair › accepts 0 / 0
- PASS - assertCoordinatePair › rejects half-set coordinates 17.4 / undefined
- PASS - assertCoordinatePair › rejects half-set coordinates 17.4 / null
- PASS - assertCoordinatePair › rejects half-set coordinates undefined / 78.3
- PASS - assertCoordinatePair › rejects half-set coordinates null / 78.3
- PASS - assertCoordinatePair › names the missing field

### `customers.api.int-spec.ts`

- PASS - profile › answers 404 until the profile exists
- PASS - profile › creates the profile: PENDING, mobile from the verified identity, audited without personal data
- PASS - profile › accepts international names and common name punctuation
- PASS - profile › rejects empty name with field-level VALIDATION_FAILED and saves nothing
- PASS - profile › rejects digits in name with field-level VALIDATION_FAILED and saves nothing
- PASS - profile › rejects symbols in name with field-level VALIDATION_FAILED and saves nothing
- PASS - profile › rejects name too long with field-level VALIDATION_FAILED and saves nothing
- PASS - profile › rejects bad email with field-level VALIDATION_FAILED and saves nothing
- PASS - profile › rejects missing email with field-level VALIDATION_FAILED and saves nothing
- PASS - profile › rejects bad language format with field-level VALIDATION_FAILED and saves nothing
- PASS - profile › rejects missing language with field-level VALIDATION_FAILED and saves nothing
- PASS - profile › rejects a second profile (409) and creates exactly one under parallel requests
- PASS - profile › ignores server-controlled fields on create and update (mass assignment)
- PASS - profile › updates profile fields, audits field names only, and rejects empty updates
- PASS - profile › cannot update a profile that does not exist
- PASS - profile › keeps each customer's data separate
- PASS - profile › is reserved for customers: workers, admins and anonymous callers are refused
- PASS - profile › stops a suspended customer at once, across every customer endpoint
- PASS - addresses › requires a profile first (409)
- PASS - addresses › saves several addresses with optional map coordinates and lists them (own only)
- PASS - addresses › rejects bad pincode without saving anything
- PASS - addresses › rejects pincode with letters without saving anything
- PASS - addresses › rejects pincode starting 0 without saving anything
- PASS - addresses › rejects missing line without saving anything
- PASS - addresses › rejects missing area without saving anything
- PASS - addresses › rejects missing city without saving anything
- PASS - addresses › rejects blank city without saving anything
- PASS - addresses › rejects latitude only without saving anything
- PASS - addresses › rejects longitude only without saving anything
- PASS - addresses › rejects latitude out of range without saving anything
- PASS - addresses › rejects longitude out of range without saving anything
- PASS - addresses › rejects too many decimals without saving anything
- PASS - addresses › rejects non-numeric coordinates without saving anything
- PASS - addresses › rejects isDefault not boolean without saving anything
- PASS - addresses › has no default until one is chosen, then keeps exactly one default
- PASS - addresses › is idempotent when the current default is chosen again (no extra audit)
- PASS - addresses › never ends with two defaults when default changes race
- PASS - addresses › never ends with two defaults when creations with isDefault race
- PASS - addresses › edits address fields, supports clearing the map location, and keeps coordinates paired
- PASS - addresses › does not let a client flip server-controlled address fields (mass assignment)
- PASS - addresses › removes an address softly: hidden from the customer, kept in the database, default cleared
- PASS - addresses › treats another customer's address id as not found for every operation (IDOR)
- PASS - addresses › rejects malformed address ids
- PASS - addresses › lets the database itself refuse states the application must never produce
- PASS - admin customer management › lists customers with pagination, filters and masked mobiles
- PASS - admin customer management › filters by verification status
- PASS - admin customer management › rejects page 0
- PASS - admin customer management › rejects negative page
- PASS - admin customer management › rejects limit above the ceiling
- PASS - admin customer management › rejects limit 0
- PASS - admin customer management › rejects non-numeric page
- PASS - admin customer management › rejects unknown status
- PASS - admin customer management › shows full detail: unmasked mobile, account status, and inactive addresses flagged
- PASS - admin customer management › answers 404 for unknown customers and 400 for malformed ids
- PASS - admin customer management › changes verification status with an audited before/after, idempotently and safely under concurrency
- PASS - admin customer management › adds and lists notes newest first, auditing the note id but never its text
- PASS - admin customer management › never exposes notes or admin data to the customer
- PASS - admin customer management › enforces permissions per capability and refuses non-admins

## Not covered

- Load testing of list endpoints; measured query counts (list queries reviewed: profiles, count, one batched user lookup).
