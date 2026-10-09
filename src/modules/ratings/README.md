# Ratings

Customer-to-worker ratings and reviews of completed bookings, and the per-worker totals.

## Requirements covered

FR-RAT-001..004, FRD FM-10 (rate after an eligible engagement, optional review, worker sees received ratings, admin can moderate abusive content), AC-09.

## APIs (`/api/v1`)

| Who      | Endpoint                                                                                         | Notes                                                                                                             |
| -------- | ------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------- |
| Customer | `POST /ratings {bookingId, score, review?}`                                                      | The booking must be the caller's own and COMPLETED. The worker is taken from the booking, never from the request. |
| Customer | `GET /ratings`, `GET /ratings/{id}`, `GET /ratings/bookings/{bookingId}`                         | Own ratings only; anything else is 404.                                                                           |
| Worker   | `GET /workers/me/ratings`, `GET /workers/me/ratings/summary`                                     | Visible ratings only; score, review and date, no customer identity.                                               |
| Admin    | `GET /admin/ratings`, `GET /admin/ratings/{id}`, `GET /admin/ratings/workers/{workerId}/summary` | `rating.view`                                                                                                     |
| Admin    | `POST /admin/ratings/{id}/hide`, `/unhide` `{reason}`                                            | `rating.moderate`, audited, keeps the totals correct.                                                             |

## Rules

- One rating per booking (unique constraint; parallel requests create one, the rest get 409 `RATING_ALREADY_EXISTS`).
- Score is a whole number from 1 to `RATING_SCALE_MAX` (required configuration, no default; Q-58).
- Eligibility is the `RATING_POLICY` boundary (`ratings.policy.ts`). The specs say "completed or otherwise eligible" and leave the rule to be defined, so only the documented part is implemented: a COMPLETED booking with a worker. A REPLACED booking is not rateable until the client defines it.
- No customer edit or delete exists (the specs define neither, Q-60). Only moderation changes a rating: HIDDEN removes it from the worker view and the totals; the reason is stored and audited.
- Totals live in `worker_rating_summaries`, adjusted by one atomic statement inside each rating or moderation transaction, so reading an average never scans ratings. `RatingsService.getSummaries(workerIds)` is the one-query contract for other modules (profile cards, reports). **Search and Matching deliberately do not use it** (Q-46, Q-52).
- The review text is free text written by the customer and is kept out of the audit log.

## Open

Q-58 (scale, eligibility beyond COMPLETED, length limit), Q-60 (edit/delete, who sees the customer name, whether the worker may answer a review).
