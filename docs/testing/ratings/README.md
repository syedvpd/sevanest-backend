# Ratings - test results

**Result: PASS** - 13/13 integration tests passed, 0 failed (1 suite, `ratings.api.int-spec.ts`). Run date: 2026-10-12.

Environment: Node 24.21, PostgreSQL 17 and Redis 7 (Docker), dedicated database `sevanest_test`, real HTTP through the full application. `RATING_SCALE_MAX=5` is a test value (Q-58).

## Results by group

| Group | Passed | Failed |
|---|---|---|
| creating | 7 | 0 |
| reading | 3 | 0 |
| administration | 3 | 0 |

## What was proved

- **Eligibility**: a COMPLETED booking is rated and the worker is taken from the booking (a `workerId` smuggled in the body is ignored and the rating goes to the booking's worker). MATCHED, CONFIRMED, ACTIVE and CANCELLED bookings answer 422 `RATING_NOT_ELIGIBLE` and store nothing.
- **Scale and input**: 0, negative, fractional, above `RATING_SCALE_MAX`, blank/over-long review, missing score, malformed booking id: all 400 with nothing stored; the top of the scale is accepted.
- **Duplicates**: six parallel requests for one booking create exactly one rating (5 x 409 `RATING_ALREADY_EXISTS`), summary count 1.
- **IDOR / authorization**: another customer's booking, an unknown booking: 404; worker token, admin token: 403; no token: 401; another customer's rating (by id or by booking): 404; a worker sees only their own received ratings.
- **Edit/delete**: PATCH, PUT and DELETE on a rating answer 404 and the score is unchanged (none is defined, Q-60).
- **Audit**: `rating.create` holds booking, worker and score but not the review text.
- **Worker view**: score, review, date only (exact key list asserted); hidden ratings are excluded.
- **Totals**: 5 and 2 give average 3.5 through the API and through `RatingsService.getSummaries`; hide and unhide adjust the totals, repeating a hide changes nothing; six parallel hide/unhide calls leave the summary equal to a fresh aggregate over visible ratings.
- **Admin**: `rating.view` lists/reads, `rating.moderate` hides/restores (reason required, audited with actor); a role without the permission, a customer and a worker get 403, anonymous 401.

## Defect found and fixed during the run

Hiding a rating returned 500: the first implementation used an upsert for the negative adjustment, and PostgreSQL evaluates the non-negative CHECK on the proposed insert row before looking for the conflict. Negative adjustments now use a plain UPDATE.

## Not tested

Load; review-wording moderation beyond hide/unhide.
