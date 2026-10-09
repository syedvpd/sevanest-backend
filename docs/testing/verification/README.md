# Verification (KYC) - test results

**Result: PASS** - 41/41 tests passed, 0 failed (2 suites). Run date: 2026-10-08.

Environment: Node 24.21, PostgreSQL 17 and Redis 7 (Docker), dedicated test database `sevanest_test` (real database and Redis for integration tests), in-memory SMS and storage adapters. OTP/lockout limits in the tests are test values, not approved business values.

## Suites

| Kind | File | Passed | Failed |
|---|---|---|---|
| unit | `verification.rules.spec.ts` | 7 | 0 |
| integration | `verification.api.int-spec.ts` | 34 | 0 |

## Mutation checks (tests proven to catch regressions)

- Removing the row lock (FOR UPDATE) on a check fails both concurrency tests (parallel decisions: more than one wins; parallel submission: duplicate history); the code was restored.

## Results by group

| Group | Passed | Failed |
|---|---|---|
| verification.rules › effectiveStatus | 4 | 0 |
| verification.rules › indiaToday | 1 | 0 |
| verification.rules › verifiedWorkerCondition | 2 | 0 |
| verification.api › worker: status and access | 4 | 0 |
| verification.api › worker: documents | 6 | 0 |
| verification.api › worker: submitting a check | 5 | 0 |
| verification.api › admin: access control | 2 | 0 |
| verification.api › admin: queue and review state machine | 5 | 0 |
| verification.api › worker-level verification (the badge rule) | 4 | 0 |
| verification.api › admin: documents (KYC) access | 3 | 0 |
| verification.api › admin: required checks (configuration) | 2 | 0 |
| verification.api › audit trail and history | 1 | 0 |
| verification.api › database invariants | 2 | 0 |

## Every test and its result

### `verification.rules.spec.ts`

- PASS - effectiveStatus › treats a missing check as NOT_SUBMITTED
- PASS - effectiveStatus › keeps stored statuses as they are
- PASS - effectiveStatus › keeps an approval valid until its re-check date, and due on the date itself
- PASS - effectiveStatus › never turns a non-approval into RECHECK_DUE
- PASS - indiaToday › uses the India calendar, which is ahead of UTC late in the UTC day
- PASS - verifiedWorkerCondition › only accepts a plain column reference
- PASS - verifiedWorkerCondition › requires at least one requirement and every requirement to be approved and not due

### `verification.api.int-spec.ts`

- PASS - worker: status and access › shows a new worker NOT_STARTED with every check NOT_SUBMITTED and the required set
- PASS - worker: status and access › answers 404 before a worker profile exists, and 401/403 for anonymous, customer and admin callers
- PASS - worker: status and access › needs a submitted profile before verification can start (422 PROFILE_NOT_SUBMITTED)
- PASS - worker: status and access › stops a suspended worker at once
- PASS - worker: documents › issues a signed upload link without revealing any storage path
- PASS - worker: documents › rejects a content type that is not accepted, an oversized file and bad input
- PASS - worker: documents › confirms only a document that really arrived, repeats safely, and refuses a larger object than declared
- PASS - worker: documents › hides another worker's document: confirm answers 404 exactly like an unknown id
- PASS - worker: documents › limits the open draft documents of one check
- PASS - worker: documents › answers 503 and writes nothing when storage is not available
- PASS - worker: submitting a check › needs a document for identity, address and police checks (422 CHECK_INCOMPLETE)
- PASS - worker: submitting a check › checks emergency contact and previous employment against the profile data
- PASS - worker: submitting a check › submits with an uploaded document, repeats without a second event, and freezes the check
- PASS - worker: submitting a check › ignores status and reviewer fields a worker tries to send (mass assignment)
- PASS - worker: submitting a check › submits exactly once when the same submission arrives in parallel
- PASS - admin: access control › keeps customers, workers and anonymous callers out of every admin verification endpoint
- PASS - admin: access control › enforces each permission separately (review, decide, document view, configure)
- PASS - admin: queue and review state machine › lists the queue oldest first, filters it, and bounds the page size
- PASS - admin: queue and review state machine › only allows SUBMITTED to IN_REVIEW to APPROVED/REJECTED; every other move is 409 INVALID_TRANSITION
- PASS - admin: queue and review state machine › validates remarks and the re-check date, and answers 404/400 for bad ids
- PASS - admin: queue and review state machine › rejects with remarks, shows them to the worker, accepts a resubmission, and keeps every attempt in the history
- PASS - admin: queue and review state machine › lets only one of many parallel decisions win
- PASS - worker-level verification (the badge rule) › is VERIFIED only when every required check is approved, and never while a check is only submitted or in review
- PASS - worker-level verification (the badge rule) › never counts anyone as verified while no check is required (fails closed), and follows a change of the set at once
- PASS - worker-level verification (the badge rule) › moves an approved check back to review on re-check, which ends the verified status immediately
- PASS - worker-level verification (the badge rule) › treats an approval whose re-check date has been reached as RECHECK_DUE and lets the worker resubmit
- PASS - admin: documents (KYC) access › issues a short-lived link only for uploaded documents, audits every issue, and never returns the storage path
- PASS - admin: documents (KYC) access › returns no link (and writes no audit row) when the storage adapter fails, and 503 when it is not configured
- PASS - admin: documents (KYC) access › keeps KYC material out of every ordinary worker response
- PASS - admin: required checks (configuration) › replaces the set, is idempotent, rejects bad input, and audits the before/after
- PASS - admin: required checks (configuration) › converges to one of the requested sets when two administrators replace it at once
- PASS - audit trail and history › records every worker and staff action with actor, and keeps remarks and storage keys out of the audit log
- PASS - database invariants › refuses to change or delete verification history
- PASS - database invariants › refuses impossible states even from a direct SQL write

## Not covered

- A real object-storage vendor, malware scanning, encryption at rest and retention/deletion (not selected or not specified; Q-02, Q-08, Q-50).
- An external verification partner (Q-51); notifying the worker of an outcome (Notifications module).
- Real clock passage for re-check dates (simulated by moving the stored date).
