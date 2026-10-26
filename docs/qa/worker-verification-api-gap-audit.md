# Worker application and verification: API gap audit

Date: 2026-10-15. Scope: backend only. Evidence is the local code and a disposable local database (`sevanest_vfy_ci`); nothing was compared with staging or production, and no deployed API was called.

## 1. What the backend actually models (read this first)

The request used the words "dossier", "application", "worker verification status" and "activation". The code has different concepts. Nothing was renamed or faked to match.

| Request term | What exists | Evidence |
| --- | --- | --- |
| Application / `applicationId` / `applicationNumber` | **Not modelled.** One `WorkerProfile` per worker. Its `id` is the only identity; `submittedAt` is the submission time; `onboardingStatus` is `DRAFT` or `SUBMITTED` only. | `prisma/schema.prisma` `WorkerProfile` |
| Dossier / `dossierId` | **Not modelled.** Verification is one `WorkerVerificationCheck` row per (worker, check type). The "dossier" read is `GET /admin/workers/{workerId}/verification`. | `WorkerVerificationCheck`, `AdminWorkerVerificationController` |
| Worker verification status | **Derived, never stored.** `level` = `VERIFIED` / `IN_PROGRESS` / `NOT_STARTED`, computed from the admin-configured required set; `VERIFIED` when every required check is APPROVED and none is due for re-check. | `verification-eligibility.ts`, `VerificationService.levelOf` |
| Final decision (`APPROVED` / `REJECTED` / `CORRECTIONS_REQUESTED`) | **Per check only** (approve / reject / recheck). There is no worker-level decision state to write. | `VerificationService.transition` |
| Activation | **Not a state.** `users.status` is `ACTIVE` or `SUSPENDED` (default `ACTIVE`); a verified worker becomes searchable automatically. `PATCH /admin/workers/{id}` is a profile edit, not activation. | `AdminWorkersController.update`, `verifiedWorkerCondition` |
| `workers.manage_status` | **Not in the permission registry.** Real keys: `verification.review`, `verification.decide`, `verification.document.view`, `verification.configure`, `worker.view`, `worker.manage`, `user.status.manage`. | `rbac.constants.ts` |
| Reviewer display name | **Not stored.** Admin users have no name column. Only the reviewer user id is exposed. | `model User` |

Consequences: items 1 (worker-level decision), 7 (completed event) and 8 (activation) cannot be built without inventing business rules the project forbids. They are listed as product decisions (section 5), not implemented.

## 2. Requirement matrix

Status key: EXISTS = correct, unchanged. NEEDS UPDATE = existed, corrected now. MISSING = built now. DECISION = cannot be built without a product decision.

| # | Requirement / endpoint | Status | Evidence (source) | Canonical endpoint | Change made | Tests (local) | Remaining |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | Final worker decision `POST /admin/verification/dossiers/{id}/decision` | DECISION | No dossier/worker-level state (section 1). Level is derived. | Per-check `approve` / `reject` / `recheck`; overall result = `level` on `GET /admin/workers/{workerId}/verification` | None. Nothing invented. | Existing per-check suites (see section 4) | Q-123 |
| 1a | Approval blocked unless required checks complete | EXISTS (as derivation) | `levelOf` + `verifiedWorkerCondition`: a worker is VERIFIED only when all required checks are APPROVED and not due; empty required set = nobody verified (fail closed). Check approve needs `IN_REVIEW` (409 `INVALID_TRANSITION`). | same | None | `verification.api.int-spec.ts` state machine, level tests | Required set is Q-04/Q-118 |
| 1b | Concurrency / retries | EXISTS | `transition` locks the row `FOR UPDATE`; a parallel decision loses with 409. | same | None | `verification.api.int-spec.ts` | none |
| 2 | Application identity: `GET /admin/workers/{id}`, queue, dossier, worker verification | NEEDS UPDATE | `workerId` is returned by all four. No application number exists, none is fabricated. | `workerId` = application identity | Queue now also returns `workerName` and `applicationSubmittedAt` (the profile `submittedAt`). Roster/detail already carry `onboardingStatus` and `createdAt`. | `verification.assignment.int-spec.ts` (queue item shape) | Q-124: separate application number? |
| 3 | Queue and dossier retrieval | NEEDS UPDATE | `VerificationService.queue`, `VerificationRepository.queue`. Documents are metadata only (no key, no link). | `GET /admin/verification/queue`, `GET /admin/workers/{workerId}/verification` | Added filters `categoryId`, `search` (worker name), `assignedTo=me`, `reviewerId`; order is check `submittedAt` then `id` (stable); one row per check (checkId is the authoritative id, no display-field dedup). | assignment spec: search, category, order, validation | Queue is per check, not per worker (no worker-level row). OTP pre-check: not applicable, mobile OTP is verified at login and is not a check (`schema.prisma` comment). |
| 4a | `start-review` | NEEDS UPDATE | Before: set status only; `reviewerUserId` stayed null, so no assignment. | `POST /admin/verification/checks/{checkId}/start-review` | Now persists `reviewerUserId` and new `claimedAt`; repeat by owner is a no-op; another reviewer gets 409 `CHECK_ALREADY_ASSIGNED`; an unassigned `IN_REVIEW` check (after re-check) can be claimed. Audited (`verification.start_review`) with history event. | assignment spec (3 tests incl. concurrent claim) | no reassignment (Q-125) |
| 4b | `approve` | EXISTS | `VerificationService.approve`: needs IN_REVIEW, optional remarks and `recheckAt`. | `.../approve` | None | `verification.api.int-spec.ts` | "required evidence/notes" rule undefined (Q-126) |
| 4c | `reject` | EXISTS (partly) | Remarks mandatory (DTO `RemarksDto`); history + audit + worker notification. | `.../reject` | None | `verification.api.int-spec.ts` | No rejection **reason-code** enum exists; not invented (Q-126) |
| 4d | `recheck` | EXISTS | APPROVED to IN_REVIEW with mandatory remarks; the worker stops counting as verified at once. Per check, so "affected checks" = the check id. | `.../recheck` | `claimedAt` cleared on recheck/resubmit | `verification.api.int-spec.ts`, assignment spec | none |
| 5 | My Reviews | MISSING (built) | Queue had no reviewer filter or assignment data. | `GET /admin/verification/queue?assignedTo=me` | `assignedTo=me` resolves from the token; `reviewerId=<uuid>` for other reviewers; both together = 400; response has `reviewerUserId`, `claimedAt`. | assignment spec: me / other / unassigned / both / unauthorised | Reassign policy (Q-125). Name: only user id exists. |
| 6 | Signed document link | NEEDS UPDATE | `VerificationService.documentLink` already: permission `verification.document.view`, real object key, integrity re-check, audit before the link, storage path never returned, 404/409/503 errors. Response was `{url, expiresAt}`. | `GET /admin/verification/documents/{documentId}/link` | Response now `{url, signedUrl, expiresAt, expiresInSeconds}` (`url` kept for compatibility; `signedUrl` is the same value). | assignment spec + updated key assertion in `verification.api.int-spec.ts` | Mock storage only. No real bucket was exercised. |
| 7 | `worker.verification.completed` event | DECISION | The outbox carries notification payloads only (`NOTIFICATION_TOPIC`); no other topic or consumer exists. Admin recipient routing is undefined (Q-57). | none | Not built. Discovery instead: `GET /admin/workers?verified=true|false`. | assignment spec (verified filter) | Q-127 |
| 8 | Activation `PATCH /admin/workers/{id}` | DECISION | That route edits profile fields (`worker.manage`). Account suspension/reactivation is `PATCH /admin/users/{userId}/status` (`user.status.manage`). Workers are `ACTIVE` from creation; verification is separate. | `PATCH /admin/users/{userId}/status` for suspend/reactivate | None. No guessed permission key, no auto-activation. | existing user-status tests | Q-128 |
| 9 | SLA / expiry metadata | see below | | | | | Q-129 |
| 10 | Auth and permissions | EXISTS | Permissions read per request; admin login/refresh return `user.permissions` (`docs/qa/admin-session-permissions.md`). Reviewer id never taken from the caller for claims or `assignedTo=me`. | | None | assignment spec (403/401) | Q-70 matrix is unapproved |
| 11 | Database | NEEDS UPDATE | `claimed_at` was the only missing persisted fact. Reviewer, history and audit already existed. | | Migration `20261101090000_verification_claimed_at` (additive nullable column). | `migrate deploy` on an empty DB, `migrate diff` = no drift | Upgrade-path run: section 4 |

### SLA and expiry fields (item 9)

| Field | Classification | Notes |
| --- | --- | --- |
| `assignedTo` | Supported now | `reviewerUserId` + `claimedAt` on queue and admin view. |
| `decidedAt` | Already supported | `reviewedAt` on each check (admin and worker views). |
| Turnaround duration | Safely derivable, not added | `reviewedAt - submittedAt`; no consumer requested a format, so no field was added. |
| Document expiry / recheck due | Already supported | `recheckAt` (India date) and derived status `RECHECK_DUE`; the date is set by the reviewer on approval. No default interval invented. |
| `dueAt`, `isOverdue` | **Depends on a missing policy** | No verification SLA exists in the specs. Not added. |

## 3. Final canonical endpoint list (verification and related)

Base `/api/v1`. All admin routes need an ADMIN token. Errors use the project envelope `{ code, message, details? }`.

| Method | Path | Permission | Notes |
| --- | --- | --- | --- |
| GET | `/admin/verification/queue` | `verification.review` | Query: `status`, `checkType`, `categoryId`, `search`, `assignedTo=me`, `reviewerId`, `page`, `limit` (max 100). Item: `checkId, workerId, workerName, applicationSubmittedAt, checkType, status, submittedAt, reviewerUserId, claimedAt, uploadedDocuments`. Default status filter: SUBMITTED + IN_REVIEW. Oldest first, then id. |
| GET | `/admin/workers/{workerId}/verification` | `verification.review` | Full per-check view with history; adds `claimedAt` per check. |
| POST | `/admin/verification/checks/{checkId}/start-review` | `verification.review` | Claim. 409 `INVALID_TRANSITION`, 409 `CHECK_ALREADY_ASSIGNED`, 404 `CHECK_NOT_FOUND`. |
| POST | `/admin/verification/checks/{checkId}/approve` | `verification.decide` | Body `{remarks?, recheckAt?}`. |
| POST | `/admin/verification/checks/{checkId}/reject` | `verification.decide` | Body `{remarks}` required. |
| POST | `/admin/verification/checks/{checkId}/recheck` | `verification.decide` | Body `{remarks}` required. |
| GET | `/admin/verification/documents/{documentId}/link` | `verification.document.view` | `{url, signedUrl, expiresAt, expiresInSeconds}`; 404 `DOCUMENT_NOT_FOUND`, 409 `DOCUMENT_INTEGRITY_FAILED`, 503 `STORAGE_NOT_CONFIGURED`. |
| GET / PUT | `/admin/verification/requirements` | review / `verification.configure` | Required check set. |
| GET | `/admin/workers?verified=true\|false` | `worker.view` | New filter; account status is unchanged by verification. |
| PATCH | `/admin/users/{userId}/status` | `user.status.manage` | Suspend / reactivate (existing). |

OpenAPI: `docs/openapi.json`, exported from this local code (section 4). It matches local code only; it was not compared with a deployed API.

## 4. Verification evidence (local, run 2026-10-15)

See the final run block at the end of this file (filled from the actual command output).

## 5. Product decisions required (no invention)

- **Q-123 Worker-level decision**: is a single "approve application" step wanted on top of per-check approval? If yes: states, who may do it, what `CORRECTIONS_REQUESTED` maps to (today a rejected check lets the worker resubmit that check), and whether it is stored or stays derived.
- **Q-124 Application number**: is a human-readable application reference required? If yes: format, series, and whether it is created at profile submission.
- **Q-125 Reassignment**: who may take a case from another reviewer, and is there auto-release after inactivity? Today: 409, no override.
- **Q-126 Rejection reason codes and approval evidence**: the reason-code list, and which check types need notes/evidence before approval. Today: free-text remarks only.
- **Q-127 Verification-completed handoff**: which role is told, by which channel, and is a new event topic wanted (the outbox is notification-only; admin routing is Q-57)?
- **Q-128 Activation**: is a separate "activated by operations" step required after verification (new worker state and permission), or is verified + `ACTIVE` account enough as today?
- **Q-129 SLA**: the verification due time (from submission or claim), business-hours calendar, and the overdue definition.

## 6. Not verified

No staging/production call, no real storage provider (mock adapter only), no live SMS/FCM. `docs/openapi.json` is a local export.
