# Notifications

Admin-configurable notifications over push (FCM), SMS and WhatsApp (optional), delivered asynchronously. Channels outside the specification are not offered
(email is Q-20). **No vendor or credential exists yet**: `PUSH_PROVIDER`, `WHATSAPP_PROVIDER` and `SMS_PROVIDER` are `disabled` or the test-only `memory` adapter
(refused in production).

## Requirements covered

FR-NOT-001..006 (push, SMS, WhatsApp, admin templates, channel/template/status recorded, graceful retry), FRD section 6 (PROPOSED matrix).

## Flow

business transaction -> `outbox_events` row **in the same transaction** (shared `OutboxService`, so the event exists iff the change committed) ->
dispatcher claims events (`FOR UPDATE SKIP LOCKED`), writes one `notifications` row per recipient and **active template** (dedupe key `outbox event:recipient:channel`)
-> BullMQ queue `notifications` (job id = notification id) -> worker delivers through the adapter -> `SENT` / `FAILED` / `SKIPPED`.

- The queue consumer and the 5-second dispatch loop run in the **worker process** (`NotificationsWorkerModule`), not in the API process.
- Retry: a transient provider error is rethrown so BullMQ retries with the platform backoff (5 attempts); a permanent one, or the last attempt, makes it FAILED.
  Delivery holds a per-notification lock, so a notification is never sent twice concurrently; a finished one is never re-sent. A QUEUED notification older than a
  minute is offered to the queue again (the job id keeps it single).
- SKIPPED with a reason: no device / no mobile / recipient not ACTIVE / template switched off. An event with no active template produces nothing.
- The delivery log shows event, channel, status, attempts and a stable reason code - never text, number, token or provider message.

## Events (placeholders a template may use)

JOB_OPPORTUNITY, INTERVIEW_TRIAL_SCHEDULED, BOOKING_CONFIRMED, PAYMENT_SUCCEEDED, PAYMENT_FAILED, VERIFICATION_APPROVED, VERIFICATION_REJECTED, REPLACEMENT_UPDATE
(`GET /admin/notification-events`). Wording is **not seeded** (not specified); a template using an unknown placeholder is rejected.

## APIs (admin, `notification.manage`)

`GET /admin/notification-events`, `GET|POST /admin/notification-templates`, `GET|PATCH /admin/notification-templates/{id}`, `GET /admin/notifications`.

Open: vendors and credentials (Q-08), template language per user, ticket and "recheck due" events (modules/jobs not built), delivery receipts from providers.
