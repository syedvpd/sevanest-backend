# BACKEND_SCREENS_STATUS — Customer-app screens: real API surface and gaps

Compiled: 2026-11-03. **All entries are derived from the actual controller, DTO and service source files in
`src/modules/`**. No doc or spec file was used as the primary source of truth; file paths are cited for every
claim. Nothing was tested against the live API in this session.

Base path for all customer calls: `GET|POST|… /api/v1/…`
Auth: `Authorization: Bearer <accessToken>` unless marked **public**.

Legend:
- ✅ **EXISTS** — route is in the controller, role-guard matches CUSTOMER
- ⚠️ **PARTIAL** — route exists but one or more requested fields are absent from the real DTO
- ❌ **MISSING** — no route exists for this screen need
- 🔧 **CONFIG** — route exists; returns `null` or 503 until an env-var / DB row is set by ops
- 🚫 **BLOCKED** — route exists but the feature requires a client decision before it can be used correctly

---

## Screen 1 — Splash / App-config

Sources: [`meta.controller.ts`](file:///c:/Users/ABC/Desktop/Seva%20Nest/src/modules/meta/meta.controller.ts)

| Method | Path | Auth | Status |
|---|---|---|---|
| GET | `/app-config` | public, `Cache-Control: public, max-age=60` | ✅ |
| GET | `/reference-data` | public, `Cache-Control: public, max-age=300` | ✅ |

**`GET /app-config` actual response shape** (from `AppConfigView` class in the controller):
```
{
  customer: { minVersion: string|null, storeUrl: string|null },
  worker:   { minVersion: string|null, storeUrl: string|null },
  maintenance: boolean,
  support:  { phone: string|null, email: string|null },
  legal:    { terms: { version, url }|null, privacy: { version, url }|null },
  policy:   { cancellationText: string|null, cancellationUrl: string|null,
              refundText: string|null, refundUrl: string|null },
  languages: string[]
}
```
All settings come from `PlatformConfigService.effective()` — meaning they are DB-backed, editable by staff via
`/admin/app-settings`. Env-var overrides are the default until a staff member writes a DB row.

**Still needed from ops:**
- `customer.storeUrl` → `null` until ops sets it in the admin portal. 🔧
- `support.phone` / `support.email` → `null` until ops sets them. 🔧
- `legal.terms` / `legal.privacy` → entire object is `null` until version AND url are both set. 🔧
- `policy.cancellationText`, `policy.refundText` etc. → `null`; client must supply the approved text. 🚫

---

## Screen 2 — Sign-in: enter mobile / request OTP

Sources: [`auth.controller.ts`](file:///c:/Users/ABC/Desktop/Seva%20Nest/src/modules/auth/auth.controller.ts)

| Method | Path | Auth | Status |
|---|---|---|---|
| POST | `/auth/otp/request` | public | ✅ |

**Request:** `{ mobile: string, appType: "CUSTOMER" }`
**Response:** `OtpRequestedResponse` — includes `expiresInSeconds`.
Rate-limited per mobile and per IP. 429 carries `details[0].retryAfterSeconds`. Answer is identical for every
number (known, unknown, suspended) — nothing is revealed.

**Still needed:**
- Real SMS delivery — the SMS provider adapter is wired but `SMS_PROVIDER` must be set to `twilio` or `msg91`
  with full credentials. Until then, staging uses `DEMO_OTP_ACCEPT_ANY=true` (any 6-digit code accepted, no SMS
  sent). ❌ (external provider)
- DLT-registered sender/template for Indian numbers. ❌ (external)

---

## Screen 3 — Sign-in: verify OTP / create session

Sources: [`auth.controller.ts`](file:///c:/Users/ABC/Desktop/Seva%20Nest/src/modules/auth/auth.controller.ts)

| Method | Path | Auth | Status |
|---|---|---|---|
| POST | `/auth/otp/verify` | public | ✅ |
| POST | `/auth/token/refresh` | refresh token | ✅ |

**`/auth/otp/verify` request:** `{ mobile, appType, otp, deviceId?, deviceName? }`
**Response:** `TokenResponse` — `{ accessToken, refreshToken, tokenType, expiresIn, user: { id, type, isNewUser } }`

`isNewUser: true` on first verification — app should navigate to the profile-creation screen.
OTP error codes that exist in the codebase: `OTP_EXPIRED` (400), `OTP_INVALID` (400),
`OTP_ATTEMPTS_EXCEEDED` / `OTP_LOCKED` (429). 429 body: `{ code, message, details: [{ retryAfterSeconds }] }`.

**Refresh** response additionally includes `roles` and `permissions` on the `user` object.

---

## Screen 4 — Onboarding: name / email / language

Sources: [`customers.controller.ts`](file:///c:/Users/ABC/Desktop/Seva%20Nest/src/modules/customers/customers.controller.ts)

| Method | Path | Auth | Status |
|---|---|---|---|
| POST | `/customers/me` | CUSTOMER | ✅ |
| PATCH | `/customers/me` | CUSTOMER | ✅ |
| GET | `/customers/me` | CUSTOMER | ✅ |
| GET | `/customers/me/onboarding` | CUSTOMER | ✅ |

`POST /customers/me` → `CustomerProfileResponse`. 409 `CUSTOMER_PROFILE_EXISTS` on repeat.
`GET /customers/me/onboarding` → `CustomerOnboardingResponse` — works even before the profile exists
(`profileCreated: false, nextStep: "PROFILE"`). Steps: `PROFILE`, `ADDRESS`, `VERIFICATION`.
Both write endpoints support `If-Match` / `ETag`.
Language is validated against the configured allow-list (default `en` only). Telugu/Hindi are Phase 2.

---

## Screen 5 — Onboarding: address

Sources: [`customers.controller.ts`](file:///c:/Users/ABC/Desktop/Seva%20Nest/src/modules/customers/customers.controller.ts),
[`availability.controller.ts`](file:///c:/Users/ABC/Desktop/Seva%20Nest/src/modules/availability/availability.controller.ts)

| Method | Path | Auth | Status |
|---|---|---|---|
| POST | `/customers/me/addresses` | CUSTOMER | ✅ |
| GET | `/service-areas` | any signed-in | ✅ |
| GET | `/locations/service-area?name=&city=&lat=&lng=` | any signed-in | ✅ |

Address fields: `line, area, city, pincode (6 digits), latitude?, longitude?, label?, line2?, state?, isDefault?`
`GET /locations/service-area` resolves a lat/lng or name+city to the nearest enabled area (no geocoder — the
match is by the admin-set circle radius or exact name). 404 `AREA_NOT_FOUND` when nothing matches.

**Still needed:**
- **Address/home photo** — no endpoint exists. `POST /customers/me/photo` stores a personal *profile* photo,
  not a photo of the address/home. Saving a home photo against the address has no API. ❌

---

## Screen 6 — Saved addresses list / edit / default / delete

Sources: [`customers.controller.ts`](file:///c:/Users/ABC/Desktop/Seva%20Nest/src/modules/customers/customers.controller.ts)

| Method | Path | Auth | Status |
|---|---|---|---|
| GET | `/customers/me/addresses` | CUSTOMER | ✅ |
| GET | `/customers/me/addresses/:addressId` | CUSTOMER | ✅ |
| PATCH | `/customers/me/addresses/:addressId` | CUSTOMER | ✅ |
| PUT | `/customers/me/addresses/:addressId/default` | CUSTOMER | ✅ |
| DELETE | `/customers/me/addresses/:addressId` | CUSTOMER | ✅ |

All write endpoints support optional `If-Match` (412 `STALE_VERSION` when the address changed meanwhile).
Deleting the default address leaves no default until another is chosen.
Delete is soft (hidden from the customer, kept for past bookings).

---

## Screen 7 — Home

Sources: [`home.controller.ts`](file:///c:/Users/ABC/Desktop/Seva%20Nest/src/modules/home/home.controller.ts),
[`service-categories.controller.ts`](file:///c:/Users/ABC/Desktop/Seva%20Nest/src/modules/service-categories/service-categories.controller.ts)

| Method | Path | Auth | Status |
|---|---|---|---|
| GET | `/customers/me/home` | CUSTOMER | ⚠️ |
| GET | `/service-categories` | any signed-in | ⚠️ |

**`GET /customers/me/home` — actual `HomeView` fields** (from `HomeController`, `home.controller.ts`):
```
{
  activeBooking:       CustomerBookingView | null,   // newest unfinished booking; worker carries photoUrl
  activeBookingsTotal: number,
  upcomingInterview:   HomeInterviewView | null,     // next CONFIRMED interview with worker
  todayAttendance:     TodayAttendanceView | null,   // null when no ACTIVE booking
  topRated:            TopRatedWorkerView[],          // up to 6, area-scoped
  unreadNotifications: number,
  shortlistPreview:    ShortlistItemView[],           // 5 items max
  shortlistTotal:      number
}
```

`TodayAttendanceView` fields (from `home.controller.ts`):
`bookingId, status (ARRIVED|NOT_ARRIVED|ABSENT|LEAVE|EXCEPTION), attendanceStatus (raw backend value|null),
arrivedAt (server-stamped|null), workerName, photoUrl, engagement`

`TopRatedWorkerView` fields (from `search.dto.ts`, referenced in `home.controller.ts`):
`workerId, name, photoUrl, photo, roleName, ratingAverage, ratingCount, completedJobs,
latestReviewSnippet, verified`

Response uses `Cache-Control: private, no-cache` + `Vary: Authorization` + `ETag` (hash excludes signed-link
URLs; changes on any booking/interview/shortlist change).

**Category images** (`ServiceCategoryResponse`): `image: { url, largeUrl, cacheKey } | null` — `null` until
an admin uploads via `PUT /admin/service-categories/:id/image`. 🔧

**Still needed:**
- **Promo/banner carousel** — no endpoint. Not in the codebase at all. ❌
- **Prices on shortlist cards** — worker pay is not exposed to customers anywhere in the codebase (search DTO
  explicitly excludes it). No endpoint for this. 🚫 (client decision)
- The app design shows `LEAVE` as an attendance status; the backend emits it (it is in the `TODAY_ATTENDANCE_STATUSES`
  const in `home.controller.ts`). App must handle it.

---

## Screen 8 — Choose service / engagement

Sources: [`service-categories.controller.ts`](file:///c:/Users/ABC/Desktop/Seva%20Nest/src/modules/service-categories/service-categories.controller.ts),
[`meta.controller.ts`](file:///c:/Users/ABC/Desktop/Seva%20Nest/src/modules/meta/meta.controller.ts)

| Method | Path | Auth | Status |
|---|---|---|---|
| GET | `/service-categories` | any signed-in | ✅ |
| GET | `/service-categories/:categoryId` | any signed-in | ✅ |
| GET | `/reference-data` (→ `engagements`, `budgetPeriods`) | public | ✅ |

`ServiceCategoryResponse` carries `allowedEngagements[]` (set by admin per category; empty = all engagements
allowed). Disabled categories return 404; passing one in search/booking returns 422 `CATEGORY_NOT_AVAILABLE`.

**Still needed:**
- Each category's `allowedEngagements` must be filled in by an admin. Empty until ops does this. 🔧

---

## Screen 9 — Worker search results

Sources: [`search.controller.ts`](file:///c:/Users/ABC/Desktop/Seva%20Nest/src/modules/search/search.controller.ts),
[`search.dto.ts`](file:///c:/Users/ABC/Desktop/Seva%20Nest/src/modules/search/dto/search.dto.ts)

| Method | Path | Auth | Status |
|---|---|---|---|
| GET | `/search/workers` | CUSTOMER | ✅ |
| GET | `/search/workers/count` | CUSTOMER | ✅ |

**Query params** (from `SearchWorkersQuery` in `search.dto.ts`):
`category (required), areaId (required), engagement?, availableFrom? (HH:mm), availableTo?,
startDate? (YYYY-MM-DD), language?, minExperienceMonths? (0-1200), minRating? (1-10),
sort? (EXPERIENCE_DESC|EXPERIENCE_ASC|RATING_DESC|DISTANCE_ASC — default EXPERIENCE_DESC, case-insensitive),
latitude?, longitude?, page, limit`

Response: `{ data: WorkerCard[], meta: { page, limit, total }, canRequestAdminMatching: boolean }`
`canRequestAdminMatching: true` when zero results — show "Ask staff to find a worker" → `POST /bookings` without `workerId`.

`WorkerCard` fields: `workerId, name (first+last initial), photoUrl, photo { url, largeUrl, cacheKey, expiresAt },
experienceMonths, categories[], languages[], serviceAreas[], availability[], engagementPreference,
rating: { average, count } | null, verified (always true for listed workers), completedJobs, latestReviewSnippet`

`GET /search/workers/count` takes same query, returns `{ total: number }`.

**Still needed:**
- **`BEST_MATCH` sort / `matchScore`** — not in the enum in `search.dto.ts`. No scoring formula defined. ❌
- **Weekday availability filter** — not in `SearchWorkersQuery`. Availability windows are daily only. ❌
- **Monthly rate** — not in `WorkerCard` (private). Remove from the UI. 🚫
- **`verifiedOnly` filter** — not needed; all returned workers are `verified: true` by the search query.
- **Distance value** — `DISTANCE_ASC` sort uses lat/lng params but the `distance` field is **not** on the
  `WorkerCard` response DTO. ❌
- Worker `photoUrl` is `null` until `PROFILE_PHOTO_MAX_BYTES` env-var is set on the deployed service. 🔧

---

## Screen 10 — Worker profile / detail

Sources: [`search.controller.ts`](file:///c:/Users/ABC/Desktop/Seva%20Nest/src/modules/search/search.controller.ts),
[`search.dto.ts`](file:///c:/Users/ABC/Desktop/Seva%20Nest/src/modules/search/dto/search.dto.ts)

| Method | Path | Auth | Status |
|---|---|---|---|
| GET | `/search/workers/:workerId` | CUSTOMER | ⚠️ |
| GET | `/search/workers/:workerId/ratings` | CUSTOMER | ✅ |
| GET | `/search/workers/:workerId/slots` | CUSTOMER | ✅ |
| PUT | `/shortlist/:workerId` | CUSTOMER, 204 | ✅ |
| DELETE | `/shortlist/:workerId` | CUSTOMER, 204 | ✅ |

`GET /search/workers/:workerId` → `WorkerCard` (same fields as a search result card — see Screen 9).
404 `WORKER_NOT_FOUND` for unknown **and** for a worker who is not fully verified / active — answers are identical.

`GET /search/workers/:workerId/ratings` →
`{ data: WorkerReviewView[], meta: { page, limit, total }, summary: ReviewSummaryView }`
`WorkerReviewView`: `score, comment, createdAt, reviewerFirstName`
`ReviewSummaryView`: `{ average, count, distribution: { "5": n, "4": n, … } }`
Reviews moderated/hidden are excluded; `meta.total` = count of visible reviews.

`GET /search/workers/:workerId/slots` → `WorkerSlotsView`
1-hour slots inside the worker's availability windows, minus bookings and confirmed interviews, within 14 days.
Query: `date (YYYY-MM-DD, today–14 days)`. 400 outside the horizon.

**Still needed from the worker profile endpoint — fields not in `WorkerCard`:**
- **"About" / bio text** — no bio/description field in the schema anywhere. ❌
- **Price per month / expected salary** — stored but not in the customer-facing DTO (private). 🚫
- **Distance to job** — not in `WorkerCard` (see Screen 9). ❌
- **Repeat-customer %** — not computed or stored in any DTO. ❌
- **Verification check list** — only `verified: boolean` is on `WorkerCard`. Individual checks are not exposed to
  customers. ❌ (client decision on what to show)
- **`canRequestInterview`** — not a field anywhere. The signal to show the interview button lives in the booking's
  `allowedActions` array (on `CustomerBookingDetailView`). Check `allowedActions.includes('schedule')`. ⚠️

---

## Screen 11 — Shortlist (favourites)

Sources: [`shortlist.controller.ts`](file:///c:/Users/ABC/Desktop/Seva%20Nest/src/modules/shortlist/shortlist.controller.ts)

| Method | Path | Auth | Status |
|---|---|---|---|
| GET | `/shortlist` | CUSTOMER | ✅ |
| PUT | `/shortlist/:workerId` | CUSTOMER, 204 | ✅ |
| DELETE | `/shortlist/:workerId` | CUSTOMER, 204 | ✅ |

`GET /shortlist` response (from `ShortlistController`):
```
{
  data: ShortlistItemView[],          // { workerId, addedAt, available, worker: WorkerCard|null }
  meta: { page, limit, total },
  categoryCounts: [{ code, name, count }]   // whole shortlist, ignoring page/filter
}
```
Optional `?category=<code>` filter on the GET. Max 100 entries (422 `SHORTLIST_FULL`).
`worker: null` when the worker is no longer visible; `available: false`.

---

## Screen 12 — Interview / trial

Sources: [`interview.controller.ts`](file:///c:/Users/ABC/Desktop/Seva%20Nest/src/modules/booking/interview.controller.ts)

| Method | Path | Auth | Status |
|---|---|---|---|
| GET | `/bookings/:bookingId/interviews` | CUSTOMER | ✅ |
| POST | `/interviews` | CUSTOMER, Idempotent | ✅ |
| GET | `/interviews` | CUSTOMER | ✅ |
| GET | `/interviews/:interviewId` | CUSTOMER | ✅ |
| POST | `/interviews/:interviewId/reschedule` | CUSTOMER, Idempotent | ✅ |
| POST | `/interviews/:interviewId/accept-proposal` | CUSTOMER, Idempotent | ✅ |
| POST | `/interviews/:interviewId/reject-proposal` | CUSTOMER, Idempotent | ✅ |
| POST | `/interviews/:interviewId/complete` | CUSTOMER, Idempotent | ✅ |
| POST | `/interviews/:interviewId/cancel` | CUSTOMER, Idempotent | ✅ |

`POST /interviews` request (`RequestInterviewDto`): `{ bookingId, type: INTERVIEW|TRIAL, preferredAt, note? }`
Only for a booking with a matched worker in state MATCHED or INTERVIEW_TRIAL_COMPLETED (further round).
One open session per booking at a time (409 `INTERVIEW_ALREADY_OPEN`).

`GET /interviews` response: `{ data: CustomerInterviewView[], meta, counts: { upcoming, past, total } }`
Optional query `scope=upcoming|past`, filter by `status`, `type`.
Each `CustomerInterviewView` carries the worker summary.

State flow: `REQUESTED → CONFIRMED | DECLINED | RESCHEDULE_PROPOSED`; open sessions can be `CANCELLED`;
`CONFIRMED → COMPLETED` with outcome.

**Still needed:**
- Outcome values (suitable/not suitable) — `completeInterviewDto.outcomeNote` is free text (max 1000). No fixed
  enum in any DTO file. 🚫 (client decision)
- Slot enforcement — the backend only checks "in the future"; `GET .../slots` is advisory guidance only. 🚫

---

## Screen 13 — Create booking

Sources: [`booking.controller.ts`](file:///c:/Users/ABC/Desktop/Seva%20Nest/src/modules/booking/booking.controller.ts),
[`payment.controller.ts`](file:///c:/Users/ABC/Desktop/Seva%20Nest/src/modules/payment/payment.controller.ts)

| Method | Path | Auth | Status |
|---|---|---|---|
| POST | `/bookings` | CUSTOMER, Idempotent | ✅ |
| GET | `/service-areas` | any signed-in | ✅ |
| GET | `/pricing/guidance` | CUSTOMER or WORKER | 🔧 |

`POST /bookings` request (`CreateBookingDto`): `{ category, areaId, engagement, availableFrom, availableTo,
startDate?, addressId?, budgetMinMinor?, budgetMaxMinor?, budgetPeriod?, requirementNote?, workerId? }`
Without `workerId` → `NEW_REQUEST`, staff alert sent. With eligible `workerId` → `MATCHED`.
Supports `Idempotency-Key` header.

`GET /pricing/guidance` → returns salary bands, 404 `PRICING_GUIDANCE_NOT_FOUND` until an admin enters data. 🔧

---

## Screen 14 — Confirm booking (pre-payment fee preview)

Sources: [`booking.controller.ts`](file:///c:/Users/ABC/Desktop/Seva%20Nest/src/modules/booking/booking.controller.ts),
[`payment.controller.ts`](file:///c:/Users/ABC/Desktop/Seva%20Nest/src/modules/payment/payment.controller.ts)

| Method | Path | Auth | Status |
|---|---|---|---|
| GET | `/bookings/:bookingId` | CUSTOMER | ✅ |
| GET | `/bookings` | CUSTOMER | ✅ |
| GET | `/fees/booking` | CUSTOMER | ⚠️ |
| GET | `/fees/payable` | CUSTOMER | ✅ |
| POST | `/bookings/:bookingId/:action` | CUSTOMER | ✅ |

`GET /fees/booking` → `BookingFeeQuote`: `{ code, amountMinor, currency }` (in paise).
Add `?bookingId=<id>` (own booking) to get the exact amount of the already-open payment.
422 `FEE_NOT_CONFIGURED` when no active booking fee exists.
This is the **only pre-payment fee endpoint**. There is no breakdown into `wage + fee + tax + total`.

`GET /bookings/:bookingId` → `CustomerBookingDetailView` which carries `allowedActions: CustomerAllowedAction[]`
and `timeline[]`. Actions: `schedule, reopen-matching, interview-complete, confirm-worker, start, complete,
cancel, pay, rate, rebook, report-attendance-exception`.

**Still needed:**
- **Itemised quote (wage + platform fee + tax + total)** — does not exist. `GET /fees/booking` returns only the
  platform fee as one `amountMinor`. No wage field is exposed to customers (private). ❌
  > Interim: display `amountMinor / 100` as "Platform fee" and add 18% GST client-side. Label it clearly as an
  > estimate until the backend adds a breakdown endpoint.
- Cancellation / refund policy text → `GET /app-config` → `policy.*`; all `null` until ops configures. 🔧

---

## Screen 15 — Payment (Razorpay checkout → verify)

Sources: [`payment.controller.ts`](file:///c:/Users/ABC/Desktop/Seva%20Nest/src/modules/payment/payment.controller.ts)

| Method | Path | Auth | Status |
|---|---|---|---|
| POST | `/payments` | CUSTOMER, Idempotent | 🚫 (external) |
| POST | `/payments/:paymentId/verify` | CUSTOMER | 🚫 (external) |
| GET | `/payments/:paymentId` | CUSTOMER | ✅ |
| GET | `/payments` | CUSTOMER | ✅ |
| GET | `/payments/:paymentId/receipt` | CUSTOMER | ✅ |
| GET | `/payments/:paymentId/receipt/pdf` | CUSTOMER | ✅ |
| POST | `/fee-payments` | CUSTOMER, Idempotent | ✅ |
| POST | `/webhooks/payments` | public (raw-body signature) | ✅ |

`POST /payments` → `CreatePaymentResponse`: `{ checkout: { orderId, keyId, amount, currency } }`.
The app opens the Razorpay SDK with these values; the customer picks UPI/card/net-banking in the Razorpay sheet.

`POST /payments/:paymentId/verify` → `{ providerPaymentId, signature }`. Signature is checked server-side.

`GET /payments` → paginated list, `status` filter, `bookingId` filter, `refunded` boolean filter.
`GET /payments/:paymentId` → `PaymentView` — includes `receiptNumber`, `failureCode`, `failureReason`,
`refundStatus`, `refundedAt`.
`GET /payments/:paymentId/receipt/pdf` → PDF stream (`application/pdf`). 409 `RECEIPT_NOT_AVAILABLE` before
payment is verified.

**Still needed:**
- Razorpay test-mode keys on staging: `PAYMENT_GATEWAY=razorpay`, `RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET`,
  `RAZORPAY_WEBHOOK_SECRET`. The webhook endpoint must be reachable from Razorpay's servers. 🔧
- Receipt PDF is a plain receipt, **not a GST invoice**. Format decision pending. 🚫

---

## Screen 16 — Active service / attendance

Sources: [`attendance.controller.ts`](file:///c:/Users/ABC/Desktop/Seva%20Nest/src/modules/attendance/attendance.controller.ts)

| Method | Path | Auth | Status |
|---|---|---|---|
| GET | `/attendance/bookings/:bookingId` | CUSTOMER | ✅ |
| GET | `/attendance/bookings/:bookingId/summary?month=YYYY-MM` | CUSTOMER | ✅ |
| POST | `/attendance/bookings/:bookingId/exceptions` | CUSTOMER, Idempotent | ✅ |

`GET /attendance/bookings/:bookingId` → paginated `AttendanceView[]` (newest date first).
`GET .../summary?month=YYYY-MM` → `AttendanceSummaryView`: counts per status + scheduled window `{ from, to }`.
`POST .../exceptions` → `AttendanceView`. Only when no entry exists for that date; note (1–500) required.

**Still needed:**
- **Money / transactions month summary** — no endpoint. `GET /payments?bookingId=` lists individual payments but
  there is no monthly-spend aggregation in any controller. ❌
- **Bookings free-text search** — `GET /bookings` accepts `status, category, area, engagement, createdFrom,
  createdTo` filters but no `search` text param exists in any controller or DTO. ❌

---

## Screen 17 — History

Sources: [`history.controller.ts`](file:///c:/Users/ABC/Desktop/Seva%20Nest/src/modules/history/history.controller.ts),
[`booking.controller.ts`](file:///c:/Users/ABC/Desktop/Seva%20Nest/src/modules/booking/booking.controller.ts)

| Method | Path | Auth | Status |
|---|---|---|---|
| GET | `/customers/me/booking-history` | CUSTOMER | ✅ |
| GET | `/customers/me/booking-history/summary` | CUSTOMER | ✅ |
| GET | `/bookings/:bookingId/replacement-chain` | CUSTOMER | ✅ |
| POST | `/bookings/rebook` | CUSTOMER, Idempotent | ✅ |

**`GET /customers/me/booking-history`** (from `HistoryController`):
Filters: `year` (service start date / request date, India time), `category` (code),
`search` (category name or worker name — **this filter EXISTS in the history service**), `status`.
Each item carries `amountPaidMinor`.

**`GET /customers/me/booking-history/summary`** (from `HistoryController`):
Returns `{ totalServices, distinctWorkers, totalSpentMinor }`.
`totalSpentMinor` = sum of payments with status SUCCEEDED, REFUND_PENDING, REFUND_FAILED over matching bookings.

**`POST /bookings/rebook`** body: `{ bookingId, startDate? }`. 409 `REBOOK_NOT_ALLOWED` for a non-COMPLETED booking.

**Still needed:**
- History screen has `search` in the query — ✅ it **does exist** in `HistoryController`; the filter is by
  category name or worker name.
- `totalSpentMinor` definition (platform fees only vs. wages vs. both) — the code sums payments; whether that
  matches the design intent for "Total spent" needs confirmation. 🚫

---

## Screen 18 — Rate worker

Sources: [`ratings.controller.ts`](file:///c:/Users/ABC/Desktop/Seva%20Nest/src/modules/ratings/ratings.controller.ts)

| Method | Path | Auth | Status |
|---|---|---|---|
| POST | `/ratings` | CUSTOMER, Idempotent | ✅ |
| GET | `/ratings` | CUSTOMER | ✅ |
| GET | `/ratings/:ratingId` | CUSTOMER | ✅ |
| GET | `/ratings/bookings/:bookingId` | CUSTOMER | ✅ |
| GET | `/ratings/bookings/:bookingId/eligibility` | CUSTOMER | ✅ |

`POST /ratings` body (`CreateRatingDto`): `{ bookingId, score, reviewText?, tags?: string[] }`
- `score`: 1 to `ratingScaleMax` (from `GET /reference-data`). 400 `RATING_SCORE_OUT_OF_SCALE`.
- `tags`: array of codes. Unknown code, non-array, duplicates → 400. Omitted/`null`/`[]` = no tags.
  Valid tag codes: `PUNCTUAL, POLITE, SKILLED, CLEAN_WORK, TRUSTWORTHY, LATE, RUDE, POOR_QUALITY_WORK,
  UNRELIABLE`. Catalogue (`code, label, sentiment`) in `GET /reference-data` → `ratingTags`.
- 422 `RATING_NOT_ELIGIBLE` unless eligibility check passes. 409 `RATING_ALREADY_EXISTS`.

`GET /ratings/bookings/:bookingId/eligibility` → `RatingEligibilityView`:
`{ eligible, code: ELIGIBLE|ALREADY_RATED|NOT_COMPLETED|ENDED_EARLY_NOT_RATEABLE|NO_WORKER, reason, ratingReviewMax, ratingScaleMax }`

**Still needed:**
- Tag catalogue labels/sentiment must be confirmed by client (currently seeded with defaults). 🚫
- Score/tag pairing rule (e.g. positive tags only with score ≥ 4) — not enforced in the code; any tag with any
  score is accepted. 🚫

---

## Screen 19 — Replacement request

Sources: [`replacement.controller.ts`](file:///c:/Users/ABC/Desktop/Seva%20Nest/src/modules/replacement/replacement.controller.ts)

| Method | Path | Auth | Status |
|---|---|---|---|
| POST | `/replacement-requests` | CUSTOMER, Idempotent | ✅ |
| GET | `/replacement-requests` | CUSTOMER | ✅ |
| GET | `/replacement-requests/:requestId` | CUSTOMER | ✅ |
| GET | `/replacement-requests/:requestId/alternatives` | CUSTOMER | ✅ |
| POST | `/replacement-requests/:requestId/cancel` | CUSTOMER, Idempotent | ✅ |
| POST | `/replacement-requests/:requestId/select` | CUSTOMER, Idempotent | ✅ |

`POST /replacement-requests` body (`CreateReplacementDto`): `{ bookingId, reason?, reasonCode?, neededFrom? (YYYY-MM-DD) }`
`neededFrom` is stored and returned, informational only (does not change the replacement booking or start date).
`GET .../alternatives` → paginated `WorkerCard[]` — only when request is APPROVED; excludes the current worker.

`GET .../detail` response (`ReplacementDetailView`): `{ …, decisionMessage (customer-facing only), timeline[] }`
Staff remarks are never returned to customers.

**Still needed:**
- Fixed `reasonCode` list — `REPLACEMENT_REASONS` array is in the `meta.controller.ts` `referenceData`
  response. Its values are defined in `replacement.dto.ts`. Check the actual codes with the team. ⚠️
- Replacement fee / price / interview rules — not defined in the code. 🚫

---

## Screen 20 — Support / help

Sources: [`support.controller.ts`](file:///c:/Users/ABC/Desktop/Seva%20Nest/src/modules/support/support.controller.ts),
[`meta.controller.ts`](file:///c:/Users/ABC/Desktop/Seva%20Nest/src/modules/meta/meta.controller.ts)

| Method | Path | Auth | Status |
|---|---|---|---|
| GET | `/support/categories` | CUSTOMER or WORKER | 🔧 |
| POST | `/support/tickets` | CUSTOMER or WORKER, Idempotent | ✅ |
| GET | `/support/tickets` | CUSTOMER or WORKER | ✅ |
| GET | `/support/tickets/:ticketId` | CUSTOMER or WORKER | ✅ |
| POST | `/support/tickets/:ticketId/messages` | CUSTOMER or WORKER, Idempotent | ✅ |
| GET | `/support/tickets/:ticketId/messages` | CUSTOMER or WORKER | ✅ |

`GET /support/categories` → `SupportCategoryView[]` (enabled only). **Empty until staff add at least one.**
Ticket creation fails `422 SUPPORT_CATEGORY_INVALID` without a category. 🔧

`POST /support/tickets` body (`CreateTicketDto`):
`{ categoryId (required), description (10-4000 chars trimmed), subject? (1-120), bookingId? (must be caller's) }`
`priority` is staff-only; any priority field in the request is silently stripped.

`GET /support/tickets/:ticketId` (`TicketDetailView`): statuses `OPEN, IN_PROGRESS, ESCALATED, CLOSED`.
`history[].type` fixed set: `CREATED, ASSIGNED, PRIORITY_SET, ESCALATED, CLOSED`. Staff notes, staff identity
and priority are never returned to the customer.

Messages oldest-first (`createdAt` then `id`). Staff internal notes never appear in the customer view.
Closed ticket → 409 `TICKET_CLOSED` on `POST .../messages`. CLOSED is final — no reopen. 🚫

`support.phone` / `support.email` → from `GET /app-config` (see Screen 1). 🔧

**Still needed:**
- **FAQ endpoint** — does not exist anywhere in the codebase. ❌
- **Photo/file attachments on tickets** — `CreateTicketDto` has no attachment field. No file upload endpoint for
  support tickets exists. ❌

---

## Screen 21 — Notifications / inbox

Sources: [`notifications.controller.ts`](file:///c:/Users/ABC/Desktop/Seva%20Nest/src/modules/notifications/notifications.controller.ts),
[`notifications.service.ts`](file:///c:/Users/ABC/Desktop/Seva%20Nest/src/modules/notifications/notifications.service.ts)

| Method | Path | Auth | Status |
|---|---|---|---|
| GET | `/notifications` | any signed-in | ✅ |
| GET | `/notifications/unread-count` | any signed-in | ✅ |
| POST | `/notifications/read-all` | any signed-in | ✅ |
| POST | `/notifications/:notificationId/read` | any signed-in | ✅ |
| POST | `/notifications/:notificationId/unread` | any signed-in | ✅ |

**Unread count shape** (from `UnreadCountView`): `{ count: number, unread: number }` — both values are identical;
`unread` is the older name kept for compatibility.

**Push payload keys** (from `notifications.service.ts` `dispatchPush()`):
FCM `data` object (all strings): `notificationId, event`, and when there is a route: `routeType, routeId`.

**Route types** (from `ENTITY_ROUTES` const in `notifications.service.ts`):

| routeType | Events |
|---|---|
| `payment` | `PAYMENT_SUCCEEDED`, `PAYMENT_FAILED`, `PAYMENT_UNDER_REVIEW`, `PAYMENT_REFUND_INITIATED`, `PAYMENT_REFUNDED` |
| `replacement` | `REPLACEMENT_UPDATE` |
| `interview` | `INTERVIEW_REQUESTED`, `INTERVIEW_RESPONDED`, `INTERVIEW_CANCELLED` |
| `booking` | all other events carrying `bookingId` (fallback) |
| `ticket` | events carrying `ticketId` (fallback) |

Fallback order (from `routeFor()` function): own entity route first → `bookingId` → `ticketId` →
`replacementId` → `paymentId`.

**Still needed:**
- **Notification preferences** (per-channel on/off, per-event opt-out) — `PUT /users/me/notification-preferences`
  exists in `users.controller.ts` but only controls the **email** channel (`{ email: boolean }`). No per-event or
  push/SMS preference is implemented. ⚠️
- **Delete inbox item** — no `DELETE /notifications/:id` endpoint in any controller. ❌
- **`RATING_RECEIVED` push** — the event code exists in the outbox event definitions but nothing in the codebase
  emits it to any queue. ❌
- FCM delivery unverified — `PUSH_PROVIDER=fcm` and `FCM_SERVICE_ACCOUNT_JSON` must be set on staging. 🔧

---

## Screen 22 — Account / settings

Sources: [`users.controller.ts`](file:///c:/Users/ABC/Desktop/Seva%20Nest/src/modules/users/users.controller.ts),
[`auth.controller.ts`](file:///c:/Users/ABC/Desktop/Seva%20Nest/src/modules/auth/auth.controller.ts),
[`customer-photo.controller.ts`](file:///c:/Users/ABC/Desktop/Seva%20Nest/src/modules/customer-photo/customer-photo.controller.ts),
[`customers.controller.ts`](file:///c:/Users/ABC/Desktop/Seva%20Nest/src/modules/customers/customers.controller.ts),
[`safety.controller.ts`](file:///c:/Users/ABC/Desktop/Seva%20Nest/src/modules/safety/safety.controller.ts),
[`legal.controller.ts`](file:///c:/Users/ABC/Desktop/Seva%20Nest/src/modules/legal/legal.controller.ts)

| Method | Path | Auth | Status |
|---|---|---|---|
| GET | `/users/me` | any signed-in | ✅ |
| GET | `/users/me/notification-preferences` | any signed-in | ⚠️ |
| PUT | `/users/me/notification-preferences` | any signed-in | ⚠️ |
| GET | `/customers/me` | CUSTOMER | ✅ |
| PATCH | `/customers/me` | CUSTOMER | ✅ |
| GET | `/auth/sessions` | any signed-in | ✅ |
| DELETE | `/auth/sessions/:sessionId` | any signed-in | ✅ |
| POST | `/auth/logout` | any signed-in | ✅ |
| PUT | `/auth/device-token` | CUSTOMER or WORKER | ✅ |
| DELETE | `/auth/device-token` | CUSTOMER or WORKER | ✅ |
| POST | `/customers/me/photo` | CUSTOMER | 🔧 |
| POST | `/customers/me/photo/:photoId/confirm` | CUSTOMER | 🔧 |
| GET | `/customers/me/photo` | CUSTOMER | 🔧 |
| GET | `/safety/blocks` | CUSTOMER or WORKER | ✅ |
| DELETE | `/safety/blocks/:blockId` | CUSTOMER or WORKER | ✅ |
| GET | `/legal/current` | public | ✅ |
| GET | `/legal/status` | any signed-in | ✅ |
| POST | `/legal/accept` | any signed-in | ✅ |
| POST | `/me/deletion-request` | any signed-in | ⚠️ |
| GET | `/me/deletion-request` | any signed-in | ✅ |
| DELETE | `/me/deletion-request` | any signed-in | ✅ |

**Notification preferences** — only `email: boolean` exists (`NotificationPreferencesView`). No push, no
per-event switches. ⚠️

**Customer photo** (from `CustomerPhotoController`):
- `POST /customers/me/photo` request: `{ contentType: "image/jpeg"|"image/png", sizeBytes: number }`
  → `PhotoUploadResponse`: `{ photoId, uploadUrl, expiresAt }`. 503 `PHOTO_NOT_CONFIGURED` until
  `PROFILE_PHOTO_MAX_BYTES` env-var is set. 🔧
- PUT the image bytes to `uploadUrl` directly (not through the API).
- `POST /customers/me/photo/:photoId/confirm` → `{ photoId, status: "READY" }`. Validates size, file signature,
  content; optional ClamAV scan. Parallel safe. Replaces the previous photo.
- `GET /customers/me/photo` → `PhotoLink`: `{ url, largeUrl, expiresAt, cacheKey }`. 404 `PHOTO_NOT_FOUND`
  when the customer has no photo. Photo is **owner-only** — not in `GET /customers/me`, not visible to workers
  or staff. 🚫 (Q-113: scope pending)

**Deletion request** (from `AccountDeletionController` in [`legal.controller.ts`](file:///c:/Users/ABC/Desktop/Seva%20Nest/src/modules/legal/legal.controller.ts)):
- `POST /me/deletion-request { reason? }` → `DeletionRequestView`. 409 `DELETION_BLOCKED` while a booking is
  unfinished or a payment/refund is in progress. Repeating returns the open request.
- `GET /me/deletion-request` → `DeletionRequestView | null`.
- `DELETE /me/deletion-request` → 204, withdraws the open request.
- **Nothing is erased automatically.** The request is recorded for staff; erasure/anonymisation is undefined. 🚫
  App wording must be "we will review your request", **not** "your data has been deleted".

**Legal consent** (from `LegalController` in `legal.controller.ts`):
- `GET /legal/current` (public) → current terms/privacy versions.
- `GET /legal/status` → has the signed-in user accepted the current versions.
- `POST /legal/accept { termsVersion?, privacyVersion? }` → idempotent; 409 `LEGAL_VERSION_MISMATCH` for an old
  version.

**Still needed:**
- `storeUrl` / support contact / legal URLs — all from `GET /app-config`; see Screen 1. 🔧

---

## Priority gaps for the backend developer

### P0 — Blocks a complete screen

| Gap | Screen | Detail |
|---|---|---|
| Itemised fee quote (wage + fee + tax + total) | 14 — Confirm booking | Only `GET /fees/booking` → `{ amountMinor }` exists. No breakdown. |
| Address / home photo | 5 — Address | `POST /customers/me/photo` is a profile photo, not a home photo. No address-scoped photo endpoint. |
| Promo / banner carousel | 7 — Home | No endpoint exists. |
| FAQ endpoint | 20 — Support | No route in any controller. |
| Support ticket photo attachments | 20 — Support | No upload route for ticket attachments. |

### P1 — Feature degraded but screen loads

| Gap | Screen | Detail |
|---|---|---|
| Worker "About" / bio field | 10 — Worker profile | No bio column in any worker DTO. Needs migration + worker onboarding. |
| Repeat-customer % | 10 — Worker profile | Not computed; no definition agreed. |
| Verification check list per check | 10 — Worker profile | Only `verified: boolean`. Individual checks not exposed. |
| Distance value on card | 9, 10 — Search / Profile | Sort by DISTANCE_ASC works but `distance` field is absent from `WorkerCard`. |
| `BEST_MATCH` sort + `matchScore` | 9 — Search | Not in sort enum. Use `EXPERIENCE_DESC` as fallback. |
| Weekday availability filter | 9 — Search | Not in query DTO; availability windows are daily. |
| Monthly transaction summary | 16 — Active service | No aggregation endpoint exists. |
| Delete inbox item | 21 — Notifications | No DELETE route on notifications. |
| `RATING_RECEIVED` push | 21 — Notifications | Event code exists but nothing emits it. |
| Per-event / per-channel notification preferences | 21, 22 | Only email on/off is implemented (`PUT /users/me/notification-preferences`). |

### P2 — Ops configuration (everything works once set)

| Env-var / DB setting | Effect when missing | Screen |
|---|---|---|
| `PROFILE_PHOTO_MAX_BYTES` | 503 on photo upload | 22 |
| `APP_STORE_URL_CUSTOMER` | `storeUrl: null` | 1, 22 |
| `SUPPORT_CONTACT_PHONE` / `_EMAIL` | `null` → Call/Email disabled | 1, 20, 22 |
| `LEGAL_TERMS_URL` + `LEGAL_TERMS_VERSION` | `legal.terms: null` | 1, 22 |
| `LEGAL_PRIVACY_URL` + `LEGAL_PRIVACY_VERSION` | `legal.privacy: null` | 1, 22 |
| `POLICY_CANCELLATION_TEXT` / `POLICY_REFUND_TEXT` | `null` | 14, 15 |
| Support categories (admin portal DB row) | ticket creation 422 | 20 |
| Category images (admin portal upload) | `image: null` on tiles | 7, 8 |
| `PAYMENT_GATEWAY` + Razorpay keys | payment flow broken | 15 |
| `PUSH_PROVIDER=fcm` + `FCM_SERVICE_ACCOUNT_JSON` | no push | 21 |
| `SMS_PROVIDER` + credentials | no real OTP SMS | 2 |

---

*Every route, field and status in this document was read from the actual controller or DTO source file in
`src/modules/`. No documentation file was used as the authority. Local test evidence not re-run in this session.*
