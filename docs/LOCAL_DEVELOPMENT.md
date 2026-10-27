# Local development (internal)

For developers working on this repository. Everything here is **local only**: the values in `docker.env` are non-secret development defaults, the demo accounts are fake, and the fixed OTP is refused when `NODE_ENV=production`. Never reuse any of it on a shared, staging or production environment.

## Run the whole backend in Docker
Requires Docker. No `.env` file and no Node.js needed.
```bash
git clone https://github.com/syedvpd/sevanest-backend.git
cd sevanest-backend
```
```bash
docker compose --profile app up -d --build
```
Startup order: PostgreSQL 17 and Redis 7 → `migrate` (`prisma migrate deploy`) → `seed` (roles, permissions, categories, pilot areas, starter templates; demo customers and workers only when `SEED_DEMO=true`) → `api` and `worker`. Settings come from `docker.env`.

Check readiness:
```bash
curl http://localhost:3000/health/ready
```
API `http://localhost:3000/api/v1` · Swagger `http://localhost:3000/docs` · OpenAPI `http://localhost:3000/docs/openapi.json`

Logs and stop:
```bash
docker compose --profile app logs -f api worker
```
```bash
docker compose --profile app stop
```

## After a `git pull`
```bash
docker compose --profile app run --rm migrate    # applies pending migrations; never resets or drops
docker compose --profile app run --rm seed       # idempotent seed
docker compose --profile app up -d --build api worker
```

## Local accounts
| Account | Login |
|---|---|
| Admin `admin@sevanest.local` | password in `docker.env`, `POST /api/v1/auth/admin/login` |
| Demo customers `+919000000201` to `+919000000203` | `POST /api/v1/auth/otp/request`, then `POST /api/v1/auth/otp/verify` with `{ "mobile", "appType": "CUSTOMER", "otp": "123456" }` |
| Demo workers `+919000000101` to `+919000000103` | same, `appType: "WORKER"` |

The fixed OTP comes from `ALLOW_TEST_OTP`, `TEST_OTP_NUMBERS` and `TEST_OTP_CODE`; only the listed numbers use it, and config validation forces it off in production. The demo seed (`src/seed-demo.ts`) refuses `NODE_ENV=production` and hosted database hosts. It is OFF by default (no invented people in any database unless you ask): start the stack with `SEED_DEMO=true docker compose --profile app up -d --build` to load it, or run it alone with `npm run seed:demo` against a local database. The demo accounts below exist only after that.

## Reset local data
Deletes the local Docker volumes (PostgreSQL and Redis) of this compose project. Local only, never run against a shared database.
```bash
docker compose --profile app down -v
```

## Troubleshooting
* **Port in use:** set `API_PORT`, `POSTGRES_PORT` or `REDIS_PORT` in the shell, for example `API_PORT=3300 docker compose --profile app up -d`.
* **API not ready:** `docker compose --profile app ps -a` and the `migrate` / `seed` logs; the API waits for both to finish.
* **A parallel stack:** use `docker compose -p <name> ...` with different ports so it does not touch your main one.

## Develop on the host
```bash
cp .env.example .env
npm ci
```
```bash
npm run infra:up
```
```bash
npm run prisma:migrate:deploy
npm run build
npm run seed
npm run seed:launch
```
```bash
npm run start:dev
```
`.env.example` lists every setting. A host `.env` must point `DATABASE_URL` at your local database, never at a shared one. Quality gates: see the README and [DEVELOPMENT.md](DEVELOPMENT.md). Backups and moving databases: [DATABASE_MIGRATION.md](DATABASE_MIGRATION.md).
