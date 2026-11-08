# Replacement workflow client decision register

Date: 2026-11-09

## Approved decisions (D-108)

- After `INTERVIEW_TRIAL_COMPLETED`, preserve the original booking, worker assignment, and interview/trial rows; mark the original `REPLACED`; create an unassigned linked `NEW_REQUEST` successor; Admin matches the successor; notify the former worker.
- Active-service replacement remains limited to `ACTIVE`, requires Admin review, then customer or Admin selection.
- Replacement is free. Keep existing payment on the historical booking; do not transfer payment or issue an automatic refund. The successor follows the normal booking/payment lifecycle.
- `REPLACEMENT_PLAN` is not customer-payable.
- Keep the six fixed reason codes; Admin can change labels and enabled state. Notes are limited to 500 characters.
- No pre-service replacement API for `CONFIRMED` or `PENDING_PAYMENT` is authorized.

## Approved decisions (D-109 / D-110, 2026-11-09)

- Refund approval uses one Admin: `POST /api/v1/admin/payments/{paymentId}/refund` requires explicit `approval: "APPROVE"`, records the Admin and reason, and initiates the existing full gateway refund in that action. There is no second approver and no automatic replacement refund.
- Completed-interview Find Another Worker requires the customer-selected enabled reason code, captures an optional reason description (`OTHER` requires one), and optional notes up to 500 characters. The linked request record is visible to Admin; previous-worker notifications contain no reason or notes.

## Scope closure

| ID | Open matter | Boundary |
|---|---|---|
| Q-143 | Pre-service replacement for `CONFIRMED` or `PENDING_PAYMENT` bookings. | Closed by D-108: intentionally unsupported; endpoint remains ACTIVE-only. |

See `docs/project-intelligence/DECISION_INDEX.md` (D-108 through D-110) and `OPEN_QUESTIONS.md` (closed Q-143) for the durable decision record.
