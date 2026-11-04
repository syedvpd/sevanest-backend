# FCM push: end-to-end diagnostic guide

Audience: backend operator and Flutter developer diagnosing "push notifications do not arrive".
Status date: 2026-11-04.

> **Security notice.** A Firebase service-account JSON (key id ending `c8ec68...`) was pasted into a chat and must be treated as
> compromised. It was never copied into this repository, used for a request, or printed by the tooling described here. Revoke it and
> issue a replacement before any end-to-end test (rotation steps in §7). Do not send the replacement key through chat.

## 1. What the backend actually runs (FACT, source-verified)

The backend does **not** use the `firebase-admin` SDK. Push is a hand-written FCM HTTP v1 client,
`src/integrations/notifications/fcm.provider.ts`:

1. Builds an RS256 JWT for the service account (`iss` = `client_email`, scope `https://www.googleapis.com/auth/firebase.messaging`).
2. Exchanges it at Google's OAuth token endpoint (`https://oauth2.googleapis.com/token` unless the account's `token_uri` says otherwise), caching the access token until ~60 s before expiry.
3. `POST`s to `https://fcm.googleapis.com/v1/projects/{project_id}/messages:send` with `message.token`, `message.notification`, `message.data`.

Credentials are read from **either**:

* `FCM_SERVICE_ACCOUNT_JSON` — the whole JSON on one line, **or**
* `FIREBASE_PROJECT_ID` (default `sevanest-47cef`), `FIREBASE_CLIENT_EMAIL`, `FIREBASE_PRIVATE_KEY` (literal `\n` accepted).

There is **one** credential source for the whole deployment: the API and the embedded worker
(`EMBEDDED_WORKERS=true`) share `NotificationsModule` and therefore one provider and one OAuth token.
`WORKER_FCM_SERVICE_ACCOUNT_JSON` is not read by anything — setting it only logs a `ConfigWarning`. See
`docs/qa/SINGLE_SERVICE_DEPLOYMENT.md` for the full single-service mapping.

`PUSH_PROVIDER` selects the implementation: `fcm`, `memory` (tests only, refused in production), `disabled` (default).

Push is a **separate channel** from in-app. `NotificationsService.expand()` creates one notification row per *active template channel*
for an event and only queues the non-`IN_APP` rows. `src/seed-launch.ts` installs only `IN_APP` starter templates. Therefore a database
seeded with the launch data has **zero PUSH templates and therefore zero push jobs**, regardless of Firebase credentials. This is a
primary root-cause candidate and is now reported by readiness (see §3).

## 2. Diagnostic endpoints (SOURCE VERIFIED)

Both are rate limited to **5 requests/minute per client** (on top of the global 120/min) and audited as `notification.test_push`.

### 2.1 Self-service (own devices)

`POST /api/v1/notifications/test-push` — customer or worker session.

```json
{ "title": "optional, max 120", "body": "optional, max 1000", "correlationId": "optional, max 64" }
```

In production this is **admin-only** unless `ALLOW_TEST_PUSH=true`; otherwise `403 TEST_PUSH_RESTRICTED`.

### 2.2 Admin, explicit recipient (recommended for support)

`POST /api/v1/admin/notifications/test-push` — admin session with `NOTIFICATION_MANAGE`.

```json
{ "userId": "<customer-or-worker-uuid, required>", "title": "optional", "body": "optional", "correlationId": "optional" }
```

The caller's own devices are never used. The audit record carries `correlationId`, `targetUserId` and `targetIsActor`.

### 2.3 Response (both endpoints)

| Field | Meaning |
|---|---|
| `success` | At least one device accepted the message. |
| `correlationId` | Echo of the request value, or a generated UUID. Quote it in any report. |
| `stage` | `DISPATCHED` \| `NO_DEVICE_TOKEN` \| `CONFIG_ERROR` \| `FAILED`. |
| `pushProvider`, `firebaseProjectId` | What the backend is actually configured with. |
| `tokensCount` | Number of registered device tokens for the target user. |
| `tokens[]` | Per token: `token` (**masked**), `status` `DELIVERED`/`FAILED`, `providerMessageId` (FCM message name), `error` (stable code). |
| `diagnostics` | `tokenRegistered`, `fcmConfigured`, counts, foreground/background guidance, troubleshooting text. |

Stable `error` codes (never provider text, never a token):

| Code | Cause | Action |
|---|---|---|
| `INVALID_REGISTRATION_TOKEN` | FCM says the token is unregistered/invalid; the binding is deleted automatically. | App must register a fresh token. |
| `PROVIDER_REJECTED` | Non-retryable FCM rejection (bad payload, wrong sender/project, permission). | Compare `firebaseProjectId` with the app's `google-services.json`. |
| `PROVIDER_UNAVAILABLE` | Timeout / 429 / 5xx. | Retry later; queued jobs retry 5× with exponential backoff. |
| `PUSH_PROVIDER_DISABLED` | `PUSH_PROVIDER=disabled`. | Configure FCM or accept push is off. |
| `DISPATCH_FAILED` | Unexpected non-provider failure. | Check backend logs for the same `correlationId`. |

`SENT` in the notification delivery log means **accepted by FCM**, not displayed on a device.

## 3. Readiness

`GET /api/v1/admin/system/readiness` (admin) includes:

* `provider_push` — WARNING when `PUSH_PROVIDER` is not `fcm`.
* `notification_push_templates` — WARNING (only when push is `fcm`) listing every customer/worker event without an active `PUSH`
  template. `PAYMENT_EXCEPTION_ALERT` is excluded because staff alerts use the admin alert inbox. Create PUSH templates with
  `POST /api/v1/admin/notification-templates` (`eventCode`, `channel: "PUSH"`, `title`, `body`).

Events that trigger notifications (33): `JOB_OPPORTUNITY`, `INTERVIEW_TRIAL_SCHEDULED`, `BOOKING_CONFIRMED`, `PAYMENT_SUCCEEDED`,
`PAYMENT_FAILED`, `VERIFICATION_APPROVED`, `VERIFICATION_REJECTED`, `REPLACEMENT_UPDATE`, `TICKET_UPDATE`, `RECHECK_DUE`,
`WORKER_VERIFIED`, `WORKER_ACTIVATED`, `PAYMENT_UNDER_REVIEW`, `PAYMENT_REFUND_INITIATED`, `PAYMENT_REFUNDED`, `BOOKING_MATCHED`,
`WORKER_ACCEPTED`, `WORKER_DECLINED`, `INTERVIEW_OUTCOME`, `BOOKING_PAYMENT_DUE`, `BOOKING_STARTED`, `BOOKING_COMPLETED`,
`BOOKING_CANCELLED`, `BOOKING_SLOT_PROPOSED`, `INTERVIEW_REQUESTED`, `INTERVIEW_RESPONDED`, `INTERVIEW_CANCELLED`,
`BOOKING_SLOT_ANSWERED`, `RATING_RECEIVED`, `ATTENDANCE_EXCEPTION`, `TICKET_MESSAGE`, `SUPPORT_SLA_BREACH`,
`PAYMENT_EXCEPTION_ALERT`.

## 4. Credential check

`npm run build && npm run check:providers` now performs an FCM **credential-only** check: JWT signing + OAuth exchange, no message
sent (`FcmPushProvider.verifyCredentials()`). It prints the project id and token lifetime, never the key or token. It authenticates as
the configured service account, so do not run it against a key that is about to be revoked.

## 5. Flutter diagnostic checklist (no source changes)

Run in this order and record the result of each step.

1. **Firebase project match** — `google-services.json` / `GoogleService-Info.plist` `project_id` equals the backend's `firebaseProjectId`
   (default `sevanest-47cef`).
2. **Permission** — Android 13+: `POST_NOTIFICATIONS` is granted (settings → app → notifications). iOS: the user allowed notifications.
3. **Token exists** — log `FirebaseMessaging.instance.getToken()`; it must be a non-empty string. Enable Firebase debug logging:
   `adb shell setprop log.tag.FirebaseMessaging VERBOSE`.
4. **Token registered** — after login the app calls `PUT /api/v1/auth/device-token` with `{ "token": "<fcm>", "platform": "ANDROID" | "IOS" }`.
   Confirm the response is 204 and the token is the same one as step 3.
5. **Token refresh** — `FirebaseMessaging.onTokenRefresh` is wired and calls `PUT /api/v1/auth/device-token` again.
6. **Foreground** — `FirebaseMessaging.onMessage` fires. FCM does **not** show a banner in foreground; the app must show a local
   notification on channel `sevanest_high_importance` (importance.max) to make it visible.
7. **Background** — `onMessageOpenedApp` / the system tray banner appears for a `notification` payload.
8. **Terminated** — `getInitialMessage()` returns the tap when the app was launched from the notification.
9. **Backend result** — call the admin test-push for this user; if `stage=DISPATCHED` but the device shows nothing, the fault is in the
   app/Firebase config, not the backend. If `NO_DEVICE_TOKEN`, step 4 failed. If `CONFIG_ERROR`, backend env is wrong.
10. **Do not change Flutter source to work around a backend fault**; report the `correlationId` and backend result instead.

## 6. End-to-end diagnostic matrix (11 rows)

Run top to bottom. Record evidence labels from §8 for each row.

| # | Layer | Check | Backend evidence | App evidence | Verdict rules |
|---|---|---|---|---|---|
| 1 | Firebase project | App config `project_id` vs backend `firebaseProjectId` | `POST /admin/notifications/test-push` response `firebaseProjectId` | `google-services.json` | Mismatch = config fault |
| 2 | FCM credentials | `verifyCredentials()` | `npm run check:providers` → FCM OK / FAILED | — | FAILED = key/clock/project fault |
| 3 | Provider wiring | `PUSH_PROVIDER=fcm` on the service (API and embedded worker share it) | readiness `provider_push`; test-push `pushProvider` | — | `disabled` = no push ever |
| 4 | Token presence | Token registered for the target user | test-push `tokensCount`, `stage` | Steps 3–4 | 0 tokens = app/registration fault |
| 5 | Token validity | FCM accepts the token | test-push `tokens[].error` | Step 3 | `INVALID_REGISTRATION_TOKEN` = re-register |
| 6 | Direct send | Backend → FCM accepted | `stage=DISPATCHED`, `providerMessageId` present | — | No message id = FCM rejection |
| 7 | Foreground display | `onMessage` + local notification | — | Step 6 | Payload received, no banner = app display fault |
| 8 | Background display | System tray banner | — | Step 7 | No banner = payload/permission fault |
| 9 | Tap routing | `getInitialMessage` / `onMessageOpenedApp` | `data.routeType`/`routeId` in payload | Step 8 | No navigation = app handler fault |
| 10 | Business event queueing | Event produced a PUSH row/job | readiness `notification_push_templates`; delivery log `GET /admin/notifications?channel=PUSH` | — | No PUSH template = event queues nothing |
| 11 | Worker delivery | Worker loop running and sending | readiness `background_workers`, `GET /admin/notifications/health` (`QUEUED` age, queue depth) | — | Stuck `QUEUED` = worker down/queue fault |

## 7. Rotation and deployment (owner action, NOT performed by an agent)

The deployment is **one** Render web service with `EMBEDDED_WORKERS=true`; the API and the notification workers share
one process and one credential. Full detail: `docs/qa/SINGLE_SERVICE_DEPLOYMENT.md`.

1. Firebase console → Project settings → Service accounts → delete the key ending `c8ec68...` (or revoke via Google Cloud IAM).
2. Create a new key; store it only in the host's secret store.
3. On the **single** web service set `PUSH_PROVIDER=fcm` and either `FCM_SERVICE_ACCOUNT_JSON` or
   `FIREBASE_PROJECT_ID`/`FIREBASE_CLIENT_EMAIL`/`FIREBASE_PRIVATE_KEY`, plus `EMBEDDED_WORKERS=true`.
   **Delete** `WORKER_FCM_SERVICE_ACCOUNT_JSON`: nothing reads it, so rotating only that copy leaves push broken.
   `render.yaml` currently hard-codes `PUSH_PROVIDER=disabled` and declares a second `sevanest-worker` service; change
   that file or the dashboard values (the file is not edited here because blueprint-sync can create/delete services).
4. Redeploy, then `GET /health/ready` and `GET /api/v1/admin/system/readiness` (`provider_push` OK, `background_workers` OK).
5. Create the missing `PUSH` templates (§3) — otherwise even a perfect credential still queues nothing.
6. Send one admin test push to a staff-controlled device and record the `correlationId` + `providerMessageId`.

## 8. Evidence labels used in reports

* `SOURCE VERIFIED` — read in this repository's code.
* `UNIT TEST VERIFIED` — a named unit spec ran and passed in this session.
* `LOCAL INTEGRATION VERIFIED` — ran against real PostgreSQL/Redis.
* `DEPLOYED BACKEND VERIFIED` — observed on the deployed service.
* `FLUTTER DEVICE VERIFIED` — observed on a real device with this build.
* `NOT VERIFIED` — not run, with the reason.
