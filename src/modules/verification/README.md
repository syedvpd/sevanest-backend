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

| Method  | Path                                               | Requires                          | Purpose                                                                        |
| ------- | -------------------------------------------------- | --------------------------------- | ------------------------------------------------------------------------------ |
| GET     | `/workers/me/verification`                         | WORKER                            | Level, required checks, each check with status and remarks                     |
| POST    | `/workers/me/verification/checks/{type}/documents` | WORKER (profile submitted)        | `{contentType, sizeBytes}` -> signed upload link                               |
| POST    | `/workers/me/verification/documents/{id}/confirm`  | WORKER (owner)                    | Server checks the object arrived and fits; idempotent                          |
| POST    | `/workers/me/verification/checks/{type}/submit`    | WORKER                            | Submit one check for review; idempotent                                        |
| GET     | `/admin/verification/queue`                        | `verification.review`             | Oldest first; status, checkType, categoryId, search, assignedTo=me, reviewerId |
| GET/PUT | `/admin/verification/requirements`                 | review / `verification.configure` | Which checks are required (audited)                                            |
| POST    | `/admin/verification/checks/{id}/start-review`     | `verification.review`             | Claim: persists reviewer + claimedAt; 409 if held by another                   |
| POST    | `/admin/verification/checks/{id}/approve`          | `verification.decide`             | IN_REVIEW -> APPROVED (optional `recheckAt`)                                   |
| POST    | `/admin/verification/checks/{id}/reject`           | `verification.decide`             | IN_REVIEW -> REJECTED; body `reasonCode` (+ `remarks`, mandatory for OTHER)      |
| POST    | `/admin/verification/checks/{id}/release-review`   | `verification.review`             | IN_REVIEW -> SUBMITTED; the claimant, or a supervisor (`verification.reassign`) |
| POST    | `/admin/verification/checks/{id}/reassign-review`  | `verification.reassign`           | Give a check in review to another eligible reviewer                            |
| POST    | `/admin/verification/checks/{id}/notes`            | `verification.review`             | Reviewer or call note (staff only); counts as reviewer activity                |
| PUT     | `/admin/verification/checks/{id}/document-details` | `verification.review`             | Document number (last four kept) and validity end                              |
| POST    | `/admin/workers/{workerId}/verification/sign-off`  | `verification.signoff`            | Final sign-off once every required check is approved (idempotent)              |
| POST    | `/admin/workers/{workerId}/activate`               | `worker.activate`                 | Activate a signed-off worker: live in search and matching (idempotent)         |
| POST    | `/admin/verification/checks/{id}/recheck`          | `verification.decide`             | APPROVED -> IN_REVIEW (remarks required)                                       |
| GET     | `/admin/verification/documents/{id}/link`          | `verification.document.view`      | Signed link `{url, signedUrl, expiresAt, expiresInSeconds}`; audited           |
| GET     | `/admin/workers/{workerId}/verification`           | `verification.review`             | Checks, document metadata, full history                                        |

## Worker lifecycle (D-90, client decisions of 2026-10-26)

`DRAFT` -> `SUBMITTED` -> `UNDER_REVIEW` -> `VERIFIED` -> `ACTIVE`, plus `ACTION_REQUIRED` and `REJECTED`. This overall `applicationStatus` is derived (shown on the worker's
own verification, the admin dossier); only two facts are stored: the sign-off time and the activation time.

| applicationStatus | Meaning |
| --- | --- |
| `DRAFT` | profile not submitted yet |
| `SUBMITTED` | profile submitted, no check submitted yet |
| `UNDER_REVIEW` | at least one check submitted, or every required check approved and the sign-off is still to come |
| `ACTION_REQUIRED` | a check was rejected with a non-disqualifying reason: the worker resubmits only that check (approved checks stay approved) |
| `VERIFIED` | every required check approved AND the final sign-off given. Not yet live in search |
| `ACTIVE` | verified, signed off AND activated by operations: live in search and matching |
| `REJECTED` | a check was rejected with a disqualifying code (CRIMINAL_RECORD_DISQUALIFIED, SUSPECTED_TAMPERING): final |

Matching eligibility = fully verified (all required checks approved, none due for re-check) AND signed off AND activated (`activeWorkerCondition`).
A re-check takes a worker out of matching at once; approving it again brings them back without a new sign-off.

- **Sign-off** (`verification.signoff`, Operations Admin and Verification Supervisor): needs all required checks approved (409 `NOT_FULLY_VERIFIED`), no
  disqualifying rejection (409 `WORKER_DISQUALIFIED`). Sends `WORKER_VERIFIED` to the worker and raises an alert for `worker.activate` holders. Once only.
- **Activation** (`worker.activate`): needs the sign-off (409 `NOT_SIGNED_OFF`), still fully verified, one service category, one service area, the criminal
  self-declaration, an active account and no blacklisting (422 `ACTIVATION_REQUIREMENTS_MISSING` lists what is missing). Sends `WORKER_ACTIVATED`.
- **Application reference**: `SEVA` + 8 digits (database sequence), stamped when the profile is submitted; null while DRAFT.
- **Rejection codes**: BLURRY_IMAGE, DOCUMENT_EXPIRED, NAME_MISMATCH, INCOMPLETE_DOCUMENT, INVALID_DOCUMENT_TYPE, SUSPECTED_TAMPERING, UNVERIFIABLE_REFERENCE,
  CRIMINAL_RECORD_DISQUALIFIED, OTHER (remarks mandatory). The worker sees the standard wording of the code. Without remarks the wording is stored as the remarks.
- **Ownership**: approve, reject, notes and document details belong to the reviewer who claimed the check (409 `CHECK_NOT_ASSIGNED_TO_YOU`); a holder of `verification.reassign`
  (Operations Admin, Verification Supervisor, Super Admin) may act on any claim. A claim with no activity (claim, note, document link) for 30 minutes is released
  automatically to SUBMITTED by the worker-process loop `claim-release`.
- **Approval requirements**: PREVIOUS_EMPLOYMENT needs a CALL note; POLICE_VERIFICATION needs the reference number and a validity end; LICENSE needs a validity end
  (422 `APPROVAL_REQUIREMENTS_MISSING`). The validity end becomes the re-check date unless the reviewer chose another. Only the last four characters of a document
  number are stored (`XXXX-XXXX-1234`); the full number is never stored or logged.
- **SLA** (queue and dossier): `dueAt` = 24 business hours after submission (09:00-19:00 IST, Monday to Saturday; an after-hours submission starts at 09:00 the next
  business day); `claimDueAt` = claim + 2 hours; `slaFlags` `OVERDUE` (undecided past `dueAt`) and `STALLED_CLAIM` (claimed over 2 hours ago, undecided); `isOverdue`; `decidedAt`.

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
