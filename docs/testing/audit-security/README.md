# Audit and security hardening - test results

**Result: PASS** - 25/25 integration tests (`security.api.int-spec.ts`) plus unit tests for redaction and the three guards. Run date: 2026-10-12.

Environment: Node 24.21, PostgreSQL 17 and Redis 7 (Docker), dedicated database `sevanest_test`, real HTTP through the full application. This is the focused development-phase check, **not** the exhaustive security audit (next phase).

## Results by group

| Group | Passed | Failed |
|---|---|---|
| route inventory (every endpoint explicitly protected) | 6 | 0 |
| permission bypass attempts | 6 | 0 |
| refused access is recorded | 5 | 0 |
| authentication events | 1 | 0 |
| sensitive data never leaves the API | 1 | 0 |
| error handling and transport | 4 | 0 |
| privileged state changes are audited / audit is append-only | 2 | 0 |
| unit: `audit.service` redaction (+1), `guards`/`user-type` denial events | 29 (3 suites run for this check) | 0 |

## What was proved

- **Inventory** (159 routes discovered from the running application): exactly seven routes are public (OTP request/verify, token refresh, admin login, two health probes, payment webhook); every other route carries a user-type restriction except eight reviewed "any signed-in user" routes that the service scopes to the caller or to reference data; every `/admin` route is admin-only and has an explicit permission, except the dashboard, whose sections are gated per permission; no admin route sits in a customer/worker controller; every permission code used exists in the catalog and **every catalog permission guards at least one endpoint**.
- **Bypass matrix** (every route x every wrong caller, generated from the inventory): anonymous -> 401 on all protected routes; forged/tampered/malformed token -> 401; a customer, a worker or an admin on a route of another user type -> 403 (never 200/404/500); an admin with no permission -> 403 on every permission-guarded route; an admin holding only `report.view` -> 403 on every other permission-guarded route; a suspended admin with an older token -> 401.
- **Refused access is recorded**: who, method, **route pattern** (not the URL), which check refused (`USER_TYPE` / `ROLE` / `PERMISSION`) and caller type; a secret in the query string, a request body value and a path id are *not* stored; allowed and anonymous calls record nothing; the same 403 is returned (no detail leaked) when the audit write fails; the Super Admin finds the entries in the audit viewer.
- **Authentication events**: wrong-OTP attempts and the lockout write `auth.otp_failed` without the mobile number or the code.
- **Leakage scan**: 13 representative responses (identity, sessions, admin user list/detail, roles, audit log, customers, payments, notifications, booking, own payments) contain none of `passwordHash`, refresh-token hashes, storage keys, OTP hashes or secrets, nor a password-hash prefix.
- **Errors**: unknown route, malformed JSON, bad token, malformed id, absurd body all return the single envelope with a request id (equal to the `x-request-id` header) and no stack, SQL, file path or library name; a simulated database failure with a connection string and password in its message returns a generic 500 with none of it; helmet headers present, `x-powered-by` absent; a 2 MB body is 413.
- **Audit coverage of privileged changes**: fee, category create/update, area, verification requirements, user status, role-permission changes all leave an audit record with the acting admin; the audit table rejects UPDATE, DELETE and TRUNCATE.
- **Redaction** (unit): keys for mobile, phone, email, card number, CVV, IFSC, PIN, JWT, bearer are redacted at any depth in addition to the earlier list; a JWT or `Bearer ...` value is redacted even under an innocent key; `pincode` and ordinary prose are left alone; the audit viewer redacts again on read.

## Mutation checks

- Removing the Super-Admin-only restriction on role permissions fails the "refuses privilege escalation" test.
- Removing the denial audit from `PermissionsGuard` fails two "refused access is recorded" tests.

## Cross-module verification pass (once, after Module 19)

| Check | Result |
|---|---|
| `npm run typecheck`, `npm run lint`, `npm run format:check`, `npm run build` | exit 0 |
| Unit | 182/182 (17 suites) |
| e2e (infrastructure stubbed) | 27/27 (2 suites) |
| Integration (real PostgreSQL + Redis, all suites) | 542/542 (22 suites): 89 new (ratings 13, support 15, reports 15, admin 21, security 25) + 453 existing, all green |
| `prisma validate`, `migrate status`, `migrate diff` against the dev and the test database | valid, up to date, no drift |

## Defects found while testing

1. Hiding a rating returned 500 (negative upsert vs CHECK) - fixed (see `docs/testing/ratings`).
2. Test setup created Super Admins with a "TEST_SETUP" actor; the new rule that only a Super Admin (or the system bootstrap) may create a Super Admin required the setup to use the system bootstrap actor - test helper updated, production rule unchanged.

## Not tested / not done (be honest)

Exhaustive penetration-style testing, dependency audit, fuzzing, timing side channels, load/rate-limit behaviour of the new endpoints beyond the global throttler (Q-64), Redis-outage behaviour, a real-server manual run after this batch, Docker image rebuild, the GitHub CI workflow (never run on GitHub), real SMS/payment/push/WhatsApp/storage vendors.
