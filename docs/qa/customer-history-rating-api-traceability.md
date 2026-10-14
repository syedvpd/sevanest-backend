# Customer History, Rating, Rebook and worker identity: API traceability (2026-10-14)

Baseline: the OpenAPI of 2026-10-13. Response shapes are checked against the published OpenAPI by
`test/integration/contract.openapi.int-spec.ts`; behaviour by `test/integration/customer.history-rating.int-spec.ts` (17 tests) and
`src/modules/ratings/rating-eligibility.spec.ts` (11 tests).

## 3. Customer history and summary

| | |
|---|---|
| Initial finding | The app groups `GET /bookings` by status; the design needs totals, year and category filters and search. |
| Found | No history route. Booking list had status/category/area/engagement/created filters only. |
| Implemented | `GET /bookings/history` (paginated; filters `year`, `category` code, `search`, `status` in COMPLETED/REPLACED/CANCELLED; each item = the customer booking view plus `amountPaidMinor`, `currency`) and `GET /bookings/history/summary` (`totalServices`, `distinctWorkers`, `totalSpentMinor`, `currency`, `year`, `category`). Owner-scoped in SQL (`customer_user_id`), validated inputs (year 2000..2100, category pattern, search 1..100 characters, plain-text matching with wildcards escaped), pagination bounds, newest service first. |
| Definitions (D-78) | A service = a COMPLETED or REPLACED booking. Distinct workers = different workers across those. Spent = the customer's payments in SUCCEEDED, REFUND_PENDING or REFUND_FAILED (money still held) over ALL their bookings matching year/category, so a cancelled booking whose payment was not refunded counts and a refunded payment does not; no payment is counted twice (sum per payment row). Year = the service start date, else the request date, in India time. Search = category name, or the worker name only where the worker is shown (D-81). |
| Performance | Two statements for the page (ids + total) then one fetch; one batched name lookup and one batched photo lookup per page; index `bookings(customer_user_id, status)`; no per-row queries except the bounded rebook check (see 6). A test asserts a single worker-name statement per history page. |
| Open | Q-104 (business meaning of "spent" and "service"). |

## 4. Rating eligibility and booking actions

| | |
|---|---|
| Initial finding | No eligibility endpoint, no `allowedActions`; COMPLETED only; design shows REPLACED as "Ended early". |
| Spec | FRD FM-10: ratings tied to "completed/eligible engagements"; "otherwise eligible" is undefined (Q-58). |
| Implemented | One pure rule `evaluateRatingEligibility` (D-79) used by POST /ratings (enforcement), `GET /ratings/bookings/{id}/eligibility` (`eligible`, stable `code` ELIGIBLE / ALREADY_RATED / NOT_COMPLETED / ENDED_EARLY_NOT_RATEABLE / NO_WORKER, `reason`, `reviewMaxLength`, `scaleMax`) and every customer booking (`allowedActions`, `rating {rated, eligible, code}`; list, detail, home). `allowedActions` codes: the state-machine actions allowed now (schedule, reopen-matching, interview-complete, confirm-worker, start, complete, cancel) plus `pay`, `rate`, `rebook`, `report-attendance-exception`. |
| Policy | REPLACED is **not** rateable (Q-102); `RATING_ALLOW_ENDED_EARLY=true` switches it on (only for a started service). A repeat rating, also under a race, answers 409 `RATING_ALREADY_EXISTS` with one stored row; a stranger's booking is 404. |
| Tests | Eligibility for COMPLETED, REPLACED, CANCELLED, ACTIVE, MATCHED, PENDING_PAYMENT; actions per state; rate once then `ALREADY_RATED`; six concurrent submissions -> one 201, five 409; server refusal of ACTIVE/REPLACED/CANCELLED; flag on/off; cross-customer 404; unit table over every status. |

## 5. Review limit and tags

| | |
|---|---|
| Initial finding | Swagger said 2000; the design says 300. |
| Implemented | `RATING_REVIEW_MAX_LENGTH` (default **300**, D-80), counted in characters (emoji count once), 400 `RATING_REVIEW_TOO_LONG`, empty or blank review 400, no review allowed; published as `ratingReviewMax` in `/reference-data` and in the eligibility answer; OpenAPI `maxLength` 300. Older longer reviews stay valid. |
| Tags | The specs define no tag catalogue (Q-103): nothing is stored, accepted or returned; `tags` in a request is ignored and absent from responses; `/reference-data` has no `ratingTags`. |
| Tests | Boundary 300/301, 300 vs 301 emoji, empty, blank, config override to 20 (enforced and published), tags ignored, response consistency. |

## 6. Rebook / hire again

| | |
|---|---|
| Implemented | `POST /bookings/{id}/rebook` (optional body `startDate`, optional `Idempotency-Key`) for the customer's own COMPLETED booking: a NEW booking for the same worker with the same category, area, engagement, window, address (if still active), budget and note, through the normal creation path (D-82). Nothing of the old booking (payments, attendance, rating, timeline) is copied. `rebook` is in `allowedActions` only when category and area are enabled, the engagement is still offered, the worker is eligible and free, and there is no open booking with them. |
| Errors | 409 `REBOOK_NOT_ALLOWED` (other statuses), 404 (not mine), 422 `WORKER_NOT_ELIGIBLE`, 409 `WORKER_UNAVAILABLE`, 409 `DUPLICATE_BOOKING`, 422 `CATEGORY_NOT_AVAILABLE`, 400 past `startDate`. A replay with the same key answers 200 with the same booking. |
| Tests | New booking has no payments/attendance/rating and a two-entry timeline; replay; second hire 409; action disappears with a live booking; suspended worker, changed engagement, busy worker (another customer holds them), disabled category; non-completed states; stranger, anonymous, wrong app. |
| Cost note | The `rebook` flag is computed per COMPLETED row of a page (a few indexed statements each), bounded by the page size; it is the only per-row work. |
| Open | Q-106 (other statuses, new interview). |

## 7 (booking part). Worker identity

`worker {displayName "Ramesh K.", initials "RK", photo {url, largeUrl, expiresAt, cacheKey} | null}` on customer booking list, detail, history and home,
from the interview stage on (D-81); null for NEW_REQUEST, MATCHED and CANCELLED. One batched name query and one batched photo query per page. Verified:
active and historical bookings, a missing photo (null), a non-READY photo (null), storage down (worker shown, photo null), a single-word name, other
customers (404), the worker's own view (no `worker` block), and that no phone, address, document or object key appears. Links expire (`expiresAt`);
cache images by `cacheKey`.
