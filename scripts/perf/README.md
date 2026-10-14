# Performance test and Postman collection

Two things live here, both for the WHOLE API (every module, every operation), not a single endpoint.

## 1. Performance test (not a load test)

One client, strictly sequential. Each iteration walks every module through its lifecycle on a real HTTP port (create, read, list, update,
state changes, delete) and times every call; repeating the iteration gives the first hit, the second hit and the p50/p95/p99.
Nothing runs in parallel, so this measures how fast the API answers, not how many users it survives (for that see `scripts/load/`).

```bash
# 1. a disposable local database (the guard refuses anything not named *_ci or *_test)
docker exec sevanest-postgres-1 psql -U sevanest -d postgres -c "CREATE DATABASE sevanest_perf_ci"
export DATABASE_URL=postgresql://sevanest:<password>@localhost:5432/sevanest_perf_ci
export TEST_DATABASE_URL=$DATABASE_URL
npx prisma migrate deploy

# 2. run the journeys (PERF_ITERATIONS = how many times; 15 is the recorded run)
PERF_ITERATIONS=15 PERF_OUT=test/perf/out node --experimental-vm-modules ./node_modules/jest/bin/jest.js \
  --config test/jest-integration.config.js --runInBand --forceExit --testRegex "perf/perf-journeys\.perf-spec\.ts$"

# 3. the OpenAPI document of that build (used for module names) and the report
PERF_OUT=test/perf/out node --experimental-vm-modules ./node_modules/jest/bin/jest.js \
  --config test/jest-integration.config.js --runInBand --forceExit --testRegex "perf/perf-dataset\.perf-spec\.ts$"
node scripts/perf/report.mjs            # writes docs/qa/performance-test-results.md and .csv
```

Notes

* The journeys live in `test/perf/perf-journeys.perf-spec.ts`. They use the in-process app of the integration tests (fake payment gateway,
  in-memory SMS and storage) behind a real HTTP port, so the client talks to the server over loopback. Network latency and TLS are not
  included: a hosted deployment adds its round trip on top.
* Raw samples are written to `test/perf/out/journeys.json` (ignored by git: it also holds throwaway tokens of the local database).
* If the machine sleeps or stalls during a run the report shows one huge sample and a 500; rerun it.
* Never point it at staging or production: it creates users, bookings and payments, and the database guard refuses anything that is not a
  disposable `*_ci` / `*_test` database.

## 2. Postman collection

`postman/SevaNest.postman_collection.json` (every operation, 54 module folders, lifecycle order) and
`postman/SevaNest.local.postman_environment.json`. Regenerate it after the API changes:

```bash
curl http://localhost:3000/docs/openapi.json -o test/perf/out/openapi.json     # needs SWAGGER_ENABLED=true
node scripts/perf/generate-postman.mjs
```

Use: import both files, select the environment, fill `adminEmail` / `adminPassword` and your test OTP numbers, run "00 Start here" first (it
sets the three tokens), then the module folders from top to bottom. Each request checks no 5xx, a documented success or a business-state
answer (404/409/422), response time under `slowMs`, and the standard error envelope; create and list requests store ids in collection
variables for the requests after them. With Newman: `newman run postman/SevaNest.postman_collection.json -e postman/SevaNest.local.postman_environment.json`.
