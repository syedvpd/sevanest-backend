# Replacement workflow contract for the Customer App

Base URL path: `/api/v1`. All customer endpoints require a bearer token for a `CUSTOMER` user and enforce request ownership. Admin endpoints require an `ADMIN` bearer token and the listed permission.

## Active-service replacement

1. Create a request: `POST /replacement-requests` (`Idempotency-Key` optional).

   ```json
   {
     "bookingId": "<active booking UUID>",
     "reasonCode": "ATTENDANCE",
     "reason": "Worker has repeatedly arrived late",
     "notes": "Supporting detail, up to 500 characters"
   }
   ```

   The original booking must be owned by the customer, eligible under the replacement policy, and `ACTIVE`. Success is `201`; it becomes `REPLACEMENT_REQUESTED`. Duplicate open requests return `409 REPLACEMENT_ALREADY_OPEN`; ineligible status returns `422 REPLACEMENT_NOT_ELIGIBLE`.

2. Admin review: `POST /admin/replacement-requests/{requestId}/approve` or `/reject`. Both require `replacement.manage`; listing/details require `replacement.view`; candidate search requires `replacement.view` and `matching.run`. Rejection requires internal `remarks`. Optional `message` is customer-facing. Approval is required before alternatives or selection.

3. Alternatives: `GET /replacement-requests/{requestId}/alternatives?page=1&limit=20`. Only an approved request owned by the customer is readable. Response uses the standard page shape `{data, meta:{page,limit,total}}`; alternatives exclude the current worker. Selection checks eligibility and availability again.

4. Select: `POST /replacement-requests/{requestId}/select` with `{"workerId":"<worker UUID>"}` and optional `Idempotency-Key`. The worker must be eligible and different from the current worker. Success marks the replacement request `COMPLETED`, creates a successor booking in `MATCHED`, and marks the original booking `REPLACED`. The successor contains `replacesBookingId`; the request contains `replacementBookingId`. The successor continues through normal worker acceptance/interview/confirmation/payment lifecycle. No payment is copied to the successor, and the endpoint performs no automatic refund or transfer.

5. Cancel: `POST /replacement-requests/{requestId}/cancel` with optional `Idempotency-Key`. The customer may withdraw an open request. The request becomes `CANCELLED`; the original booking returns to `ACTIVE`.

6. Details: `GET /replacement-requests/{requestId}` returns `ReplacementDetailView`, extending `ReplacementView` with `timeline[]`. Timeline entries contain `status`, `at`, `actor` (`CUSTOMER|STAFF|SYSTEM`) and `remarks`, oldest first. Customer views expose `decisionMessage`, not internal `decisionRemarks`. Admin detail also has requester/reviewer ids, internal remarks, and `currentWorkerId`.

`CreateReplacementDto` accepts `reasonCode` from the fixed enum below; labels and enablement are managed by Admin at `/admin/replacement-reasons`; `reason` is at most 1,000 characters and `notes` at most 500. `neededFrom` is optional informational data and does not set service start, price or review time. Standard errors use `ApiError`; relevant codes include `REPLACEMENT_NOT_ELIGIBLE`, `REPLACEMENT_ALREADY_OPEN`, `INVALID_TRANSITION`, `WORKER_NOT_ELIGIBLE`, `WORKER_UNAVAILABLE`, `SAME_WORKER`, `REPLACEMENT_REASON_DISABLED`, and `IDEMPOTENCY_KEY_REUSED`.

## Fixed reference reasons

`GET /reference-data` returns a `replacementReasons` array constructed from these codes and labels:

| Code | Label |
|---|---|
| `WORK_QUALITY` | Quality of work |
| `BEHAVIOUR` | Behaviour |
| `ATTENDANCE` | Attendance or punctuality |
| `MISMATCH` | Not the right match |
| `WORKER_UNAVAILABLE` | Worker unavailable |
| `OTHER` | Other |

The HTTP response was not available in this session; this list is verified against the controller and DTO source and has an existing integration assertion, which remains blocked by local infrastructure.

## Find Another Worker after interview

`POST /bookings/{bookingId}/reopen-matching` accepts a CUSTOMER bearer token, an optional `Idempotency-Key`, and a body. From `INTERVIEW_TRIAL_SCHEDULED`, it returns the same booking to `MATCHED`; reason fields may be omitted. From `INTERVIEW_TRIAL_COMPLETED`, `reasonCode` is required and must be enabled in reference data. `OTHER` requires `reason`; `notes` are optional and limited to 500 characters. The endpoint atomically stores a `FindAnotherWorkerRequest` record, creates an unassigned successor in `NEW_REQUEST`, sets its `replacesBookingId` to the original booking, marks the original `REPLACED`, preserves the old worker and completed interview/trial history, raises an Admin matching alert, and records an outbox notification to the previous worker. The response contains `request`, `originalBooking`, and `successorBooking`. Admin can review the saved reason and notes in `GET /admin/bookings/{bookingId}`; the former-worker notification contains no submitted reason or notes. The unique successor relation and original booking lock prevent another successor. No replacement fee/refund/transfer is introduced: the successor follows normal fee/payment lifecycle and prior payments remain on the historical booking.

Completed-interview request body:

```json
{
  "reasonCode": "ATTENDANCE",
  "notes": "Supporting detail, up to 500 characters"
}
```

`reason` is optional for codes other than `OTHER`, and required for `OTHER`. If omitted, the request stores the current enabled label as its reason snapshot. Example response fields:

```json
{
  "request": {
    "reasonCode": "ATTENDANCE",
    "reason": "Attendance or punctuality",
    "notes": "Supporting detail, up to 500 characters",
    "requestedAt": "<ISO timestamp>",
    "requestedByUserId": "<customer UUID>"
  },
  "originalBooking": { "id": "<UUID>", "status": "REPLACED", "workerId": "<former worker UUID>" },
  "successorBooking": { "id": "<UUID>", "status": "NEW_REQUEST", "workerId": null, "replacesBookingId": "<original UUID>" }
}
```

The Admin `POST /admin/bookings/{bookingId}/reopen-matching` route remains available for scheduled-interview reopening. It returns 403 for completed-interview requests so only the customer can submit the required customer-selected reason; Admin matches the resulting successor normally.

The existing Admin endpoint `POST /admin/payments/{paymentId}/refund` requires `{ "approval": "APPROVE", "reason": "..." }` and `payment.refund`. The Admin reviews the payment and booking, then this one action records explicit approval and initiates the existing full refund. Approval and gateway result are separately audited. No second Admin approval is required. This path does not create automatic replacement refunds or alter cancellation refund behavior.

Example request:

```json
{ "approval": "APPROVE", "reason": "Reviewed payment and booking; refund authorized" }
```

## Idempotency

Replacement create, customer cancel, customer select, and Admin-assisted select accept optional `Idempotency-Key`. Keys are scoped to the signed-in user, last 24 hours, and replay the stored response for the same method/path/body (`Idempotent-Replay: true`). Reusing a key for a changed request returns `422 IDEMPOTENCY_KEY_REUSED`; an in-flight retry may return `409 IDEMPOTENCY_IN_PROGRESS`. Selection also has transactional booking/request locks and a unique successor relation. Endpoint integration tests were added but are **not verified** because PostgreSQL/Redis setup was unavailable.

## Generated API document

Current generated specification: [`docs/openapi.json`](../openapi.json). It is generated from the Nest controller/DTO metadata with `SwaggerModule.createDocument` and standard error responses. The current local path count and generation evidence are recorded in `CURRENT_STATE.md`. It has not been compared with a deployed API.

## Client decisions recorded

Per D-108, the Find Another Worker successor starts unassigned in `NEW_REQUEST`, Admin performs matching, replacement is free, existing payment remains attached to the historical booking, no automatic refund or transfer occurs, and the successor follows normal payment lifecycle. D-109 requires an explicit single-Admin refund approval action. D-110 requires a customer-selected reason and optional notes for the completed-interview Find Another Worker path. Pre-service replacement remains intentionally unsupported for `CONFIRMED` or `PENDING_PAYMENT`.

