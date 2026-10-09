# Cross-module (journeys, boundaries, contract, foundation) - test results

**Result: PASS** - 104/104 tests passed, 0 failed (12 suites). Run date: 2026-10-08.

Environment: Node 24.21, PostgreSQL 17 and Redis 7 (Docker), dedicated test database `sevanest_test` (real database and Redis for integration tests), in-memory SMS and storage adapters. OTP/lockout limits in the tests are test values, not approved business values.

## Suites

| Kind | File | Passed | Failed |
|---|---|---|---|
| unit | `validation.pipe.spec.ts` | 2 | 0 |
| unit | `audit.service.spec.ts` | 5 | 0 |
| unit | `token.service.spec.ts` | 7 | 0 |
| unit | `guards.spec.ts` | 17 | 0 |
| unit | `request-context.spec.ts` | 9 | 0 |
| unit | `all-exceptions.filter.spec.ts` | 8 | 0 |
| unit | `redis-connection.spec.ts` | 2 | 0 |
| e2e | `throttling.e2e-spec.ts` | 1 | 0 |
| e2e | `foundation.e2e-spec.ts` | 26 | 0 |
| integration | `modules.workforce.int-spec.ts` | 9 | 0 |
| integration | `modules.journey.int-spec.ts` | 7 | 0 |
| integration | `foundation.int-spec.ts` | 11 | 0 |

## Other verification

- The exact CI command sequence (prisma validate, migrate deploy on an empty database, lint, format:check, typecheck, build, unit, e2e, integration) was run locally with only the CI environment block and no `.env` after Modules 1-3: all steps passed. It was NOT repeated after Modules 4-6; the CI environment block is unchanged by them. The GitHub workflow itself has never run on GitHub.
- Docker image/compose were not rebuilt after Modules 1-6.

## Results by group

| Group | Passed | Failed |
|---|---|---|
| validation.pipe › createValidationPipe | 2 | 0 |
| audit.service › redactSensitive | 3 | 0 |
| audit.service › AuditService | 2 | 0 |
| token.service › TokenService | 7 | 0 |
| guards › JwtAuthGuard | 11 | 0 |
| guards › RolesGuard / PermissionsGuard | 6 | 0 |
| request-context › request context | 9 | 0 |
| all-exceptions.filter › AllExceptionsFilter | 8 | 0 |
| redis-connection › redisConnectionFromUrl | 2 | 0 |
| throttling › Throttling (e2e) | 1 | 0 |
| foundation › health | 5 | 0 |
| foundation › request id | 2 | 0 |
| foundation › error envelope | 4 | 0 |
| foundation › validation | 2 | 0 |
| foundation › authentication (default-deny) | 8 | 0 |
| foundation › authorization (RBAC mechanism) | 2 | 0 |
| foundation › security hardening | 2 | 0 |
| foundation › OpenAPI | 1 | 0 |
| modules.workforce › Module boundaries (static) | 5 | 0 |
| modules.workforce › Workforce journey and contract (integration) | 2 | 0 |
| modules.workforce › OpenAPI | 2 | 0 |
| modules.journey › Auth -> Users -> Customers journey and OpenAPI contract (integration) | 3 | 0 |
| modules.journey › OpenAPI | 4 | 0 |
| foundation › connectivity | 4 | 0 |
| foundation › schema guarantees | 4 | 0 |
| foundation › auth repository against the real schema | 1 | 0 |
| foundation › BullMQ infrastructure | 1 | 0 |
| foundation › Worker process module (real infrastructure) | 1 | 0 |

## Every test and its result

### `validation.pipe.spec.ts`

- PASS - createValidationPipe › transforms and strips unknown fields
- PASS - createValidationPipe › returns VALIDATION_FAILED with per-field details and never echoes submitted values

### `audit.service.spec.ts`

- PASS - redactSensitive › redacts secret-like keys at any depth, including camelCase forms
- PASS - redactSensitive › does not over-redact innocent keys that merely contain a sensitive substring
- PASS - redactSensitive › truncates absurd depth and serialises dates
- PASS - AuditService › writes actor, role, action, entity, redacted metadata and the request id; forwards the transaction
- PASS - AuditService › defaults optional fields to null/undefined outside a request

### `token.service.spec.ts`

- PASS - TokenService › round-trips access-token claims
- PASS - TokenService › rejects a token signed with a different secret
- PASS - TokenService › rejects an expired token
- PASS - TokenService › rejects tampered and garbage tokens
- PASS - TokenService › rejects an unsigned (alg=none) token
- PASS - TokenService › rejects a validly-signed token with a different audience or missing claims
- PASS - TokenService › generates unique, high-entropy refresh tokens and hashes them deterministically

### `guards.spec.ts`

- PASS - JwtAuthGuard › lets @Public routes through without touching tokens or the database
- PASS - JwtAuthGuard › rejects a missing/malformed Authorization header: undefined
- PASS - JwtAuthGuard › rejects a missing/malformed Authorization header: ""
- PASS - JwtAuthGuard › rejects a missing/malformed Authorization header: "Basic abc"
- PASS - JwtAuthGuard › rejects a missing/malformed Authorization header: "Bearer"
- PASS - JwtAuthGuard › rejects a missing/malformed Authorization header: "Bearer a b"
- PASS - JwtAuthGuard › attaches the user for a valid token with an active session
- PASS - JwtAuthGuard › rejects an invalid token
- PASS - JwtAuthGuard › rejects when the session is revoked/expired/unknown
- PASS - JwtAuthGuard › rejects a suspended user even with a valid token and session
- PASS - JwtAuthGuard › rejects when the session belongs to a different user than the token subject
- PASS - RolesGuard / PermissionsGuard › allow routes that declare no requirement
- PASS - RolesGuard / PermissionsGuard › RolesGuard: requires any listed role
- PASS - RolesGuard / PermissionsGuard › PermissionsGuard: requires ALL listed permissions
- PASS - RolesGuard / PermissionsGuard › denies (does not crash) when no authenticated user is present
- PASS - RolesGuard / PermissionsGuard › does not reveal which permission was missing
- PASS - RolesGuard / PermissionsGuard › AuthorizationService resolves once per request even when several guards ask

### `request-context.spec.ts`

- PASS - request context › reuses a well-formed inbound X-Request-Id and echoes it
- PASS - request context › generates a UUID when absent
- PASS - request context › replaces an unacceptable inbound id: "short"
- PASS - request context › replaces an unacceptable inbound id: "has spaces in it"
- PASS - request context › replaces an unacceptable inbound id: "bad\r\nheader-injection"
- PASS - request context › replaces an unacceptable inbound id: "xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
- PASS - request context › replaces an unacceptable inbound id: "semi;colon;value"
- PASS - request context › is idempotent for one request (logger and middleware both call it)
- PASS - request context › exposes the id to downstream code through AsyncLocalStorage

### `all-exceptions.filter.spec.ts`

- PASS - AllExceptionsFilter › maps DomainException to its own code, message, status and details
- PASS - AllExceptionsFilter › does not leak framework/parser messages from plain HttpExceptions
- PASS - AllExceptionsFilter › maps standard statuses to stable codes
- PASS - AllExceptionsFilter › turns unknown errors into a generic 500 and logs the real error server-side
- PASS - AllExceptionsFilter › maps Prisma unique violations to 409 without exposing constraint details
- PASS - AllExceptionsFilter › maps Prisma record-not-found to 404
- PASS - AllExceptionsFilter › maps client-error status objects (e.g. body-parser) to 4xx, not 500
- PASS - AllExceptionsFilter › never includes a stack trace

### `redis-connection.spec.ts`

- PASS - redisConnectionFromUrl › parses a plain local URL
- PASS - redisConnectionFromUrl › parses credentials, db index and TLS

### `throttling.e2e-spec.ts`

- PASS - Throttling (e2e) › answers 429 RATE_LIMITED in the standard envelope after the limit, but never throttles health probes

### `foundation.e2e-spec.ts`

- PASS - health › GET /health/live is public, unversioned and cheap
- PASS - health › GET /health/ready reports database and redis up
- PASS - health › GET /health/ready returns 503 naming the failing dependency, without leaking internals
- PASS - health › reports redis down independently
- PASS - health › is not available under the versioned prefix
- PASS - request id › echoes a well-formed inbound X-Request-Id on success and in the error body
- PASS - request id › generates one when absent and replaces malformed values
- PASS - error envelope › unknown route -> 404 envelope with requestId
- PASS - error envelope › domain exception keeps its own code/message/status
- PASS - error envelope › unexpected error -> generic 500, no internals, no stack
- PASS - error envelope › malformed JSON -> 400 without parser internals
- PASS - validation › rejects invalid bodies with VALIDATION_FAILED and per-field details, not echoing values
- PASS - validation › strips unknown fields from valid bodies
- PASS - authentication (default-deny) › public route needs no token
- PASS - authentication (default-deny) › protected route rejects no header with 401 UNAUTHENTICATED
- PASS - authentication (default-deny) › protected route rejects not a bearer with 401 UNAUTHENTICATED
- PASS - authentication (default-deny) › protected route rejects garbage token with 401 UNAUTHENTICATED
- PASS - authentication (default-deny) › accepts a valid token for an active session
- PASS - authentication (default-deny) › rejects a valid token whose session was revoked or never existed
- PASS - authentication (default-deny) › rejects a suspended user
- PASS - authentication (default-deny) › rejects a token signed with another secret
- PASS - authorization (RBAC mechanism) › allows a caller holding the permission and the role
- PASS - authorization (RBAC mechanism) › returns 403 FORBIDDEN, not naming the missing permission, for an authenticated caller without it
- PASS - security hardening › sends security headers and hides the framework
- PASS - security hardening › has no CORS headers unless origins are configured
- PASS - OpenAPI › serves the document with the bearer scheme and operations

### `modules.workforce.int-spec.ts`

- PASS - Module boundaries (static) › only depends on modules in the allowed direction
- PASS - Module boundaries (static) › touches each Prisma table only inside its owning module
- PASS - Module boundaries (static) › keeps Search and Matching read-only: no Prisma model access and no statement that writes
- PASS - Module boundaries (static) › shares ONE definition of "verified": Search embeds the Verification fragment instead of re-implementing it
- PASS - Module boundaries (static) › keeps KYC/document concerns out of Workers, Categories and Availability
- PASS - Workforce journey and contract (integration) › lets a worker onboard end to end while a customer can only read categories and areas
- PASS - Workforce journey and contract (integration) › takes a worker from sign-up to being found by a customer and an administrator, and out again on re-check
- PASS - OpenAPI › documents every Workers, Categories and Availability operation as bearer-protected
- PASS - OpenAPI › exposes only client-writable fields in request schemas and no private fields in responses

### `modules.journey.int-spec.ts`

- PASS - Auth -> Users -> Customers journey and OpenAPI contract (integration) › walks a new customer from OTP registration to a managed, then suspended, account
- PASS - Auth -> Users -> Customers journey and OpenAPI contract (integration) › keeps a worker out of customer-private data and customers out of worker accounts
- PASS - Auth -> Users -> Customers journey and OpenAPI contract (integration) › never returns secrets or internal fields from any module
- PASS - OpenAPI › documents every Auth, Users and Customers endpoint under /api/v1
- PASS - OpenAPI › marks protected operations with bearer auth and leaves the login/OTP/refresh operations open
- PASS - OpenAPI › keeps passwords write-only and exposes no credential fields in response schemas
- PASS - OpenAPI › does not accept client-controlled server fields in request schemas

### `foundation.int-spec.ts`

- PASS - connectivity › PostgreSQL answers and the foundation migration is applied
- PASS - connectivity › Redis answers PING
- PASS - connectivity › GET /health/ready (real app, real infrastructure) is 200 with database and redis up
- PASS - connectivity › GET /health/live and an unknown /api/v1 route behave per the API conventions
- PASS - schema guarantees › audit_logs is append-only: UPDATE and DELETE are rejected by the database
- PASS - schema guarantees › the audit trigger that blocks TRUNCATE exists (checked via catalog, TRUNCATE itself is never executed)
- PASS - schema guarantees › a user must have at least one login identifier
- PASS - schema guarantees › mobile numbers are unique
- PASS - auth repository against the real schema › finds only active sessions and resolves the union of role permissions
- PASS - BullMQ infrastructure › platform job defaults apply (retries, exponential backoff, failed jobs retained) on the real Redis
- PASS - Worker process module (real infrastructure) › starts, connects to PostgreSQL/Redis/BullMQ configuration, and shuts down cleanly
