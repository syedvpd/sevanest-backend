# 01 — Module and route inventory (Phase 0–1)

Source: repository at branch `claude/sevanest-backend-audit-59ab64` (clean tree at start), commit `6e94a74`.
Route list taken from the **running Nest application metadata** (`test/integration/qa.inventory.int-spec.ts` with `QA_ROUTES_OUT`), not from regex. Full machine-readable list: [endpoint-inventory.csv](endpoint-inventory.csv).

## Baseline facts (verified)

| Item | Value | Evidence |
|---|---|---|
| Stack | NestJS 11.2.7, TypeScript 5.9.3, Prisma 7.10.0, BullMQ 6.3.11, ioredis 6, Node ^24 | `package.json` |
| Reported "NestJS 12, TypeScript 6" | **Wrong**: package.json pins Nest **11**.2.7 and TypeScript **5.9.3** | `package.json` |
| Controllers | 36 files | `src/**/*.controller.ts` |
| HTTP routes registered at runtime | **305** (303 under `/api/v1`, 2 health probes) | qa.inventory run |
| OpenAPI operations (`docs/openapi.json`) | **304** | parsed JSON |
| Reported "252 operations" | **Does not match.** 303 API routes exist. Likely the briefing predates later admin/customer/worker additions. | difference 51 |
| Registered but not in OpenAPI | `POST /api/v1/webhooks/payments` (provider webhook, intentionally hidden) | diff |
| In OpenAPI but not registered | none | diff |
| Duplicate method+path | none (qa.inventory test passes) | test |
| Modules under `src/modules` | **31** (reported 19) | directory listing |
| Prisma models | 58, 83 `@@index`, 45 migrations | schema |
| Queues | `NOTIFICATION_QUEUE` (BullMQ) plus DB-polled loops: notifications, recheck-reminders, abandoned-uploads, claim-release, payment-recovery, booking-checks, support-sla, retention, security-events | `readiness.service.ts` EXPECTED_LOOPS |
| Integrations dirs | http, malware, maps, notifications, payments, storage, verification | `src/integrations` |

Route count per area (path segment after `/api/v1`): admin 162, workers 37, customers 16, auth 9, bookings 8, interviews 8, payments 6, replacement-requests 6, support 6, notifications 5, ratings 5, search 4, safety 4, attendance 3, legal 3, me 3, shortlist 3, users 3, service-areas 2, service-categories 2, fees 2, health 2, others 1 each.

## Public routes (10)

`GET /api/v1/app-config`, `POST /auth/admin/login`, `POST /auth/otp/request`, `POST /auth/otp/verify`, `POST /auth/token/refresh`, `GET /legal/current`, `GET /reference-data`, `POST /webhooks/payments`, `GET /health/live`, `GET /health/ready`.

## Authenticated routes with no user-type, role, or permission gate (20)

Self-service or shared-read routes. Each needs a resource-ownership check in its service, not a decorator. Not yet verified one by one (see AUDIT_PROGRESS).

auth logout/sessions (3), legal accept/status (2), me/deletion-request (3), notifications (5), service-areas (2), service-categories (2), users/me and notification-preferences (3).

Admin routes without a permission/role decorator: `GET /admin/dashboard` (by design: sections filtered per permission, see `dashboard.controller.ts:11`) and `POST /admin/account/password` (self-service).

## Per-module file counts

Module: controllers / services / repositories / DTO files / unit specs.

| Module | C | S | R | DTO | Spec |
|---|---|---|---|---|---|
| alerts | 1 | 1 | 0 | 1 | 0 |
| attendance | 1 | 1 | 1 | 1 | 0 |
| auth | 2 | 6 | 2 | 1 | 3 |
| availability | 1 | 2 | 1 | 1 | 1 |
| booking | 2 | 3 | 2 | 2 | 1 |
| customer-photo | 1 | 1 | 1 | 0 | 0 |
| customers | 1 | 2 | 1 | 1 | 1 |
| earnings | 1 | 1 | 1 | 1 | 0 |
| history | 1 | 1 | 0 | 0 | 0 |
| home | 1 | 0 | 0 | 0 | 0 |
| legal | 1 | 1 | 0 | 1 | 0 |
| matching | 1 | 1 | 0 | 1 | 0 |
| meta | 1 | 0 | 0 | 0 | 0 |
| notifications | 1 | 1 | 1 | 1 | 1 |
| payment | 1 | 2 | 1 | 1 | 2 |
| platform-config | 1 | 1 | 1 | 1 | 0 |
| ratings | 1 | 1 | 1 | 1 | 0 |
| replacement | 1 | 1 | 1 | 1 | 0 |
| reports | 2 | 2 | 1 | 1 | 0 |
| retention | 1 | 1 | 0 | 0 | 0 |
| safety | 1 | 1 | 0 | 1 | 0 |
| search | 1 | 1 | 1 | 1 | 1 |
| service-categories | 1 | 2 | 1 | 1 | 1 |
| shortlist | 1 | 1 | 1 | 1 | 0 |
| support | 1 | 1 | 1 | 1 | 0 |
| system | 1 | 1 | 0 | 0 | 0 |
| users | 1 | 3 | 1 | 2 | 1 |
| verification | 2 | 1 | 1 | 1 | 2 |
| worker-photo | 1 | 1 | 1 | 1 | 0 |
| workers | 1 | 1 | 1 | 1 | 0 |

DTO counts count `*.dto.ts` files only; some modules keep DTOs in `dto/` subfolders or inline. Zero unit specs does not mean untested: 71 integration specs exercise most modules through HTTP. Per-module coverage mapping is **not yet done**.

## Per-route detail

`endpoint-inventory.csv` holds, for all 305 routes: method, path, controller, handler, public flag, user types, permissions, roles and whether the route is in OpenAPI. The remaining columns of the brief are covered per area, not per route:

- request/response shapes, validation and status codes: `02_API_CONTRACT_AUDIT.md` (all 304 operations scanned);
- existing and missing tests: `03_MODULE_NEGATIVE_TEST_REPORT.md` (named suites per batch);
- statements per request, database time and N+1 reading for 212 route templates: `04_query_counts_per_route.json` and 04;
- latency: `05_api_performance_baseline.csv` (206 operations);
- cache behaviour: none. No application-level response cache exists except `ETag`/304 on customer home and admin If-Match. Phase 6 below.

## Phase 6 — caching (decision, no change)

No cache was added. The measured reads are already 5 to 100 ms and the one slow read, customer home, already supports `ETag`. Candidates considered and rejected for now: service categories and areas (2 to 3 statements, 8 to 17 ms), platform configuration and reference data (single fast read), home and dashboard summaries (user-specific, change on every booking event; staleness risk outweighs a 50 ms gain). Authorization is read from PostgreSQL on purpose so a suspension applies at once (tested); caching it would break that requirement. If a cache is introduced later, the safe first target is public reference data with a short TTL and explicit invalidation on admin writes, with Redis failure falling back to the database (which the app already does for reads).
