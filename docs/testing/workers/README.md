# Workers - test results

**Result: PASS** - 72/72 tests passed, 0 failed (3 suites). Run date: 2026-10-08.

Environment: Node 24.21, PostgreSQL 17 and Redis 7 (Docker), dedicated test database `sevanest_test` (real database and Redis for integration tests), in-memory SMS and storage adapters. OTP/lockout limits in the tests are test values, not approved business values.

## Suites

| Kind | File | Passed | Failed |
|---|---|---|---|
| unit | `fields.spec.ts` | 1 | 0 |
| unit | `language.spec.ts` | 14 | 0 |
| integration | `workers.api.int-spec.ts` | 57 | 0 |

## Manual verification (real running server)

- Real HTTP journey (test database): 404 before profile; profile created with forbidden `onboardingStatus` ignored (DRAFT); step saves; invalid pincode rejected; submit too early lists the missing items; role set; submit succeeds and repeats idempotently; worker 2 sees only own profile; customer and worker get 403 on the admin worker list; admin sees detail (private fields, `hasProfilePhoto=false`, no photo reference/KYC), masked list, assisted edit; suspended worker gets 401.

## Results by group

| Group | Passed | Failed |
|---|---|---|
| fields › changedFieldNames | 1 | 0 |
| language › LANGUAGE_CODE | 12 | 0 |
| language › assertLanguageSupported | 2 | 0 |
| workers.api › profile | 10 | 0 |
| workers.api › saving steps (PATCH /workers/me) | 23 | 0 |
| workers.api › roles (PUT /workers/me/categories) | 9 | 0 |
| workers.api › submission rules (availability items are covered in the Availability suite) | 2 | 0 |
| workers.api › ownership and role isolation | 3 | 0 |
| workers.api › admin worker management | 8 | 0 |
| workers.api › contract for other modules and database invariants | 2 | 0 |

## Every test and its result

### `fields.spec.ts`

- PASS - changedFieldNames › lists provided fields only, sorted, ignoring undefined (null is a deliberate value)

### `language.spec.ts`

- PASS - LANGUAGE_CODE › accepts en
- PASS - LANGUAGE_CODE › accepts hi
- PASS - LANGUAGE_CODE › accepts te
- PASS - LANGUAGE_CODE › accepts en-IN
- PASS - LANGUAGE_CODE › accepts zh-Hant
- PASS - LANGUAGE_CODE › rejects ""
- PASS - LANGUAGE_CODE › rejects "English"
- PASS - LANGUAGE_CODE › rejects "EN"
- PASS - LANGUAGE_CODE › rejects "e"
- PASS - LANGUAGE_CODE › rejects "en_IN"
- PASS - LANGUAGE_CODE › rejects "en-"
- PASS - LANGUAGE_CODE › rejects "12"
- PASS - assertLanguageSupported › accepts any well-formed code when no allow-list is configured
- PASS - assertLanguageSupported › enforces the allow-list when one is configured and names the field

### `workers.api.int-spec.ts`

- PASS - profile › answers 404 until the profile exists
- PASS - profile › starts a DRAFT profile on the verified account, audited without personal data
- PASS - profile › never exposes internal or KYC-related fields
- PASS - profile › rejects empty name and creates nothing
- PASS - profile › rejects digits in name and creates nothing
- PASS - profile › rejects symbols in name and creates nothing
- PASS - profile › rejects name too long and creates nothing
- PASS - profile › rejects missing name and creates nothing
- PASS - profile › rejects a second profile and creates exactly one under parallel requests
- PASS - profile › ignores server-controlled fields on create (mass assignment)
- PASS - saving steps (PATCH /workers/me) › saves each onboarding step independently and keeps the others
- PASS - saving steps (PATCH /workers/me) › replaces a group as a whole, replaces languages, and clears optional values with null
- PASS - saving steps (PATCH /workers/me) › rejects negative experience and changes nothing
- PASS - saving steps (PATCH /workers/me) › rejects fractional experience and changes nothing
- PASS - saving steps (PATCH /workers/me) › rejects absurd experience and changes nothing
- PASS - saving steps (PATCH /workers/me) › rejects zero salary and changes nothing
- PASS - saving steps (PATCH /workers/me) › rejects negative salary and changes nothing
- PASS - saving steps (PATCH /workers/me) › rejects salary with 3 decimals and changes nothing
- PASS - saving steps (PATCH /workers/me) › rejects empty languages and changes nothing
- PASS - saving steps (PATCH /workers/me) › rejects duplicate languages and changes nothing
- PASS - saving steps (PATCH /workers/me) › rejects bad language code and changes nothing
- PASS - saving steps (PATCH /workers/me) › rejects bad pincode and changes nothing
- PASS - saving steps (PATCH /workers/me) › rejects incomplete address and changes nothing
- PASS - saving steps (PATCH /workers/me) › rejects bad emergency mobile and changes nothing
- PASS - saving steps (PATCH /workers/me) › rejects emergency contact without name and changes nothing
- PASS - saving steps (PATCH /workers/me) › rejects bad previous employer mobile and changes nothing
- PASS - saving steps (PATCH /workers/me) › rejects name with digits and changes nothing
- PASS - saving steps (PATCH /workers/me) › rejects empty updates and updates that contain only server-controlled fields
- PASS - saving steps (PATCH /workers/me) › ignores server-controlled fields mixed into a valid update (mass assignment)
- PASS - saving steps (PATCH /workers/me) › audits field names only, never values
- PASS - saving steps (PATCH /workers/me) › cannot update a profile that does not exist
- PASS - saving steps (PATCH /workers/me) › keeps parallel language replacements consistent (exactly one wins, no merged set)
- PASS - saving steps (PATCH /workers/me) › keeps parallel updates of different steps (no lost update)
- PASS - roles (PUT /workers/me/categories) › sets and replaces the worker's roles from enabled categories, audited with added/removed
- PASS - roles (PUT /workers/me/categories) › rejects empty set
- PASS - roles (PUT /workers/me/categories) › rejects not an array
- PASS - roles (PUT /workers/me/categories) › rejects not a uuid
- PASS - roles (PUT /workers/me/categories) › rejects duplicates
- PASS - roles (PUT /workers/me/categories) › rejects missing
- PASS - roles (PUT /workers/me/categories) › rejects an unknown category (400) and a disabled category the worker does not hold (422)
- PASS - roles (PUT /workers/me/categories) › lets a worker keep a category that was disabled after they chose it
- PASS - roles (PUT /workers/me/categories) › stays consistent when different role sets are submitted in parallel
- PASS - submission rules (availability items are covered in the Availability suite) › answers 422 PROFILE_INCOMPLETE listing what is missing, and stays DRAFT
- PASS - submission rules (availability items are covered in the Availability suite) › cannot submit without a profile
- PASS - ownership and role isolation › keeps every worker's data separate (the API has no worker id to tamper with)
- PASS - ownership and role isolation › is reserved for workers: customers, admins and anonymous callers are refused on every operation
- PASS - ownership and role isolation › stops a suspended worker at once and changes nothing behind the rejected requests
- PASS - admin worker management › lists workers with pagination, masked mobiles, categories, and filters
- PASS - admin worker management › rejects page 0
- PASS - admin worker management › rejects limit 101
- PASS - admin worker management › rejects bad status
- PASS - admin worker management › rejects bad category id
- PASS - admin worker management › shows full detail to authorised admins, including private fields, with 404/400 handling
- PASS - admin worker management › supports assisted onboarding: admin edits and sets roles on the worker's behalf, audited with the admin as actor
- PASS - admin worker management › enforces permissions per capability and refuses non-admins
- PASS - contract for other modules and database invariants › exposes a private-data-free contract to future modules
- PASS - contract for other modules and database invariants › lets the database refuse states the application must never produce

## Not covered

- Photo upload and KYC (not built; Verification module).
- Customer-facing worker visibility (undefined).
- Load tests.
