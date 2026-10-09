# Users - test results

**Result: PASS** - 29/29 tests passed, 0 failed (2 suites). Run date: 2026-10-08.

Environment: Node 24.21, PostgreSQL 17 and Redis 7 (Docker), dedicated test database `sevanest_test` (real database and Redis for integration tests), in-memory SMS and storage adapters. OTP/lockout limits in the tests are test values, not approved business values.

## Suites

| Kind | File | Passed | Failed |
|---|---|---|---|
| unit | `user-type.guard.spec.ts` | 5 | 0 |
| integration | `users.api.int-spec.ts` | 24 | 0 |

## Manual verification (real running server)

- Real HTTP journey (test database): admin login, customer suspension ends access at once and blocks OTP login, reactivation; dev database seeded with reference data only, 0 users (recorded when Modules 1-3 were verified).

## Results by group

| Group | Passed | Failed |
|---|---|---|
| user-type.guard › UserTypeGuard | 5 | 0 |
| users.api › GET /users/me | 3 | 0 |
| users.api › POST /admin/users (create admin) | 6 | 0 |
| users.api › GET /admin/users/:userId | 2 | 0 |
| users.api › PATCH /admin/users/:userId/status | 7 | 0 |
| users.api › inactive and cross-role access | 3 | 0 |
| users.api › account creation and reference data | 3 | 0 |

## Every test and its result

### `user-type.guard.spec.ts`

- PASS - UserTypeGuard › allows the listed user type
- PASS - UserTypeGuard › allows any listed type when several are given
- PASS - UserTypeGuard › answers 403 for another type without naming the accepted ones
- PASS - UserTypeGuard › answers 403 when no user is attached (guard misordering fails closed)
- PASS - UserTypeGuard › does nothing when no types are declared

### `users.api.int-spec.ts`

- PASS - GET /users/me › answers who a customer is, with no roles or permissions
- PASS - GET /users/me › answers a worker and an admin with their own type, role and permissions
- PASS - GET /users/me › requires authentication
- PASS - POST /admin/users (create admin) › lets a Super Admin create an admin who can then log in
- PASS - POST /admin/users (create admin) › rejects a duplicate email with 409 ADMIN_EMAIL_TAKEN
- PASS - POST /admin/users (create admin) › creates exactly one account when the same request is sent in parallel
- PASS - POST /admin/users (create admin) › enforces the configured minimum password length and field validation
- PASS - POST /admin/users (create admin) › ignores fields a client must not control (mass assignment)
- PASS - POST /admin/users (create admin) › is forbidden to an admin whose role lacks admin.manage_users, to customers, to workers, and to anonymous callers
- PASS - GET /admin/users/:userId › returns the account with the mobile masked
- PASS - GET /admin/users/:userId › returns 404 for an unknown account, 400 for a malformed id, 403 without user.view
- PASS - PATCH /admin/users/:userId/status › suspends a customer: login stops, sessions are revoked, the change is audited with before/after
- PASS - PATCH /admin/users/:userId/status › reactivates a suspended account, which can then log in again
- PASS - PATCH /admin/users/:userId/status › is idempotent: repeating the same status writes no extra audit record
- PASS - PATCH /admin/users/:userId/status › serialises parallel changes: five concurrent suspensions produce one change and one audit record
- PASS - PATCH /admin/users/:userId/status › does not let an admin change their own status
- PASS - PATCH /admin/users/:userId/status › requires admin.manage_users in addition to user.status.manage to change an ADMIN account
- PASS - PATCH /admin/users/:userId/status › answers 404 for unknown users, 400 for bad bodies, 403 without the permission, 403 for non-admins
- PASS - inactive and cross-role access › stops a suspended admin from using any admin endpoint with an existing token
- PASS - inactive and cross-role access › keeps customers and workers out of every admin endpoint
- PASS - inactive and cross-role access › applies a role change on the very next request (permissions are read from the database)
- PASS - account creation and reference data › creates exactly one account when many first-time verifications race for the same mobile
- PASS - account creation and reference data › seeds RBAC reference data idempotently and only maps SUPER_ADMIN
- PASS - account creation and reference data › does not bootstrap a second Super Admin

## Not covered

- Role/permission administration endpoints (not built), the full permission matrix (undefined), an admin user list.
