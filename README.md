# SevaNest Backend

REST API for **SevaNest**, a household-workforce marketplace: customers find and book verified workers (maids, cooks, drivers, caregivers), workers manage their profile and jobs, and staff run verification, matching, payments and support.

**Stack:** NestJS 11 modular monolith, TypeScript, PostgreSQL 17 (source of truth), Redis + BullMQ (queues, rate limits; not authoritative), Prisma 7, Jest. Node 24.

## Run it (Docker, one command)
Needs Docker only. No `.env` required.
```bash
git clone https://github.com/syedvpd/sevanest-backend.git && cd sevanest-backend
docker compose --profile app up -d --build
curl http://localhost:3000/health/ready
```
This starts PostgreSQL, Redis, applies all migrations, seeds reference and demo data, then starts the API and the worker.

* API `http://localhost:3000/api/v1` · Swagger `http://localhost:3000/docs` · OpenAPI `http://localhost:3000/docs/openapi.json`
* Local admin (development only): `admin@sevanest.local` / `Local-Docker-Admin-2026!` -> `POST /api/v1/auth/admin/login`
* Demo customers `+919000000201..203`, demo workers `+919000000101..103`: fixed OTP `123456` (development only, refused in production)

After a `git pull`:
```bash
docker compose --profile app run --rm migrate    # apply new migrations (never resets or drops)
docker compose --profile app run --rm seed       # idempotent seed
docker compose --profile app up -d --build api worker
```
Wipe local data: `docker compose --profile app down -v`. Ports busy? Set `API_PORT`, `POSTGRES_PORT`, `REDIS_PORT`.

## Develop on the host
```bash
cp .env.example .env && npm ci
npm run infra:up                  # PostgreSQL + Redis in Docker
npm run prisma:migrate:deploy && npm run build && npm run seed && npm run seed:launch
npm run start:dev
```

## Verify
```bash
npm run typecheck && npm run lint && npm test          # unit
npm run test:e2e                                        # end to end
npm run test:integration                                # needs a disposable database whose name ends _test or _ci
```
Latest full run: 47 integration suites / 818 tests, 29 unit suites / 270 tests, 27 e2e tests, all passing.

## What is in the box
Auth (mobile OTP, admin login, refresh rotation) · Users and RBAC · Customers and addresses · Workers and onboarding · Service categories and areas · Availability · Verification (KYC) · Search · Matching · Booking, interviews and trials · Payments (provider abstraction, webhook, refunds) · Notifications (outbox, push, SMS, WhatsApp) · Attendance · Replacement · Ratings · Support · Reports · Audit and security. Each module has its own `src/modules/<name>/README.md`.

## Repository map
| Path | Contents |
|---|---|
| `src/` | application code (`modules/`, `common/`, `infrastructure/`, `integrations/`) |
| `prisma/` | schema and reviewed SQL migrations |
| `test/` | integration, e2e and support code |
| `scripts/` | database backup/restore/rebuild (`db/`), local demo seed, load-test tools (`load/`) |
| `docs/` | `DEVELOPMENT.md` (full reference), `DATABASE_MIGRATION.md`, `project-specifications/` (PRD, SRS, FRD, TRD), `qa/` (verification evidence, API handoff), `project-intelligence/` (decisions, open questions, state), `testing/` |
| `docker-compose.yml`, `docker.env`, `Dockerfile` | local stack and image (`docker.env` holds local, non-secret values only) |
| `render.yaml` | Render deployment blueprint |

## Operations
* Production settings, providers (SMS, push, storage, payments), Super Admin bootstrap, security notes: `docs/DEVELOPMENT.md`
* Backups, restore, moving to another database (for example AWS RDS): `docs/DATABASE_MIGRATION.md`
* Backups, monitoring, keep-alive: `docs/qa/OPERATIONS_RUNBOOK.md`
* App team API handoff: `docs/qa/customer-app-integration-handoff.md`

## Rules
Schema changes only through reviewed migrations (`prisma migrate dev`, then `migrate deploy`). Never run `migrate reset`, `DROP` or `TRUNCATE` on a database with real data. Never commit `.env`, keys or service-account files.
