# SevaNest Backend

REST API for the SevaNest household-workforce marketplace (Customer app, Worker app, Admin portal).
NestJS modular monolith · PostgreSQL (source of truth) · Redis + BullMQ (non-authoritative) · Prisma.

Requirements live in `docs/project-specifications/`.

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
```

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
npm run test:integration                               # needs `npm run infra:up` + migrations; rolls back all writes
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
