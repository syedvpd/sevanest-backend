# Worker-app backend blockers: verification report (2026-10-14)

Method: every claim was checked against the source, the specs (PRD, FRD, SRS, worker-app architecture) and a running system before anything
changed. An unauthenticated 401 was not treated as a defect. Evidence is in `test/integration/worker.app.blockers.int-spec.ts` (18 tests)
and `test/integration/support.api.int-spec.ts` (subject block, 4 tests). Totals of the final run are at the end.

## 1. Critical - demo OTP fallback (`DemoOtpSession`)

* **Initial finding:** the app enables a local `DemoOtpSession` when OTP request answers `503 SMS_NOT_CONFIGURED`.
* **Discovered:** the fallback is **frontend-only**. The backend has no demo-session concept: every protected route needs an HS256 JWT signed
  with the server secret (issuer and audience checked) AND a live server-side session row for that token's `sid`
  (`JwtAuthGuard.findActiveSession`), and the account must be ACTIVE. A token the app mints itself can therefore never reach the API.
* **Test login:** `ALLOW_TEST_OTP=true` is the only fixed-code path. It is refused at startup when `NODE_ENV=production` (D-70, unit tested for
  every spelling of the flag), applies only to numbers in `TEST_OTP_NUMBERS`, keeps cooldown/attempt limits, and is reported by the readiness
  check `test_otp`. `seed-demo` refuses `NODE_ENV=production` and any hosted database. Without the flag, a listed number with a configured
  code still gets no shortcut (tested).
* **Hardening added (defence in depth):** `AppConfigService.testOtpCodeFor` now also returns nothing when `NODE_ENV=production`, so even a
  configuration that bypassed the startup check could not honour the fixed code at runtime (`app-config.service.spec.ts`, 3 tests).
* **Verdict:** not a backend defect; a client rule. **Required frontend rule:** the demo session must exist only in debug/profile builds and
  must never be offered when the build is release; a `503 SMS_NOT_CONFIGURED` on a release build must show "login is unavailable".
* **Tests added (negative paths):** demo-looking and malformed tokens on worker, customer and admin routes; JWT with no signature, wrong
  secret, HS512 forgery, wrong audience, expired, and a validly signed token whose session the server never created; a revoked session and a
  refresh token used as an access token; the fixed code ignored while the flag is off; a failing SMS provider leaves no session, no token and
  rejects every guessed code.

## 2. High - authenticated worker flows

* **Discovered:** the flows already had deep negative-path coverage (`docs/qa/worker-negative-path-results.md`); the gap was an HTTP-level
  walk with persistence and ownership in one place.
* **Verified:** profile read/update (persisted in the database, validation errors 400, unknown field 400), onboarding progress, availability
  read-after-write and invalid window 400, verification status shows only my checks, ratings list/summary shape, attendance (201 first,
  repeat 201 with one stored entry, conflicting status 409, strangers 404, summary needs `month`), interviews (own list, strangers 404).
* **Real defect found (documentation):** the attendance endpoint documented a repeat as `200` but answers `201`. The behaviour is correct and
  stays; the OpenAPI description now says 201.
* **No other backend defect found.**

## 3. High - opportunity detail

* **Discovered:** an opportunity is a booking already assigned to the worker (`MATCHED`, no response yet). The list returns the same
  `WorkerBookingView` the booking-detail route returns, with the same id. The frontend's use of `GET /workers/me/bookings/{id}` is correct.
* **Decision D-74:** no `/opportunities/{id}` route (it would duplicate the resource).
* **Tests:** list item equals detail (`toEqual`); no customer identity/address/contact keys; `/opportunities/{id}` is 404; another worker and
  an unknown id get 404 `BOOKING_NOT_FOUND`, a bad id 400, a customer 403, anonymous 401; accept removes it from the feed but the detail
  remains; decline removes it from the feed and the detail becomes 404; a cancelled offer leaves the feed and the detail shows `CANCELLED`
  (accepting it then answers 409).
* **Docs:** the list and detail OpenAPI descriptions state the canonical route.

## 4. Medium - categories and areas

* **Discovered:** onboarding in both apps runs after OTP login (worker app architecture: "mobile + OTP -> short steps"); no document asks for
  pre-login discovery. **Decision D-75:** keep them behind login. The apps must attach the bearer token.
* **Tests:** anonymous 401 on lists, by-id and `locations/service-area`; customer, worker and admin get the same read-only data (no admin
  fields); non-admins cannot mutate (403, anonymous 401); disabled categories/areas disappear from lists and answer 404 by id; a category
  engagement restriction is visible as `allowedEngagements`.

## 5. Medium - support ticket subject

* **Discovered:** no document requires a subject, so it was a contract clarification; since the worker app wants one, an optional field was
  added (D-73) rather than leaving the title inside the description.
* **Change:** `subject` optional (1-120, trimmed) on `POST /support/tickets`; stored in its own column; returned as `subject` (string or null)
  in the creator list/detail and admin views. Migration `20261026090000_support_ticket_subject` (additive, nullable, CHECK 1..120).
  Older clients keep working (field omitted -> `null`).
* **Tests:** stored and returned separately to creator and staff; optional; empty, blank, oversized (121), non-string and missing-description
  rejected before anything is stored; 120 accepted; ownership 404, unknown category 422, someone else's booking 404, anonymous 401; a worker
  raises a ticket about their own booking with a subject.
* **Frontend change:** send `subject` separately; stop prefixing it to `description`; show `subject ?? first line of description`.

## Files and migrations

`prisma/migrations/20261026090000_support_ticket_subject`, `prisma/schema.prisma`, `src/modules/support/*` (dto, repository, service),
`src/modules/booking/booking.controller.ts`, `src/modules/attendance/attendance.controller.ts`,
`src/modules/service-categories/service-categories.controller.ts`, `src/modules/availability/availability.controller.ts`,
`src/config/app-config.service.ts` (+ spec), `src/config/env.validation.spec.ts`, `test/integration/worker.app.blockers.int-spec.ts`, `test/integration/support.api.int-spec.ts`.

## Remaining external dependencies

Real SMS provider (the 503 on OTP request stays until one is configured; staging uses the test OTP with `NODE_ENV=development`), the frontend
rule in item 1, and the receipt/GST decision (Q-100).
