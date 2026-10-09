# Verification (KYC)

Worker verification: checks, document metadata, review by authorised staff, history, and the single definition of "fully verified".

## Requirements covered

FR-VER-001..012 (identity, address, emergency contact, previous employment, police status; review, approve/reject with remarks,
expiry/re-check, not "verified" until approved, audit trail, manual fallback, status shown to the worker), FR-SEC-003/004 (KYC by role,
no public documents), FR-WD-007 (no identity documents on cards), FRD FM-05 and section 5 (status model, PROPOSED), BEA "KYC document
architecture" (private storage, short-lived signed links, permission check first, audited).

## Domain model

- `verification_requirements`: the set of check types that must all be approved. **Empty until an administrator chooses** (Q-04): while it
  is empty nobody counts as verified (fails closed).
- `worker_verification_checks`: one row per (worker, check type): `status` NOT_SUBMITTED | SUBMITTED | IN_REVIEW | APPROVED | REJECTED,
  reviewer, `reviewed_at`, `remarks`, optional `recheck_at` (India date). **RECHECK_DUE is derived** (APPROVED with `recheck_at` reached),
  never stored, so no scheduler is needed and the badge drops exactly on the date.
- `worker_verification_events`: append-only history (a database trigger blocks UPDATE/DELETE): from, to, actor, remarks, time.
- `verification_documents`: metadata only (type, size, status, submitted flag). The bytes live in private object storage; `object_key` is
  random, unique and never returned by any API.
- CHECK constraints: approved/rejected rows carry reviewer and time; a rejection carries remarks; `recheck_at` only on an approval;
  documents have a positive size and a consistent uploaded/submitted state.

## APIs (`/api/v1`)

| Method  | Path                                               | Requires                          | Purpose                                                    |
| ------- | -------------------------------------------------- | --------------------------------- | ---------------------------------------------------------- |
| GET     | `/workers/me/verification`                         | WORKER                            | Level, required checks, each check with status and remarks |
| POST    | `/workers/me/verification/checks/{type}/documents` | WORKER (profile submitted)        | `{contentType, sizeBytes}` -> signed upload link           |
| POST    | `/workers/me/verification/documents/{id}/confirm`  | WORKER (owner)                    | Server checks the object arrived and fits; idempotent      |
| POST    | `/workers/me/verification/checks/{type}/submit`    | WORKER                            | Submit one check for review; idempotent                    |
| GET     | `/admin/verification/queue`                        | `verification.review`             | Oldest first, filter by status / check type, paginated     |
| GET/PUT | `/admin/verification/requirements`                 | review / `verification.configure` | Which checks are required (audited)                        |
| POST    | `/admin/verification/checks/{id}/start-review`     | `verification.review`             | SUBMITTED -> IN_REVIEW                                     |
| POST    | `/admin/verification/checks/{id}/approve`          | `verification.decide`             | IN_REVIEW -> APPROVED (optional `recheckAt`)               |
| POST    | `/admin/verification/checks/{id}/reject`           | `verification.decide`             | IN_REVIEW -> REJECTED (remarks required)                   |
| POST    | `/admin/verification/checks/{id}/recheck`          | `verification.decide`             | APPROVED -> IN_REVIEW (remarks required)                   |
| GET     | `/admin/verification/documents/{id}/link`          | `verification.document.view`      | Short-lived signed link; the issue is audited              |
| GET     | `/admin/workers/{workerId}/verification`           | `verification.review`             | Checks, document metadata, full history                    |

## Rules

- Identity, address and police checks need an uploaded document; emergency-contact and previous-employment checks need that data in the
  worker profile. Nothing is invented beyond that (Q-45).
- A check can be changed by the worker only while NOT_SUBMITTED, REJECTED or RECHECK_DUE; a resubmission clears the old decision and keeps
  every earlier attempt in the history. Repeating a submission or a confirmation changes nothing.
- Transitions lock the check row; of many parallel decisions exactly one wins and the rest answer 409 `INVALID_TRANSITION`.
- Staff remarks live in the history table only. The audit log carries ids, check type and status change, never remarks, keys or links.
- `STORAGE_PROVIDER=disabled` (default) answers 503 `STORAGE_NOT_CONFIGURED`; `memory` is for tests and refused in production.

## Contract for other modules

`verifiedWorkerCondition(alias)` (SQL fragment, embedded by Search) and `VerificationService.isFullyVerified(workerId)`.
