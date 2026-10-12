# Production readiness - final QA

Status vocabulary: **READY** (verified, nothing to do) - **READY WITH CONFIG** (code complete and verified; needs values/infrastructure at deploy) -
**BLOCKED** (cannot go live until an external dependency or a code change exists) - **NOT REQUIRED** (no source requires it) - **OPEN DECISION** (needs a business/owner decision).
Evidence references point to the other `docs/qa/` files. Nothing here is marked READY on the strength of passing tests alone.

## 1. Checklist

| Area | Status | Evidence / what is needed |
|---|---|---|
| CONFIGURATION | READY WITH CONFIG | Startup validation (class-validator) refuses a missing/invalid variable (32-character minimum on the JWT and OTP secrets) and, in `NODE_ENV=production`, refuses `memory`/`fake` adapters and placeholder secrets (`change-me`, `example`, `secret`); verified by `env.validation.spec.ts` and by starting the production image with bad values. `.env.example` ships `SWAGGER_ENABLED=true` (S-10): set `false` in production. |
| SECURITY | READY WITH CONFIG | Default-deny global guard on all 159 operations, RBAC/IDOR sweeps, token attacks, injection, mass assignment, KYC leak scan: 0 leaks (API_SECURITY_AUDIT, RBAC_MATRIX). Open: S-04 per-process throttler, S-05 `TRUST_PROXY_HOPS` must equal the real proxy depth, S-08 presigned PUT cannot cap size/type. |
| DATABASE | READY WITH CONFIG | 40 tables, 61 FKs, 45 CHECKs, 1 exclusion, 122 indexes, 6 append-only triggers; clean `migrate deploy` from empty in CI simulation. Needs a managed PostgreSQL, TLS in `DATABASE_URL`, a migration role separate from the runtime role (recommended). Pool sizing is the first scaling limit (PERFORMANCE_REVIEW P-5). |
| REDIS | READY WITH CONFIG | Used for OTP state, throttling-adjacent counters and BullMQ; non-authoritative. Needs a managed Redis with persistence and `maxmemory-policy noeviction` (BullMQ requirement). |
| QUEUES | READY WITH CONFIG | Outbox (PostgreSQL) -> BullMQ `notifications` queue; consumer and dispatch loop run only in the `worker` process (verified live: real server and Docker delivered 4 notifications). Needs the worker process deployed as its own service/container and at least one replica. |
| STORAGE | BLOCKED (live) / READY WITH CONFIG | `s3` adapter (user-authored, 4 unit tests) is **not verified against a real bucket**. Needs bucket (private), `STORAGE_S3_*`, a live upload/confirm/download test, a bucket-level size limit (S-08). KYC cannot go live before that test. |
| PAYMENTS | BLOCKED | No gateway vendor selected (Q-08). Only `fake` (refused in production) and `disabled`. Booking cannot reach CONFIRMED in production without a real adapter. Webhook verification, amount-from-server, idempotency and replay protection are verified against the fake. |
| SMS | BLOCKED | No vendor (Q-08). `memory` refused in production; `disabled` means no OTP can be delivered, so nobody can log in. |
| PUSH | BLOCKED | No FCM adapter/credentials. Notifications for that channel are skipped/failed per policy (Q-08). |
| WHATSAPP | BLOCKED | No provider/templates. Same as push. |
| AUTH | READY WITH CONFIG | OTP (hash-only, atomic Lua, attempt/cooldown/lockout), refresh rotation with replay detection that revokes the session, suspended/revoked users refused, logout invalidates access token; 42/42 real-server and Docker checks. Needs `JWT_*` and `OTP_HMAC_SECRET` secrets of production strength. |
| KYC | READY WITH CONFIG | Review flow, per-document signed links, no storage keys/URLs/ids leak (30 surfaces scanned). Depends on STORAGE above and on the retention/consent decisions (Q-02, Q-50). |
| LOGGING | READY | pino JSON, request id echoed, redaction; 321 lines scanned against 15 secrets - none present; production-mode scan clean. S-13: an expected 503 is logged as ERROR ("Unhandled exception"). |
| MONITORING | READY WITH CONFIG | `/health/live` and `/health/ready` exist; no metrics endpoint, tracing or alerting is implemented. Needs platform-level monitoring (uptime check on `/health/ready`, log-based alerts on `level>=50`, queue depth/DLQ for `notifications`). Not demanded by any source document. |
| BACKUPS | OPEN DECISION | Not an application feature. Needs managed PostgreSQL PITR and a restore drill; RPO/RTO undefined in the sources. |
| MIGRATIONS | READY | Forward-only SQL migrations, applied by `prisma migrate deploy` in a separate container/step; never edited in place. Rollback = restore from backup or a forward fix (see below). |
| ROLLBACK | READY WITH CONFIG | Application image is stateless: redeploy previous tag. Schema is forward-only; every migration so far is additive, so the previous image runs on the new schema. Take a snapshot before each migration. |
| HEALTH CHECKS | READY | `HEALTHCHECK` in the Docker image uses `/health/live`; `/health/ready` checks PostgreSQL and Redis and leaks no connection strings (verified live). |
| CI/CD | NOT VERIFIED | The GitHub workflow was never executed on GitHub. Its exact command sequence was reproduced from a clean copy and a clean database - every step exit 0 (FINAL_QA_REPORT section 13). That is a simulation, not a CI run. No deploy pipeline exists. |
| SECRETS | READY WITH CONFIG | No secret in the repository (gitignored `.env`); secrets only from environment. Needs a secret manager. The `.env` in the working copy holds real credentials (Supabase) - must stay uncommitted and be rotated if ever shared. |
| RATE LIMITS | READY WITH CONFIG | OTP: per mobile, per IP, cooldown, lockout (Redis, shared across instances). Global HTTP throttler is in-memory per process (S-04): with N replicas the effective limit is N times higher. Put edge rate limiting (gateway/WAF) or move to Redis storage. |
| ERROR HANDLING | READY | One error envelope with stable codes and request id; no stack traces or SQL in responses (adversarial suite). |
| AUDIT | READY | 16 modules write audit rows in the same transaction as the change; append-only trigger blocks UPDATE/DELETE. S-09: a refused request also writes a row (R-27) - volume risk under attack. |
| DATA RETENTION | OPEN DECISION | No retention/erasure/refund policy in the sources (Q-02). Nothing deletes data automatically; audit log and notification rows grow without bound. |
| FIRST SUPER ADMIN | OPEN DECISION | S-06: no supported way to create the first Super Admin in production (the seed is for development). Needs an approved bootstrap procedure. |

## 2. Switching providers to production

All providers are chosen by environment variable and bound once at startup. `NODE_ENV=production` rejects `memory` and `fake`. A new vendor means **a new adapter class implementing the existing interface plus one line in the module's provider factory**; no service changes.

### SMS (OTP and notifications)
1. Choose a vendor (Q-08) and DLT/sender registration where the destination country requires it.
2. Implement the adapter for `src/integrations/notifications/notification-providers.interface.ts` (the SMS provider), map vendor errors to `ProviderError` (retryable vs permanent - drives the outbox retry policy), add the enum value to `SmsProviderKind`, its credentials to `env.validation.ts` (required only when selected), and a unit test with the vendor HTTP mocked.
3. Set `SMS_PROVIDER=<vendor>` and credentials; keep `OTP_*` limits. Verify with one real OTP login on a staging number.

### Payment gateway
1. Vendor selection and merchant onboarding (Q-08), plus the refund/fee policy (open).
2. Implement `payment-provider.interface.ts`: create order for the **server-computed** amount, verify the webhook signature on the raw body, return a normalised event. Add the enum value `PaymentProviderKind`, its key/secret to `env.validation.ts`.
3. Register the gateway webhook URL (`POST /api/v1/webhooks/payments`), enable HTTPS only, set the shared secret. Keep `PAYMENT_FAKE_WEBHOOK_SECRET` unset (production refuses `fake`).
4. Re-run `payment.api`, `qa.journeys` and `qa.concurrency` with the adapter in a sandbox; run a real sandbox payment end to end, including a duplicate webhook and a wrong signature.

### Push (FCM)
Implement the push interface with FCM HTTP v1; device tokens are already registered by the apps through `PUT /api/v1/auth/device-token`; add `MessagingProviderKind.Fcm`, service-account credentials via secret manager; map invalid-token errors to permanent failure so tokens get dropped.

### WhatsApp
Needs approved message templates (the notification template catalogue is already data-driven), a Business API provider, an adapter on the WhatsApp interface and credentials. Opt-in/consent rules are undecided.

### Storage (KYC documents)
1. Create a **private** bucket; set `STORAGE_PROVIDER=s3`, `STORAGE_S3_ENDPOINT`, `STORAGE_S3_REGION`, `STORAGE_S3_BUCKET`, `STORAGE_S3_ACCESS_KEY_ID`, `STORAGE_S3_SECRET_ACCESS_KEY`.
2. Bucket policy: max object size and allowed content types (the presigned PUT cannot enforce them - S-08), lifecycle/retention per decision, server-side encryption, no public access.
3. Verify live: request upload link -> PUT from a client -> confirm (HEAD size is read from the bucket) -> reviewer downloads through the signed GET -> link expires. Not yet done.

## 3. Minimum deployment topology
Three processes from one image: `migrate` (once per release), `api` (N replicas behind TLS terminating proxy with `TRUST_PROXY_HOPS` set), `worker` (1+ replicas). PostgreSQL and Redis managed. Environment per `.env.example` with production values.
