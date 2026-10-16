# Open blockers and findings

Rewritten 2026-10-16 after the audit-fix branch `fix/audit-2026-10-16`. Evidence is the test named in `docs/audit/FIX_REPORT.md`; anything marked "not executed" was not run.

Class: CODE DEFECT - CONFIGURATION GAP - EXTERNAL PROVIDER GAP - OPEN BUSINESS DECISION.
No P0 is known. Items below are what still stands between this code and a real launch.

## 1. Release blockers (need something only the owner can supply)

| ID | Class | Blocker | Needed to clear it |
|---|---|---|---|
| B-1 | OPEN BUSINESS DECISION | Booking state model is the proposed FRD section 4 model; TRD section 6.4 has no PENDING_PAYMENT / INTERVIEW states (C-02, Q-05, Q-55). | Client sign-off. |
| B-2 | EXTERNAL PROVIDER GAP | **Razorpay adapter exists, never run against a real gateway.** Unit-tested with mocked HTTP only; `npm run check:providers` and `scripts/staging-payment-smoke.mjs` need live test keys. | Razorpay test keys, then the smoke run; live keys for production. |
| B-3 | EXTERNAL PROVIDER GAP | **MSG91 / Twilio SMS adapters never sent a real SMS.** MSG91 needs a DLT-registered OTP template. | Vendor account, sender and DLT template, `check:providers`. |
| B-4 | EXTERNAL PROVIDER GAP | FCM (push), Brevo (e-mail), Google Geocoding (maps) and the S3 bucket adapters are tested with mocked HTTP only. | Credentials, one live send per provider, bucket limits. |
| B-5 | CONFIGURATION GAP | **Backups**: scripts exist (`scripts/db/backup.sh`, `restore.sh`); a restore drill has not been done and Render backups must be enabled. | Enable PITR / backups, run one restore drill. |
| B-6 | CONFIGURATION GAP | **CI has not been seen green on GitHub** for this branch. | Push, open the PR, read the run. |
| B-7 | OPEN BUSINESS DECISION | **Owner sign-off on every default in `docs/audit/DECISIONS_NEEDING_OWNER_SIGNOFF.md`** (timers, refund, retention, wage reference, blacklist, fee kinds). Nothing there is a client-approved value. | Business, finance, legal, security approvals. |
| B-8 | OPEN BUSINESS DECISION | Retention and erasure ship **OFF** (`RETENTION_ENABLED=false`). Periods are assumptions until legal approves. | Legal text, then enable with a dry run first. |

## 2. Important findings

| ID | Class | Finding | Mitigation |
|---|---|---|---|
| R-1 | CONFIGURATION GAP | `ADMIN_IF_MATCH_REQUIRED` defaults to true (DEC-16): an admin client that does not send `If-Match` gets 428. | Update the admin app first, or set the flag false until it does. |
| R-2 | CODE (known limit) | The 24-month **audit archive** is not built: moving rows needs a bypass of the append-only trigger, which loosens a security control. | Partition `audit_logs` by month in a later migration instead. |
| R-3 | CODE (known limit) | DEC-15: suspended and wrong-app numbers receive no SMS, so those users see an OTP problem instead of "account suspended". | Product decision if the support cost is too high. |
| R-4 | CODE (known limit) | Support ticket text and rating comments are free text and are NOT anonymised by the erasure job (only profile, addresses, photos, KYC files, inbox, sessions). | Decide if text must be scrubbed. |
| R-5 | CONFIGURATION GAP | New permissions (`worker.blacklist`, `worker.reveal_emergency_contact`) are added to Super Admin automatically; the Operations Admin role only gets them if its mapping is empty (seed rule). | `PUT /admin/roles/OPERATIONS_ADMIN/permissions` on existing environments. |
| R-6 | CONFIGURATION GAP | `typescript` stays in the production image (it arrives through `@prisma/client` -> `prisma`; `--omit=peer` does not remove it). Size only. | Accept. |
| R-7 | CONFIGURATION GAP | Worker location is geocoded and stored only to about 1 km and used only for ordering; ordering by distance still leaks coarse location to a determined caller. | Accept or order by area only. |
| R-8 | CONFIGURATION GAP | `render.yaml` carries the new timer values; docker-compose relies on the built-in defaults. Existing Render services need the env vars added by hand or a blueprint sync. | Sync the blueprint. |

## 3. Fixed in this branch (were open before)

Timers off by default and unpaid-booking lock (N-01) - fixed. Demo OTP on any number (N-02) - allow-list and `APP_ENV`. Migration date risk (N-03) - CI guard (`npm run check:migrations`), no renames. `OPEN_BLOCKERS` stale claims (N-04) - this file. Refresh replay (F-10), OTP state leak (F-14), HS256-only JWT (F-21), worker healthcheck (F-18), refused-request audit volume and offset audit paging (S-09/14), 503 logged as ERROR (S-13), earnings reference, blacklist, SLA escalation, concurrent edits, cancellation refund, request-admin-matching, replacement no-alternative alert, photo gate, monthly engagement, revenue kinds, e-mail, maps, retention. Push and WhatsApp adapters and report/block exist (the earlier claim that they did not was wrong).

## 4. Not verified here

GitHub Actions run; any real payment/SMS/push/WhatsApp/e-mail/maps provider; a real S3 bucket; behaviour behind a real proxy and TLS; load; backup restore; the Docker image build.
