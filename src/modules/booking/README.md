# Booking

The booking lifecycle: a customer requirement, the worker engaged for it, interview/trial, confirmation, service, completion, cancellation.

## Requirements covered

FR-BK-001..009 (request interview/trial, preferred date and time, confirm worker, pay fee (Payment module), status timeline, state machine,
admin actions), FRD FM-06/FM-08 and the booking state model of FRD section 4 (**PROPOSED; conflict C-02 / Q-05 is open**), FR-ON-002 (service history).

## State model (FRD section 4)

`NEW_REQUEST -> MATCHED -> INTERVIEW_TRIAL_SCHEDULED -> INTERVIEW_TRIAL_COMPLETED -> PENDING_PAYMENT -> CONFIRMED -> ACTIVE -> COMPLETED`,
plus `REPLACEMENT_REQUESTED -> REPLACED` (Replacement module), `CANCELLED` (final). Booking and engagement are one entity (Q-15).
Every change locks the row and writes, in one transaction: the new state, an append-only timeline entry (actor, time), the audit record and the
notification outbox event.

## APIs (`/api/v1`)

| Who      | Path                                                    | Purpose                                                                                                |
| -------- | ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| CUSTOMER | `POST /bookings` (+ optional `Idempotency-Key`)         | New request; with an eligible `workerId` it starts as MATCHED                                          |
| CUSTOMER | `GET /bookings`, `GET /bookings/{id}`                   | Own bookings, status timeline (404 for anyone else's)                                                  |
| CUSTOMER | `POST /bookings/{id}/{action}`                          | schedule, reopen-matching, interview-complete, confirm-worker, start, complete, cancel                 |
| WORKER   | `GET /workers/me/bookings[/{id}]`                       | Requirement summary only - never the customer                                                          |
| WORKER   | `POST /workers/me/bookings/{id}/{action}`               | schedule, decline, start                                                                               |
| ADMIN    | `GET /admin/bookings[/{id}]` (`booking.view`)           | List/filter, full timeline with actors                                                                 |
| ADMIN    | `POST /admin/bookings/{id}/{action}` (`booking.manage`) | match, schedule, decline, reopen-matching, interview-complete, confirm-worker, start, complete, cancel |

## Rules

- A chosen worker must be eligible (active, submitted, fully verified, offering the category in the area with the engagement and a window covering
  the timings) - checked through Search at create, match and again at confirm-worker. 422 `WORKER_NOT_ELIGIBLE` for every reason.
- 404 for a booking that is not yours, 403 `ACTION_NOT_ALLOWED` for an action your role may never do, 409 `INVALID_TRANSITION` for "not now".
  Repeating an action whose result already holds is a no-op (200); schedule/confirm with different values than recorded are 409.
- `Idempotency-Key`: same key and request returns the first booking (200), same key with another request is 409; parallel duplicates create one.
- One live booking per customer, worker and service (database partial unique index, 409 `DUPLICATE_BOOKING`).
- cancel needs a reason; PENDING_PAYMENT -> CONFIRMED happens only through `BookingService.applyPaymentSucceeded` (Payment).
- Replacement hooks in through `BookingLifecycleHooks`; Booking never imports Payment, Notifications or Replacement.

Not decided by the specification (open): worker acceptance as its own state, interview outcome values, cancellation fee/refund (Q-21), double-booking
a worker across customers, start-date gating.
