# Replacement workflow audit

Date: 2026-11-08  
Scope: replacement workflow and the separate `Find Another Worker` / `reopen-matching` action.  
Requirement source: client-approved PRD, Section 8.3, `docs/project-specifications/SevaNest_PRD.pdf`.

## Findings

| Requirement / question | Observed implementation | Result |
|---|---|---|
| Original worker remains auditable | The original `Booking.workerId` is not cleared by replacement-request creation, rejection, cancellation, or selection. Replacement selection changes the original booking status to `REPLACED` and retains its worker id. | Verified in source. |
| Replacement worker and final assignment | Selection creates a successor booking with `replacesBookingId`, assigns the selected `workerId`, and records the successor id on `ReplacementRequest.replacementBookingId`. | Verified in source; database integration not run. |
| Reason and supporting notes | `ReplacementRequest` stores `reasonCode`, `reason`, and `notes`. Six fixed codes have admin-managed labels and enablement; DTO limits `reason` to 1,000 and `notes` to 500 characters. | Verified in source. |
| Reviewer and decision | Request stores `decidedByUserId`, `decidedAt`, internal `decisionRemarks`, and customer-facing `decisionMessage`. Approval/rejection also write audit events. | Verified in source. |
| Transition history and timestamps | Replacement timeline is assembled from persisted `replacement.*` audit events, oldest first. Booking transitions are separately appended to `booking_events`; both writes receive the same Prisma transaction client as the workflow change. | Verified in source. |
| Rejection and cancellation history | Rejection persists the decision, reviewer, timestamp, internal remarks, customer message, and timeline event. Customer cancellation persists `CANCELLED`, actor and time in audit history; the cancel endpoint has no cancellation-reason field. | Verified in source. |
| Interview/trial history | `reopen-matching` calls `cancelOpen`; completed interview/trial rows and the original booking outcome note remain unchanged. | Verified in source; HTTP integration blocked. |
| Find Another Worker worker assignment | After `INTERVIEW_TRIAL_COMPLETED`, `reopen-matching` creates an unassigned `NEW_REQUEST` successor linked by `replacesBookingId`, then marks the original `REPLACED` without clearing its `workerId`. Admin matches the successor through normal booking actions. | Implemented per user-approved D-108. |
| Previous worker notification in Find Another Worker | A transactional outbox event targets the former worker; delivery uses the normal notification dispatcher. | Event persistence implemented; live provider delivery not tested. |
| Find Another Worker reason and notes | Completed-interview requests require one enabled reason code from the stable six-code catalogue; `OTHER` requires a description. Supporting notes are optional, capped at 500 characters, stored in a linked immutable request record, returned to the customer, and visible to Admin booking detail. Notification payload contains booking ids only. | Implemented per D-110; database integration not run. |
| Old booking / duplicate engagements | The original is terminal `REPLACED`; the successor relation is unique and the original row is locked in the transaction. A retry cannot create another successor. | Implemented in source; database concurrency test remains blocked. |
| Transaction boundaries | Booking action locks the booking and wraps the status update, interview operation, booking event, and outbox writes in a Prisma transaction. Replacement selection locks booking then request and performs eligibility check, successor creation/assignment, original close, request completion, audit, and outbox work in one transaction. | Verified in source. |
| Refund approval | `POST /api/v1/admin/payments/{paymentId}/refund` requires `approval: "APPROVE"` and `payment.refund`; one Admin action records approval and initiates the full gateway refund. Approval and gateway result have separate audit events; no second Admin is required. | Implemented per D-109; gateway integration tests blocked. |
| Payment boundary | Replacement successor has no copied payment relation; it follows the normal booking lifecycle. No automatic refund or payment transfer is performed by replacement selection. | Implemented per D-108. |

## Disposition

The active-service replacement flow persists request/review/decision history and atomically links a successor that starts `MATCHED`; it is not immediately `CONFIRMED`. The post-interview route creates an unassigned `NEW_REQUEST` successor and closes the historical booking as `REPLACED`, following D-108. Both retain the original worker and completed interview records. D-110 adds durable customer reason/notes capture to the post-interview flow. The additive reason-settings table stores Admin-configured labels and enabled state for the six fixed reason codes. D-109 adds explicit single-Admin refund approval to the existing gateway action.

## Source trace

- `src/modules/booking/booking.service.ts`: transition rules, `reopen-matching`, replacement methods, and transaction boundaries.
- `src/modules/booking/interview.repository.ts`: completed interview/trial records are distinct persisted rows.
- `src/modules/replacement/replacement.service.ts`: request, decision, cancellation, selection, and timeline behavior.
- `src/modules/replacement/replacement.repository.ts`: replacement request persistence.
- `src/modules/replacement/dto/replacement.dto.ts`: request/view fields and validation limits.
- `prisma/schema.prisma`: booking, booking event, interview/trial, and replacement request relations.
- `src/common/idempotency/idempotency.interceptor.ts` and `src/common/idempotency/idempotency.service.ts`: persisted retry semantics.

