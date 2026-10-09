# Replacement

The replacement workflow: request, staff review, alternative workers, selection, confirmation with the old booking REPLACED and linked to the new one.

## Requirements covered

FR-REP-001..008, FRD FM-06 ("replace") and booking states REPLACEMENT_REQUESTED / REPLACED (C-10: modelled as booking states plus a request record).

## Flow and APIs (`/api/v1`)

1. CUSTOMER `POST /replacement-requests {bookingId, reason, notes?}` - the booking must be theirs and pass the **eligibility policy**; the booking moves to REPLACEMENT_REQUESTED.
2. ADMIN `POST /admin/replacement-requests/{id}/approve` or `/reject` (`replacement.manage`; rejection needs remarks and returns the booking to ACTIVE).
3. ADMIN `GET /admin/replacement-requests/{id}/candidates` (`replacement.view` + `matching.run`): Matching for the booking requirement, excluding the current worker.
4. CUSTOMER (or ADMIN) `POST .../{id}/select {workerId}` once APPROVED: creates the replacement booking (same requirement, the chosen eligible worker, MATCHED, then the normal lifecycle),
   closes the old booking as REPLACED and completes the request - one transaction.
5. CUSTOMER `POST .../{id}/cancel` withdraws an open request (booking back to ACTIVE). Cancelling the booking itself closes the open request (via `BookingLifecycleHooks`).

Also `GET /replacement-requests[/{id}]` (own) and `GET /admin/replacement-requests[/{id}]` (`replacement.view`).

## Rules

- One open request per booking (partial unique index; parallel requests create one). Repeating approve/cancel/select(same worker) is a no-op; a different worker afterwards is 409.
- `REPLACEMENT_POLICY` is the single boundary for "may this booking be replaced?". The specification defines no rule (Q-09, Q-54), so the default only requires an ACTIVE booking;
  no time window, count limit or plan is invented. Replace the provider when the client decides.
- Open: whether a replacement booking needs a new interview or fee (replacement plan), reason list, who pays.
