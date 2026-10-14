# Customer app — support, safety, notifications and push (Module 10)

Base URL `/api/v1`. Auth: `Authorization: Bearer <accessToken>` (customer or worker) unless noted. Errors use the standard envelope `{code, message, details?, requestId}`. Question-by-question status: `docs/BACKEND_REQUESTS.md` (45–54).

Verified by: `test/integration/module10.support-safety-notifications.int-spec.ts`, `src/integrations/notifications/fcm.provider.spec.ts`, `src/config/app-config.service.spec.ts`. **Not verified:** Firebase, any real device, any live data (see §9).

## 1. App config and FAQ

`GET /app-config` (public) → `support: { "phone": string | null, "email": string | null }`.
Environment keys (owner: client/operations supplies the values; nothing is invented): `SUPPORT_CONTACT_PHONE`, `SUPPORT_CONTACT_EMAIL`. Unset or blank → `null` (the app disables Call/Email). `/app-config` is cached by clients per their own policy; the values apply after an API restart.

FAQ/help: **no endpoint** — no approved content exists (blocked on product input, see BACKEND_REQUESTS 45).

## 2. Support tickets

| Endpoint | Notes |
|---|---|
| `GET /support/categories` | Enabled categories `[ {id, code, name} ]`. Admin data; none are seeded, so tickets cannot be raised until staff add one. |
| `POST /support/tickets` | Optional `Idempotency-Key`. 201 `TicketDetail`. |
| `GET /support/tickets?status=&page=&limit=` | Own tickets, newest first (`createdAt`, then id). |
| `GET /support/tickets/{id}` | `TicketDetail`; 404 `TICKET_NOT_FOUND` for unknown **and** other people's tickets. |
| `POST /support/tickets/{id}/messages` | `{body}` (1–2000, no `<` `>`). 201 `Message`. 409 `TICKET_CLOSED`. Optional `Idempotency-Key`. |
| `GET /support/tickets/{id}/messages?page=&limit=` | Paginated `Message`s, **oldest first, ordered by `createdAt` then `id`**. Staff internal notes never appear. |

Create request:

```json
{ "categoryId": "uuid", "subject": "Worker did not come", "description": "She did not arrive at 9am today.", "bookingId": "uuid" }
```

| Field | Rule |
|---|---|
| `categoryId` | required, an enabled category, else 422 `SUPPORT_CATEGORY_INVALID` |
| `subject` | optional, 1–120 |
| `description` | required, **trimmed length 10–4000**, else 400 |
| `bookingId` | optional; must be a booking the caller is a party to (customer, or the booking's worker), else 404 `BOOKING_NOT_FOUND`. Payment, replacement and interview problems are all linked through their booking; no other entity id is accepted. |
| priority / urgent | **not accepted**: unknown fields are silently stripped, so a `priority` in the request has no effect. Priority is staff-only. |
| attachments | **not supported** (no safe upload route exists; blocked, BACKEND_REQUESTS 46) |

`TicketDetail` response (customer view):

```json
{
  "id": "uuid", "category": {"id":"uuid","code":"PAYMENT_ISSUE","name":"Payment issue"},
  "bookingId": "uuid|null", "subject": "string|null", "description": "string",
  "status": "OPEN|IN_PROGRESS|ESCALATED|CLOSED", "resolution": "string|null",
  "dueAt": "ISO|null", "createdAt": "ISO", "closedAt": "ISO|null",
  "history": [ {"type":"CREATED","fromStatus":null,"toStatus":"OPEN","createdAt":"ISO"} ]
}
```

`Message`: `{ "id", "from": "CUSTOMER|WORKER|ADMIN", "body", "createdAt" }` (staff are not identified).

### Lifecycle (from `SupportService`)
`OPEN` → `IN_PROGRESS` (first staff assignment) → `ESCALATED` (staff escalate; internal; still being worked) → `CLOSED` (staff close; `resolution` required and shown to the customer). Escalate may be applied from OPEN or IN_PROGRESS; repeating it changes nothing. **CLOSED is final**: no message (409 `TICKET_CLOSED`), no staff action, no reopen — the customer raises a new ticket. Suggested labels: OPEN "Open", IN_PROGRESS and ESCALATED "In progress", CLOSED "Closed" with `resolution`. "Waiting for you" and "Resolved" do not exist (Q-108).

`history[].type` — closed set, written by the service:

| type | meaning | statuses |
|---|---|---|
| `CREATED` | ticket raised | null → OPEN |
| `ASSIGNED` | an owner was set; the first one moves OPEN → IN_PROGRESS | from → to |
| `PRIORITY_SET` | staff changed priority (the priority and who are not shown) | unchanged |
| `ESCALATED` | staff escalated | → ESCALATED |
| `CLOSED` | closed with a resolution | → CLOSED |

History lines are ordered oldest first and expose only `type, fromStatus, toStatus, createdAt`. Never exposed to the customer: staff notes, escalation reasons, priority, staff ids, SLA breach flag.

### The first message
The `description` is **not** stored or returned as a message. Render `ticket.description` as the first bubble; the message list holds only what was written afterwards. Do not de-duplicate by comparing text.

### Safety-category tickets
No category is special-cased and no prioritisation is promised. Do not tell the customer a safety ticket is prioritised. For incidents use `POST /safety/reports` (§3), which alerts staff (`SAFETY_CONCERN` raises a CRITICAL alert).

## 3. Safety reports and blocks

| Endpoint | Notes |
|---|---|
| `POST /safety/reports` | 201 `{id, reasonCode, createdAt}`. Send `Idempotency-Key`. |
| `POST /safety/blocks` | 200 `{id, workerId, createdAt}`. Repeating is harmless; also honours `Idempotency-Key`. |
| `GET /safety/blocks` | The caller's blocks, newest first: `[ {id, workerId, createdAt} ]` (customers see the worker reference; workers see `workerId: null`). Not paginated (a person blocks few people). |
| `DELETE /safety/blocks/{id}` | 204. 404 for someone else's block; 409 `BLOCK_ADMIN_APPLIED` when staff applied it. |

Report request:

```json
{ "reasonCode": "MISCONDUCT", "bookingId": "uuid", "workerId": "uuid", "note": "What happened (max 1000)", "alsoBlock": true, "reason": "optional block text (max 500)" }
```

- `reasonCode`: `HARASSMENT, THEFT, SAFETY_CONCERN, MISCONDUCT, FRAUD, NO_SHOW, OTHER` (also in `/reference-data`). Anything else → 400. Lateness, leaving early, wrong attendance and work quality are **not** safety reasons: use the attendance exception flow or a support ticket.
- `note` — the reporter's account; staff only; stored on the report; kept out of the audit log. **The app should send `note`.**
- `reason` — only the text kept with the block when `alsoBlock: true` (the reason code is used if absent). It is not stored on the report.
- Target: `workerId` and/or `bookingId`. `bookingId` must be the customer's own booking with an assigned worker. If both are given, the worker must be the one on that booking. Otherwise 404 `SAFETY_TARGET_NOT_FOUND` (identical for unknown and not-yours). Neither given → 400 `SAFETY_TARGET_REQUIRED`.
- Idempotency: the same `Idempotency-Key` + same body returns the first response with header `Idempotent-Replay: true`, also under concurrent retries (a request still in flight may answer 409 `IDEMPOTENCY_IN_PROGRESS` — retry). Same key with a different body → 422 `IDEMPOTENCY_KEY_REUSED`. Keys are per signed-in user.
- The response `id` is the **report id**. No support ticket is created or linked.
- Rate limiting: the global throttle applies. Staff access is `support.view` (`GET /admin/safety/reports`); other customers cannot read reports.
- Effect of a block (existing behaviour): neither side is shown to the other in search, shortlist, matching, replacement candidates, and they cannot be booked together.

## 4. Device tokens and logout

| Endpoint | Behaviour |
|---|---|
| `PUT /auth/device-token` `{token, platform: ANDROID|IOS}` | 204. Binds the token to the **current session**. A token already bound to another session (reinstall, another account on the phone) moves here. |
| `DELETE /auth/device-token` | 204. **New.** Removes the current session's token only. Idempotent. Session stays valid. |
| `POST /auth/logout` | 204. Revokes the session; its token is removed with it (DB cascade). Other devices keep theirs. |

Model: one token per session; a person with several devices has several. Sessions that end (logout, revoke, refresh-token replay, suspension) drop their token. Tokens are never logged or returned (the admin delivery log shows no token).

Invalid tokens: when FCM answers HTTP 404 / `UNREGISTERED`, or HTTP 400 `INVALID_ARGUMENT` naming the registration token, the provider raises `InvalidDeviceTokenError`; delivery deletes that binding, still sends to the person's other devices, and finishes `SKIPPED` / `NO_VALID_DEVICE` if none remain. Any other FCM error (bad payload, credentials, 5xx, timeout) keeps the token and follows the normal retry/fail path (`PROVIDER_ERROR` retried with backoff; `PROVIDER_REJECTED` fails at once). If one device succeeds and another fails transiently, the notification counts as sent (no duplicate pushes on retry).

## 5. FCM data payload (push)

Notification part: `title`, `body` from the admin-configured PUSH template (placeholders are ids and labels only). `data` map, **all values strings**:

| key | when | value |
|---|---|---|
| `notificationId` | always | id of the notification row |
| `event` | always | event code, e.g. `TICKET_UPDATE` |
| `routeType` | event names an entity | `booking` or `ticket` for current events (see §6) |
| `routeId` | with `routeType` | entity uuid |

No names, phone numbers, addresses, document data, report text or ticket text is sent. Delivery is asynchronous (outbox → queue → worker): a notification row existing does **not** mean the push was delivered; `GET /admin/notifications` shows `QUEUED/SENT/FAILED/SKIPPED` (`SENT` = FCM accepted it, not that a device displayed it).

## 6. Inbox and `route.type`

`GET /notifications?unreadOnly=&page=&limit=` → items `{id, event, title, body, route: {type,id}|null, readAt, createdAt}`, newest first. The inbox only holds events that have an **active IN_APP template** (admin-configured; defaults in `default-templates.ts`).

`route` is derived from the event's ids, first match wins: `bookingId` → `booking`; `ticketId` → `ticket`; `replacementId` → `replacement`; `paymentId` → `payment`; otherwise `null`.

| Event (emitted today) | Recipient | `route` |
|---|---|---|
| JOB_OPPORTUNITY, INTERVIEW_TRIAL_SCHEDULED, BOOKING_CONFIRMED, BOOKING_MATCHED, WORKER_ACCEPTED, WORKER_DECLINED, INTERVIEW_OUTCOME, BOOKING_PAYMENT_DUE, BOOKING_STARTED, BOOKING_COMPLETED, BOOKING_CANCELLED, BOOKING_SLOT_PROPOSED, BOOKING_SLOT_ANSWERED | customer or worker | `booking` |
| INTERVIEW_REQUESTED, INTERVIEW_RESPONDED, INTERVIEW_CANCELLED | customer or worker | `booking` (`interviewId` is a parameter but not routed; there is **no `interview` route type**) |
| PAYMENT_SUCCEEDED, PAYMENT_FAILED, PAYMENT_UNDER_REVIEW | customer | `booking` (payment events carry `bookingId`, which wins; `payment` is not emitted) |
| REPLACEMENT_UPDATE | customer | `booking` (same reason; `replacement` is not emitted) |
| TICKET_UPDATE, TICKET_MESSAGE | ticket creator | `ticket` |
| VERIFICATION_APPROVED, VERIFICATION_REJECTED, RECHECK_DUE | worker | `null` |
| PAYMENT_EXCEPTION_ALERT | staff | `payment`/`null` (staff only) |
| RATING_RECEIVED, ATTENDANCE_EXCEPTION | — | **defined with default wording, but nothing emits them** |

There is **no rating-prompt** notification or route. Changing route types (e.g. emitting `interview`, `payment`, `replacement`) would alter what the shipped app receives and needs a decision (Q-110).

### Unread count and row actions

| Endpoint | Response |
|---|---|
| `GET /notifications/unread-count` | `{ "count": 3, "unread": 3 }` — both identical; `unread` is the older name. Counts the caller's delivered, unread IN_APP items only. |
| `POST /notifications/{id}/read` | 204, owner only, idempotent |
| `POST /notifications/{id}/unread` | 204, **new**, owner only, idempotent |
| `POST /notifications/read-all` | 200 `{updated}` |

404 `NOTIFICATION_NOT_FOUND` for unknown and other people's ids; 400 for a non-UUID. **Not built:** delete, notification preferences (Q-109).

## 7. Permission re-ask (3 days)
Client-side decision. The backend has no setting, scheduler or stored prompt state for it, and none was added.

## 8. Error cases (quick list)
400 validation (`description` < 10, bad `reasonCode`, malformed id) · 401 no token · 403 wrong user type/permission · 404 `TICKET_NOT_FOUND`, `BOOKING_NOT_FOUND`, `SAFETY_TARGET_NOT_FOUND`, `BLOCK_NOT_FOUND`, `NOTIFICATION_NOT_FOUND` · 409 `TICKET_CLOSED`, `BLOCK_ADMIN_APPLIED` · 422 `SUPPORT_CATEGORY_INVALID`, `IDEMPOTENCY_KEY_REUSED` · 429 throttle.

## 9. Known limitations and external blockers
- FCM delivery, the exact production error bodies for dead tokens, iOS/APNs and any real device are **unverified**: tests use an in-memory push adapter and faked HTTP responses. The local `.env` carries FCM settings but no push was sent. Firebase apps/keystore/iOS builds are outside the backend.
- Ticket attachments, FAQ, delete/preferences, reopening, "waiting for you"/"resolved" states and any safety-ticket prioritisation need product decisions (Q-107..Q-110, `OPEN_QUESTIONS.md`).
- `SUPPORT_CONTACT_PHONE/EMAIL` are unset until the client provides them.
- Ticket `description` minimum (10) also applies to workers using the same endpoint.
