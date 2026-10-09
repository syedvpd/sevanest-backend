# Auth - test results

**Result: PASS** - 127/127 tests passed, 0 failed (4 suites). Run date: 2026-10-08.

Environment: Node 24.21, PostgreSQL 17 and Redis 7 (Docker), dedicated test database `sevanest_test` (real database and Redis for integration tests), in-memory SMS and storage adapters. OTP/lockout limits in the tests are test values, not approved business values.

## Suites

| Kind | File | Passed | Failed |
|---|---|---|---|
| unit | `env.validation.spec.ts` | 36 | 0 |
| unit | `indian-mobile.spec.ts` | 22 | 0 |
| unit | `password-hasher.service.spec.ts` | 10 | 0 |
| integration | `auth.api.int-spec.ts` | 59 | 0 |

## Mutation checks (tests proven to catch regressions)

- Changing the OTP attempt comparison from `>=` to `>` was caught by 2 tests (attempt limit, parallel guesses); the code was restored.

## Manual verification (real running server)

- Real built server (`dist/main`) against the dev database: health ready, OTP request answers 503 `SMS_NOT_CONFIGURED` with the disabled SMS adapter, validation and 401 envelopes, OpenAPI lists the Auth/Users/Customers paths.
- Real HTTP socket with the in-memory SMS adapter against the test database: OTP request/cooldown/wrong OTP/verify/single use, refresh rotation and replay (session revoked), admin wrong-password and login, logout. The server log (136 lines) was scanned for the admin password, mobile numbers, OTPs and 8 tokens used: none present. Audit log scanned for emails, mobiles, token-like strings and secret-named keys: none.

## Results by group

| Group | Passed | Failed |
|---|---|---|
| env.validation › validateEnvironment | 21 | 0 |
| env.validation › production safeguards for the open auth settings | 15 | 0 |
| indian-mobile › normalizeIndianMobile | 13 | 0 |
| indian-mobile › IsIndianMobile | 7 | 0 |
| indian-mobile › maskMobile | 2 | 0 |
| password-hasher.service › PasswordHasher | 10 | 0 |
| auth.api › POST /auth/otp/request | 14 | 0 |
| auth.api › SMS provider failure | 2 | 0 |
| auth.api › POST /auth/otp/verify | 12 | 0 |
| auth.api › sessions and access tokens | 11 | 0 |
| auth.api › POST /auth/token/refresh | 5 | 0 |
| auth.api › POST /auth/logout and device tokens | 4 | 0 |
| auth.api › admin credential login | 10 | 0 |
| auth.api › audit trail and data exposure | 1 | 0 |

## Every test and its result

### `env.validation.spec.ts`

- PASS - validateEnvironment › accepts a complete environment and coerces numbers
- PASS - validateEnvironment › applies engineering defaults only where documented
- PASS - validateEnvironment › rejects a missing JWT_ACCESS_TTL_SECONDS instead of defaulting it
- PASS - validateEnvironment › rejects a missing REFRESH_TOKEN_TTL_SECONDS instead of defaulting it
- PASS - validateEnvironment › rejects a missing THROTTLE_LIMIT instead of defaulting it
- PASS - validateEnvironment › rejects a missing OTP_LENGTH instead of defaulting it
- PASS - validateEnvironment › rejects a missing OTP_TTL_SECONDS instead of defaulting it
- PASS - validateEnvironment › rejects a missing OTP_HMAC_SECRET instead of defaulting it
- PASS - validateEnvironment › rejects a missing SMS_PROVIDER instead of defaulting it
- PASS - validateEnvironment › rejects a missing STORAGE_PROVIDER instead of defaulting it
- PASS - validateEnvironment › rejects a missing VERIFICATION_DOCUMENT_MAX_BYTES instead of defaulting it
- PASS - validateEnvironment › rejects a missing VERIFICATION_DOCUMENT_CONTENT_TYPES instead of defaulting it
- PASS - validateEnvironment › rejects a missing SIGNED_URL_TTL_SECONDS instead of defaulting it
- PASS - validateEnvironment › rejects a missing ADMIN_LOGIN_MAX_FAILURES instead of defaulting it
- PASS - validateEnvironment › rejects a missing ADMIN_PASSWORD_MIN_LENGTH instead of defaulting it
- PASS - validateEnvironment › rejects a missing DATABASE_URL instead of defaulting it
- PASS - validateEnvironment › rejects a missing REDIS_URL instead of defaulting it
- PASS - production safeguards for the open auth settings › accepts an explicit, non-placeholder production configuration
- PASS - production safeguards for the open auth settings › refuses the in-memory SMS adapter in production
- PASS - production safeguards for the open auth settings › refuses the in-memory storage adapter in production
- PASS - production safeguards for the open auth settings › accepts only known document content types
- PASS - production safeguards for the open auth settings › refuses a placeholder OTP HMAC secret in production
- PASS - production safeguards for the open auth settings › requires OTP_MAX_VERIFY_ATTEMPTS explicitly (nothing is silently defaulted)
- PASS - production safeguards for the open auth settings › requires OTP_RESEND_COOLDOWN_SECONDS explicitly (nothing is silently defaulted)
- PASS - production safeguards for the open auth settings › requires OTP_SEND_WINDOW_SECONDS explicitly (nothing is silently defaulted)
- PASS - production safeguards for the open auth settings › requires OTP_MAX_SENDS_PER_MOBILE_PER_WINDOW explicitly (nothing is silently defaulted)
- PASS - production safeguards for the open auth settings › requires OTP_MAX_REQUESTS_PER_IP_PER_WINDOW explicitly (nothing is silently defaulted)
- PASS - production safeguards for the open auth settings › requires OTP_LOCKOUT_SECONDS explicitly (nothing is silently defaulted)
- PASS - production safeguards for the open auth settings › requires ADMIN_LOGIN_FAILURE_WINDOW_SECONDS explicitly (nothing is silently defaulted)
- PASS - production safeguards for the open auth settings › requires ADMIN_LOGIN_LOCKOUT_SECONDS explicitly (nothing is silently defaulted)
- PASS - production safeguards for the open auth settings › rejects an unknown SMS provider and an out-of-range OTP length
- PASS - production safeguards for the open auth settings › treats the language allow-list as optional and validates it when set
- PASS - validateEnvironment › rejects a short JWT secret
- PASS - validateEnvironment › rejects non-postgres database URLs
- PASS - validateEnvironment › refuses a placeholder JWT secret in production
- PASS - validateEnvironment › parses SWAGGER_ENABLED from strings

### `indian-mobile.spec.ts`

- PASS - normalizeIndianMobile › normalises 9876543210 to +919876543210
- PASS - normalizeIndianMobile › normalises +919876543210 to +919876543210
- PASS - normalizeIndianMobile › normalises 919876543210 to +919876543210
- PASS - normalizeIndianMobile › normalises 09876543210 to +919876543210
- PASS - normalizeIndianMobile › normalises   6000000000  to +916000000000
- PASS - normalizeIndianMobile › rejects 5876543210
- PASS - normalizeIndianMobile › rejects 987654321
- PASS - normalizeIndianMobile › rejects 98765432101
- PASS - normalizeIndianMobile › rejects +449876543210
- PASS - normalizeIndianMobile › rejects 98765 43210
- PASS - normalizeIndianMobile › rejects 98765-43210
- PASS - normalizeIndianMobile › rejects 
- PASS - normalizeIndianMobile › rejects abcdefghij
- PASS - IsIndianMobile › normalises first, then validates, so services only see E.164
- PASS - IsIndianMobile › rejects non-mobile input 123
- PASS - IsIndianMobile › rejects non-mobile input null
- PASS - IsIndianMobile › rejects non-mobile input undefined
- PASS - IsIndianMobile › rejects non-mobile input {}
- PASS - IsIndianMobile › rejects non-mobile input ["9876543210"]
- PASS - IsIndianMobile › rejects non-mobile input "nope"
- PASS - maskMobile › keeps the country code and last four digits
- PASS - maskMobile › passes null through

### `password-hasher.service.spec.ts`

- PASS - PasswordHasher › verifies the right password and rejects a wrong one
- PASS - PasswordHasher › is salted: the same password never produces the same hash
- PASS - PasswordHasher › stores parameters in a self-describing format and never the password
- PASS - PasswordHasher › never matches (and never throws on) malformed stored value ""
- PASS - PasswordHasher › never matches (and never throws on) malformed stored value "plaintext"
- PASS - PasswordHasher › never matches (and never throws on) malformed stored value "scrypt$1$2$3$a$b"
- PASS - PasswordHasher › never matches (and never throws on) malformed stored value "scrypt$x$8$1$AAAA$BBBB"
- PASS - PasswordHasher › never matches (and never throws on) malformed stored value "bcrypt$abc"
- PASS - PasswordHasher › rejects absurd cost parameters instead of exhausting memory
- PASS - PasswordHasher › provides one reusable dummy hash for constant-time failure paths

### `auth.api.int-spec.ts`

- PASS - POST /auth/otp/request › sends an OTP, reports expiry/resend timing and never returns the OTP
- PASS - POST /auth/otp/request › stores only a keyed hash with a TTL in Redis (no raw OTP)
- PASS - POST /auth/otp/request › rejects letters with VALIDATION_FAILED
- PASS - POST /auth/otp/request › rejects too short with VALIDATION_FAILED
- PASS - POST /auth/otp/request › rejects non-Indian prefix with VALIDATION_FAILED
- PASS - POST /auth/otp/request › rejects missing mobile with VALIDATION_FAILED
- PASS - POST /auth/otp/request › rejects bad app type with VALIDATION_FAILED
- PASS - POST /auth/otp/request › rejects missing app type with VALIDATION_FAILED
- PASS - POST /auth/otp/request › treats +91 / 91 / 0 / bare 10-digit forms of the same number as one account
- PASS - POST /auth/otp/request › enforces the resend cooldown (429 OTP_RESEND_COOLDOWN with retry hint)
- PASS - POST /auth/otp/request › enforces the per-mobile send limit per window
- PASS - POST /auth/otp/request › enforces the per-IP request limit across different numbers
- PASS - POST /auth/otp/request › refuses suspended accounts BEFORE sending anything
- PASS - POST /auth/otp/request › refuses a number registered under the other account type (one mobile = one account)
- PASS - SMS provider failure › answers 503 SMS_NOT_CONFIGURED for a non-retryable provider error and lets the user retry at once
- PASS - SMS provider failure › answers 503 SMS_DELIVERY_FAILED for a transient provider error
- PASS - POST /auth/otp/verify › creates the account on first verification and starts a session
- PASS - POST /auth/otp/verify › returns the standard token body without secrets and with a bounded access token
- PASS - POST /auth/otp/verify › logs an existing user in again with isNewUser=false
- PASS - POST /auth/otp/verify › registers a worker when the Worker app signs in
- PASS - POST /auth/otp/verify › treats the OTP as single use
- PASS - POST /auth/otp/verify › rejects a wrong OTP, reports remaining attempts, and still accepts the right one afterwards
- PASS - POST /auth/otp/verify › rejects an expired or never-requested OTP
- PASS - POST /auth/otp/verify › locks the number after the attempt limit, even for the correct OTP and for new requests
- PASS - POST /auth/otp/verify › cannot exceed the attempt limit with parallel guesses
- PASS - POST /auth/otp/verify › lets exactly one of several parallel verifications of the same OTP succeed
- PASS - POST /auth/otp/verify › rejects a valid OTP for an account suspended after the OTP was issued
- PASS - POST /auth/otp/verify › validates the OTP shape and device fields
- PASS - sessions and access tokens › accepts a valid access token and exposes the caller identity
- PASS - sessions and access tokens › rejects no header with 401 UNAUTHENTICATED
- PASS - sessions and access tokens › rejects not a bearer scheme with 401 UNAUTHENTICATED
- PASS - sessions and access tokens › rejects garbage token with 401 UNAUTHENTICATED
- PASS - sessions and access tokens › rejects a tampered signature and a token for an unknown session
- PASS - sessions and access tokens › rejects an expired session (access and refresh)
- PASS - sessions and access tokens › lists my sessions, flags the current one and keeps one active session per device
- PASS - sessions and access tokens › lets a user revoke another of their own sessions, and revoked sessions stop working
- PASS - sessions and access tokens › does not let a user revoke (or learn about) another user's session
- PASS - sessions and access tokens › validates the session id format
- PASS - sessions and access tokens › requires authentication for session endpoints
- PASS - POST /auth/token/refresh › rotates the refresh token: the new pair works, the old token does not
- PASS - POST /auth/token/refresh › treats replay of a rotated token as theft: revokes the session and audits the event
- PASS - POST /auth/token/refresh › lets only one of several parallel refreshes with the same token win
- PASS - POST /auth/token/refresh › rejects unknown, malformed and missing tokens without detail
- PASS - POST /auth/token/refresh › refuses to refresh for a suspended account and revokes the session
- PASS - POST /auth/logout and device tokens › revokes the session: access and refresh tokens stop working
- PASS - POST /auth/logout and device tokens › binds a push token to the session and removes it on logout
- PASS - POST /auth/logout and device tokens › moves a push token to the newest session that registers it (reinstall / shared device)
- PASS - POST /auth/logout and device tokens › validates the device token body and refuses admins
- PASS - admin credential login › logs in with email and password and returns roles, never the password or its hash
- PASS - admin credential login › normalises the email (case/whitespace)
- PASS - admin credential login › answers identically for a wrong password and for an unknown email
- PASS - admin credential login › does not let customers or workers (no password) authenticate through the admin endpoint
- PASS - admin credential login › validates the payload
- PASS - admin credential login › locks the account after repeated failures, even for the right password, then recovers
- PASS - admin credential login › locks an IP that keeps failing across different accounts
- PASS - admin credential login › counts parallel failures atomically (cannot out-run the limit)
- PASS - admin credential login › refuses a suspended admin only after the correct password (no status leak to guessers)
- PASS - admin credential login › logs out and refreshes like any other session
- PASS - audit trail and data exposure › records registration, login, failed admin login and lockout without secrets

## Not covered

- Real SMS delivery (no vendor selected).
- Redis-outage behaviour of OTP/login; load and performance; response-time equality of admin login failure paths.
