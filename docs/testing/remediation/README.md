# Backend gap remediation - recorded results (2026-10-09)

Results of real runs on this machine (Windows, Node 24.21.0, Docker Desktop with `postgres:17-alpine` and `redis:7-alpine`). Local only: **no GitHub Actions run happened.**
The remote database named in `.env` (`DATABASE_URL`) was never contacted: every run used a local database passed explicitly.

## Fresh disposable databases (created by this phase, local postgres container)
`sevanest_remediation_ci` (tests) and `sevanest_bootstrap_ci` (CLI and HTTP smoke). `prisma migrate deploy` applied all 8 migrations to each empty database; `prisma migrate diff` (migrations vs `schema.prisma`) reported no difference.

## Final-tree results
| Command | Result |
|---|---|
| `npm run typecheck` | exit 0 |
| `npm run lint` | exit 0 |
| `npm run format:check` | exit 0 |
| `npx prisma validate` | schema valid |
| `npm test` (final tree) | 20 suites, 194 tests passed |
| `npm run test:e2e` | 2 suites, 27 tests passed |
| `npm run test:integration` on fresh `sevanest_remediation_ci` | **32 suites, 610 tests passed** (427 s) |
| `docker build --target runtime` | built; container runs as user `node` |
| API container + worker container (production env, providers disabled, `--init`) | API `/health/live` 200 and `/health/ready` 200; worker process running; both stop on SIGTERM (exit 143, signal re-raised after shutdown hooks) |

Note: the integration run started before the last two unit-only edits (`users.bootstrap.spec.ts`, `env.validation.spec.ts`); no `src/` code changed between that run and the final tree, and the unit/lint/format/typecheck rows above are from the final tree.

## Tests added by this phase
| File | Cases | Covers |
|---|---|---|
| `src/modules/users/users.bootstrap.spec.ts` | 3 | create under lock and audit without credentials; refusal audited; short password refused before any database work |
| `src/modules/verification/document-signature.spec.ts` | 3 | PDF/JPEG/PNG signatures; wrong type, empty, truncated, unknown type refused |
| `src/config/env.validation.spec.ts` (1 added) | 1 | `THROTTLE_STORAGE` validation; production warnings for proxy depth 0 and `memory` store |
| `test/integration/remediation.admin.int-spec.ts` | 7 | bootstrap refused when a Super Admin exists (audited, no email/password in the row, actor null); 6 concurrent attempts create nobody; short password 400; password change revokes other sessions only, old password dead, audit without secrets; wrong current password 422 x3 then lockout 429 and 3 audit rows; min length 400; same password 422; no token 401 |
| `test/integration/remediation.throttle.int-spec.ts` | 3 | counts shared by two storage instances and window expiry; block duration; Redis failure falls back to process memory |
| `test/integration/remediation.notifications.int-spec.ts` | 5 | health body shape and no content; 403 without `notification.manage`, for customer; 401; retry FAILED -> QUEUED once, audited; SENT/QUEUED refused 409; unknown 404, malformed 400, unauthorised 401/403 leave the row FAILED |
| `test/integration/verification.api.int-spec.ts` (1 added) | 1 | HTML and JPEG payloads declared as PDF refused 422 `DOCUMENT_CONTENT_MISMATCH`, document stays `PENDING_UPLOAD`, 2 audit rows; honest re-upload then accepted |
| `test/integration/security.api.int-spec.ts`, `qa.inventory.int-spec.ts` | edited | `POST /admin/account/password` listed as a reviewed no-permission admin route |

## Real CLI run: first Super Admin (production environment, disposable database)
1. Credentials present, no confirmation phrase: refused ("In production set BOOTSTRAP_SUPER_ADMIN_CONFIRM=...").
2. With the phrase: "First Super Admin created".
3. Repeat: refused, exit 1.
4. `npm run seed` with the credentials in production: refused.
5. Database afterwards: 1 user, 1 role assignment, hash format `scrypt$...`, password absent from the hash column; audit actions `admin.bootstrap` then `admin.bootstrap_rejected` (actor role `SYSTEM_BOOTSTRAP`); zero audit rows contain the email or password.

## Real HTTP smoke against `node dist/main` (NODE_ENV=production, SMS/payment/push/WhatsApp/storage `disabled`, `THROTTLE_STORAGE=redis`)
`/health/live` 200, `/health/ready` 200 · admin login 200 (twice, two sessions) · dashboard 200 · `/admin/users` 200 · password change with wrong current password 422 `CURRENT_PASSWORD_INCORRECT` · correct change 200 `{"revokedSessions":1}` · calling session still 200 · other session 401 · old password login 401 · new password login 200 · OTP request 503 (SMS disabled) · unauthenticated admin route 401 · the password does not appear in the API log.
Observed side finding: `/docs` answered 200 because `SWAGGER_ENABLED=true` came from the local `.env` (copied from `.env.example`); production must set it false (S-10).

## Test-database pollution (pre-existing test fragility, not a product defect)
Against the long-lived local `sevanest_test` database three older tests failed (`qa.access` KYC queue lookup with `limit=100`, `verification.api` queue listing, `notifications.api` stale re-queue limited to 100 oldest rows). They depend on a clean database and pass on a fresh one (the 610/610 run). CI uses a fresh service container, so it is unaffected; local developers should recreate `sevanest_test` periodically.

## Not run / blocked
GitHub Actions; any real payment/SMS/push/WhatsApp/S3 provider; reverse proxy/TLS; load; backup restore; multi-replica Redis behaviour; the `readObjectHead` S3 call against a real bucket.

# Phase 2 results (2026-10-09)
Fresh disposable database `sevanest_p2_ci` (local container; 11 migrations applied, no drift). Remote `.env` database never contacted.

| Command | Result |
|---|---|
| typecheck / lint / format:check / build | exit 0 |
| `npm test` | 20 suites, 194 tests passed |
| `npm run test:e2e` | 27 passed |
| `npm run test:integration` (clean run) | 33/34 suites, 629/630 tests; 1 transient 30 s timeout in `matching.api`, which passes alone (11/11) |
| Targeted: remediation2 + qa.statemachine + search.api + modules.workforce | 48 passed |
| Docker production image + API/worker containers | built, ready 200, worker up, bad config aborts start-up |

New suites: `remediation2.discovery.int-spec.ts` (15), `remediation2.operations.int-spec.ts` (5). Detail and caveats: `docs/qa/backend-gap-remediation.md` P2.5.
