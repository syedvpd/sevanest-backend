# Admin session restoration and permission consistency (2026-10-14)

Report: Verification Executive signs in, sees the verification queues, and after a browser refresh or a direct visit to `/workers` the portal shows
"Access Restricted - Required permission: workers.view".

## 1. Root cause (confirmed in code and tests)

The backend never lost or corrupted the permission. Permissions are resolved from the database on every request
(`AuthorizationService` / `AuthRepository.getRoleAndPermissionCodes`); the JWT carries only `sub` and `sid`, nothing is cached across requests,
and a role change applies on the next request. Two real contract defects and one naming mismatch remained:

| # | Finding | Evidence | Status |
|---|---|---|---|
| 1 | **`POST /auth/token/refresh` returned no `roles` or `permissions`**, while `POST /auth/admin/login` returned `roles`. A client that restores a session through refresh (the normal page-reload path) gets an identity with nothing to build a permission set from, and any client that kept the login-time list has nothing to compare it with. | `auth.controller.ts` refresh returned `{id,type,isNewUser}` only | **Fixed** (additive fields) |
| 2 | **Login returned `roles` but not `permissions`.** The only place a permission list existed was `GET /users/me`, so the three calls disagreed in shape. | `AuthUserSummary` had `roles?` only | **Fixed** (additive field) |
| 3 | **Code mismatch: the catalog code is `worker.view` (singular); `workers.view` does not exist** in the backend, the seed, the docs or any route. A check for `workers.view` can never succeed for any role, including Super Admin. All three worker routes require `worker.view`. | `rbac.constants.ts` `PermissionCode.WORKER_VIEW`; `docs/qa/RBAC_MATRIX.md` | **Frontend contract fix** (use `worker.view`); no alias added |

Finding 3 is the most likely cause of the exact banner. I could not inspect the frontend, so this is stated as the strongest hypothesis, not as proof.
`workers.view` was deliberately NOT added as an alias or granted: the approved policy (D-71) gives the Verification Executive `worker.view`, and a second
spelling would fork the contract.

Not verifiable from this workspace (needs a read of the live staging database): whether the Verification Executive role there actually holds `worker.view`.
The D-71 seed only fills a role that holds NO permission, so a role that a Super Admin had already edited by hand (for example set to only
`verification.review` to unblock the queue) never received `worker.view`. Check with the SQL in section 9; if it is missing, a Super Admin fixes it with
`PUT /api/v1/admin/roles/VERIFICATION_EXECUTIVE/permissions` (no production role was changed here).

## 2. Files changed

- `src/modules/auth/auth.service.ts` - admin login returns `user.permissions` (same lookup as `roles`).
- `src/modules/auth/session.service.ts` - refresh re-reads an ADMIN's roles and permissions from the database after rotation.
- `src/modules/auth/auth.controller.ts` - refresh response includes `roles` and `permissions` for admins.
- `src/modules/auth/dto/auth.dto.ts` - `AuthUserSummary.permissions?` and clearer descriptions (OpenAPI).
- `test/integration/admin.session.permissions.int-spec.ts` - 16 new tests (section 6).

No migration, no seed change, no change to guards, JWT claims or token validation.

## 3. Before and after

| Call | Before | After |
|---|---|---|
| `POST /auth/admin/login` | `user: {id,type,isNewUser,roles}` | `user: {id,type,isNewUser,roles,permissions}` |
| `POST /auth/token/refresh` (admin) | `user: {id,type,isNewUser}` | `user: {id,type,isNewUser,roles,permissions}`, read from the database at refresh time |
| `POST /auth/token/refresh` (customer, worker) | `user: {id,type,isNewUser}` | unchanged (no roles, no permissions) |
| `GET /users/me` | `roles`, `permissions` | unchanged; always equals the set in login / refresh unless a role change happened in between |

All additions are optional fields; no existing field changed name, type or meaning.

## 4. Permission matrix (seeded defaults, D-71; Super Admin = whole catalog of 34)

| Capability | Super Admin | Operations Admin | Verification Executive | Support Executive |
|---|---|---|---|---|
| `worker.view` (worker list, detail, availability) | yes | yes | **yes** | yes |
| `worker.manage` | yes | yes | no | no |
| `verification.review` (queue, requirements, worker verification) | yes | no | **yes** | no |
| `verification.decide` (approve / reject / recheck) | yes | no | yes | no |
| `verification.document.view` (open KYC document link) | yes | no | yes | no |
| `verification.configure` | yes | no | no | no |
| booking / customer / payment-view / report / rating / replacement / attendance | yes | per `DEFAULT_ROLE_PERMISSIONS` | no | booking.view, customer.view, rating.view |
| support.view / support.manage | yes | support.view | no | yes |
| `role.manage`, `audit.view`, `admin.manage_users` | yes | never | never | never |

Authoritative source: `DEFAULT_ROLE_PERMISSIONS` in `src/modules/users/rbac.constants.ts`; the live mapping is whatever a Super Admin has set
(`GET /admin/roles`). Missing permission is never a wildcard: a role with none gets 403 on every permissioned route and 200 only on the dashboard shell.

## 5. Authorization enforcement (checked, no change needed)

- No token / malformed / forged / unsigned token: 401 (`UNAUTHENTICATED`). Authenticated without the permission: 403 (`FORBIDDEN`). Wrong user type: 403. Unknown id with the permission: 404.
- Verification queue = `verification.review`; worker list/detail = `worker.view`; KYC document link = `verification.document.view` (separate, so review-only cannot open documents).
- Role / permission hints in the token payload, headers or query are ignored (the server reads roles from the database by session user).

## 6. Tests

New: `test/integration/admin.session.permissions.int-spec.ts` (16 tests): VE login/refresh//users/me identical and canonical; non-admin refresh unchanged;
refresh rotation; role change visible to the old access token at once and in the next refresh and `/users/me`; no wildcard; worker endpoints with and
without `worker.view`; queue vs document separation; cross-type 403; tampered / unsigned token; malformed tokens; logout; revoked and expired sessions;
parallel refresh; four-role matrix. With the source fix reverted, the two contract tests fail and the rest pass (enforcement was already correct).

## 7. API contract changes

Additive only: `user.permissions` on admin login and admin refresh, `user.roles` + `user.permissions` on admin refresh. OpenAPI updated through the DTO.

## 8. Outstanding gaps and clarifications

| Contract | Current | Expected | Needs |
|---|---|---|---|
| Permission spelling | Catalog uses singular, dotted codes: `worker.view`, `customer.view`, `booking.view`, `verification.review` | Frontend checks must use exactly these codes | Frontend contract clarification (list: `GET /admin/permissions`, Super Admin only; or the table above) |
| Concurrent refresh | Two refreshes with the same token: one succeeds, the replay revokes the session (design, no grace period) | A client must serialize restoration to ONE refresh call (React StrictMode / two tabs can double-fire it). A grace window would weaken theft detection and needs a decision | Frontend fix; backend change only if the owner approves a grace period |
| Live VE role mapping | Unknown from here | Contains `worker.view` per D-71 | Operational check / Super Admin `PUT` (section 9) |
| Permissions in the access token | Not present, by design (always read from the database) | Frontend must call `/users/me` or use the login/refresh `user.permissions`; never decode the JWT | Frontend clarification |

## 9. Safe manual verification (authorized test account only)

1. Sign in as the Verification Executive test account: `POST /api/v1/auth/admin/login`. Confirm `user.permissions` contains `verification.review` and `worker.view`.
2. `POST /api/v1/auth/token/refresh` with the returned refresh token: `user.roles` and `user.permissions` must equal step 1. Use the NEW refresh token next time.
3. `GET /api/v1/users/me` with the refreshed access token: same set.
4. `GET /api/v1/admin/workers` with that token: 200 when `worker.view` is held, otherwise 403.
5. Staging data check (read only, as the database owner): `select p.code from roles r join role_permissions rp on rp.role_id=r.id join permissions p on p.id=rp.permission_id where r.code='VERIFICATION_EXECUTIVE' order by 1;` (table names per `prisma/schema.prisma`). If `worker.view` is absent and policy says it should be there, a Super Admin sets it through `PUT /admin/roles/VERIFICATION_EXECUTIVE/permissions` with the complete list.
Never paste tokens or passwords into tickets or logs.
