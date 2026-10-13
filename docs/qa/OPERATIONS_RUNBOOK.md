# Operations runbook (backups, monitoring, keep-alive)

These items are infrastructure, not application code. The application exposes what an operator needs; the rest is configuration at the host.

## Health and readiness
* `GET /health/live` and `GET /health/ready` (public) - database and Redis status; use `/health/ready` as the platform health check.
* `GET /api/v1/admin/system/readiness` (Super Admin) - every launch prerequisite (providers, templates, workers, malware scanning) with the exact fix.
* `GET /api/v1/admin/notifications/health` - outbox backlog and dead-lettered events.
* `GET /api/v1/admin/alerts/summary` - open staff alerts (money problems, stuck bookings, SLA breaches).

## Backups (Supabase PostgreSQL)
1. Enable the project's automatic daily backups (Supabase dashboard -> Database -> Backups; point-in-time recovery needs a paid plan).
2. Before every deploy that includes a migration, take a manual backup or confirm the last automatic one.
3. Test a restore into a scratch project once before launch: restore the backup, run `npx prisma migrate status` against it, log in as the Super Admin.
4. KYC documents live in the private storage bucket: enable the bucket's versioning/backup in the storage provider, and keep the bucket private.
5. Retention periods are not decided (Q-88): do not purge backups or documents on a schedule yet.

## Error monitoring and uptime
* The application writes structured JSON logs with a request id on every line and on every error response; ship the platform logs to a log service.
* Add an uptime monitor on `/health/ready` (every 5 minutes). On Render's free plan the service sleeps after inactivity: the same monitor keeps it awake.
* Alert on: HTTP 5xx rate, `/health/ready` failing, and the readiness report showing a missing background loop.
* An error-tracking SDK (for example Sentry) is not bundled; adding one is a dependency decision (Q-91).

## Background work
* `node dist/worker` (or `EMBEDDED_WORKERS=true` in the API) runs notification delivery, re-check reminders, abandoned-upload clean-up, payment recovery, booking checks (also purges expired idempotency keys) and support SLA checks. Heartbeats show in the readiness report.

## Malware scanning (optional)
* Run a ClamAV daemon (`clamd`) the API can reach, then set `CLAMAV_HOST` (and `CLAMAV_PORT`, default 3310). With it, every confirmed KYC document is streamed to the scanner; an infected file is deleted and rejected, a scanner that cannot answer leaves the document unconfirmed (503, retry).

## Launch checks you run yourself (they need your accounts)

### 1. Provider check (safe, read-only as far as possible)
```bash
npm run build
npm run check:providers
```
Prints one line per provider and never prints a secret, touches the database or sends a message.
* Razorpay: with **test** keys it creates a Rs 1 test order and looks it up; live keys are refused.
* Twilio: reads the account record (credentials check). MSG91 and FCM have no read-only call.
* Storage: probes a key that cannot exist (proves credentials, bucket and endpoint).
* ClamAV: scans the harmless EICAR test string and expects "infected".
Last local result (2026-10-13, local `.env`): storage OK (bucket reachable); Razorpay, SMS, ClamAV, FCM NOT_CONFIGURED locally.

### 2. Razorpay sandbox session (manual, test keys only)
1. Set `PAYMENT_PROVIDER=razorpay`, test `RAZORPAY_KEY_ID` / `RAZORPAY_KEY_SECRET`, and (for webhooks) `RAZORPAY_WEBHOOK_SECRET`; in the Razorpay dashboard add the webhook URL `https://<service>/api/v1/webhooks/payments` for the payment and refund events.
2. `npm run check:providers` must show Razorpay OK.
3. Create a booking through the API up to PENDING_PAYMENT, call `POST /payments`, complete the checkout with a Razorpay test card/UPI, then `POST /payments/{id}/verify`. Confirm the booking is CONFIRMED.
4. Make a second payment and close the browser before verifying: within the recovery window `GET /admin/payments/{id}` must become SUCCEEDED by itself (lost-callback recovery), or use `POST /admin/payments/{id}/reconcile`.
5. Refund it with `POST /admin/payments/{id}/refund`; confirm status REFUND_PENDING then REFUNDED.
Record the result in `docs/qa/phase-verification-results.md`. Until you do, payments stay NOT_VERIFIED against the real gateway.

### 3. After every deploy
1. `GET /health/ready` is 200.
2. Wait 15 minutes (the slowest loop ticks every 15 minutes), then log in as Super Admin and read `GET /api/v1/admin/system/readiness`: `background_workers` must be OK. The heartbeat lifetime now follows each loop's interval, so a healthy worker no longer shows loops as missing.
3. If a loop is still missing, read the service logs for `Heartbeat not recorded` (Redis) or a crash of the worker process.

### 4. Secrets
* `.env` is git-ignored and has never been committed (checked 2026-10-13: not tracked, absent from history; tracked files contain only placeholders).
* Secrets that were pasted into a chat must be rotated by their owner: Razorpay keys and webhook secret, Supabase database password and service keys, Redis URL password, `JWT_ACCESS_SECRET`, `OTP_HMAC_SECRET`, SMS/Twilio tokens, FCM service account. Change them in the host environment, redeploy, then confirm `GET /health/ready`.
* Replace the weak admin password: sign in, `POST /admin/account/password`.

## Monitoring and alerting (set up 2026-10-13)
* **Sentry project** `syed-yh/sevanest-backend`. The API and worker report unexpected errors (HTTP 5xx and failed background runs) when `SENTRY_DSN` is set; nothing is sent without it. Request bodies, headers, cookies, query strings and user data are stripped before sending (`src/common/observability/sentry.ts`). To enable, add `SENTRY_DSN` (from the Sentry project's Client Keys page) and `SENTRY_ENVIRONMENT=production` to **both** Render services and redeploy.
* **Uptime monitor** "SevaNest API readiness": `GET https://sevanest-backend.onrender.com/health/ready` every 5 minutes, 10 s timeout, marked down after 2 failures. Sentry emails the project team on downtime by default; add Slack or other actions under Alerts if wanted.
* **Not yet done:** a test error was not sent from the deployed service (the DSN is not on Render yet), alert routing beyond the default email is not configured, and Render free instances sleep when idle, which the uptime monitor will report as slow or down.

## TLS (checked 2026-10-13)
`sevanest-backend.onrender.com`: TLS 1.3 (`TLS_AES_256_GCM_SHA384`), certificate issued by Google Trust Services (Render-managed, auto-renewed; current one valid until 2026-12-20), HTTP redirects to HTTPS (301), HSTS `max-age=31536000; includeSubDomains`. A custom domain will need its own certificate check after it is added in Render.

## Backups and restore drill
Scripts: `scripts/db/backup.sh`, `scripts/db/restore.sh` (guide `docs/DATABASE_MIGRATION.md`). Restore drill done **locally** on 2026-10-13 (backup of a local database restored into an empty one; all rows and 21 migrations back; `prisma migrate status` up to date). **Still to do by the owner:** confirm Supabase automatic backups are enabled for the project, run `backup.sh` against Supabase on a schedule and keep copies outside Supabase, and do one restore drill from a Supabase backup into a scratch database.
