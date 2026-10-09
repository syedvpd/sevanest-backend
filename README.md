# SevaNest Backend

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
(never in a committed file) before `npm run seed` to create the first Super Admin. It is refused in production.

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

## Database safety
Schema changes only via `prisma migrate dev` (reviewed SQL in `prisma/migrations`) and `prisma migrate deploy` elsewhere.
Never `migrate reset`, `db push --force-reset`, `DROP`, or `TRUNCATE` on a shared database.
`docker compose down -v` deletes the local data volumes — avoid it unless you intend to erase local data.

## Docker (application containers)
Infrastructure only (host-based development): `npm run infra:up` (PostgreSQL + Redis, no profile).
API + worker + migrations in containers (compose profile `app`):
```bash
docker compose --profile app up -d --build   # builds the image, runs `prisma migrate deploy`, starts api + worker
docker compose --profile app ps
curl http://localhost:3000/health/ready      # set API_PORT in .env to change the host port (default 3000)
docker compose --profile app logs api worker
docker compose --profile app stop api worker # graceful SIGTERM (init process + Nest shutdown hooks)
docker compose --profile app down            # removes app containers; keeps data volumes
```
Images: `docker build --target runtime -t sevanest-backend .` (API/worker) and `--target migrate` (applies migrations).

## CI
`.github/workflows/ci.yml` runs, in order: `npm ci`, `npx prisma validate`, `npx prisma migrate deploy`, `npm run lint`,
`npm run format:check`, `npm run typecheck`, `npm run build`, `npm test`, `npm run test:e2e`, `npm run test:integration`,
then builds both Docker targets. Run the same checks locally with the commands above (integration needs `npm run infra:up`).
