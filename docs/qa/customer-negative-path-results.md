# Customer app: negative-path results

Evidence: automated integration tests run against a disposable local PostgreSQL/Redis with fake providers. Titles are the exact `it(...)` names from the spec files; all passed in the full run of 2026-10-13 (47 suites, 818 tests). They assert HTTP status, error code and database effect as written in each test. Tests are grouped by keyword in their titles, so a group is an index into the evidence, not a count of distinct requirements; the per-requirement mapping is in the screen traceability documents. Real-provider, deployed-environment and Flutter-screen behaviour is **NOT_VERIFIED**.

## Unauthenticated request

Status: PASS_VERIFIED (12 tests). First 12 shown.

* `guards`: keeps answering 401 for a session that merely ended while the account is active
* `appgaps2`: is closed to the wrong audience and to anonymous callers
* `appgaps2`: does not resolve to a disabled area, and requires sign-in
* `appgaps2`: answers 404 for an unknown or not visible worker, and 401/403 for the wrong caller
* `auth.api`: rejects %s with 401 UNAUTHENTICATED
* `customers.api`: is reserved for customers: workers, admins and anonymous callers are refused
* `onboarding`: is closed to the wrong role and to a suspended customer; unauthenticated callers get 401
* `remaining`: staff read them with an audit record; customers and anonymous callers cannot
* `security.api`: answers 401 to an anonymous caller on every protected route
* `security.api`: answers 401 to a forged or malformed token
* `security.api`: records a role refusal and nothing for allowed calls or anonymous calls
* `support.api`: is refused for admins and anonymous callers

## Wrong role / insufficient permission

Status: PASS_VERIFIED (26 tests). First 12 shown.

* `guards`: rejects a suspended user even with a valid token and session, saying so (403 ACCOUNT_SUSPENDED)
* `guards`: PermissionsGuard: requires ALL listed permissions
* `guards`: records an access-denied event for a refused role or permission, never for an allowed call
* `guards`: does not reveal which permission was missing
* `appgaps2`: is closed to the wrong audience and to anonymous callers
* `appgaps2`: answers 404 for an unknown or not visible worker, and 401/403 for the wrong caller
* `availability.api`: is reserved for workers; the admin endpoints are reserved for admins with the right permission
* `booking.api`: tells apart "never allowed for you" (403) from "not now" (409) and "not yours" (404)
* `customers.api`: enforces permissions per capability and refuses non-admins
* `gap.closing`: tells a suspended user so (403 ACCOUNT_SUSPENDED) instead of a login loop
* `interview`: keeps other customers, other workers, and the wrong role out
* `interview`: staff search, act on behalf of both sides, and need the right permission

## Cross-account access (IDOR)

Status: PASS_VERIFIED (10 tests). First 10 shown.

* `appfeedback`: cannot be read or changed through another customer's address id
* `appgaps2`: does not show another customer the data, is customer-only and needs sign-in
* `booking.api`: tells apart "never allowed for you" (403) from "not now" (409) and "not yours" (404)
* `customers.api`: treats another customer's address id as not found for every operation (IDOR)
* `interview`: keeps other customers, other workers, and the wrong role out
* `ratings.api`: cannot rate someone else booking, an unknown booking, or act as another user type
* `remaining`: shows the whole chain oldest first from any link, hides workers from the customer and other customers see nothing
* `remaining`: versions addresses the same way and keeps other customers out
* `replacement.api`: cannot be done by someone else's customer, and staff can do it on the customer behalf
* `scheduling`: refuses an overlapping time, allows the hour after it ends, the same hour on another day, and another worker

## Suspended or inactive account

Status: PASS_VERIFIED (15 tests). First 12 shown.

* `guards`: rejects a suspended user even with a valid token and session, saying so (403 ACCOUNT_SUSPENDED)
* `guards`: tells a suspended user whose sessions were already revoked the same thing, not a login loop
* `auth.api`: answers a suspended account like any other number, and refuses it at verify
* `auth.api`: rejects a valid OTP for an account suspended after the OTP was issued
* `auth.api`: refuses to refresh for a suspended account and revokes the session
* `auth.api`: refuses a suspended admin only after the correct password (no status leak to guessers)
* `availability.api`: stops a suspended worker at once and changes nothing behind the rejected request
* `customers.api`: stops a suspended customer at once, across every customer endpoint
* `customers.api`: shows full detail: unmasked mobile, account status, and inactive addresses flagged
* `gap.closing`: tells a suspended user so (403 ACCOUNT_SUSPENDED) instead of a login loop
* `onboarding`: is closed to the wrong role and to a suspended customer; unauthenticated callers get 401
* `onboarding`: is closed to the wrong role and to a suspended worker; parallel saves both land

## Malformed / invalid / unsupported input

Status: PASS_VERIFIED (103 tests). First 12 shown.

* `password-hasher.service`: verifies the right password and rejects a wrong one
* `password-hasher.service`: never matches (and never throws on) malformed stored value %p
* `password-hasher.service`: rejects absurd cost parameters instead of exhausting memory
* `password-strength`: rejects a weak password (%s)
* `razorpay-payment.provider`: rejects a forged signature without calling the gateway
* `razorpay-payment.provider`: rejects a payment that the gateway says belongs to another order
* `razorpay-payment.provider`: never reports success for authorized-but-uncaptured or unknown statuses
* `razorpay-payment.provider`: returns an empty list when nobody attempted payment, and refuses a malformed answer
* `razorpay-payment.provider`: refuses every webhook when no webhook secret is configured (never an empty-key HMAC)
* `razorpay-payment.provider`: parses refund events, acknowledges unrelated ones and rejects malformed bodies
* `guards`: rejects a missing/malformed Authorization header: %j
* `guards`: rejects an invalid token

## Duplicate submission / replay / idempotency

Status: PASS_VERIFIED (49 tests). First 12 shown.

* `razorpay-payment.provider`: sends the idempotency header and maps pending/processed/failed
* `razorpay-payment.provider`: parses payment events and uses the event-id header for duplicate protection
* `guards`: tells a suspended user whose sessions were already revoked the same thing, not a login loop
* `guards`: AuthorizationService resolves once per request even when several guards ask
* `appfeedback`: does not list a review hidden by moderation, and lists it again once restored
* `attendance.api`: records today's status once, repeats safely, and cannot change a recorded day
* `attendance.api`: records one entry when the same day is submitted many times at once, and lets one of two conflicting statuses win
* `attendance.api`: raises an exception for a missed day, once, within the service period
* `auth.api`: answers 503 SMS_NOT_CONFIGURED for a non-retryable provider error and lets the user retry at once
* `auth.api`: treats replay of a rotated token as theft: revokes the session and audits the event
* `availability.api`: stops a suspended worker at once and changes nothing behind the rejected request
* `availability.api`: lists the availability items as missing, then submits once everything required is saved

## Concurrency / race

Status: PASS_VERIFIED (25 tests). First 12 shown.

* `auth.api`: cannot exceed the attempt limit with parallel guesses
* `auth.api`: lets exactly one of several parallel verifications of the same OTP succeed
* `auth.api`: lets only one of several parallel refreshes with the same token win
* `auth.api`: counts parallel failures atomically (cannot out-run the limit)
* `availability.api`: creates exactly one area when the same request is sent in parallel
* `availability.api`: stays consistent when different window sets are saved in parallel (exactly one wins, never overlapping)
* `availability.api`: stays consistent when different area sets are saved in parallel
* `availability.api`: submits exactly once when the request is repeated in parallel
* `booking.api`: creates exactly one booking when the same keyed request arrives in parallel
* `booking.api`: applies one of many parallel conflicting actions, never two
* `categories.api`: creates exactly one category when the same request is sent in parallel
* `categories.api`: serialises parallel edits of one category (the result is exactly one of the submitted values)

## Invalid state transition

Status: PASS_VERIFIED (24 tests). First 12 shown.

* `guards`: rejects when the session is revoked/expired/unknown
* `token.service`: rejects an expired token
* `appgaps2`: is closed to the wrong audience and to anonymous callers
* `auth.api`: rejects an expired or never-requested OTP
* `auth.api`: rejects an expired session (access and refresh)
* `booking.api`: does not let an active service be cancelled, and completes only from ACTIVE
* `gap.closing`: lets both sides talk; internal notes stay internal; closed or foreign tickets refuse
* `onboarding`: is closed to the wrong role and to a suspended customer; unauthenticated callers get 401
* `onboarding`: is closed to the wrong role and to a suspended worker; parallel saves both land
* `payments.recovery`: treats a late payment success for a cancelled booking as a financial exception, never as an ordinary payment
* `payments.recovery`: flags money already held when a confirmed booking is cancelled (exactly once, nothing refunded)
* `payments.recovery`: catches money held for a cancelled booking even if the cancellation hook never ran (backstop sweep)

## Stale If-Match / optimistic concurrency

Status: PASS_VERIFIED (2 tests). First 2 shown.

* `remaining`: guards staff edits of categories, areas and templates with If-Match as well
* `small.items`: applies an edit made on the current version, refuses a stale one with 412, and keeps working without the header

## Payment webhook (duplicate, reorder, signature)

Status: PASS_VERIFIED (16 tests). First 12 shown.

* `razorpay-payment.provider`: rejects a forged signature without calling the gateway
* `razorpay-payment.provider`: lists the refunds of a payment
* `razorpay-payment.provider`: verifies the signature over the raw body with the webhook secret (not the API secret)
* `razorpay-payment.provider`: refuses every webhook when no webhook secret is configured (never an empty-key HMAC)
* `razorpay-payment.provider`: parses refund events, acknowledges unrelated ones and rejects malformed bodies
* `auth.api`: rejects a tampered signature and a token for an unknown session
* `interview`: only completes a confirmed interview, needs an outcome, and refuses steps out of order
* `payments.recovery`: treats a late payment success for a cancelled booking as a financial exception, never as an ordinary payment
* `payments.recovery`: flags money already held when a confirmed booking is cancelled (exactly once, nothing refunded)
* `payments.recovery`: leaves a payment that is already being refunded alone
* `payments.recovery`: applies a webhook that raced ahead of its order once the order exists, and escalates one that never matches
* `payments.recovery`: never calls a pending refund complete; the sweeper completes it from the gateway answer

## Provider failure / rollback / retry

Status: PASS_VERIFIED (12 tests). First 12 shown.

* `razorpay-payment.provider`: classifies failures: 5xx, 429, timeouts and network errors retry; 4xx does not
* `appgaps2`: does not resolve to a disabled area, and requires sign-in
* `auth.api`: enforces the resend cooldown (429 OTP_RESEND_COOLDOWN with retry hint)
* `auth.api`: answers 503 SMS_NOT_CONFIGURED for a non-retryable provider error and lets the user retry at once
* `auth.api`: answers 503 SMS_DELIVERY_FAILED for a transient provider error
* `availability.api`: hides disabled areas from customers and workers but not from admins
* `availability.api`: rejects a disabled area the worker does not hold (422) but lets a held one stay
* `categories.api`: hides disabled categories from the public list and lookup
* `categories.api`: lists everything for admins with filters and pagination, and reads one including disabled
* `payments.recovery`: reports a provider outage to an admin who reconciles by hand, without consuming the automatic budget
* `search.api`: answers 422 for a disabled or unknown category and area, and shows disabled categories nowhere on a card
* `small.items`: forgets a failed request so the client can retry with the same key; no key means no memory

## Pagination / filters

Status: PASS_VERIFIED (4 tests). First 4 shown.

* `appfeedback`: pages: page 2 is empty but total stays 1; bad paging is a 400
* `categories.api`: answers 404 for unknown ids and 400 for malformed ids or paging
* `categories.api`: lists everything for admins with filters and pagination, and reads one including disabled
* `customers.api`: lists customers with pagination, filters and masked mobiles

## Documents: ownership, type, size, expiry

Status: PASS_VERIFIED (12 tests). First 12 shown.

* `razorpay-payment.provider`: accepts a correctly signed payment that the gateway confirms for the same order
* `token.service`: rejects a token signed with a different secret
* `token.service`: rejects an unsigned (alg=none) token
* `token.service`: rejects a validly-signed token with a different audience or missing claims
* `categories.api`: holds the categories defined by the project documents, stored in PostgreSQL
* `onboarding`: shows a rejected document as an action for the worker and accepts a resubmission
* `search.api`: bounds the page size and rejects malformed input
* `security.api`: gives every other route a user-type restriction, except the reviewed "any signed-in user" list
* `security.api`: rejects an oversized body before it reaches any handler
* `small.items`: is off by default: the readiness report says documents are not scanned, and uploads still work
* `small.items`: rejects and deletes an infected file, and leaves the document unconfirmed
* `small.items`: never accepts a file it could not scan: 503, the document stays unconfirmed and can be confirmed later

Total category matches: 310 (a test can match several categories).