# Single Render service: API + embedded workers

Audience: whoever operates the SevaNest backend on Render.
Status date: 2026-11-04.
Scope: this describes what **this repository's code actually does**. It does not describe what the live Render
dashboard currently contains — that is listed separately as an owner action (§9).

Evidence labels used here: `SOURCE VERIFIED` (read in this repo), `UNIT TEST VERIFIED` (a named spec ran in this
session), `DEPLOYED BACKEND VERIFIED` (observed on the running service), `NOT VERIFIED` (not run, with the reason).

---

## 1. The architecture

One Render **web** service runs both the HTTP API and every background loop.

| Piece | How it is selected | Source |
|---|---|---|
| HTTP API | `node dist/main` (Dockerfile `CMD`) | `Dockerfile`, `src/main.ts` |
| Background loops | `EMBEDDED_WORKERS=true` adds the worker modules to `AppModule` | `src/app.module.ts:67-79`, `:133` |
| Separate worker process (not used here) | `node dist/worker` → `WorkerModule` | `src/worker.ts`, `src/worker.module.ts` |

`EMBEDDED_WORKERS` must be the exact string `true` (`src/app.module.ts:68` compares with `=== 'true'`). The env
validator only accepts `true`/`false`, so `1`, `TRUE` or `yes` fail startup instead of silently disabling the
loops. `SOURCE VERIFIED`.

With `EMBEDDED_WORKERS=true`, these modules are registered in the API process (`src/app.module.ts:70-77`):
`NotificationsWorkerModule`, `VerificationWorkerModule`, `PaymentWorkerModule`, `BookingWorkerModule`,
`SupportWorkerModule`, `CustomerPhotoWorkerModule`, `RetentionWorkerModule`, `SecurityEventsWorkerModule`.
`SOURCE VERIFIED`.

`EMBEDDED_WORKERS=false` (the default) starts **none** of them; the API then only enqueues work and nothing
consumes it until a separate worker service is deployed. That is the failure mode to avoid on a single service.
`SOURCE VERIFIED`.

---

## 2. Startup chain for push (`SOURCE VERIFIED`)

1. `src/config/env.validation.ts:875` — `validateEnvironment()` runs before Nest builds anything
   (`src/config/config.module.ts` passes it as `ConfigModule.forRoot({ validate })`). With `PUSH_PROVIDER=fcm` it
   resolves credentials and throws if none are usable (`:897-910`). A deployment with `PUSH_PROVIDER=fcm` and no
   credential **fails to start** rather than starting push-dead.
2. `src/app.module.ts:67-79` — `EMBEDDED_WORKERS=true` adds `NotificationsWorkerModule`.
3. `src/modules/notifications/notifications.worker.ts:70-74` — that module imports `NotificationsModule` and
   provides `NotificationProcessor` (`@Processor('notifications')`, `:17-29`) and `NotificationDispatchLoop`
   (`:36-68`).
4. `src/modules/notifications/notifications.module.ts:64-80` — the **only** `PUSH_PROVIDER` factory. It reads
   `AppConfigService.pushProvider` and returns `FcmPushProvider` built from `config.fcmServiceAccount`.
5. `src/infrastructure/queue/queue.module.ts:13-19` — one `BullModule.forRootAsync` connection built from
   `config.redisUrl` (`redisConnectionFromUrl`, `src/infrastructure/queue/redis-connection.ts`), with
   `maxRetriesPerRequest: null` so a worker reconnects instead of dying.
6. `NotificationDispatchLoop.onApplicationBootstrap()` (`:46-48`) starts a 5-second interval that writes the
   `notifications` heartbeat and calls `dispatchOutbox()` + `requeueStale()`.
7. `NotificationProcessor.process()` (`:23-28`) calls `NotificationsService.deliver(notificationId)` for each job
   on the `notifications` queue (`src/modules/notifications/notifications.constants.ts`).

**The API and the worker therefore do not have separate FCM configuration.** They resolve the same
`EnvironmentVariables` object, the same `AppConfigService`, and — because a static Nest module is instantiated
once per application context — the same `NotificationsModule`/`FcmPushProvider` instance and its cached OAuth
token. The "same instance" part is an INFERENCE from Nest's module-container semantics; the "same configuration"
part is directly `SOURCE VERIFIED`.

---

## 3. Exact environment-variable mapping

| Question | Answer | Source |
|---|---|---|
| What supplies the API's FCM provider? | `FCM_SERVICE_ACCOUNT_JSON`, or `FIREBASE_CLIENT_EMAIL` + `FIREBASE_PRIVATE_KEY` (with `FIREBASE_PROJECT_ID` optional) | `src/config/env.validation.ts:796-814`, `src/config/app-config.service.ts:275-282` |
| What supplies the worker's FCM provider? | The same variables. There is no worker-specific credential | `src/modules/notifications/notifications.module.ts:64-80` (single factory, used by both module trees) |
| Is `WORKER_FCM_SERVICE_ACCOUNT_JSON` recognized? | **No.** It has zero references in `src/`, `test/`, `docs/` and `render.yaml`. It is inert | repo-wide search, 2026-11-04 |
| Is `FIREBASE_PROJECT_ID` required separately? | No. Default `sevanest-47cef`; ignored for sending when the JSON is used (the JSON's `project_id` wins) | `src/integrations/notifications/fcm.provider.ts:54-74`, `src/config/app-config.service.ts:262-271` |
| Does the worker initialize its own provider? | No. One factory, one provider instance per process | `src/modules/notifications/notifications.module.ts:64-80` |
| Conflict when both variables are set? | No crash: `WORKER_*` is simply unread. Since D-105 the validator emits a `ConfigWarning` naming the ignored variable, and `firebaseProjectId` in diagnostics reports the project actually used | `src/config/env.validation.ts:911-920`, `src/config/app-config.service.ts:262-271` |

**One service account is sufficient and correct** for this architecture. Two would only make sense with two
processes that must authenticate as different Google identities — which this code cannot express, because it has no
per-process credential lookup.

Recommended configuration (simplest secure):

```
PUSH_PROVIDER=fcm
FCM_SERVICE_ACCOUNT_JSON=<the whole service-account JSON on ONE line>
```

Delete `WORKER_FCM_SERVICE_ACCOUNT_JSON` from the service. Keeping it costs nothing at runtime but it is a trap: an
operator who rotates the key in the ignored copy will believe push was fixed while the process keeps using the old
one.

---

## 4. Is the embedded notification worker actually running?

What can be proven from the repository (`SOURCE VERIFIED` / `UNIT TEST VERIFIED`):

- The module wiring above is unconditional on `EMBEDDED_WORKERS=true`.
- `NotificationDispatchLoop` ticks every 5 s and calls `HeartbeatService.beat('notifications')`
  (`src/modules/notifications/notifications.worker.ts:54-59`); the key lives 2.5 × the tick, minimum 180 s
  (`src/infrastructure/cache/heartbeat.service.ts:4-6, 19-22`).
- `GET /api/v1/admin/system/readiness` reports `background_workers` as **BLOCKER** unless every loop in
  `EXPECTED_LOOPS` — which includes `notifications` — has a fresh heartbeat
  (`src/modules/system/readiness.service.ts:33-43, 257-268`).
- `GET /api/v1/admin/notifications/health` reports delivery, outbox and queue health including `QUEUED` age
  (`src/modules/notifications/notifications.controller.ts:129-138`).

What is **`NOT VERIFIED`**: nobody has opened the live service's readiness endpoint in this session. The check
that answers "is it running?" is:

1. `GET https://<service>/api/v1/admin/system/readiness` → `background_workers.ok === true` and
   `workers[]` contains `notifications`.
2. `GET https://<service>/api/v1/admin/notifications/health` → queue depth near zero, no growing `QUEUED` age.

If `background_workers` lists `notifications` as "not seen recently", either `EMBEDDED_WORKERS` is not exactly
`true`, Redis is unreachable, or the loop is crashing — in that order.

### Why `/health/ready` does not answer this

`GET /health/ready` checks only PostgreSQL and Redis (`src/infrastructure/observability/health/health.controller.ts:106-117`).
It is a dependency probe for Render's health check, deliberately cheap and non-authenticated; it says nothing about
whether a single loop is alive. Worker liveness is the authenticated readiness report above. Do **not** add worker
heartbeats to `/health/ready`: a Redis hiccup would then restart a healthy API, and a slow loop would flap the
service.

---

## 5. Redis requirements

One Redis instance serves: BullMQ queues, heartbeat keys, throttle counters, the search cache.

- `REDIS_URL` is required (`src/config/env.validation.ts:140-155`). `rediss://` enables TLS
  (`src/infrastructure/queue/redis-connection.ts:13`).
- BullMQ workers need `maxRetriesPerRequest: null` — already set in that helper. Do not "fix" it to a number.
- A **single** Render service with `EMBEDDED_WORKERS=true` still needs Redis: BullMQ is the queue between the
  outbox dispatcher and the processor, and heartbeats are how readiness sees the loops. A process-local queue is not
  an option in this code.
- Redis is non-authoritative: losing it loses queue jobs and heartbeats, never business data. PostgreSQL remains
  the source of truth, and the outbox re-dispatches events whose delivery never happened.

---

## 6. FCM initialization and what "SENT" means

`src/integrations/notifications/fcm.provider.ts` is a hand-written HTTP v1 client, not `firebase-admin`:

1. RS256 JWT for the service account (`iss` = `client_email`, scope `.../auth/firebase.messaging`).
2. Exchange at `https://oauth2.googleapis.com/token`; the access token is cached until ~60 s before expiry, so one
   process performs one exchange per hour, not one per push.
3. `POST https://fcm.googleapis.com/v1/projects/{project_id}/messages:send`.

A `SENT` row in the notification delivery log means **FCM accepted the message** — it is not proof the device showed
anything. Push display is a client concern (see `docs/qa/FCM_PUSH_DIAGNOSTICS.md` §5).

`npm run check:providers` performs a credential-only probe (`FcmPushProvider.verifyCredentials()`): JWT signing and
OAuth exchange, no message sent. It never prints the key or the token. Because it authenticates as the configured
service account, it must not be run against a key that is about to be revoked.

---

## 7. Safe direct push testing

`PUT /api/v1/auth/device-token` with `{ "token": "<fcm token>", "platform": "ANDROID" | "IOS" }` registers the device
(204). Then, as an administrator with `NOTIFICATION_MANAGE`:

```
POST /api/v1/admin/notifications/test-push
{ "userId": "<uuid>", "title": "optional", "body": "optional", "correlationId": "optional" }
```

Both test-push routes are limited to 5 requests/minute per client on top of the global limit, and audited as
`notification.test_push`. Response fields and the stable error codes are documented in
`docs/qa/FCM_PUSH_DIAGNOSTICS.md` §2.3. Tokens are returned masked; never paste a full FCM token into a ticket.

This is safe to run against production because it targets one explicit user, sends one message, and writes an audit
record. It is **not** a substitute for the queue: sending a direct push proves credentials and provider wiring, not
that an event produced a PUSH row. That needs an active `PUSH` template (§8).

---

## 8. Why an event still sends nothing: PUSH templates

`NotificationsService.expand()` creates one notification row per **active template channel** for an event and queues
only the non-`IN_APP` rows. `src/seed-launch.ts` installs only `IN_APP` starter templates, so a freshly seeded
database has **zero PUSH templates and therefore zero push jobs**, regardless of Firebase credentials.

Fix: `POST /api/v1/admin/notification-templates` with `eventCode`, `channel: "PUSH"`, `title`, `body`. The readiness
check `notification_push_templates` (WARNING, only when `PUSH_PROVIDER=fcm`) lists every event still missing one.
Copy and per-event delivery decisions are the owner's call (Q-139) — do not invent wording.

---

## 9. Owner actions (not performed by an agent)

1. **Rotate the exposed key** ending `c8ec68...`: Firebase console → Project settings → Service accounts → delete
   that key, create a new one, store it only in the Render secret store. See §10 for the exact sequence.
2. **Reconcile `render.yaml` with reality.** The committed file declares `PUSH_PROVIDER: disabled` and a second
   `sevanest-worker` service, which contradicts the single-service setup. Editing service definitions in a blueprint
   can make Render create/delete services on the next sync, so this needs a deliberate decision, not a silent edit.
   Until then the dashboard values are the source of truth.
3. Put `PUSH_PROVIDER=fcm`, `FCM_SERVICE_ACCOUNT_JSON` (new key) and `EMBEDDED_WORKERS=true` on the one web service.
4. Remove `WORKER_FCM_SERVICE_ACCOUNT_JSON`.
5. Create the `PUSH` templates (§8), then verify readiness (§4).

---

## 10. Rotation runbook

1. In the Firebase console, delete the compromised key (or revoke it in Google Cloud IAM). Do this first; do not
   reuse it anywhere.
2. Create a new key for the same service account, download it, and keep it out of the repository and out of chat.
3. In Render: paste the new JSON as `FCM_SERVICE_ACCOUNT_JSON` on the single web service (one line). Delete
   `WORKER_FCM_SERVICE_ACCOUNT_JSON`.
4. Redeploy.
5. `GET /health/ready` → 200. `GET /api/v1/admin/system/readiness` → `provider_push` ok, `background_workers` ok,
   `notification_push_templates` acceptable.
6. `npm run check:providers` **once** against the new key (it is safe to authenticate with the key you intend to keep).
7. One admin test-push to a staff device; record `correlationId` and `providerMessageId`.
8. Revoke nothing further, but record the rotation date in the operations log.

---

## 11. Known limits of this document

- `DEPLOYED BACKEND VERIFIED` is absent: no live endpoint was queried in this session.
- `FLUTTER DEVICE VERIFIED` is absent: no device was available.
- Local integration tests could not run (Docker daemon unavailable); the evidence for the queue/heartbeat behaviour
  is source reading plus unit tests, not a real Redis run.
- Real FCM delivery was not tested, because the only key available is the compromised one.
