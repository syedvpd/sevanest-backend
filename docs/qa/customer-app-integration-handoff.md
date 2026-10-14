# Customer app: integration handoff (2026-10-13)

For the Flutter team. Base path `/api/v1`. Every route needs `Authorization: Bearer <accessToken>` of a CUSTOMER unless stated. Lists are `{ data: [...], meta: { page, limit, total } }` (`total` always present; defaults page=1, limit=20, max 100). Errors are `{ code, message, details? }`. The live OpenAPI document is `GET /docs/openapi.json` (every route below has a typed success schema; `test/integration/contract.openapi.int-spec.ts` checks real responses against it).

## Answers to the confirmations
| Question | Answer |
|---|---|
| `category` in search | the category **code** (`HOUSE_MAID`); `GET /service-categories` items carry `id`, `code`, `name`, `description` |
| Shortlist entry | `{ workerId, addedAt, available, worker }`; `worker` is the search card, or `null` with `available:false` |
| `meta.total` | always present |
| Rating scale | `GET /reference-data` -> `ratingScaleMax` (whole-number scores 1..max; `rating.average` on the same scale) |
| `minRating`, `sort` | both supported; `sort` = `EXPERIENCE_DESC` (default), `EXPERIENCE_ASC`, `RATING_DESC` |
| OTP errors | wrong code 400 `OTP_INVALID`; expired 400 `OTP_EXPIRED`; too many wrong 429 `OTP_ATTEMPTS_EXCEEDED`; locked 429 `OTP_LOCKED`; send side 429 `OTP_RESEND_COOLDOWN`, `OTP_SEND_LIMIT`, `OTP_RATE_LIMITED`. Every 429 has `details[0] = { field: "retryAfterSeconds", ... }` |
| Refresh | `POST /auth/token/refresh` body `{ "refreshToken": "..." }`; rotation: the old token is single use, replaying it revokes the session (401 `REFRESH_TOKEN_INVALID`) |
| Addresses | first address is NOT auto-default; `isDefault:true` or `PUT /customers/me/addresses/{id}/default` moves the default; deleting the default leaves none; delete is never blocked by bookings; unserviceable area = 422 `AREA_NOT_AVAILABLE` |
| Support contact | set `SUPPORT_CONTACT_PHONE` / `SUPPORT_CONTACT_EMAIL` on the server (owner supplies the values) |

## New or completed endpoints
| Need | Route | Notes |
|---|---|---|
| Reviews | `GET /search/workers/{workerId}/ratings?page&limit` | `{score, comment|null, createdAt, reviewerFirstName|null}`; 404 `WORKER_NOT_FOUND` when unknown or not visible |
| Price guidance | `GET /pricing/guidance?category=COOK&engagement=PART_TIME&areaId=` | `{ minMinor, maxMinor, period, basis }` (paise). **404 `PRICING_GUIDANCE_NOT_FOUND` until an admin enters a band** (`PUT /admin/pricing-guidance`). Nothing is derived from bookings |
| Home | `GET /customers/me/home` | `{ activeBooking|null, upcomingInterview|null, unreadNotifications, shortlistPreview[5], shortlistTotal }` |
| Area from position | `GET /locations/service-area?latitude&longitude&name&city` | `{id,name,city}`; nearest admin-configured circle, else exact name; 404 `AREA_NOT_FOUND` -> let the customer pick |
| Worker slots | `GET /search/workers/{workerId}/slots?date=YYYY-MM-DD` | `{ date, slotMinutes:60, horizonDays:14, slots:["09:00",...] }`; 400 outside today..today+13 |
| My interviews | `GET /interviews?page&limit&status&type` | all bookings, newest first |
| Address fields | `label`, `line2`, `state` (all optional, nullable) on `POST/PATCH /customers/me/addresses` | |

## Interview / trial flow (real contract, differs from the draft)
An interview belongs to a **booking that already names the worker**:
1. `POST /bookings` `{category, areaId, engagement, availableFrom, availableTo, workerId, startDate?, addressId?, budget*}`
2. `GET /search/workers/{workerId}/slots?date=...` to show free hours
3. `POST /interviews` (header `Idempotency-Key`) `{ bookingId, type: "INTERVIEW"|"TRIAL", preferredAt: ISO-8601, note? }` -> 201 interview
4. worker answers (accept / decline / propose another time); customer uses `POST /interviews/{id}/reschedule {preferredAt, note?}`, `/cancel {reason?}`, `/accept-proposal`, `/reject-proposal`, `/complete {outcomeNote?}`
5. `GET /interviews/{id}`.

Interview object: `{ id, bookingId, type, status, statusLabel, requestedBy, preferredAt, scheduledAt|null, proposedAt|null, proposedBy|null, note, declineReason, cancelReason, outcomeNote, completedAt, cancelledAt, createdAt, updatedAt, allowedActions[], timeline[] }`. Statuses: `REQUESTED, CONFIRMED, RESCHEDULE_PROPOSED, DECLINED, CANCELLED, COMPLETED`. Show only the buttons in `allowedActions` (`reschedule, cancel, complete, accept-proposal, reject-proposal`). `timeline` = `[{title, state: done|current|upcoming|failed, at|null}]`. Differences from your draft: ISO `preferredAt` instead of `date`+`slot`; `workerId`/requirement live on the booking (`GET /bookings/{id}`); there is no `decision` route (the customer cancels; the worker declines); statuses SCHEDULED and NOT_A_FIT do not exist. One session is open per booking (a second request is refused with 409). Booking a worker who is busy at that time is refused at booking and confirm (409 `WORKER_UNAVAILABLE`). The interview length (60 min) and 14-day horizon are the slot policy of `/slots` (documented defaults, not client-approved; see `OPEN_QUESTIONS`).

## Not built, with the reason and your fallback
| Ask | Status | Fallback |
|---|---|---|
| Budget filter in search | decision: budget stays a label on the booking | keep it for the booking request |
| Weekday / start-date matching | `startDate` IS used; weekdays are not stored (availability is time-of-day only) | send time range + `startDate` |
| Customer profile photo | out of V1 scope (FR-CUS-001..006 list name, email, addresses, language) | hide "Add a photo" |
| Lat/long polygons | areas have an optional centre + radius only | `locations/service-area` then manual pick |

## Test customer
`scripts/seed-demo.ts` (local DB only) builds customers with profile, two addresses, workers in several categories/areas and shortlists, through the real API. For a deployed staging server set `ALLOW_TEST_OTP=true`, `TEST_OTP_NUMBERS=<synthetic +91 number>`, `TEST_OTP_CODE=<digits>` (never in production). No real data was seeded anywhere by this work.

## Module 7 - payments (2026-10-13)
| # | Question | Answer |
|---|---|---|
| 1 | Checkout shape | `checkout` is now typed: `{ gateway: "razorpay" \| "fake", keyId: string \| null, orderId, amount, currency }`. Razorpay SDK: `key = keyId`, `order_id = orderId`, `amount`, `currency`. Verify with `POST /payments/{id}/verify { providerPaymentId: razorpay_payment_id, signature: razorpay_signature }`; `razorpay_order_id` is not needed (the server already knows its order and checks the signature against it). The deployed gateway is Razorpay once `PAYMENT_PROVIDER=razorpay` and keys are set (not yet done). |
| 2 | Receipt | New `GET /payments/{id}/receipt` -> `{ receiptNumber, paymentId, bookingId, feeCode, amountMinor, currency, paidAt, paymentMethod, paymentMethodDetail, gatewayReference, status, refundStatus, refundedAt }`; 409 `RECEIPT_NOT_AVAILABLE` before success; 404 for anyone else. No PDF yet: render it in the app (a PDF needs an approved invoice/GST format). |
| 3 | Method and reference | `PaymentView` now has `paymentMethod` (upi, card, netbanking, wallet, emi), `paymentMethodDetail` (masked: `ab***@okhdfc`, `Visa **** 4242`, bank or wallet code) and `gatewayReference` (Razorpay `pay_...`). Null until the gateway answers. |
| 4 | Payment of a booking | `GET /payments?bookingId=` (customer, own payments only). `BookingView` stays without a payment id (bookings do not depend on payments). |
| 5 | CREATED vs PENDING | `CREATED` only while the gateway order is not yet created (rare; retry `POST /payments`). Once `checkout` is returned the status is `PENDING` until the gateway answers. Treat `PENDING` with a checkout as payable (open the checkout) and after the SDK returns as confirming. |
| 6 | Retry after FAILED | `POST /payments` for the same booking creates a NEW payment (new order) while the booking is still `PENDING_PAYMENT`; send a fresh `Idempotency-Key`. |
| 7 | Refund filter | `GET /payments?refunded=true` returns REFUND_PENDING, REFUNDED and REFUND_FAILED. |
| 8 | Failure reason | `failureCode` and `failureReason` (the gateway's display message) on FAILED payments; null otherwise. The backend cannot know whether money was deducted, so it does not say "no money deducted"; Razorpay automatically refunds amounts debited for failed payments, so the app may say "if money was debited it is refunded automatically by the bank/gateway". |
Evidence: `test/integration/payment.appfields.int-spec.ts` (4 tests), Razorpay masking unit test; payment, contract, inventory and security suites pass (97 tests). Not verified against real Razorpay (no keys).

## Payment blockers raised by the app (2026-10-14)
| # | Ask | Answer |
|---|---|---|
| 1 | What does the fake gateway accept in verify? | Nothing an app can produce. `POST /payments/{id}/verify` with `gateway: "fake"` only passes for a `providerPaymentId` that the in-process test helper `FakePaymentProvider.completeCheckout()` registered, signed with HMAC-SHA256(`PAYMENT_FAKE_WEBHOOK_SECRET`, `"<orderId>\|<providerPaymentId>"`). There is no HTTP route for that helper and its orders live in one process's memory. It is also refused when `NODE_ENV=production`, which the Render staging service uses. So the fake gateway is for backend tests only; a staging build completes a payment only with Razorpay **test** keys (item 2). The app should treat `gateway: "fake"` as "payments not available here". |
| 2 | Razorpay test keys; a booking waiting for payment | Keys: the account owner creates them in the Razorpay dashboard (Test mode) and sets `PAYMENT_PROVIDER=razorpay`, `RAZORPAY_KEY_ID=rzp_test_...`, `RAZORPAY_KEY_SECRET` (and optionally `RAZORPAY_WEBHOOK_SECRET`) on the API **and** worker services. Not done yet: no Razorpay key is in the backend env files as of 2026-10-14, so `POST /payments` answers 503 `PAYMENT_PROVIDER_UNAVAILABLE` there. Test mode moves no money (Razorpay test cards / test UPI). Booking: the demo seed leaves customer `+919000000205` with one `PENDING_PAYMENT` booking (not re-checked on the hosted DB). Any test customer can make its own using customer APIs only: `POST /bookings` with a `workerId` -> `POST /bookings/{id}/schedule` (`INTERVIEW`) -> `POST /bookings/{id}/interview-complete` -> `POST /bookings/{id}/confirm-worker` `{ startDate }` -> the booking is `PENDING_PAYMENT`. A booking fee must be active (`PUT /admin/fees/booking-fee`), else 422 `FEE_NOT_CONFIGURED`. |
| 3 | Live tests (`SEVANEST_LIVE`, test mobile, OTP) | Backend side exists: on staging set `ALLOW_TEST_OTP=true`, `TEST_OTP_NUMBERS=<synthetic +91 numbers>`, `TEST_OTP_CODE=<OTP_LENGTH digits>`; those numbers log in with that code and no SMS is sent (cooldowns and limits unchanged). The values are chosen by whoever runs staging and given to the app team privately; they are not in this repository. Success-response shapes are the published OpenAPI schemas; real Razorpay responses are still unverified until item 2 is done. |
| 4 | Receipt PDF | Not built and not built until decided: a PDF needs an approved invoice/GST format (Q-100). Keep rendering `GET /payments/{id}/receipt` on screen. |

Follow-up 2026-10-14: the user reports the Razorpay test keys are set on the staging Render service (a different account from the tools available here, so not inspected). Staging `/health/ready` answers 200 (database and Redis up); an OTP request for a number outside the test list answers 503 `SMS_NOT_CONFIGURED`, as expected with no SMS provider. Live proof of items 1-3: run `scripts/staging-payment-smoke.mjs` with a test number and code (see `scripts/README.md`); `--checkout` completes a real test-mode payment through Razorpay Checkout and prints the payment and receipt the app should parse. Not run yet: needs the private test number and code.

Update 2026-10-14 (later): verified live with the staging Razorpay TEST keys on a local API (same code as staging): login with the test OTP, booking to `PENDING_PAYMENT`, `POST /payments` -> real Razorpay order, wrong signature -> 400, Razorpay test checkout (netbanking) -> verify 200 `SUCCEEDED`, receipt, booking `CONFIRMED` (14/14 checks). Staging has `PAYMENT_PROVIDER=razorpay`, `ALLOW_TEST_OTP=true`, `TEST_OTP_NUMBERS=+919999900001,+919999900002`. New: `GET /payments/{id}/receipt/pdf` (customer, own paid payment; one-page PDF marked "payment receipt, not a tax invoice"; same 404/409 as the JSON receipt). A GST invoice still waits for Q-100. Startup now warns when `PAYMENT_GATEWAY` is set (not read) or Razorpay keys are set without `PAYMENT_PROVIDER=razorpay`.

## Worker photo contract change (2026-10-14, D-69)
Every worker `photo` object (search, profile, shortlist, home, `GET /workers/me/photo`) is now `{ url, largeUrl, expiresAt, cacheKey }`:
`url` = small square WebP (320 px) for cards and lists, `largeUrl` = WebP with the longest side at most 1080 px for the profile screen,
`cacheKey` = stable id of the current photo. Signed links change on every read and expire, so cache the image by `cacheKey`, not by URL.
Upload is unchanged (JPEG or PNG through the signed URL, then confirm); the server converts it and removes camera/GPS metadata. Shrinking
the image in the worker app before upload (for example to about 1600 px, JPEG quality 80) makes the upload itself faster. New confirm error:
422 `PHOTO_MALWARE_DETECTED` (only when a scanner is configured); a corrupt image answers 422 `PHOTO_CONTENT_MISMATCH`.
Test OTP: refused when the server runs `NODE_ENV=production` (D-70); staging runs `NODE_ENV=development`.

## Worker-app blockers answered (2026-10-14) - details in `docs/qa/worker-app-blockers-audit.md`
| # | Question | Answer |
|---|---|---|
| 1 | `DemoOtpSession` on 503 `SMS_NOT_CONFIGURED` | Frontend-only. The server accepts only its own signed token plus a live server session, so a demo session never reaches the API. Keep it out of release builds. Server test login (`ALLOW_TEST_OTP`) is refused in production. |
| 2 | Authenticated flows | Verified with a real worker token over HTTP (profile, onboarding, availability, verification, opportunities, bookings, interviews, attendance, ratings, support). One doc correction: repeating the same attendance status answers 201 (not 200), one entry stored. |
| 3 | Opportunity detail | Use `GET /workers/me/bookings/{id}`: same id and fields as the item in `GET /workers/me/opportunities`. No `/opportunities/{id}` route. After decline the detail is 404; after accept it stays; a cancelled offer shows `status: CANCELLED`. |
| 4 | Categories and areas | Behind login on purpose (onboarding runs after OTP). Attach the bearer token. Disabled ones are absent / 404. |
| 5 | Ticket subject | New optional `subject` (1-120) on `POST /support/tickets`; returned as `subject` (string or null). Send it separately; do not prepend it to `description`. |

## Active Service, History and Rating (2026-10-14) - details in `docs/qa/customer-active-service-api-traceability.md` and `docs/qa/customer-history-rating-api-traceability.md`
| # | Ask | Answer |
|---|---|---|
| 1 | Attendance for customers | Already worked: `GET /attendance/bookings/{id}` (page) and `/summary?month=YYYY-MM` accept the customer token, own bookings only (404 otherwise). |
| 2 | Late, Leave, times, window | **New.** Statuses `LATE` and `LEAVE`; every row has `checkInAt`/`checkOutAt` (server-stamped when the worker checks in/out, else null - never guessed); the summary has `late`, `leave`, `scheduledWindow {from,to}` (the booking's own hours) and `worker`. Awaiting client sign-off (Q-101): handle unknown statuses gracefully. |
| 3 | History | **New.** `GET /bookings/history?year=&category=&search=&status=&page=&limit=` (items = booking view + `amountPaidMinor`) and `GET /bookings/history/summary?year=&category=` -> `{totalServices, distinctWorkers, totalSpentMinor, currency}`. Definitions in D-78 (spent = money still held; service = COMPLETED or REPLACED). |
| 4 | Rating eligibility | **New.** `GET /ratings/bookings/{id}/eligibility` and `allowedActions` + `rating {rated, eligible, code}` on every customer booking (list, detail, history, home). COMPLETED only; REPLACED ("Ended early") is not rateable until the client decides (Q-102) - hide Rate when `allowedActions` lacks `rate`. A repeat rating is 409. |
| 5 | Review limit, tags | **New.** `ratingReviewMax` in `/reference-data` (300 by default); longer reviews are 400 `RATING_REVIEW_TOO_LONG` (counted in characters). Rating tags do not exist (no approved catalogue, Q-103): do not show tag chips. |
| 6 | Hire again | **New.** `POST /bookings/{id}/rebook` (optional `{startDate}`, optional `Idempotency-Key`) -> a NEW booking (201, 200 on replay). Show the button only when `allowedActions` has `rebook`. Errors: 409 `REBOOK_NOT_ALLOWED`, 422 `WORKER_NOT_ELIGIBLE`, 409 `WORKER_UNAVAILABLE`, 409 `DUPLICATE_BOOKING`. |
| 7 | Worker identity | **New.** `worker {displayName ("Ramesh K."), initials, photo {url, largeUrl, expiresAt, cacheKey} or null}` on customer bookings and the attendance summary, from the interview stage on (null for earlier and for cancelled bookings). Cache by `cacheKey`; the links expire. No phone, address or documents. |
| 8 | Customer exception | Already worked; rules confirmed: own ACTIVE booking, date from the start date to today, no existing entry (409), note 1..500 required. Shown as `EXCEPTION` recorded by `CUSTOMER`; staff can correct it. |

`allowedActions` values: `schedule`, `reopen-matching`, `interview-complete`, `confirm-worker`, `start`, `complete`, `cancel`, `pay`, `rate`, `rebook`, `report-attendance-exception`. Worker app: new `POST /workers/me/attendance/bookings/{id}/check-in` and `/check-out`; `LATE`/`LEAVE` can be recorded by the worker for today.
