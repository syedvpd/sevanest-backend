# Worker app: negative-path results

Evidence: automated integration tests run against a disposable local PostgreSQL/Redis with fake providers. Titles are the exact `it(...)` names from the spec files; all passed in the full run of 2026-10-13 (47 suites, 818 tests). They assert HTTP status, error code and database effect as written in each test. Tests are grouped by keyword in their titles, so a group is an index into the evidence, not a count of distinct requirements; the per-requirement mapping is in the screen traceability documents. Real-provider, deployed-environment and Flutter-screen behaviour is **NOT_VERIFIED**.

## Unauthenticated request

Status: PASS_VERIFIED (12 tests). First 12 shown.

* `fcm.provider`: retries on outages, refreshes the token once after a 401, and refuses a message FCM did not name
* `guards`: keeps answering 401 for a session that merely ended while the account is active
* `auth.api`: rejects %s with 401 UNAUTHENTICATED
* `onboarding`: is closed to the wrong role and to a suspended customer; unauthenticated callers get 401
* `remaining`: staff read them with an audit record; customers and anonymous callers cannot
* `security.api`: answers 401 to an anonymous caller on every protected route
* `security.api`: answers 401 to a forged or malformed token
* `security.api`: records a role refusal and nothing for allowed calls or anonymous calls
* `support.api`: is refused for admins and anonymous callers
* `verification.api`: answers 404 before a worker profile exists, and 401/403 for anonymous, customer and admin callers
* `verification.api`: keeps customers, workers and anonymous callers out of every admin verification endpoint
* `workers.api`: is reserved for workers: customers, admins and anonymous callers are refused on every operation

## Wrong role / insufficient permission

Status: PASS_VERIFIED (22 tests). First 12 shown.

* `guards`: rejects a suspended user even with a valid token and session, saying so (403 ACCOUNT_SUSPENDED)
* `guards`: PermissionsGuard: requires ALL listed permissions
* `guards`: records an access-denied event for a refused role or permission, never for an allowed call
* `guards`: does not reveal which permission was missing
* `availability.api`: is reserved for workers; the admin endpoints are reserved for admins with the right permission
* `booking.api`: tells apart "never allowed for you" (403) from "not now" (409) and "not yours" (404)
* `interview`: keeps other customers, other workers, and the wrong role out
* `interview`: staff search, act on behalf of both sides, and need the right permission
* `onboarding`: is closed to the wrong role and to a suspended customer; unauthenticated callers get 401
* `onboarding`: is closed to the wrong role and to a suspended worker; parallel saves both land
* `replacement.api`: keeps view, manage and candidate permissions separate and keeps others out
* `scheduling`: validates the list, needs the permission and audits the change

## Cross-account access (IDOR)

Status: PASS_VERIFIED (8 tests). First 8 shown.

* `booking.api`: tells apart "never allowed for you" (403) from "not now" (409) and "not yours" (404)
* `interview`: keeps other customers, other workers, and the wrong role out
* `ratings.api`: cannot rate someone else booking, an unknown booking, or act as another user type
* `remaining`: shows the whole chain oldest first from any link, hides workers from the customer and other customers see nothing
* `remaining`: versions addresses the same way and keeps other customers out
* `replacement.api`: cannot be done by someone else's customer, and staff can do it on the customer behalf
* `scheduling`: refuses an overlapping time, allows the hour after it ends, the same hour on another day, and another worker
* `verification.api`: hides another worker's document: confirm answers 404 exactly like an unknown id

## Suspended or inactive account

Status: PASS_VERIFIED (12 tests). First 12 shown.

* `guards`: rejects a suspended user even with a valid token and session, saying so (403 ACCOUNT_SUSPENDED)
* `guards`: tells a suspended user whose sessions were already revoked the same thing, not a login loop
* `auth.api`: answers a suspended account like any other number, and refuses it at verify
* `auth.api`: rejects a valid OTP for an account suspended after the OTP was issued
* `auth.api`: refuses to refresh for a suspended account and revokes the session
* `auth.api`: refuses a suspended admin only after the correct password (no status leak to guessers)
* `availability.api`: stops a suspended worker at once and changes nothing behind the rejected request
* `onboarding`: is closed to the wrong role and to a suspended customer; unauthenticated callers get 401
* `onboarding`: is closed to the wrong role and to a suspended worker; parallel saves both land
* `security.api`: answers 403 to a suspended admin who still holds an older token
* `verification.api`: stops a suspended worker at once
* `workers.api`: stops a suspended worker at once and changes nothing behind the rejected requests

## Malformed / invalid / unsupported input

Status: PASS_VERIFIED (87 tests). First 12 shown.

* `password-hasher.service`: verifies the right password and rejects a wrong one
* `password-hasher.service`: never matches (and never throws on) malformed stored value %p
* `password-hasher.service`: rejects absurd cost parameters instead of exhausting memory
* `password-strength`: rejects a weak password (%s)
* `fcm.provider`: treats an unknown device token as a permanent rejection and never leaks the key or token
* `fcm.provider`: retries on outages, refreshes the token once after a 401, and refuses a message FCM did not name
* `sms-providers`: refuses free text: only DLT-registered templates may be sent
* `guards`: rejects a missing/malformed Authorization header: %j
* `guards`: rejects an invalid token
* `guards`: rejects when the session is revoked/expired/unknown
* `guards`: rejects a suspended user even with a valid token and session, saying so (403 ACCOUNT_SUSPENDED)
* `guards`: rejects when the session belongs to a different user than the token subject

## Duplicate submission / replay / idempotency

Status: PASS_VERIFIED (35 tests). First 12 shown.

* `fcm.provider`: retries on outages, refreshes the token once after a 401, and refuses a message FCM did not name
* `guards`: tells a suspended user whose sessions were already revoked the same thing, not a login loop
* `guards`: AuthorizationService resolves once per request even when several guards ask
* `attendance.api`: records today's status once, repeats safely, and cannot change a recorded day
* `attendance.api`: records one entry when the same day is submitted many times at once, and lets one of two conflicting statuses win
* `attendance.api`: raises an exception for a missed day, once, within the service period
* `auth.api`: answers 503 SMS_NOT_CONFIGURED for a non-retryable provider error and lets the user retry at once
* `auth.api`: treats replay of a rotated token as theft: revokes the session and audits the event
* `availability.api`: stops a suspended worker at once and changes nothing behind the rejected request
* `availability.api`: lists the availability items as missing, then submits once everything required is saved
* `availability.api`: submits exactly once when the request is repeated in parallel
* `booking.api`: answers the same request with the same key once, and refuses the key for a different request

## Concurrency / race

Status: PASS_VERIFIED (24 tests). First 12 shown.

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
* `kyc.integrity`: are discarded after the grace period, never confirmed documents
* `notifications.api`: sends once even when delivery is attempted in parallel and dispatch runs concurrently

## Invalid state transition

Status: PASS_VERIFIED (19 tests). First 12 shown.

* `guards`: rejects when the session is revoked/expired/unknown
* `token.service`: rejects an expired token
* `auth.api`: rejects an expired or never-requested OTP
* `auth.api`: rejects an expired session (access and refresh)
* `booking.api`: does not let an active service be cancelled, and completes only from ACTIVE
* `notifications.api`: hands a stale queued notification back to the queue without creating a second job
* `onboarding`: is closed to the wrong role and to a suspended customer; unauthenticated callers get 401
* `onboarding`: is closed to the wrong role and to a suspended worker; parallel saves both land
* `ratings.api`: is not allowed before the engagement is completed
* `remaining`: refuses a profile edit made on a stale copy (second device) and applies the current one
* `replacement.api`: closes the open request when the booking itself is cancelled
* `scheduling.buffer`: is released when the booking is cancelled, and a payment racing a cancellation leaves one consistent outcome

## Stale If-Match / optimistic concurrency

Status: PASS_VERIFIED (1 tests). First 1 shown.

* `remaining`: guards staff edits of categories, areas and templates with If-Match as well

## Payment webhook (duplicate, reorder, signature)

Status: PASS_VERIFIED (2 tests). First 2 shown.

* `auth.api`: rejects a tampered signature and a token for an unknown session
* `interview`: only completes a confirmed interview, needs an outcome, and refuses steps out of order

## Provider failure / rollback / retry

Status: PASS_VERIFIED (12 tests). First 12 shown.

* `sms-providers`: classifies provider errors and never puts the OTP, number or token in the message
* `sms-providers`: retries on provider outages but not on rejections
* `auth.api`: enforces the resend cooldown (429 OTP_RESEND_COOLDOWN with retry hint)
* `auth.api`: answers 503 SMS_NOT_CONFIGURED for a non-retryable provider error and lets the user retry at once
* `auth.api`: answers 503 SMS_DELIVERY_FAILED for a transient provider error
* `availability.api`: hides disabled areas from customers and workers but not from admins
* `availability.api`: rejects a disabled area the worker does not hold (422) but lets a held one stay
* `notifications.api`: retries a provider outage with the queue, fails after the last attempt, and hides the provider message
* `notifications.api`: fails at once on a permanent provider rejection, and recovers by retry after a transient one
* `remediation.notifications`: refuses to retry a SENT or QUEUED notification (nothing is sent twice)
* `workers.api`: rejects an unknown category (400) and a disabled category the worker does not hold (422)
* `workers.api`: lets a worker keep a category that was disabled after they chose it

## Pagination / filters

Status: PASS_VERIFIED (1 tests). First 1 shown.

* `workers.api`: lists workers with pagination, masked mobiles, categories, and filters

## Documents: ownership, type, size, expiry

Status: PASS_VERIFIED (26 tests). First 12 shown.

* `fcm.provider`: exchanges a signed JWT for an access token, caches it, and posts the message
* `token.service`: rejects a token signed with a different secret
* `token.service`: rejects an unsigned (alg=none) token
* `token.service`: rejects a validly-signed token with a different audience or missing claims
* `kyc.integrity`: refuses an empty object and an object that is not there, without touching other uploads
* `kyc.integrity`: refuses an oversized object even when the client declared a small size, and removes it
* `kyc.integrity`: a rejected slot cannot be revived: only a fresh upload slot works
* `kyc.integrity`: leaves the document unconfirmed when storage is unavailable during confirmation
* `kyc.integrity`: still refuses the upload when discarding it fails, and the sweeper discards it later
* `kyc.integrity`: are discarded after the grace period, never confirmed documents
* `kyc.integrity`: refuses to show a document whose stored bytes changed after confirmation, and audits it
* `kyc.integrity`: still serves documents confirmed before hashes existed, and says in the audit that no hash was checked

Total category matches: 261 (a test can match several categories).