# Support - test results

**Result: PASS** - 15/15 integration tests passed, 0 failed (1 suite, `support.api.int-spec.ts`). Run date: 2026-10-12.

Environment: Node 24.21, PostgreSQL 17 and Redis 7 (Docker), dedicated database `sevanest_test`, real HTTP through the full application.

## Results by group

| Group | Passed | Failed |
|---|---|---|
| categories | 2 | 0 |
| raising a ticket | 5 | 0 |
| ownership | 2 | 0 |
| staff handling | 6 | 0 |

## What was proved

- **Create**: customer and worker tickets are OPEN with a `CREATED` history line; the stored creator kind comes from the token, not the body. Blank, over-long and malformed input is 400; an unknown or disabled category is 422 `SUPPORT_CATEGORY_INVALID`.
- **Booking link**: only a party to the booking (its customer, its worker) may attach it; a stranger customer, another worker and an unknown booking all get 404 `BOOKING_NOT_FOUND`.
- **Ownership**: a stranger's ticket answers 404 with the same code as an unknown ticket; lists are scoped to the caller; a worker cannot read a customer ticket; admins get 403 on the user endpoints.
- **Protected content**: after assign/escalate/priority the creator's view contains no internal note, no staff id, no `actorUserId`, no priority.
- **Role permissions**: `support.view` lists/reads; every change needs `support.manage` (viewer, customer: 403; anonymous: 401; ticket unchanged). Categories need `support.category.manage` and are audited; codes are unique (409).
- **Lifecycle**: assign (to self) moves to IN_PROGRESS, priority, escalate (repeating is a no-op), close needs a non-blank resolution; history order `CREATED, ASSIGNED, PRIORITY_SET, ESCALATED, CLOSED`; a closed ticket answers 409 `TICKET_CLOSED` to every further change; audit actions and creator notifications (IN_PROGRESS, ESCALATED, CLOSED; recipient = creator only) match.
- **Assignment**: only an active admin holding `support.manage`; a viewer, a customer, an unknown user and a suspended admin are 422 `ASSIGNEE_INVALID`.
- **Concurrency**: five parallel closes: exactly one 200, four 409, one `CLOSED` history row.
- **Database**: ticket history rejects UPDATE/DELETE (trigger); setting CLOSED without a resolution is rejected (CHECK).
- **Audit**: `ticket.create` carries category and booking but not the description.

## Not tested / not built

SLA, auto-escalation, auto-assignment, reopen, attachments, report/block effect (Q-59). Notification delivery of `TICKET_UPDATE` (the outbox event is asserted; delivery needs templates and a provider).
