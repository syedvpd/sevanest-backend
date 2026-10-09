# Users

The common identity and account domain: who a user is, their type, account status, admin roles and permissions, and
the account lifecycle (create admin, suspend, reactivate). Customer- and worker-specific data does not live here.

## Requirements covered

| ID                          | Requirement                                 | Where                                                                                         |
| --------------------------- | ------------------------------------------- | --------------------------------------------------------------------------------------------- |
| FR-SEC-001/002, NFR-SEC-003 | Role-based access control for admin users   | roles/permissions tables + guards                                                             |
| FR-SEC-007                  | Suspension of workers and customers         | `PATCH /admin/users/{userId}/status`                                                          |
| FR-SEC-008, NFR-SEC-007     | Audit of user-status changes                | `user.status_change`, `admin.create`                                                          |
| FR-AUTH-004                 | The four admin roles                        | seeded roles `SUPER_ADMIN`, `OPERATIONS_ADMIN`, `VERIFICATION_EXECUTIVE`, `SUPPORT_EXECUTIVE` |
| FRD FM-01                   | Admin accounts are created by a Super Admin | `POST /admin/users`                                                                           |

## Domain model

`users` (type CUSTOMER/WORKER/ADMIN, status ACTIVE/SUSPENDED, mobile or email, optional password hash), `roles`,
`permissions`, `role_permissions`, `user_roles`. Roles and permissions are data. Admin sub-roles are role rows, not enum
values. `users.mobile` holds the verified identity in E.164 form; `users.email` is the admin login identifier.

Users never imports Auth. Auth imports Users and subscribes to `UserEvents`, which Users emits after a status change
commits (Auth then revokes the account's sessions).

## APIs (all under `/api/v1`)

| Method | Path                           | Requires                     | Purpose                                                       |
| ------ | ------------------------------ | ---------------------------- | ------------------------------------------------------------- |
| GET    | `/users/me`                    | any signed-in user           | Identity: id, type, status, mobile, email, roles, permissions |
| POST   | `/admin/users`                 | ADMIN + `admin.manage_users` | Create an admin `{ email, password, roleCode }` (201)         |
| GET    | `/admin/users/{userId}`        | ADMIN + `user.view`          | View an account (mobile masked)                               |
| PATCH  | `/admin/users/{userId}/status` | ADMIN + `user.status.manage` | `{ status: ACTIVE\|SUSPENDED, reason? }`                      |

## Permission codes (seeded)

`admin.manage_users`, `user.view`, `user.status.manage`, `customer.view`, `customer.manage`. Only `SUPER_ADMIN` is mapped
to them. The other three roles hold no permissions until the permission matrix is confirmed.

## Business rules

- An admin cannot change their own status (409 `CANNOT_CHANGE_OWN_STATUS`).
- Changing an ADMIN account also requires `admin.manage_users`.
- Repeating the current status is a no-op: no change, no audit record, no event.
- Suspension takes effect immediately (the guard checks the status on every request) and sessions are revoked after commit.
- Creating an admin enforces `ADMIN_PASSWORD_MIN_LENGTH`, hashes the password with scrypt, and assigns exactly one role.
- Email is lower-cased and trimmed; duplicates answer 409 `ADMIN_EMAIL_TAKEN`.

## Error codes

`USER_NOT_FOUND`, `CANNOT_CHANGE_OWN_STATUS`, `ADMIN_EMAIL_TAKEN`, `ROLE_NOT_FOUND`, plus the shared validation/auth codes.

## Transactions and concurrency

Admin creation (user + role assignment + audit) is one transaction. A status change locks the user row
(`SELECT ... FOR UPDATE`), re-reads it, updates, and writes the audit record in the same transaction, so parallel changes
serialise and produce a single audit record. First-time account creation races on the unique mobile and converges on one row.

## Security

Credential hashes never leave the module's credential lookup used by Auth. No endpoint returns a password hash, the
admin view masks mobiles, and `RequireUserType('ADMIN')` plus a permission guard protect every admin endpoint.

## Seed

`npm run build && npm run seed` ensures the roles, the five permission codes and the Super Admin mapping (idempotent).
For development only, `BOOTSTRAP_SUPER_ADMIN_EMAIL` and `BOOTSTRAP_SUPER_ADMIN_PASSWORD` in the environment create the
first Super Admin if none exists. The bootstrap is refused when `NODE_ENV=production`.

## Known limitations and open decisions

- The role-to-permission matrix (Q-11) is not defined; only Super Admin is mapped.
- There is no `BLOCKED`/blacklist status; the specification does not define it.
- Role and permission administration (create/edit roles, assign users) belongs to the Admin module and is not built.
- There is no admin list/search endpoint for users; customer lists live in Customers.
- Production provisioning of the first Super Admin is an open operational decision.
- Suspending the last active Super Admin is not prevented beyond the rule that nobody can change their own status.

## Admin access administration (Module 18)

`GET /admin/users` (`user.view`: list with type/status filters, masked mobile, roles), `PUT /admin/users/{id}/role` (`admin.manage_users`), `GET /admin/roles[/{code}]`, `GET /admin/permissions`, `PUT /admin/roles/{code}/permissions` (`role.manage`).
The permission matrix is configured here by the Super Admin instead of being seeded (Q-11, Q-33, Q-62). Guards against privilege escalation: the SUPER_ADMIN role is immutable; `role.manage`, `audit.view`, `admin.manage_users` can only be held by it; only a Super Admin may create, promote or demote a Super Admin (checked against the actor's roles under the same lock); nobody changes their own role; the last active Super Admin cannot be demoted. Changes apply on the next request and are audited (`admin.role_change`, `role.permissions_set`).
