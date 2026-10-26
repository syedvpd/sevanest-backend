# Customer app: worker names, Home and Shortlist (2026-10-26)

Local verification only (disposable PostgreSQL `sevanest_home_ci`, in-memory storage, memory SMS). Nothing was committed, pushed, deployed or run against staging or production.

## 1. Root cause of the missing worker names

The names were never lost. They are removed on purpose by the customer-facing card:

* `EligibleWorker.name` is selected and hydrated from `worker_profiles.name` (`src/modules/search/search.repository.ts:64`, `:138`, `:338`).
* `toCard()` (`src/modules/search/search.service.ts:334`) copies an explicit allow-list into `WorkerCard` and the list did not contain a name. The design rule behind it: "no name, contact details, address, salary or documents" on search cards, the worker profile and the shortlist (specs, Q-42; documented on `search.controller.ts`).
* Workers' names were only shown on a customer's own bookings, from the interview stage on (`displayName`, D-81).
* Home (`GET /customers/me/home`) therefore carried no name anywhere except inside `activeBooking.worker.displayName`, and the shortlist preview reused the same anonymous card. The app fell back to the service category.
* The other missing fields are listed in section 4. The customer's own record is not missing: `GET /customers/me` returns `name`, `email`, `mobile` and `preferredLanguage`.

Decision made for this task (owner request, D-91): cards now carry a **display name = first name and last initial** ("Lakshmi D."), plus `initials`. The surname, mobile, address, salary and account id stay private. Staff-side matching still uses the full record. This reverses the earlier "anonymous card" rule for the name only, so it needs the client's confirmation (Q-130).

## 2. Changes (additive; nothing removed or renamed)

| File | Change |
|---|---|
| `src/common/worker-display.ts` (new) | `workerDisplay(fullName)` -> `{displayName, initials}`: the one place the name text is built |
| `src/modules/search/search.service.ts:326-334` | `toCard` adds `name`, `initials` (null when the profile has no name) and `verified: true` |
| `src/modules/search/dto/search.dto.ts` (`WorkerCard`) | documents `name`, `initials`, `verified` |
| `src/modules/booking/booking.service.ts:1585` and `dto/booking.dto.ts` (`WorkerDisplayView`) | worker on bookings/attendance/history gains `name` (= `displayName`) and `verified` (real value, see below) |
| `src/modules/search/search.repository.ts:158`, `search.service.ts` | `verifiedIds()`: one cheap query with the same eligibility conditions as the visible-worker lookup |
| `src/modules/home/home.controller.ts` | `activeBookingsTotal`, `upcomingInterview.worker`, `ETag` / `Cache-Control` / `Vary` |
| `src/modules/booking/booking.service.ts:448-460` | `activeForCustomer` returns `{booking, total}`; `workerDisplayForBooking` |
| `src/modules/shortlist/shortlist.service.ts:24,43` | cap read from an instance property (`maxEntries`, 100 in production) so concurrency can be tested |

No migration. No schema change.

## 3. Before and after (dummy data)

Search card, worker profile and shortlist `worker` (same shape everywhere):

```json
// before
{ "workerId": "w-1", "experienceMonths": 36, "categories": [{"code":"COOK","name":"Cook"}], "languages": ["en","hi"],
  "serviceAreas": [{"id":"a-1","name":"Madhapur","city":"Hyderabad"}], "engagementPreference": "PART_TIME",
  "availability": [{"start":"08:00","end":"14:00"}], "verification": "VERIFIED", "rating": null, "photo": null }
// after: three additive fields
{ "workerId": "w-1", "name": "Lakshmi D.", "initials": "LD", "verified": true, "experienceMonths": 36, "...": "unchanged" }
```

`GET /customers/me/home`:

```json
{
  "activeBooking": { "id": "b-1", "status": "ACTIVE", "worker": { "displayName": "Ramesh K.", "name": "Ramesh K.", "initials": "RK", "verified": true, "photo": null }, "...": "unchanged" },
  "activeBookingsTotal": 2,
  "upcomingInterview": { "id": "i-1", "bookingId": "b-1", "worker": { "displayName": "Meena P.", "name": "Meena P.", "initials": "MP", "verified": true, "photo": null }, "...": "unchanged" },
  "unreadNotifications": 0,
  "shortlistPreview": [ { "workerId": "w-1", "addedAt": "2026-10-26T09:00:00.000Z", "available": true, "worker": { "workerId": "w-1", "name": "Lakshmi D.", "initials": "LD", "verified": true, "...": "card" } } ],
  "shortlistTotal": 6
}
```

Shortlist errors (unchanged, now tested): malformed id `400` (VALIDATION_FAILED); unknown worker and a worker not visible `404 {"code":"WORKER_NOT_FOUND","message":"Worker not found"}` (identical bodies); cap `422 {"code":"SHORTLIST_FULL"}` at 100 entries; no token `401`; worker or admin token `403`; `PUT` twice and `DELETE` twice (or for an absent entry) `204`.

## 4. Fields the app needs: status

| Field | Status | Evidence |
|---|---|---|
| Worker name on search list, profile, shortlist, Home | **FIXED** (display name, D-91) | `customer.home` "same first-name-and-initial text everywhere", `search.card.spec` |
| `worker.name` and `worker.verified` on `activeBooking` and bookings | **FIXED** | `customer.home`, `customer.history-rating`, `customer.active-service` |
| `upcomingInterview.worker` | **FIXED** (name, initials, verified, photo slot) | `customer.home` |
| `verified` as a real boolean | **FIXED**: cards: true by construction (only verified workers are returned); bookings: computed (false for a blacklisted worker, shown by name) | `customer.home` |
| `activeBookingsTotal` / multiple bookings | **FIXED**: `activeBooking` = newest unfinished booking (created desc, id desc); total counts all unfinished (not COMPLETED, CANCELLED, REPLACED) | `customer.home` (3 bookings, ordering, finishing the newest) |
| Photo | Exists (`photo`), null when the worker has none. Links are **short-lived signed URLs**; cache by `photo.cacheKey` (stable) | existing photo tests |
| Rating, experience | Exist (`rating` null when unrated, `experienceMonths` null when unknown); fallback tested | `customer.home` card values |
| **Pricing** (`pricing.min/max/unit/currency`) | **BLOCKED** (Q-39, Q-131): the only source is the worker's `expectedSalary`: one number, no period, no range, and kept private by the existing card rule. Nothing is invented; the field is omitted, not null | - |
| Worker name before any contact | **Needs client confirmation** (Q-130) | - |

## 5. Home cache behaviour (7.2, 7.3)

* Headers on `GET /customers/me/home`: `ETag: W/"..."`, `Cache-Control: private, no-cache`, `Vary: Authorization`. No `Last-Modified` (the timestamps do not cover every field).
* The ETag is a hash of the delivered JSON with the signed photo links replaced by the photo `cacheKey`, plus a time bucket of half the link lifetime. So it changes with any booking, interview, worker, shortlist or unread change, never with the random link, and a `304` can only be answered while the links in the client's cached copy still have at least half their life left.
* `If-None-Match` with a matching validator answers `304` (Express). A different customer's validator never matches (tested).
* Client expectations: keep the last body and ETag, send `If-None-Match`, on `304` reuse the body; cache photos by `cacheKey` and re-request Home (without `If-None-Match`) when a link has expired. The backend alone is not offline support.
* Response size: at most 5 preview items; the count is a separate query.

## 6. Development login (requirement 3): already exists, no new code

* `ALLOW_TEST_OTP=true`, `TEST_OTP_NUMBERS=+91...` (comma list), `TEST_OTP_CODE=<digits>` on a **non-production** API. Default off. Those numbers log in through the normal `POST /auth/otp/request` and `/verify` with the fixed code and no SMS; every other number is unaffected; wrong codes, single use and lockouts apply; tokens are the normal JWT accepted by every guard.
* `NODE_ENV=production` with `ALLOW_TEST_OTP=true` refuses to start; the fixed code is never returned in production (D-70).
* `DEMO_OTP_ACCEPT_ANY` (staging only, also refused in production, readiness warning) is the second option.
* The test customer is provisioned by completing onboarding once (`POST /customers/me`) after logging in; the data it sees is its own (ownership checks unchanged). Fixture data: `npm run seed:demo` against a **local** database only.
* Tests: `test.otp.int-spec` (allow-list only, single use, other numbers refused), `env.validation.spec` (production refusal, "no spelling of the flag"). Re-run in this task: `test.otp` passes.

## 7. "View all" recommendation (requirement 8)

Use the existing `GET /bookings?page&limit&status` (newest first, `{data, meta{page,limit,total}}`, each with `allowedActions` and `worker`). For finished services with totals, years and search use `GET /customers/me/booking-history` and `/summary`. No `/customers/me/activity` endpoint was added: nothing establishes a need. Product decision (Q-131): should "View all" show open and finished bookings together?

## 8. Tests (all local)

| Check | Result |
|---|---|
| `npm run typecheck` | 0 errors |
| `npm run lint` | 0 errors (3 old warnings) |
| `npm run format:check` | clean |
| `npx prisma validate` | valid |
| `npm test` (unit) | 389/389 |
| Integration, new `customer.home` | all pass (17 tests at the last count): names on list, detail, shortlist and Home; ineligible worker 404; 401/403; multiple bookings and ordering; verified true/false; interview worker; preview cap 5 with total 6; customer isolation; ETag 200/304/changed/other customer; PUT/DELETE idempotency; error contract; concurrent cap (exactly 3 of 6 at cap 3, rest 422); concurrent duplicate PUT (12 parallel = 1 row) |
| Integration, 11 related suites (`customer.home`, `customer.history-rating`, `customer.active-service`, `appgaps2`, `contract.openapi`, `remediation2.discovery`, `booking.api`, `search.api`, `replacement.api`, `matching.api`, `modules.workforce`, `test.otp`) | all pass after updating old assertions that said "no name" or listed the old shapes |
| **Not run** | the full integration suite (about 55 suites): the first run in this task failed 6 old assertions that I then fixed; the whole suite was not repeated |

## 9. Frontend contract notes

* Read `worker.name` (cards, Home, bookings, interviews). It is first name plus last initial by design; there is no full name.
* On cards `verified` is always `true`; use `verification` or `verified` interchangeably.
* Pricing is not available yet; hide the price line.
* Photos expire: cache by `photo.cacheKey`.

## 10. Remaining decisions

Q-130 names on search, profile and shortlist cards (client sign-off); Q-131 pricing source and period, and "View all" scope; Q-39 expected salary period; Q-105 name format.
