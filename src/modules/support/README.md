# Support / Complaints

Tickets raised by customers and workers and worked by staff.

## Requirements covered

FR-SUP-001..006, FR-ON-003, FR-WJ-010, FRD FM-12 (category from a configured list, description, owner, escalation, resolution on close, history retained), AC-08.

## APIs (`/api/v1`)

| Who              | Endpoint                                                                      | Notes                                                                                                                                                                       |
| ---------------- | ----------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Customer, Worker | `GET /support/categories`                                                     | Enabled categories only.                                                                                                                                                    |
| Customer, Worker | `POST /support/tickets {categoryId, description, bookingId?}`                 | A `bookingId` must be a booking the caller is a party to (the customer, or the booking's worker); otherwise 404.                                                            |
| Customer, Worker | `GET /support/tickets`, `GET /support/tickets/{id}`                           | Own tickets only; a stranger's ticket answers exactly like an unknown one (404). History shows what happened and when; staff notes and staff identities are never included. |
| Admin            | `GET /admin/support/tickets[/{id}]`                                           | `support.view`; filter by status, priority, owner, unassigned, category, booking, creator kind.                                                                             |
| Admin            | `POST /admin/support/tickets/{id}/assign`, `/priority`, `/escalate`, `/close` | `support.manage`; assignee must be an active admin holding `support.manage`.                                                                                                |
| Admin            | `GET/POST/PATCH /admin/support/categories`                                    | list `support.view`; change `support.category.manage` (audited).                                                                                                            |

## Lifecycle

`OPEN` -> `IN_PROGRESS` (first assignment) -> `ESCALATED` -> `CLOSED` (resolution required). A closed ticket is final (409 `TICKET_CLOSED`). Every change locks the ticket row, appends an immutable history line (database trigger blocks update/delete), writes an audit record and tells the creator (`TICKET_UPDATE` notification) in the same transaction. Database CHECKs keep CLOSED and "has resolution" equivalent.

## Not built (the specs give no value or rule - Q-59)

SLA targets and automatic escalation on breach, automatic owner assignment and priority rules, reopening, attachments, a chat thread, the effect of "report/block", the safety-incident route to Operations/Super Admin. Priority is a PROPOSED LOW/MEDIUM/HIGH set by staff only. Categories are admin data and none are seeded, so no ticket can be raised until an administrator adds one.
