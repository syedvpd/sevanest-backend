# SevaNest backend: developer reference

REST API for the SevaNest household-workforce marketplace (Customer app, Worker app, Admin portal).
NestJS modular monolith · PostgreSQL (source of truth) · Redis + BullMQ (non-authoritative) · Prisma.

Requirements live in `docs/project-specifications/`.

## Modules
| Module | Covers | Docs |
|---|---|---|
| Auth | mobile OTP login (customer, worker), admin credential login, token sessions, refresh rotation, logout | `src/modules/auth/README.md` |
| Users | accounts, status, admin roles and permissions, admin provisioning | `src/modules/users/README.md` |
| Customers | customer profile, saved addresses, admin customer management | `src/modules/customers/README.md` |
| Workers | worker profile, roles, onboarding steps, submission, assisted onboarding | `src/modules/workers/README.md` |
| Service Categories | admin-managed category master | `src/modules/service-categories/README.md` |
| Availability | engagement preference, preferred areas, daily time windows, service-area master | `src/modules/availability/README.md` |
| Verification | worker KYC checks, document metadata (private storage, signed links), review workflow, history, the definition of "verified" | `src/modules/verification/README.md` |
| Search | read-only worker discovery for customers (category, area, availability), worker cards | `src/modules/search/README.md` |
| Matching | staff-side candidate selection for a requirement (no scoring, no assignment) | `src/modules/matching/README.md` |
| Booking | booking lifecycle, interview/trial, confirmation, cancellation, timeline | `src/modules/booking/README.md` |
| Payment | booking fee payment behind a provider abstraction, webhook, refunds | `src/modules/payment/README.md` |
| Notifications | outbox, templates, queue, push/SMS/WhatsApp delivery | `src/modules/notifications/README.md` |
| Attendance | status-based attendance per booking and date | `src/modules/attendance/README.md` |
| Replacement | replacement request, review, selection, linked booking | `src/modules/replacement/README.md` |
| Ratings | customer ratings of completed bookings, worker totals, admin moderation | `src/modules/ratings/README.md` |
| Support | tickets and complaints for customers and workers, staff handling | `src/modules/support/README.md` |
| Reports | 12 read-only reports and the operations dashboard | `src/modules/reports/README.md` |
| Admin / Audit | admin accounts, roles and permissions (`src/modules/users`), audit viewer and security events (`src/common/audit`) | `src/modules/users/README.md` |

Testing documentation: `docs/testing/<module>/README.md`.

## Toolchain (locked, exact versions in `package-lock.json`)
| | |
|---|---|
| Node.js | 24 LTS (`engines`: `^24.0.0`) |
| NestJS | 11.2.7 (CommonJS) |
| TypeScript | 5.9.3 |
| Prisma | 7.10.0 (exact; `@prisma/client`, `@prisma/adapter-pg`) |
| Jest / ts-jest | 30.5.2 / 29.4.14 |
| ESLint / Prettier | 10.12.0 / 3.9.9 |
| PostgreSQL / Redis (local) | 17 / 7 via `docker-compose.yml` |

Intentional Prisma 7 + Jest configuration (each has a documented reason, do not remove):
- `prisma/schema.prisma`: `importFileExtension = ""` — Prisma 7 otherwise emits `.js` import suffixes that Jest-CommonJS cannot resolve.
- `package.json` test scripts run `node --experimental-vm-modules …jest` — Prisma 7's client loads its query compiler with dynamic `import()`.
- `tsconfig.build.json`: `rootDir: ./src` — `prisma.config.ts` sits at the repo root and would otherwise move the build output.

## Setup
```bash
nvm use                      # or any Node 24
cp .env.example .env         # then set local values (never commit .env)
npm ci
npm run infra:up             # PostgreSQL + Redis on localhost
npm run prisma:migrate:deploy
npm run build && npm run seed   # roles + permissions (idempotent reference data)
```
`.env.example` lists every required setting. The OTP, lockout and password-length values are **development placeholders, not
approved business values** (the specifications leave them open); production must set explicit, reviewed values.
`SMS_PROVIDER=disabled` answers OTP requests with `503 SMS_NOT_CONFIGURED` until an SMS vendor is integrated;
`SMS_PROVIDER=memory` (tests/local only, refused in production) keeps OTPs in process memory.

Optional, development only: set `BOOTSTRAP_SUPER_ADMIN_EMAIL` and `BOOTSTRAP_SUPER_ADMIN_PASSWORD` in the environment
(never in a committed file) before `npm run seed` to create a development Super Admin. The seed refuses this in production.

### First Super Admin in production (one-time)
Run once, in a shell of the deployed service (Render: the service's **Shell** tab; Docker: `docker exec -it`), so the command uses the
production `DATABASE_URL`. The password is typed at a **hidden prompt** (nothing is stored, logged or put in shell history):
```bash
BOOTSTRAP_SUPER_ADMIN_EMAIL=owner@yourcompany.example BOOTSTRAP_SUPER_ADMIN_CONFIRM=create-first-super-admin npm run bootstrap:admin
```
Where no terminal exists (CI, Kubernetes job) supply the password as a secret **file** instead: `BOOTSTRAP_SUPER_ADMIN_PASSWORD_FILE=/run/secrets/admin_pw`.
(`BOOTSTRAP_SUPER_ADMIN_PASSWORD` in the environment still works for compatibility; set it only for that one run and remove it.)

Refusals, all with exit code 1 and nothing written: not `NODE_ENV=production`-confirmed (missing `BOOTSTRAP_SUPER_ADMIN_CONFIRM`), missing or
invalid email, no password, a **weak password** (shorter than `ADMIN_PASSWORD_MIN_LENGTH`, fewer than three character classes, repeated
runs, contains the email name or a very common password), or **a Super Admin already exists** (audited as `admin.bootstrap_rejected`).
The check-and-create is one transaction under a lock, so two simultaneous runs create exactly one account; a failure midway rolls
everything back. Success is audited as `admin.bootstrap` (no email, no password in the row). Normal start-up and `npm run seed` never
create a production user (the seed refuses `BOOTSTRAP_*` in production; the demo seed refuses any non-local database).
After the first login change the password (`POST /api/v1/admin/account/password`) and create further admins through the API.

## Run
```bash
npm run start:dev            # API with reload   (http://localhost:3000, docs at /docs when SWAGGER_ENABLED=true)
npm run build && npm run start:prod      # API from the production build
npm run build && npm run start:worker    # background worker process
```
Probes: `GET /health/live`, `GET /health/ready`. API under `/api/v1`. OpenAPI JSON: `/docs/openapi.json`.

## Checks
```bash
npm run typecheck && npm run lint && npm test          # fast, no services needed
npm run test:e2e                                       # boots the real app, PostgreSQL/Redis stubbed
npm run test:integration                               # real PostgreSQL + Redis, see below
```
The foundation integration test rolls back all its writes. The module integration tests **commit** rows, so they run only
against a dedicated database whose name ends in `_test` or `_ci` (`TEST_DATABASE_URL`, else `DATABASE_URL`), never the
development database. One-time setup:
```bash
docker compose exec postgres createdb -U <POSTGRES_USER> sevanest_test
DATABASE_URL=postgresql://<user>:<password>@localhost:5432/sevanest_test?schema=public npx prisma migrate deploy
# then add TEST_DATABASE_URL=<that URL> to your local .env
```

## Providers (what to configure)
| Concern | Setting | Notes |
|---|---|---|
| OTP SMS | `SMS_PROVIDER=twilio` or `msg91` | Twilio: `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, and `TWILIO_MESSAGING_SERVICE_SID` (or `TWILIO_SMS_FROM`). MSG91 (India/DLT): `MSG91_AUTH_KEY`, `MSG91_OTP_TEMPLATE_ID`, `MSG91_OTP_VARIABLE`. |
| WhatsApp | `WHATSAPP_PROVIDER=twilio` | needs the Twilio credentials plus `TWILIO_WHATSAPP_FROM` (an approved WhatsApp sender or the Twilio sandbox number) |
| Payments | `PAYMENT_PROVIDER=razorpay` | `RAZORPAY_KEY_ID` (`rzp_test_*` or `rzp_live_*`), `RAZORPAY_KEY_SECRET`, `RAZORPAY_WEBHOOK_SECRET` |
| Push | `PUSH_PROVIDER=fcm` | Firebase Cloud Messaging HTTP v1: `FCM_SERVICE_ACCOUNT_JSON` (the service-account key on one line, a secret). Apps send their device token to `PUT /api/v1/auth/device-token`. |

A provider whose settings are missing or malformed stops the process at start-up with the name of the variable. `memory`/`fake` adapters are
refused in production, and `disabled` is never silently replaced by a fake one: OTP requests answer `503 SMS_NOT_CONFIGURED`, payments `503`.
Indian SMS must be sent from a **DLT-registered** sender and template: register with your operator (or through MSG91/Twilio's DLT support) and
use the approved template; the application never sends free text through MSG91. The adapters are tested against faked HTTP responses; **no real
SMS or payment has been sent by this repository's tests** - do a sandbox/test-mode delivery before launch.

Razorpay setup: create the webhook `https://<api-host>/api/v1/webhooks/payments` with the secret in `RAZORPAY_WEBHOOK_SECRET` and events
`payment.captured`, `payment.failed`, `refund.processed`, `refund.failed`; keep **auto-capture** enabled (an authorized-only payment is
never treated as paid). The checkout response contains only the public `keyId`, `orderId`, `amount`, `currency`; the client sends back
`providerPaymentId` and `signature` to `POST /api/v1/payments/{id}/verify`, and the server re-checks both with Razorpay before changing any state.

## Bookings, payments and money problems
* Cancelling a booking closes its unpaid payment (`FAILED`, `BOOKING_CANCELLED`) and keeps checking the gateway order for a short tail. If the
  customer still pays, the payment is recorded as `SUCCEEDED` (the money is real) but is **never** treated as a normal booking payment: a
  `LATE_PAYMENT_BOOKING_NOT_PENDING` exception is raised and the customer is told it is under review.
* Cancelling a booking that is already paid raises `PAID_BOOKING_CANCELLED`. **Nothing is refunded automatically** - the refund and
  cancellation-fee policy is undecided (Q-17/Q-21), so a person with `payment.refund` decides (`POST /admin/payments/{id}/refund`) and then closes the
  item (`POST /admin/payment-exceptions/{id}/resolve`).
* Other money problems become exceptions too: `AMOUNT_MISMATCH`, `CURRENCY_MISMATCH`, `DUPLICATE_PAYMENT` (second charge on a paid order),
  `UNKNOWN_ORDER_EVENT`, `RECONCILIATION_EXHAUSTED`, `REFUND_STUCK`, `REFUND_NOT_REQUESTED`. List them with `GET /admin/payment-exceptions?status=OPEN`
  (`payment.view`); each states the booking and payment state, amount, gateway references and the required action. Staff with `payment.manage` also get a
  `PAYMENT_EXCEPTION_ALERT` notification **if an admin has configured a template for that event** (templates are admin data, none is seeded) - the list is
  the source of truth.
* Recovery (worker process, every minute): payments with an open gateway order are checked against the gateway **by order** after 5 minutes and then with
  exponential backoff (5 min doubling, capped at 6 h, jittered, 12 checks); pending refunds are polled; webhooks that arrived before their order are replayed;
  cancelled bookings that still hold money are re-flagged. Rows are claimed atomically in PostgreSQL (`FOR UPDATE SKIP LOCKED` plus a lapsing claim), so
  restarts and several workers are safe. `GET /admin/payment-recovery/summary` shows the queue; a growing `dueForCheck` means the worker is not running.
* No booking-expiry rule exists (undecided), so unpaid `PENDING_PAYMENT` bookings are **not** auto-cancelled.

## Background jobs (why "nothing happens in real time" on a web-only deployment)
The API (`node dist/main`) only serves HTTP. Notification delivery, payment recovery, re-check reminders and KYC clean-up run in the **worker**
(`node dist/worker`), a separate process. If only the API is deployed (for example one Render *Web Service*) the outbox fills up and nothing is
delivered or recovered. Either deploy a second service running `node dist/worker` (Render: *Background Worker*, same environment variables; see `render.yaml`),
or set `EMBEDDED_WORKERS=true` on the API to run the same loops inside it. Redis is only used for BullMQ delivery jobs, OTP state and rate limits; the
recovery state lives in PostgreSQL.

## Proxy and client IP (`TRUST_PROXY_HOPS`)
Per-IP limits (global throttle, OTP requests, admin-login lockout) key on the client IP. `TRUST_PROXY_HOPS` tells Express how many reverse proxies in front
of the API to trust when reading `X-Forwarded-For`; it is **required in production** (the API refuses to start without it) because no default is safe:
0 behind a load balancer puts all users in one bucket (a platform-wide OTP cap and one attacker can lock out all admins), and too high lets a client forge
the header. Count the hops between the internet and the API: Render web service = 1; Cloudflare in front of Render = 2; direct exposure = 0. Check it
after deploying: (1) too low - exhaust the OTP per-IP limit from one network, then request an OTP from a second network (a phone on mobile data): if that
one is refused too, every client shares one IP, so raise the value; (2) too high - repeat the requests while changing `X-Forwarded-For` on each call: if the limit
never triggers, the header is trusted too far, so lower the value. Per-account (admin email) and per-phone (OTP) limits do not depend on the IP, so rotating IPs does
not bypass them. `THROTTLE_STORAGE` defaults to `redis` in production so the global limit is shared by all replicas; if Redis is unreachable the request
counter degrades to per-process memory (logged) instead of failing every request.

## Staff alerts, scheduled checks and launch readiness
* **Alert inbox** - `GET /api/v1/admin/alerts` (+ `/summary`, acknowledge, resolve; permissions `alert.view` / `alert.manage`; a count appears on the dashboard).
  Alerts are deduplicated per problem, visible only to admins holding the permission the problem concerns, closed automatically when the problem
  disappears, and re-opened if it returns. Raised by: money problems (`PAYMENT_EXCEPTION`), a matched worker who has not answered
  (`BOOKING_NO_RESPONSE`), a booking returned to staff after a decline (`BOOKING_NEEDS_MATCH`), a booking waiting for payment
  (`BOOKING_STUCK_PAYMENT`), a support ticket past its target (`SUPPORT_SLA_BREACH`), safety reports (`SAFETY_REPORT`) and account-deletion requests.
  The alert inbox needs no notification template, so it works on day one.
* **Rules that need a number are OFF until you set one** (the business has not decided them): `WORKER_RESPONSE_HOURS`,
  `PENDING_PAYMENT_ALERT_HOURS`, `PENDING_PAYMENT_AUTO_CANCEL_HOURS`, `SUPPORT_SLA_HOURS_*` (see `.env.example`). Auto-cancel goes through the normal
  cancellation path; nothing is ever refunded or reassigned automatically.
* **Worker loops** (`node dist/worker`, or `EMBEDDED_WORKERS=true`): notification delivery, re-check reminders, abandoned-upload clean-up, payment
  recovery, booking checks, support SLA. Each records a heartbeat in Redis every tick.
* **Launch readiness** - `GET /api/v1/admin/system/readiness` (Super Admin) lists every prerequisite and whether it is met: enabled areas and categories,
  required verification checks, booking fee, SMS/payment/storage providers, templates per event and whether the worker loops are alive (with the
  exact fix when they are not). `npm run seed:launch` installs only what the PRD itself specifies - the five Hyderabad pilot areas - and starter
  in-app wording for each event (never overwriting an administrator's text); the booking fee and the verification set stay for you to decide.
* **In-app inbox** - `GET /api/v1/notifications` (+ `unread-count`, `:id/read`, `read-all`) for customers and workers. Channel `IN_APP` is delivered
  the moment the event is processed, needs no provider, and each item carries a deep link `route`. A recipient's `preferredLanguage` selects the template language.
* **Support** is a conversation: the creator and staff exchange messages on a ticket (`/support/tickets/:id/messages`), staff can leave internal notes, and a
  resolution target (SLA) is set from configuration. **Safety** - `POST /safety/blocks` and `/safety/reports` (customers and workers); a block hides the pair
  from each other in search, shortlist, matching, replacement and booking. **Legal** - `GET /legal/current`, `POST /legal/accept`, and
  `POST /me/deletion-request` (recorded for staff; nothing is erased automatically because retention rules are undecided). **App start-up** -
  `GET /app-config` and `GET /reference-data` are public and cacheable.

## Interim policy defaults and small additions
The business has not decided several policies; the backend uses safe, switchable defaults (decision D-59, questions Q-83..Q-91) so work is not blocked:

| Item | Default now | Change it by |
|---|---|---|
| Cancellation fee / refund | fee 0, no automatic refund; a paid + cancelled booking raises a payment exception for a person with `payment.refund` | needs the client policy (Q-83) |
| Start before the agreed date | not allowed for customer/worker; staff may | `BOOKING_START_EARLY_DAYS` |
| Customer verification | VERIFIED when the profile is complete and an address is saved; staff decisions are never overridden | `CUSTOMER_AUTO_VERIFY=false` |
| Worker emergency contact / address | any admin with `worker.view`, every read audited (`worker.sensitive_view`) | needs the client policy (Q-86) |
| Forgotten admin password | a Super Admin runs `POST /admin/users/{id}/password-reset` (temporary password shown once, sessions revoked); no MFA | needs the client choice (Q-87) |
| Malware scan of KYC documents | off; with `CLAMAV_HOST` every document is scanned and an unscannable file is never accepted | `CLAMAV_HOST` |
| Data erasure | deletion requests are recorded for staff; nothing is erased automatically | needs retention rules (Q-88) |

**Worker double-booking (D-63):** a worker booked for 09:00-10:00 on a date cannot be taken for an overlapping time on that date (409 `WORKER_UNAVAILABLE`) but is bookable again from 10:00, at other hours, on other dates and by other customers' other workers; busy workers are hidden from search and matching for the requested time (`startDate` + `availableFrom/To`). **Category engagement types:** `PUT /admin/service-categories/{id}/engagements` limits what a category offers (empty = all). **Opportunity feed:** `GET /workers/me/opportunities`. **Worker references:** `GET/PUT /workers/me/references`. **Another interview time:** the worker proposes with `PUT /workers/me/bookings/{id}/slot-proposal`, the customer answers with `POST /bookings/{id}/slot-proposal/accept|reject`. **Replacement history:** `GET /bookings/{id}/replacement-chain`. **Edit conflicts:** customer profile / address and several admin resources return an `ETag`; send it back as `If-Match` (412 `STALE_VERSION` when stale). **Provider check:** `npm run check:providers` (see the runbook).

Also available: `GET .../attendance/.../summary?month=YYYY-MM`, list filters on customers and bookings, `GET /admin/reports/export/{report}` (CSV), `POST /admin/bookings` and `POST /admin/workers` (staff acting on someone's behalf), an optional `Idempotency-Key` header on unsafe endpoints, and `ETag`/`If-Match` on the worker and customer admin edits. Operations (backups, monitoring, keep-alive): `docs/qa/OPERATIONS_RUNBOOK.md`.

## Database safety
Schema changes only via `prisma migrate dev` (reviewed SQL in `prisma/migrations`) and `prisma migrate deploy` elsewhere.
Never `migrate reset`, `db push --force-reset`, `DROP`, or `TRUNCATE` on a shared database.
`docker compose down -v` deletes the local data volumes — avoid it unless you intend to erase local data.

## Docker: run the whole backend with one command
After `git clone` nothing else is needed (no `.env`): PostgreSQL 17, Redis 7 (BullMQ queues), migrations, seed, API and worker all start from `docker.env` (local, non-secret values).
```bash
docker compose --profile app up -d --build
```
Order: postgres + redis -> `migrate` (`prisma migrate deploy`) -> `seed` (roles, permissions, categories, pilot areas, starter templates, demo customers/workers) -> `api` + `worker`.
```bash
curl http://localhost:3000/health/ready      # API on http://localhost:3000, Swagger on /docs, OpenAPI on /docs/openapi.json
docker compose --profile app logs -f api worker
docker compose --profile app run --rm migrate    # apply new migrations after a git pull (never resets or drops)
docker compose --profile app run --rm seed       # re-run the idempotent seed
docker compose --profile app up -d --build api worker   # rebuild after code changes
docker compose --profile app down                # stop; keeps the data volumes
```
Local logins (from `docker.env`; development only, never use on real data):
* Admin: `admin@sevanest.local` / `Local-Docker-Admin-2026!` via `POST /api/v1/auth/admin/login`.
* Demo customers `+919000000201`..`+919000000203`, demo workers `+919000000101`..`+919000000103`: `POST /api/v1/auth/otp/request` then `POST /api/v1/auth/otp/verify` with `{ "mobile", "appType": "CUSTOMER", "otp": "123456" }` (fixed test code; refused in production).
Ports in use already? Set `API_PORT`, `POSTGRES_PORT`, `REDIS_PORT` in your shell or `.env`. Skip demo data with `SEED_DEMO=false`. Wipe everything and start fresh (local only): `docker compose --profile app down -v`.
Infrastructure only (host-based development): `npm run infra:up`. Real SMS, storage and payment providers are configured through your own environment, not `docker.env`.

Images: `docker build --target runtime -t sevanest-backend .` (API/worker) and `--target migrate` (applies migrations).

## CI
`.github/workflows/ci.yml` runs, in order: `npm ci`, `npx prisma validate`, `npx prisma migrate deploy`, `npm run lint`,
`npm run format:check`, `npm run typecheck`, `npm run build`, `npm test`, `npm run test:e2e`, `npm run test:integration`,
then builds both Docker targets. Run the same checks locally with the commands above (integration needs `npm run infra:up`).
Backup, restore and moving to another database: `docs/DATABASE_MIGRATION.md` (scripts in `scripts/db/`).
