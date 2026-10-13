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
