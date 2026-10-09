# Auth

Mobile OTP login for customers and workers, credential login for admins, token sessions with rotating refresh tokens,
logout and revocation, and the global authentication/authorization guards.

## Requirements covered

| ID                              | Requirement                                                                 | Where                                                                  |
| ------------------------------- | --------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| FR-AUTH-001/002, FR-CUS-001/002 | Customers and workers authenticate with mobile OTP                          | `POST /auth/otp/request`, `POST /auth/otp/verify`                      |
| FR-AUTH-003                     | Token-based sessions after OTP verification                                 | access JWT + opaque refresh token, `sessions` table                    |
| FR-AUTH-004                     | Rate limiting and abuse protection on OTP and API endpoints                 | `OtpService` (per mobile, per IP, cooldown, lockout), global throttler |
| FR-AUTH-005                     | Role-based login for the four admin roles                                   | `POST /auth/admin/login`                                               |
| FR-AUTH-006, NFR-SEC-006        | Admin passwords stored securely                                             | `PasswordHasher` (scrypt, salted)                                      |
| FRD FM-01                       | Wrong/expired OTP, attempt and resend limits, suspended users cannot log in | see Business rules                                                     |
| NFR-SEC-008                     | Rate limiting / brute-force protection                                      | OTP limits, admin login lockout                                        |

## Domain model

- **User** (owned by Users): the account. Auth only reads it and asks Users to create it.
- **Session** (`sessions`): one row per device session. `refreshTokenHash` is the SHA-256 of the current opaque refresh
  token; `previousRefreshTokenHash` is the token it replaced (replay detection); `deviceId`/`deviceName` identify the
  install; `expiresAt` is absolute (set at login, not extended by refresh); `revokedAt` marks logout/revocation.
- **DeviceToken** (`device_tokens`): the FCM push token bound to exactly one session; removed when the session is revoked.
- **OTP state** lives only in Redis (non-authoritative): a keyed hash of the OTP with a TTL, an attempt counter, a
  resend cooldown, send windows per mobile and per IP, and a lock key. Losing Redis loses pending OTPs, nothing else.

The access token is an HS256 JWT with only `sub` (user id) and `sid` (session id). Roles and permissions are read from
the database on every request, so a role change applies immediately and a revoked session stops working immediately.

## APIs (all under `/api/v1`)

| Method | Path                         | Auth            | Purpose                                                                                               |
| ------ | ---------------------------- | --------------- | ----------------------------------------------------------------------------------------------------- |
| POST   | `/auth/otp/request`          | public          | Send an OTP to `{ mobile, appType: CUSTOMER\|WORKER }`                                                |
| POST   | `/auth/otp/verify`           | public          | Verify `{ mobile, appType, otp, deviceId?, deviceName? }`; creates the account if new; returns tokens |
| POST   | `/auth/admin/login`          | public          | `{ email, password, deviceId?, deviceName? }`                                                         |
| POST   | `/auth/token/refresh`        | public          | `{ refreshToken }`; rotates the token pair                                                            |
| POST   | `/auth/logout`               | bearer          | Revoke the current session and its push token (204)                                                   |
| GET    | `/auth/sessions`             | bearer          | My active sessions (one per device), current one flagged                                              |
| DELETE | `/auth/sessions/{sessionId}` | bearer          | Revoke one of my own sessions (204; anyone else's is 404)                                             |
| PUT    | `/auth/device-token`         | customer/worker | Bind `{ token, platform: ANDROID\|IOS }` to the current session (204)                                 |

Success body for verify/login/refresh: `{ accessToken, refreshToken, tokenType: "Bearer", expiresIn, user: { id, type, isNewUser, roles? } }`.
`user.isNewUser = true` means this verification created the account; the app then continues to profile creation.

## Validation

Mobile numbers are Indian mobiles (10 digits starting 6-9; `+91`, `91` or `0` prefix accepted) and are normalised to
E.164 before reaching any service. The OTP is digits only; its length is server configuration. `deviceId` is
`[A-Za-z0-9._:-]{8,128}`; `deviceName` is at most 100 characters; passwords are at most 256 characters. These caps are
technical bounds, not product rules. Unknown request fields are stripped.

## Business rules

- The app that asks decides the account type (`appType`). A mobile number belongs to one account of one type; asking
  for it from the other app answers `409 ACCOUNT_TYPE_MISMATCH` (open product decision, see below).
- A suspended account is refused at OTP request (before anything is sent), at OTP verify, at refresh (the session is
  revoked) and on every authenticated request.
- Requesting an OTP: lock check, per-IP window, existence/status check, resend cooldown, per-mobile window, then
  generate, store (hashed) and send. If sending fails the stored OTP and the cooldown are removed so the user can retry
  at once (`503 SMS_DELIVERY_FAILED`, or `503 SMS_NOT_CONFIGURED` while no SMS vendor is configured).
- Verifying: the attempt is counted and compared in one atomic Redis script, the OTP is single use, and reaching the
  attempt limit deletes it and locks the number for the configured time (`429 OTP_ATTEMPTS_EXCEEDED`, then `OTP_LOCKED`).
- A new login on the same `deviceId` revokes that device's previous session.
- Refresh tokens are single use and rotate. Presenting an already-rotated token is treated as possible theft: the whole
  session is revoked and `auth.refresh_token_reuse` is audited. There is no grace period, so two truly simultaneous
  refreshes with the same token leave the session revoked (the user signs in again).
- Admin login: after `ADMIN_LOGIN_MAX_FAILURES` failures inside the window the account and the client IP are locked
  (`429 ADMIN_LOGIN_LOCKED`). Wrong password and unknown email give the same answer, and both perform one password-hash verification (response time was not measured). A suspended
  admin learns the status only after supplying the correct password.
- A revoked session's access token is rejected at once, so a second logout with the same token answers 401.

## Error codes

`OTP_INVALID`, `OTP_EXPIRED`, `OTP_ATTEMPTS_EXCEEDED`, `OTP_LOCKED`, `OTP_RESEND_COOLDOWN`, `OTP_SEND_LIMIT`,
`OTP_RATE_LIMITED`, `SMS_DELIVERY_FAILED`, `SMS_NOT_CONFIGURED`, `ACCOUNT_SUSPENDED`, `ACCOUNT_TYPE_MISMATCH`,
`INVALID_CREDENTIALS`, `ADMIN_LOGIN_LOCKED`, `REFRESH_TOKEN_INVALID`, `SESSION_NOT_FOUND`, plus the shared
`VALIDATION_FAILED`, `UNAUTHENTICATED`, `FORBIDDEN`, `RATE_LIMITED`. 429 responses carry `details[0] = { field: "retryAfterSeconds", messages: ["<n>"] }`.

## Transactions and concurrency

- Session creation (revoke the device's previous session + insert) is one transaction; the partial unique index
  `sessions_active_device_key` makes a parallel login on the same device lose cleanly and retry.
- Refresh rotation is one `UPDATE ... WHERE refresh_token_hash = old AND revoked_at IS NULL AND expires_at > now() RETURNING`,
  so concurrent refreshes cannot both win.
- OTP attempt counting, window counters and the admin failure counters are atomic Redis scripts/commands, so parallel
  guesses cannot exceed the limits.
- First-time account creation races on the unique mobile; the loser re-reads the winner's row.

## Security

- OTPs are stored only as an HMAC (keyed with `OTP_HMAC_SECRET`), expire by TTL, are never logged and never returned.
- Redis keys contain a hash of the mobile, not the number.
- Refresh tokens are 384-bit random values stored only as SHA-256 hashes. Passwords use scrypt (N=2^17, r=8, p=1, salted,
  parameters stored per hash).
- Tokens, OTPs and passwords never appear in logs, audit metadata, error bodies or OpenAPI examples.
- Guard order is fixed by `AppModule`: throttler, authentication (token + active session + ACTIVE user), roles, permissions.
  `@RequireUserType(...)` adds a per-controller user-type check.

## Audit

`user.register` (by Users), `auth.login` (method otp/password), `auth.admin_login_failed` (known admin accounts; marks the
failure that caused a lockout), `auth.logout`, `auth.session_revoke`, `auth.refresh_token_reuse`. Metadata holds labels and
ids only.

## Configuration (all required, no defaults; see `.env.example`)

`OTP_HMAC_SECRET`, `SMS_PROVIDER` (`memory` for tests/local only, refused in production; `disabled`), `OTP_LENGTH`,
`OTP_TTL_SECONDS`, `OTP_MAX_VERIFY_ATTEMPTS`, `OTP_RESEND_COOLDOWN_SECONDS`, `OTP_SEND_WINDOW_SECONDS`,
`OTP_MAX_SENDS_PER_MOBILE_PER_WINDOW`, `OTP_MAX_REQUESTS_PER_IP_PER_WINDOW`, `OTP_LOCKOUT_SECONDS`,
`ADMIN_LOGIN_MAX_FAILURES`, `ADMIN_LOGIN_FAILURE_WINDOW_SECONDS`, `ADMIN_LOGIN_LOCKOUT_SECONDS`, `ADMIN_PASSWORD_MIN_LENGTH`
(plus the existing `JWT_ACCESS_*`, `REFRESH_TOKEN_TTL_SECONDS`). The values in `.env.example` and the test/CI
configuration are development placeholders, not approved business values.

## Known limitations and open decisions

- **No SMS vendor is selected.** Only the provider interface, a `disabled` adapter and the in-memory test adapter exist, so
  real OTP delivery is not possible yet.
- **OTP length, expiry, attempt/resend/send limits, lockout durations and the admin password policy are undefined by the
  specification.** They are configuration and must be set explicitly for production.
- **One mobile = one account.** Whether the same number may hold a customer and a worker account is an open product decision.
- No MFA, password change/reset, or admin self-service flow is specified, so none exists. How the first production Super
  Admin is provisioned is an open operational decision (the seed bootstrap is refused in production).
- Refresh-token lifetime is absolute (no sliding window); the value is configuration.
- A suspended account's existence is visible at OTP request (clear message per FRD FM-01), which allows probing whether a
  number is registered and suspended.
- Admin lockout also locks the client IP, so a shared network can be affected by one attacker.
