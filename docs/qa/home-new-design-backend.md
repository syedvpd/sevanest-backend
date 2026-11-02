# Home screen, new design: backend changes (2026-11-02)

Local verification only (disposable PostgreSQL, in-memory storage). Nothing deployed; no migration, no schema change.

| # | App request | Status | What exists now |
|---|---|---|---|
| 1 | Worker photos on customer payloads | **DONE** | A flat `photoUrl` (same link as `photo.url`, null without a photo) on: `activeBooking.worker`, `upcomingInterview.worker`, the shortlist `worker` card in Home and `GET /shortlist`, the `worker` of `GET /bookings` and `/bookings/{id}`, and the items of `GET /search/workers` and the worker profile. With public image storage configured (D-93) the link is permanent; otherwise it is a short-lived signed link, so cache by `photo.cacheKey`. |
| 2 | Top-rated workers | **DONE (both options)** | `GET /search/workers?sort=RATING_DESC` already existed; the value is now case-insensitive (`rating_desc` works). Home also returns `topRated[]` (at most 6): `workerId, name, photoUrl, photo, roleName, ratingAverage, ratingCount, completedJobs, latestReviewSnippet, verified`. |
| 3 | Today's attendance on Home | **DONE** | `todayAttendance` (null when the customer has no ACTIVE booking). |
| 4 | Category images | **ALREADY DONE (D-93)** | `image {url, largeUrl, cacheKey}` on every category response (null until an admin uploads one). Use `image.url`; there is no separate `imageUrl`. |
| 5 | Recently viewed | **NOT BUILT: decision needed** | See Q-135. |

## `topRated` rules
* Ranking: average rating, highest first; ties by number of ratings, then id. Only workers with at least one visible (not moderated away) rating, fully verified and live in search (D-90), and not blocked by or blocking this customer.
* "Near the customer": workers who serve the area of the customer's default address (newest active address when none is default). When the customer has no address, or the area cannot be matched by name and city, it is the best-rated anywhere.
* No minimum number of ratings is applied (none is specified), so one 5-star rating can rank first. Show `ratingCount` next to the score. A minimum count is a product decision (Q-135).
* `ratingAverage` is on the scale of `ratingScaleMax` in `GET /reference-data`. `completedJobs` counts the worker's bookings that ended COMPLETED. `latestReviewSnippet` is the first 120 characters of the newest visible written review (the same review text customers can already read on the worker profile), else null. `name` is first name and last initial. No surname, mobile, pay or account id.

## `todayAttendance` rules
* The booking is the customer's newest **ACTIVE** booking (it can differ from `activeBooking`, which is the newest unfinished one).
* `status` is `ARRIVED` (backend PRESENT or LATE), `NOT_ARRIVED` (nothing recorded for today in India), `ABSENT`, `LEAVE` or `EXCEPTION`. **`LEAVE` is not in the app's list:** the backend has it, so the app should show it or map it. `attendanceStatus` carries the exact backend value (`PRESENT`, `LATE`, ...) or null.
* `arrivedAt` is the time the worker checked in, stamped by the server; null when nobody checked in (never inferred from the status). `engagement` is the booking's engagement; `workerName` and `photoUrl` as elsewhere.

Example (Home, dummy data):
```json
"todayAttendance": { "bookingId": "b-1", "status": "ARRIVED", "attendanceStatus": "PRESENT", "arrivedAt": "2026-11-02T03:35:12.000Z", "workerName": "Ramesh K.", "photoUrl": null, "engagement": "PART_TIME" },
"topRated": [ { "workerId": "w-1", "name": "Meena P.", "photoUrl": null, "photo": null, "roleName": "House Maid", "ratingAverage": 5, "ratingCount": 1, "completedJobs": 1, "latestReviewSnippet": "Excellent work, very punctual and careful.", "verified": true } ]
```

## Compatibility
Everything is additive: no field was removed or renamed. The Home ETag still changes only when the content changes (signed photo links stay out of the validator). Two internal places that listed fields exactly were updated in the tests (`photoUrl` added to worker cards and display objects).

## Tests (local)
`customer.home` (photoUrl on card, shortlist, Home and booking worker, null without a photo; topRated ranking, fields, area scoping, block exclusion, sort case; todayAttendance null / NOT_ARRIVED / ARRIVED, other customers), plus the updated allow-list and boundary tests (`search.api`, `modules.workforce`, `remediation2.discovery`, `appgaps2`, `customer.history-rating`, `customer.active-service`). Unit 402/402, typecheck and lint clean. The full integration suite was not run.

## Open decisions
Q-135: recently viewed (device only vs server), and a minimum ratings count for `topRated`.
