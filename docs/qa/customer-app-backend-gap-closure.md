# Customer app backend gap closure: requirements traceability (2026-10-15)

Source: "Requests for the backend team (customer app)", requests 1-57 (numbering follows the document's groups: 1-13 modules 3-5, 14-27 module 7
payments and confirmations, 28-36 module 8, 37-44 module 9, 45-54 module 10, 55-57 module 14; where the source lists several asks under one
number they share a row). Method: every row was checked against the current source, Prisma schema, existing tests and, where a gap was found,
fixed with a new test. Nothing was committed, pushed, deployed or run against Render / Supabase staging. All test evidence is **local**, on
disposable databases (`sevanest_gap_ci`, `sevanest_mig_scratch_ci`, both created and used only on the local Docker PostgreSQL).

Statuses: IMPLEMENTED AND TESTED · ALREADY IMPLEMENTED - VERIFIED · PARTIALLY IMPLEMENTED · BLOCKED - CLIENT DECISION ·
BLOCKED - EXTERNAL CREDENTIAL/INFRASTRUCTURE · NOT APPLICABLE - WITH EVIDENCE.
"This change" = done in this run; everything else was built earlier (see `customer-app-api-gaps.md`, `customer-app-api-blockers.md`,
`BACKEND_REQUESTS.md`) and was re-verified here by reading the code and the named tests.

## Changes made in this run
| Change | Files | Test |
|---|---|---|
| `GET /fees/booking[?bookingId=]`: exact booking fee, same code path as `POST /payments` | `payment.controller.ts`, `payment.service.ts` (`requireActiveBookingFee`, `quoteBookingFee`), `dto/payment.dto.ts` | `customer.gapclosure` (3 tests) |
| Customer own profile photo: `POST /customers/me/photo`, `POST .../{photoId}/confirm`, `GET /customers/me/photo`; abandoned-upload sweep in the worker | new `src/modules/customer-photo/*`, `app.module.ts`, `worker.module.ts`, `prisma/schema.prisma`, migration `20261029090000_customer_profile_photo` | `customer.gapclosure` (5 tests) |
| Defect: a worker's decline reason (free text) was returned in the customer's booking timeline | `booking.service.ts` `timelineEntry` | `customer.gapclosure` "does not show a worker's own decline reason" |
| Defect: `minRating` accepted values above the configured rating scale (silent empty result) | `search.service.ts`, `search.dto.ts` | `customer.gapclosure` "rating scale in search" |
| Defect: blank `LEGAL_TERMS_URL` / `LEGAL_PRIVACY_URL` answered `""` instead of `null` | `app-config.service.ts` | `app-config.service.spec.ts` (2 new) |
| New regression tests for booking actions: `allowedActions` agree with the server, schedule not repeatable, reopen-matching result, repeated cancel, cross-customer/worker-only actions | tests only | `customer.gapclosure` (4 tests) |

## Traceability matrix

### Module 3-5 asks (requests 1-13)
| # | Request | Status | Current implementation / evidence | Remaining blocker |
|---|---|---|---|---|
| 1 | Customer-safe worker reviews + rating scale | IMPLEMENTED AND TESTED | `GET /search/workers/{id}/ratings` -> `{data:[{score, comment, createdAt, reviewerFirstName}], meta}` (visible workers only, identical 404, moderation hidden); `ratingScaleMax` in `GET /reference-data`; averages are 2-decimal on that scale; `minRating`/`sort` documented. This change: `minRating` > scale -> 400. Tests: `appfeedback` (reviews, privacy, paging, ids, roles, scale), `customer.gapclosure`, `gap.closing` | Customers reading review text needs client sign-off (Q-60) |
| 2 | Typed success/error schemas, list envelope, shortlist shape, category identifier | ALREADY IMPLEMENTED - VERIFIED | Explicit response classes on the customer controllers; `contract.openapi.int-spec` validates real responses against the published OpenAPI. Envelope `{data, meta:{page,limit,total}}`, `total` always present. Shortlist entry `{workerId, addedAt, available, worker}` (`worker:null` when not visible). `category` = code. Error envelope `{code, message, details, requestId}` | A few inline bodies (health, `{updated}`) are untyped (documented) |
| 3 | Static test customer with data | BLOCKED - EXTERNAL CREDENTIAL/INFRASTRUCTURE | Local demo seed (`seed:demo`) and the contract test build the data through the API; test OTP is configuration (`ALLOW_TEST_OTP`, `TEST_OTP_NUMBERS`). Writing to staging was out of bounds here | The environment owner seeds staging |
| 4 | `GET /pricing/guidance` | PARTIALLY IMPLEMENTED | Endpoint + admin entry (`/admin/pricing-guidance`); 404 `PRICING_GUIDANCE_NOT_FOUND` until an admin enters a band. No price is derived or invented. Tests: `appgaps2` | BLOCKED - CLIENT DECISION: who owns the price bands (Q-76) |
| 5 | Budget filter in search | BLOCKED - CLIENT DECISION | Budget is stored on the booking (`budgetMinMinor/MaxMinor/Period`); worker `expectedSalary` has no period so a filter cannot be correct (Q-39, Q-77) | Define the budget/period semantics |
| 6 | Start date / days of week in search | PARTIALLY IMPLEMENTED | `startDate` excludes workers already booked for an overlapping time (D-63); weekdays are not stored in availability, so not matched. Tests: `scheduling`, `search.api` | BLOCKED - CLIENT DECISION: per-weekday availability (Q-37/Q-47) |
| 7 | Home aggregate | ALREADY IMPLEMENTED - VERIFIED | `GET /customers/me/home` -> `{activeBooking, upcomingInterview, unreadNotifications, shortlistPreview, shortlistTotal}`; no interview is fabricated (null). Test: `appgaps2` | - |
| 8 | Customer profile photo | IMPLEMENTED AND TESTED (this change) | Same safeguards as the worker photo: private storage, signed PUT URL (TTL `SIGNED_URL_TTL_SECONDS`), type JPEG/PNG, size cap `PROFILE_PHOTO_MAX_BYTES` (503 `PHOTO_NOT_CONFIGURED` until set), signature check, optional malware scan, WebP renditions without EXIF, confirmation idempotent under parallel calls, other customer's photo 404, roles 403/401, max 3 open uploads, abandoned uploads (>24 h) deleted by the worker loop, replaced photo deleted, audit events. Visible to the owner only: not in `/customers/me`, not shown to workers or staff. Tests: `customer.gapclosure` | BLOCKED - CLIENT DECISION: V1 scope and who may see it (Q-113). Real bucket never exercised (memory storage in tests) |
| 9 | Booking lifecycle, `allowedActions`, timeline, slots | PARTIALLY IMPLEMENTED | Customer actions and source states (state machine `RULES`): `schedule` MATCHED; `reopen-matching` INTERVIEW_TRIAL_SCHEDULED/COMPLETED -> **MATCHED** (worker kept, schedule cleared; not NEW_REQUEST); `interview-complete` INTERVIEW_TRIAL_SCHEDULED; `confirm-worker` INTERVIEW_TRIAL_COMPLETED -> PENDING_PAYMENT; `cancel` any pre-ACTIVE state, reason required, repeat = idempotent replay (200, one timeline entry); `start`/`complete` per FRD. `allowedActions` + `timeline[]` are on every customer booking and agree with the server (test). `schedule` is **not** repeatable (409): reschedule uses `POST /interviews/{id}/reschedule`. Worker's decline reason removed from the customer timeline (this change). Double-booking: 409 `WORKER_UNAVAILABLE` at creation and confirmation, parallel confirmations -> one wins (`scheduling`). Tests: `customer.gapclosure`, `booking.api`, `qa.statemachine` (full action x state x actor matrix), `qa.concurrency`, `scheduling`, `interview`, `appgaps2` | BLOCKED - CLIENT DECISION (Q-115): only "in the future" is enforced for the scheduled time; `/slots` (1 h, 14 days, availability windows) is advisory. State model itself is still PROPOSED (Q-05/Q-55). Q-116: staff free text in the customer timeline |
| 10 | Address `label`, `line2`, `state` | ALREADY IMPLEMENTED - VERIFIED | Optional, `null` clears, serialized on every response, migration `20261018090000`. Default-address and soft-delete rules unchanged. Tests: `appfeedback`, `customers.api` | - |
| 11 | Coordinates -> service area | PARTIALLY IMPLEMENTED | `GET /locations/service-area`: nearest enabled area whose admin-set circle covers the point, else exact name; 404 `AREA_NOT_FOUND`. No geocoder, no text guessing. Tests: `appgaps2` | BLOCKED - CLIENT DECISION: boundary data / map provider (Q-78) |
| 12 | Fee before payment | IMPLEMENTED AND TESTED (this change) | `GET /fees/booking` -> `{code, amountMinor, currency}`; with `?bookingId=` (own booking) an open payment's amount is returned. Equal to what `POST /payments` charges (shared `requireActiveBookingFee`); 422 `FEE_NOT_CONFIGURED`; other customer's booking 404; worker/admin 403; 401. Tests: `customer.gapclosure` | Policy text (cancellation/refund/replacement) not served: Q-114 |
| 13 | Cancellation reasons and refund info | PARTIALLY IMPLEMENTED | `cancel` takes a free-text `reason`; refund state is on the payment (`refundStatus`, `GET /payments?refunded=true`, `?bookingId=`). No fixed reasons, refund promise or fee exemption is invented. Tests: `payment.api`, `payment.appfields` | BLOCKED - CLIENT DECISION: reasons list, refund/cancellation fee policy (Q-77, Q-83, Q-114) |

### P3 confirmations and module 7 payments (requests 14-27)
| # | Request | Status | Evidence | Remaining |
|---|---|---|---|---|
| 14 | OTP error codes / 429 shape | ALREADY IMPLEMENTED - VERIFIED | `OTP_EXPIRED` 400, `OTP_INVALID` 400, `OTP_ATTEMPTS_EXCEEDED`/`OTP_LOCKED` 429 with `details[0].retryAfterSeconds`; generic `RATE_LIMITED` with `Retry-After`. Test: `auth.api` | - |
| 15 | Default-address rules, in-use delete code, unserviceable area | ALREADY IMPLEMENTED - VERIFIED | First address not auto-default; delete is soft and never blocked by a booking (no "in use" code); unserviceable area surfaces at booking (`AREA_NOT_AVAILABLE` 422). Test: `customers.api` | - |
| 16 | `minRating` scale, `sort` | IMPLEMENTED AND TESTED | See row 1 | - |
| 17 | `meta.total`, refresh rotation | ALREADY IMPLEMENTED - VERIFIED | `total` always present; refresh single-use, replay revokes the session. Tests: `search.api`, `auth.api` | - |
| 18 | Support contact in `GET /app-config` | BLOCKED - EXTERNAL CREDENTIAL/INFRASTRUCTURE | Reads `SUPPORT_CONTACT_PHONE/EMAIL`, blank = `null` (unit tested) | Operator supplies real values |
| 19-26 | Payments: checkout shape, receipt (+PDF), method/reference, payment of a booking, CREATED vs PENDING, retry after FAILED, refund filter, failure reason | ALREADY IMPLEMENTED - VERIFIED | `POST /payments`, `/verify`, `GET /payments[?bookingId=&refunded=]`, `/receipt`, `/receipt/pdf` (409 `RECEIPT_NOT_AVAILABLE`), `failureCode/failureReason`, idempotent create. Tests: `payment.api`, `payment.appfields`, `payments.recovery` (fake gateway; Razorpay test mode verified earlier by script only) | BLOCKED - EXTERNAL: no Razorpay run from this machine; GST invoice format (Q-100) |
| 27 | `force-update`/maintenance behaviour | ALREADY IMPLEMENTED - VERIFIED | See row 57 | - |

### Module 8 / history / rating (requests 28-36)
| # | Request | Status | Evidence |
|---|---|---|---|
| 28 | Customer attendance, own bookings only | ALREADY IMPLEMENTED - VERIFIED | other customers' bookings 404. `customer.active-service` |
| 29 | Statuses incl. LATE/LEAVE, check-in/out, scheduled window, worker summary | ALREADY IMPLEMENTED - VERIFIED | `checkInAt/checkOutAt`, `scheduledWindow {from,to}` (24h strings), `worker`. `customer.active-service`. Client sign-off Q-101 |
| 30 | Customer missing-day exception, duplicate day | ALREADY IMPLEMENTED - VERIFIED | ACTIVE booking, note 1-500, 409 on a day with an entry. `customer.active-service`, `customer-attendance-exception-test-results.md` |
| 31 | History + summary filters, pagination, money | ALREADY IMPLEMENTED - VERIFIED | `GET /customers/me/booking-history[/summary]`. `customer.history-rating`. "Total spent" definition awaits Q-104 |
| 32 | Rating eligibility = `allowedActions` | ALREADY IMPLEMENTED - VERIFIED | One shared rule; REPLACED not rateable (Q-102, unchanged). `customer.history-rating` |
| 33 | Review length / scale config | ALREADY IMPLEMENTED - VERIFIED | `ratingReviewMax` (300) and `ratingScaleMax` in reference-data; eligibility returns both. Q-105 |
| 34 | Rebook | ALREADY IMPLEMENTED - VERIFIED | `POST /bookings/{id}/rebook` (idempotent, 409 `REBOOK_NOT_ALLOWED`, eligibility errors; start date left null when omitted). Q-106 |
| 35 | Rating tags | BLOCKED - CLIENT DECISION | No catalogue exists (Q-103); none invented |
| 36 | Worker display name / photo | ALREADY IMPLEMENTED - VERIFIED | `worker {displayName, initials, photo{url,largeUrl,expiresAt,cacheKey}}` from the interview stage on; no contact data |

### Module 9 replacement (requests 37-44)
| # | Request | Status | Evidence |
|---|---|---|---|
| 37 | Reasons | BLOCKED - CLIENT DECISION | Free text plus reason codes endpoint (Q-107 in the replacement notes); no fixed list invented. `replacement.api` "reason codes" |
| 38 | "Needed from" date | BLOCKED - CLIENT DECISION | Not accepted or stored |
| 39-40 | Ownership, state transitions, cancel, select, alternatives private and excluding the replaced worker | ALREADY IMPLEMENTED - VERIFIED | `replacement.api` (requesting, reading, staff review, selecting, cancelling, parallel selections, invariants); alternatives only for the owner of an APPROVED request |
| 41 | Replacement booking rules (price, interview, fee) | BLOCKED - CLIENT DECISION | Follows the normal flow, nothing copied or waived (Q-54) |
| 42 | Staff remarks never leak | ALREADY IMPLEMENTED - VERIFIED | `replacement.api` "keeps internal remarks away from customers"; only approved/rejected decision remarks shown |
| 43 | Old/new booking linkage | ALREADY IMPLEMENTED - VERIFIED | `replacementBookingId`, `GET /bookings/{id}/replacement-chain` |
| 44 | Review ETA | BLOCKED - CLIENT DECISION | No ETA field or rule |

### Module 10 support, safety, notifications (requests 45-54)
| # | Request | Status | Evidence |
|---|---|---|---|
| 45 | FAQ, support contact | BLOCKED - CLIENT DECISION / EXTERNAL | No approved FAQ content (Q-111); contact is configuration |
| 46 | Ticket fields | PARTIALLY IMPLEMENTED | `subject` (optional), description 10-4000 enforced, bookingId ownership; photos BLOCKED - CLIENT DECISION (Q-107), urgent priority staff-only. `module10...int-spec` |
| 47-48 | Statuses, history types, message order, no reopen | ALREADY IMPLEMENTED - VERIFIED | Closed `history[].type` set; oldest-first messages; staff notes private. Reopen needs a decision (Q-108) |
| 49-50 | Safety reasons, ownership, bookingId/workerId relation, idempotency | ALREADY IMPLEMENTED - VERIFIED | `Idempotency-Key` on reports and blocks (concurrent retries -> one report), report id returned, mismatched worker/booking -> 404 `SAFETY_TARGET_NOT_FOUND`; `GET/DELETE /safety/blocks` is the existing user-visible block list; no silent block |
| 51 | Device token | ALREADY IMPLEMENTED - VERIFIED | One token per session, a token re-bound elsewhere moves to the new session (never two owners), logout drops it, `DELETE /auth/device-token`, dead FCM tokens removed. FCM faked only: BLOCKED - EXTERNAL (Firebase never called) |
| 52 | Push payload / route types | ALREADY IMPLEMENTED - VERIFIED | `notificationId, event, routeType, routeId` (strings, ids only); emitted types `booking`, `ticket`; Q-110 for more |
| 53 | Unread count schema, mark-unread, preferences, delete | PARTIALLY IMPLEMENTED | `{count, unread}`, `POST /notifications/{id}/unread`; preferences/delete BLOCKED - CLIENT DECISION (Q-109) |
| 54 | Push re-ask interval | NOT APPLICABLE - WITH EVIDENCE | Client-side product decision; no backend state or config exists or is needed (`BACKEND_REQUESTS.md` section 54) |

### Module 14 account and settings (requests 55-57)
| # | Request | Status | Evidence / remaining |
|---|---|---|---|
| 55 | Legal terms / privacy URLs | ALREADY IMPLEMENTED - VERIFIED (+ small fix) | `GET /app-config` `legal.terms{version,url}` / `legal.privacy{...}`; URL is `null` unless configured (`LEGAL_*_URL`, now blank = unset, unit tested). Note: the document object is only returned when its **version** (`LEGAL_*_VERSION`) is also set. No URL is hardcoded. BLOCKED - EXTERNAL: operator must supply the approved URLs |
| 56 | Account deletion | PARTIALLY IMPLEMENTED | Existing (re-verified in code; test `gap.closing` "records a deletion request, blocks it while money or an engagement is in progress, and lets the user withdraw it", passes alone 31/31): `POST /me/deletion-request {reason?}` (201; repeating returns the open request; 409 `DELETION_BLOCKED` while a booking is unfinished or a payment/refund is in progress, with generic messages), `GET /me/deletion-request` (open request or null), `DELETE /me/deletion-request` (withdraw, 404 `DELETION_NOT_FOUND`), staff `GET /admin/deletion-requests` (`user.status.manage`). It records the request, audits it and raises a staff alert; **nothing is erased or anonymised**. | BLOCKED - CLIENT DECISION: what staff then erase/anonymise and retention for payments, bookings, ratings, tickets, audit (Q-88, Q-112). The app can offer "Request account deletion" now with the wording "we will review your request"; it must not promise erasure |
| 57 | `customer.storeUrl`, `minVersion` format, maintenance | ALREADY IMPLEMENTED - VERIFIED | `customer.storeUrl`/`worker.storeUrl` from `APP_STORE_URL_*` (https only, boot fails otherwise; unit tested here); `minVersion` strictly `major.minor.patch` or `null`; `maintenance` flag; public, 60 s cache. BLOCKED - EXTERNAL: real store URL not supplied |

## Security checks per new endpoint
| Endpoint | Auth / role | Isolation | Validation | Notes |
|---|---|---|---|---|
| `GET /fees/booking` | JWT, `CUSTOMER` only (worker/admin 403, anonymous 401) | `bookingId` of another customer = 404 `BOOKING_NOT_FOUND` | `bookingId` UUID (400) | Read-only; exposes no config beyond code/amount/currency |
| `POST /customers/me/photo` | JWT, `CUSTOMER` | Object key built from the caller's id; id taken from the token only | type JPEG/PNG, size >= 1 and <= `PROFILE_PHOTO_MAX_BYTES`, <= 3 open uploads | 503 until configured; audit `customer.photo_request` |
| `POST /customers/me/photo/{id}/confirm` | JWT, `CUSTOMER` | Not the owner's photo = 404 (same as unknown) | UUID; real size, file signature, decodable image, optional scan | Parallel-safe (advisory lock + row recheck); audit `customer.photo_confirm` / `_content_rejected` / `_malware_rejected` |
| `GET /customers/me/photo` | JWT, `CUSTOMER` | Own newest READY photo only | - | Signed, expiring links; no storage key returned |

## Test results (local, this run)
| Check | Result |
|---|---|
| `npm run typecheck` | exit 0 |
| `npm run lint` | exit 0 (0 errors, 3 pre-existing warnings) |
| `npm run format:check` | exit 0 |
| `npx prisma validate` | valid |
| `npm test` (unit) | 308/308, 34 suites (baseline before changes 306/306) |
| `npm run test:e2e` | 27/27, 2 suites |
| Migrations on an empty DB + `prisma migrate diff --exit-code` | 29 migrations apply; no drift (after correcting one over-long index name in the new migration) |
| `npm run test:integration` (full, fresh `_ci` DB) | NOT verified: no clean full run finished (see below) |

### Final integration run
**Not completed cleanly.** Two full runs overlapped on the same database (the first had not stopped), so their failures (39 tests in 16 suites) are not valid evidence and are not counted either way; a third clean run was cancelled at the owner's request before it finished. What was run and passed on its own, on disposable local databases: `customer.gapclosure` 12/12 (the added `minRating` and photo-cleanup tests came after that run and were not re-run), `replacement.api` 26/26, `gap.closing` 31/31. The remaining suites were **not** verified in this run; the GitHub CI run is the first full integration evidence for this change.

## Compatibility notes for the app
* All additions are new routes or stricter validation of an impossible value. One visible behaviour change: a booking-timeline `note` written by the **worker** (decline reason) is now `null` for the customer. `minRating` above `ratingScaleMax` is now 400 instead of an empty list.
* `reopen-matching` returns the booking to **MATCHED** with the same `workerId` (the app assumed NEW_REQUEST). `schedule` cannot be repeated; use `/interviews/{id}/reschedule`.
* Environment: no new variable. The customer photo uses the existing `PROFILE_PHOTO_MAX_BYTES` and `SIGNED_URL_TTL_SECONDS`; `LEGAL_TERMS_URL`/`LEGAL_PRIVACY_URL` only appear when their `*_VERSION` is set.
* Migration `20261029090000_customer_profile_photo`: one new table, no change to existing data, rollback = `DROP TABLE customer_profile_photos` (no other object references it). Tested only on empty databases created from the migration history; there is no existing data to transform.

## Externally unverified
Razorpay live/test traffic, FCM delivery, a real storage bucket (photo upload/confirm, signed URLs), SMS, Render deployment, GitHub CI. Everything above was exercised against the in-memory storage and fake provider adapters on a local database.

## Waiting for a decision (summary)
Q-76 price data, Q-77 budget filter, Q-37/Q-47 weekday matching, Q-78 coordinates to area, Q-103 rating tags, Q-107 ticket photos, Q-108 ticket states/reopen, Q-109 notification preferences/delete, Q-110 route types, Q-111 FAQ content, Q-112 account deletion, Q-113 customer photo scope and visibility, Q-114 policy text and fixed cancellation reasons / refund, Q-115 slot enforcement, Q-116 staff free text in the timeline.

## Developer requests 2026-10-15 (priority order of the customer-app developer)

All rows: verified **locally only** (disposable PostgreSQL, in-memory storage, fake gateway). Nothing was run on Render or Firebase.

| # | Request | Existing before | Implemented / corrected | Files | Tests | Client / infrastructure dependency |
|---|---|---|---|---|---|---|
| 1 | Rating tags (Q-103) | none; `/reference-data` said no catalogue | Optional `tags` on `POST /ratings`: stable codes `PUNCTUAL, POLITE, SKILLED, CLEAN_WORK, TRUSTWORTHY, LATE, RUDE, POOR_QUALITY_WORK, UNRELIABLE`; strict validation (unknown, labels, duplicates, non-array, too many = 400; omitted/null/[] = none); returned as `tags` on customer rating reads, public worker reviews and the admin view; catalogue (`code`, `label`, `sentiment`) in `/reference-data` `ratingTags`; **no score/tag pairing rule enforced** | `common/rating/rating-tags.ts`, `ratings/*`, `search/*`, `meta/meta.controller.ts`, `prisma/schema.prisma` | `customer.devrequests` (6 rating tests: catalogue, persistence and all reads, none/null/empty, rejects, any tag with any score, 401/403/404), `customer.history-rating`, `appfeedback` updated | Client must confirm the catalogue and whether tags must match the score (Q-103, Q-121) |
| 2 | Replacement `neededFrom` | not supported | Optional `YYYY-MM-DD` on `POST /replacement-requests`, real date, today or later (India), else 400; stored in `needed_from DATE`, returned on customer and admin views; informational: the booking, start date, price and review time are untouched; no ETA added | `replacement/*`, schema | `customer.devrequests` (4 tests: stored and returned without touching the booking, omitted = null and today accepted, bad dates create nothing, other customer 404) | What the date should drive, notes limit and review ETA (Q-107, Q-122) |
| 3 | Cancellation/refund policy (Q-114) | none | `GET /app-config` `policy {cancellationText, cancellationUrl, refundText, refundUrl}`, each `null` until `POLICY_CANCELLATION_TEXT/URL`, `POLICY_REFUND_TEXT/URL` are set (text <= 4000, URLs https only, blank = unset); no text in the code | `config/*`, `meta/meta.controller.ts`, `.env.example` | `customer.devrequests` (unconfigured and configured), `app-config.service.spec` (policyContent) | Client must supply the approved text or links |
| 4 | Push types (Q-110) | only `booking` and `ticket` emitted | `payment` (PAYMENT_SUCCEEDED/FAILED/UNDER_REVIEW), `replacement` (REPLACEMENT_UPDATE), `interview` (INTERVIEW_REQUESTED/RESPONDED/CANCELLED), each only when the event carries that id, otherwise the old fallback; push `data` keys unchanged (`notificationId`, `event`, `routeType`, `routeId`; ids only, no amounts, notes or personal data); same rule for the inbox `route` | `notifications/notifications.service.ts` (`routeFor`), `docs/qa/customer-support-safety-notifications-api.md` section 6 | `route-for.spec.ts` (4 unit tests, 10 cases) | Client decision on route types (Q-110); Firebase project and config from the owner; FCM delivery **not verified** |
| 5 | Existing endpoints | mark-unread, receipt PDF, store URL, deletion request, `/fees/booking`, rebook, attendance exceptions, replacement alternatives | Re-checked against source and existing tests (owner-only mark-unread with counts and 404/401, PDF content type, `%PDF-`, "not a tax invoice", 409 before payment and 404 for others, deletion blocked with 409 `DELETION_BLOCKED`, quote equals charge, rebook idempotency and eligibility, exception date range / duplicate day, alternatives owner-only and excluding the replaced worker); no duplicate endpoint added | tests only | `module10`, `payment.appfields`, `gap.closing`, `customer.history-rating`, `customer.active-service`, `replacement.api`, `customer.gapclosure` | Deletion execution, retention (90 days suggested, **not adopted**), erase vs anonymise (Q-88, Q-112) |
| 6 | Notification preferences and delete (Q-109) | mark-unread only | **Not built**, as the developer asked (device-only switches); no retention period chosen | - | - | Client: mandatory categories, retention |

### Migration
`20261030090000_rating_tags_replacement_needed_from`: `ALTER TABLE ratings ADD COLUMN tags TEXT[] DEFAULT ARRAY[]::TEXT[]` and `ALTER TABLE replacement_requests ADD COLUMN needed_from DATE`. Additive; existing rows get an empty tag list and a null date. Rollback: drop the two columns (no other object depends on them). Applied to an empty database from the migration history with no drift reported by `prisma migrate diff`; not run against any database with existing rows.

### Local test evidence for this section (not re-run after the last doc edit)
New: `customer.devrequests` 12/12, `route-for.spec` 4/4, `app-config.service.spec` +1 test. Existing suites touched: `customer.history-rating` 17/17 and `appfeedback` (with `tags` added to the expected shapes) pass. Unit total 319/319 at the time, typecheck, lint (0 errors) and format check clean. In a combined run of 11 related suites, 3 tests failed in `gap.closing` (inbox delivery, 2 tests) and `notifications.api` (stale queued notification) on a long-reused database; I did not re-run them on a fresh database, so treat them as **not verified**. CI on GitHub is the first full integration run.

### Waiting on the client or the owner
Rating tag catalogue and pairing rule (Q-103, Q-121) · approved cancellation/refund text (Q-114) · route types and rating prompt (Q-110) · `neededFrom` meaning, notes limit, review ETA (Q-107, Q-122) · preferences, mandatory messages, inbox retention (Q-109) · account deletion execution and retention (Q-88, Q-112) · legal URLs, store URL, receipt wording (Q-100) · Firebase project and config (owner).
