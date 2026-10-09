# Admin - test results

**Result: PASS** - 21/21 integration tests passed, 0 failed (1 suite, `admin.api.int-spec.ts`). Run date: 2026-10-12.

Environment: Node 24.21, PostgreSQL 17 and Redis 7 (Docker), dedicated database `sevanest_test`, real HTTP through the full application. The shared role mapping is restored to the seed state (empty for the three non-Super roles) after the suite.

## Results by group

| Group | Passed | Failed |
|---|---|---|
| roles and permissions | 8 | 0 |
| admin accounts | 5 | 0 |
| dashboard | 3 | 0 |
| audit log viewer | 4 | 0 |
| existing admin endpoints stay compatible | 1 | 0 |

## What was proved

- **Role / permission matrix**: roles and permissions are visible and editable only with `role.manage` (an admin holding `admin.manage_users` + `user.view` but not `role.manage`, an Operations Admin and a customer: 403; anonymous 401). Setting a role's permissions takes effect on the **very next request with the same token** (a Support Executive goes 403 -> 200 -> 403 on the ticket list) and is audited with the added/removed lists; repeating the same set changes nothing and writes no second audit row; clearing a role works; five parallel edits end in exactly one of the requested sets.
- **Privilege escalation**: the SUPER_ADMIN role cannot be edited (409 `ROLE_IMMUTABLE`, still holds the whole catalog); `role.manage`, `audit.view`, `admin.manage_users` cannot be mapped to any other role (422 `PERMISSION_RESTRICTED`); unknown codes 422; malformed, duplicate or non-array bodies 400; unknown role 404.
- **Account administration**: `GET /admin/users` filters by type/status, paginates, masks the mobile and shows roles, and never contains a hash; wrong permission, customer: 403. A delegate with `admin.manage_users` can create a Support Executive but not a Super Admin (403); only a Super Admin can. A role change is audited (from/to/reason), applies immediately (403 -> 200 on a report with the same token) and repeating it is a no-op. Refused: own role (409), a delegate granting or taking away Super Admin (403), a customer target (422 `NOT_AN_ADMIN`), unknown target (404), unknown role (400), malformed id (400), wrong caller types (403/401).
- **Last Super Admin**: two Super Admins demoting each other at the same moment (all other Super Admins parked): exactly one request succeeds (200) and the other is refused (403); one Super Admin remains. The actor's roles are re-read under the lock, so a role taken away a moment ago cannot still authorise the call.
- **Dashboard**: a Super Admin sees all six sections and the numbers equal independent database counts (bookings by status total, registered workers, unassigned open tickets, submitted KYC checks); a KYC reviewer sees only `pendingKyc`; support+replacement permissions see only those two; an admin with none sees `{}`; customer 403; anonymous 401; collections are integers in the smallest currency unit.
- **Audit viewer**: one status change is found again by its `x-request-id`, by entity, action, actor, prefix and day, newest first; invalid dates, reversed range, `limit=101`, bad actor id, a malformed prefix are 400; no `audit.view`: 403; POST/PUT/PATCH/DELETE: 404; deleting audit rows is rejected by the database; metadata with a mobile number, a card number, a token, a JWT or a pasted Bearer value written under older rules is redacted on the way out.
- **Compatibility**: bookings, payments, customers, replacements, attendance and user detail admin endpoints answer 200 for the Super Admin as before.

## Not tested

Role changes taking effect across a *revoked* session policy (sessions are not revoked on role change by design: authorization is read from the database on every request), custom roles (not built), password change/reset and MFA (not built, Q-29, Q-62).
