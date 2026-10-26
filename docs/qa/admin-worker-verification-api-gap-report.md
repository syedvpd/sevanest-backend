# Admin Portal worker verification: API gap report

Date: 2026-10-26. Backend only. Extends `docs/qa/worker-verification-api-gap-audit.md` (reviewer claim, queue filters, link fields; already on `main`). All evidence is local (disposable databases `sevanest_vfy_ci`, `sevanest_vfy2_ci`, in-memory storage adapter). Nothing was checked on staging or production.

Status key: EXISTS, NEEDS UPDATE, MISSING, BLOCKED (product decision or external dependency).

## 1. Root cause of the document-link 404

`GET /api/v1/admin/verification/documents/{documentId}/link` (`AdminVerificationController.documentLink` to `VerificationService.documentLink`) answered `404 DOCUMENT_NOT_FOUND` for three different situations:

1. no `verification_documents` row with that id;
2. the id was not a document id (for example a check id or a different id from the page);
3. **the row exists but `status` is not `UPLOADED`**: the worker requested an upload slot but never called `POST /workers/me/verification/documents/{id}/confirm`, or the server discarded the object (`purgedAt`).

The lookup is by the **database document id** (`VerificationDocument.id`), never by check id, storage key or upload id. There is no `checkType` query parameter and none is required.

I cannot say which of the three hit the Admin Portal: the deployed database and bucket are not reachable from this workspace (no admin credentials, no database access). The code shows (3) is the only case where a document is visible in the dossier yet has no file, and (2) is the common frontend mistake. The Admin Portal must send the `documentId` shown in the dossier, and only for documents with `available: true`.

Fix (smallest, additive, no migration):
- A document that exists but has no stored file now answers **409 `DOCUMENT_NOT_AVAILABLE`** (reason in the message: not confirmed, or discarded). 404 stays only for an unknown id.
- A confirmed document whose object is gone from storage answers **409 `DOCUMENT_OBJECT_MISSING`** (before: with a stored hash it was reported as an integrity failure; without a hash a link to nothing was issued).
- The dossier now says per document whether it can be opened (section 2), so the frontend never offers a dead attachment.

Files: `src/modules/verification/verification.service.ts` (`documentLink`, `adminDocumentView`, `objectMissing`), `src/modules/verification/dto/verification.dto.ts`.

## 2. Dossier document references

Authoritative dossier: **`GET /api/v1/admin/workers/{workerId}/verification`** (permission `verification.review`). There is no separate dossier id: the dossier is keyed by the worker id (`WorkerProfile.id`, also the application identity; no application number exists, Q-124). The queue (`GET /admin/verification/queue`) lists checks, not workers.

Response `AdminWorkerVerificationResponse`: `workerId`, `level` (`VERIFIED` | `IN_PROGRESS` | `NOT_STARTED`), `requiredChecks[]`, `checks[]`. Each check: `checkType, status, required, submittedAt, reviewedAt, remarks, recheckAt, checkId, reviewerUserId, claimedAt, history[], documents[]`.

Each `documents[]` item (`AdminDocumentView`), all persisted values:

| Field | Meaning |
| --- | --- |
| `documentId` / `id` | `VerificationDocument.id`: the exact id the link endpoint accepts |
| `documentType` | the check type the document is evidence for (no finer type is stored) |
| `mimeType` / `contentType` | validated content type (pdf, jpeg, png) |
| `sizeBytes`, `createdAt` | as stored |
| `status` | upload status `PENDING_UPLOAD` or `UPLOADED` |
| `submitted` | true once the document is part of a submission (false = still the worker's open draft) |
| `availability` / `available` | `AVAILABLE` only when uploaded and not discarded; `NOT_UPLOADED`; `DISCARDED`. Show an attachment only when `available` is true |

Not supported (nothing stored, nothing invented): masked document number, document expiry or validity date (the only date is the check's `recheckAt`). Storage keys, hashes and links never appear. The worker's own view (`GET /workers/me/verification`) is unchanged.

## 3. Secure document access and storage configuration

| Item | Finding |
| --- | --- |
| Permission | `verification.document.view` (separate from `verification.review` and `verification.decide`); enforced server-side (`@Permissions`). Default holders: Verification Executive, Super Admin. |
| Response | `{ url, signedUrl, expiresAt, expiresInSeconds }`. `signedUrl` equals `url` (kept for compatibility). `expiresAt` is the provider-returned instant (ISO-8601). `expiresInSeconds` = `expiresAt - now` when issued; both follow `SIGNED_URL_TTL_SECONDS` (`config.verificationDocuments.signedUrlTtlSeconds`). |
| Refresh | Links are not renewable: request a new one by calling the endpoint again. An expired link is rejected by the storage provider (S3 `AccessDenied`), not by this API. |
| Errors | 401 no token; 403 missing permission; 400 malformed id; 404 `DOCUMENT_NOT_FOUND`; 409 `DOCUMENT_NOT_AVAILABLE`; 409 `DOCUMENT_OBJECT_MISSING`; 409 `DOCUMENT_INTEGRITY_FAILED` (object differs from the confirmed hash); 503 `STORAGE_NOT_CONFIGURED` (provider failure or storage disabled). No link is returned on any error. |
| Audit | Every issued link writes `verification.document_view` (actor, role, worker, check) before the link is returned; integrity failures write `verification.document_integrity_failed`. Signed URLs are never logged. |
| Storage config | `STORAGE_PROVIDER=s3` needs `STORAGE_S3_ENDPOINT`, `STORAGE_S3_REGION`, `STORAGE_S3_BUCKET`, `STORAGE_S3_ACCESS_KEY_ID`, `STORAGE_S3_SECRET_ACCESS_KEY`; the bucket must be private. `memory` is refused in production. Disabled storage answers 503. |
| CORS | The API controls only its own origin list (`CORS_ORIGINS`); a preflight from `http://localhost:3000` to the deployed API returned 204 with that origin allowed (checked 2026-10-16). The signed URL points at the **bucket**, so loading it with `fetch` from the portal needs a bucket CORS rule (allow GET from the portal origin). Opening it in a new tab, `<img>` or `<iframe>` needs none. This is a storage-side setting, not a backend code change. |
| Range requests | Not proxied: the browser talks to the bucket directly, so range requests and PDF/image delivery are the provider's behaviour (S3-compatible storage supports them). Not exercised here. |

## 4. Review ownership and release

| Question | Answer (from code) |
| --- | --- |
| Claim | `POST /admin/verification/checks/{checkId}/start-review` (`verification.review`). From `SUBMITTED`, or from an unassigned `IN_REVIEW` (after a re-check). |
| Stored | `worker_verification_checks.reviewer_user_id` and `claimed_at` (migration `20261101090000_verification_claimed_at`). |
| Duplicates | The check row is locked `FOR UPDATE`; of two simultaneous claims one wins (200), the other gets 409 `CHECK_ALREADY_ASSIGNED`. The owner repeating the call changes nothing. |
| In responses | Queue item and dossier check: `reviewerUserId`, `claimedAt` (no display name exists). Assignment is never inferred from `IN_REVIEW`. |
| Release / unclaim | **MISSING, not implemented (BLOCKED on a decision).** No existing operation releases a claim; approve, reject and recheck are the only ways out of a claim. |
| Interrupted / unavailable reviewer | Nothing happens automatically (no timeout, no reassignment). The check stays claimed. Recovery today: a database fix. |
| Reassign | None. |

Proposed contract, **not implemented** (needs Q-125): `POST /admin/verification/checks/{checkId}/release-review`, permission `verification.review`, no body or `{reason}`. Allowed for the current owner; another reviewer or a supervisor only if a role/permission is approved (the registry has none). Effect: `IN_REVIEW` with a reviewer goes back to `SUBMITTED`, `reviewer_user_id` and `claimed_at` null, a history event and an audit entry. Open points: where a re-check (`APPROVED` to `IN_REVIEW`) returns to, and who may release someone else's claim.

## 5. Queue contract

`GET /api/v1/admin/verification/queue`, permission `verification.review`. Query: `status` (default `SUBMITTED` and `IN_REVIEW`), `checkType`, `categoryId`, `search` (worker name), `assignedTo=me`, `reviewerId`, `page`, `limit` (max 100). Order: check `submittedAt` ascending, then `id`. Items:

`checkId` (required by every review action), `workerId` (also the application identity), `workerName`, `applicationSubmittedAt`, `checkType`, `status`, `submittedAt`, `reviewerUserId`, `claimedAt`, `uploadedDocuments`. Envelope `{ data[], meta: { page, limit, total } }`. There is no dossier id and no application number: use `workerId` with `GET /admin/workers/{workerId}/verification`.

Check status values (`VerificationCheckStatus`, stored):

| Status | Meaning | Moves to |
| --- | --- | --- |
| `NOT_SUBMITTED` | row exists, worker has not submitted | `SUBMITTED` (worker submit) |
| `SUBMITTED` | waiting for a reviewer | `IN_REVIEW` (claim) |
| `IN_REVIEW` | claimed, or re-check requested | `APPROVED`, `REJECTED` |
| `APPROVED` | accepted; counts toward verified | `IN_REVIEW` (recheck) |
| `REJECTED` | refused with remarks; the worker can resubmit | `SUBMITTED` (worker resubmits) |

Derived (never stored): `RECHECK_DUE` = `APPROVED` whose `recheckAt` has been reached. **Corrections required** is not a status: it is `REJECTED` plus the reviewer's `remarks`. Overall `level` is derived from the required set; queue status, check status and `level` therefore cannot disagree. Frontend mapping: submitted = `SUBMITTED`; in review = `IN_REVIEW`; corrections required = `REJECTED`; re-check due = effective `RECHECK_DUE`; rejected = `REJECTED`; approved = `APPROVED`. The queue returns stored status only; `RECHECK_DUE` appears in the dossier and worker views.

## 6. Decisions and audit history

| Operation | Route (`/api/v1/admin/verification/…`) | Permission | Body | Rules and conflicts |
| --- | --- | --- | --- | --- |
| Start review | `POST checks/{checkId}/start-review` | `verification.review` | none | 409 `INVALID_TRANSITION`, 409 `CHECK_ALREADY_ASSIGNED`, 404 `CHECK_NOT_FOUND` |
| Approve | `POST checks/{checkId}/approve` | `verification.decide` | `{ remarks?, recheckAt? }` | needs `IN_REVIEW`; `recheckAt` a real future India date |
| Reject | `POST checks/{checkId}/reject` | `verification.decide` | `{ remarks }` (1-1000, required) | needs `IN_REVIEW`; worker is notified |
| Re-verify | `POST checks/{checkId}/recheck` | `verification.decide` | `{ remarks }` required | needs `APPROVED`; worker stops counting as verified at once |
| History | `GET /admin/workers/{workerId}/verification` | `verification.review` | | `checks[].history[]`: `fromStatus, toStatus, actorUserId, remarks, createdAt`, oldest first, append-only (database trigger) |

Audit: each operation writes an audit row (`verification.start_review`, `.approve`, `.reject`, `.recheck`) with ids and status change; remarks stay in the history table only. Rejection remarks are worker-visible (the worker view shows them). **Missing / undefined**: a structured rejection reason code (no list is approved, Q-126); a separate "internal call note" on a verification check (none exists; internal notes exist only on support tickets, `POST /admin/support/tickets/{ticketId}/messages` with `internal: true`, and on customers). Proposed, not implemented: an internal-note operation on a check, once the visibility rule is decided.

## 7. Worker activation after KYC

| Concept | Where it lives |
| --- | --- |
| KYC status | per check, plus derived `level` (this module) |
| Account status | `users.status` `ACTIVE` / `SUSPENDED`; `PATCH /admin/users/{userId}/status`, permission `user.status.manage` |
| Commercial activation | **no such state exists** |
| Booking and matching eligibility | derived: `verifiedWorkerCondition` (all required checks approved, none due, required set not empty) is applied by search, matching candidates and reports; a suspended account cannot log in |

Approval does **not** change `users.status` and does not need to: workers are `ACTIVE` from creation and become searchable the moment `level` becomes `VERIFIED`. `PATCH /admin/workers/{id}` is a profile edit (`worker.manage`), not activation. No `workers.manage_status` permission exists. A separate activation step is BLOCKED on Q-128; nothing was added. Mandatory checks cannot be bypassed: eligibility is computed from approved checks on every query, so an unverified worker is never eligible.

## 8. Required backend deliverables

1. Endpoints: sections 2 to 7. 2. Root cause: section 1. 3. Code changes: section 1; no database or storage correction was needed or made in this round. 4. Permissions: review/claim `verification.review`; decide `verification.decide`; documents `verification.document.view`; requirements `verification.configure`; account status `user.status.manage`; activation: none exists. 5. Transitions: section 5. 6. Missing or mismatched: release-review, rejection reason codes, check-level internal notes, worker-level decision (Q-123), application number (Q-124), activation (Q-128), SLA (Q-129), document number and expiry metadata. 7. Tests: section 10. 8. Staging executive and test worker: **not available and not created.** No fixed test admins are seeded. The environment owner must authorise either (a) a Super Admin creating a Verification Executive through the admin-account API on staging, or (b) a local-only script; and must confirm staging has `STORAGE_PROVIDER=s3` with a private bucket. Then a test worker signs in with an OTP (or the staging demo OTP flag), uploads a small test PDF through `POST /workers/me/verification/checks/{type}/documents`, uploads to the returned URL, confirms it, and the executive opens `GET /admin/verification/documents/{documentId}/link`. No credentials are written here.

## 9. Acceptance criteria

| Criterion | Status |
| --- | --- |
| Real submitted document retrieved via the secure link | Local only: a document uploaded through the real upload and confirm endpoints into the in-memory storage adapter gets a link whose key matches its database row. **Not verified against a real bucket or staging.** |
| Missing or invalid documents return accurate errors | Done and tested: 404, 409 `DOCUMENT_NOT_AVAILABLE`, 409 `DOCUMENT_OBJECT_MISSING`, 400, 403, 401 |
| Dossier has valid references and metadata | Done and tested (section 2) |
| Server-side permissions | Existing tests (`verification.api.int-spec.ts` access-control cases) plus new ones |
| Ownership and transitions consistent | Done for claim; release BLOCKED (Q-125) |
| Activation rules documented | Documented; no separate activation exists, BLOCKED (Q-128) |
| Verified contracts and evidence | Section 10; `docs/openapi.json` regenerated from local code, **not compared with the deployed API** |

## 10. Tests and evidence

Local run, fresh disposable database `sevanest_vfy2_ci` (all 32 migrations apply to an empty database; `prisma migrate diff` shows no drift), in-memory storage adapter:

| Check | Result |
| --- | --- |
| `npm run typecheck` | clean |
| `npm run lint` | 0 errors, 3 warnings (unused eslint-disable in `test/perf/perf-journeys.perf-spec.ts`, not touched) |
| `npm run format:check` | clean |
| `prisma validate` | valid |
| `npm test` (unit) | 40 suites, 378/378 passed |
| `npm run test:e2e` | 2 suites, 27/27 passed |
| `npm run test:integration` (full) | 65 suites, 1014 of 1015 passed, **1 failed** |
| `verification.*` integration specs (rerun after the last test edit) | 2 suites, 46/46 passed |

The one failure is `qa.inventory.int-spec.ts` ("puts a permission on EVERY admin route..."): `PUT /api/v1/users/me/notification-preferences` (commit c8833ff, WP-12 e-mail channel) is open to any signed-in user, but the test allow-list only accepts GET, POST and DELETE. It is unrelated to verification and was not changed here.

New regression tests (`test/integration/verification.assignment.int-spec.ts`):
- dossier `documentId`, `documentType`, `mimeType`, `available`;
- an unconfirmed upload is `NOT_UPLOADED` and its link answers 409 `DOCUMENT_NOT_AVAILABLE` (the original ambiguous-404 case);
- a check id used as a document id answers 404;
- a confirmed document whose object was deleted answers 409 `DOCUMENT_OBJECT_MISSING`;
- a document uploaded through the real upload and confirm endpoints gets the link contract; the issued download key equals the persisted `object_key` and the object exists in the adapter.

Not tested: release-review and activation (not implemented), a real bucket, staging.

**Local vs staging vs production:** everything above is local. The storage adapter is in-memory, so "a real stored object" means an object the real upload and confirm code stored in that adapter, with its database row; no real bucket was used. The deployed API was not called with a token. `docs/openapi.json` was re-exported from this local code (241 paths) and was not compared with the deployed document.

## Files changed this round

`src/modules/verification/verification.service.ts`, `src/modules/verification/dto/verification.dto.ts`, `test/integration/verification.api.int-spec.ts`, `test/integration/verification.assignment.int-spec.ts`, `docs/openapi.json`, this report. No migration this round.

## Open decisions

Q-123 to Q-129 in `docs/project-intelligence/OPEN_QUESTIONS.md`; plus release-review semantics (extends Q-125).
