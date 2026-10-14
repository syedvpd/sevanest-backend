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

## 1b. Run the same kind of test against Render (or any URL)

The harness above builds its own data in a local database, so it cannot target a hosted server. `run-remote.mjs` is the version for a
deployed API: it needs only the URL and a test login, uses the public API only, and writes the same file the report understands.

```bash
export PERF_BASE_URL=https://sevanest-backend.onrender.com
export PERF_CUSTOMER_MOBILE=+919999900001      # a test number in TEST_OTP_NUMBERS on that server
export PERF_WORKER_MOBILE=+919999900002        # a second test number (optional: worker routes are skipped without it)
export PERF_OTP_CODE=123456                    # the server's TEST_OTP_CODE
export PERF_ADMIN_EMAIL=...                    # a staff account (optional: admin routes are skipped without it)
export PERF_ADMIN_PASSWORD=...
export PERF_ITERATIONS=15
# export PERF_WRITES=1                         # optional: also run reversible write lifecycles (never on production)

node scripts/perf/run-remote.mjs
node scripts/perf/report.mjs test/perf/out-remote docs/qa      # writes docs/qa/performance-test-results.md and .csv
```

What it does: times `GET /health/live` first (on Render's free tier a sleeping service shows its cold start there), signs in once per role
with the staging test OTP and the admin login, finds real ids through the list endpoints, then repeats a sweep of every GET operation it can
fill in, in the right role, `PERF_ITERATIONS` times, and records each call. With `PERF_WRITES=1` it also creates and removes an address,
adds and removes a shortlist entry, sets and clears a device token and marks notifications read, so create, update and delete are timed too.
It never creates bookings, payments, tickets or users, so a hosted database is not filled with test records.

Limits to know

* It measures the full path: your network, TLS, Render and the database. Run it from the place your users are (or from your laptop and from a
  server in the same region) and say which when you quote numbers. Render free instances sleep after idle time: run it twice, once cold and
  once warm.
* Booking, payment, interview, attendance, replacement and rating flows need a real worker, a real payment and real time to pass, so the
  deployed run times their read endpoints against your existing data; the full state-changing lifecycles are covered by section 1 on a local
  database, and by the Postman collection below for manual runs.
* The OpenAPI document must be reachable (`SWAGGER_ENABLED=true`, as on staging), or save a copy and set `PERF_OPENAPI=path/to/openapi.json`.
* OTP resend cooldown is 30 s per number, so the first login may wait that long if you just logged in.
* Credentials are only read from the environment and never printed or stored.

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
