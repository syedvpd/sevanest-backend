# End-to-end journeys - final QA

Three layers of evidence, each exercising the product through HTTP rather than service calls:

| Layer | What runs | Result |
|---|---|---|
| In-process, real PostgreSQL + Redis | `test/integration/qa.journeys.int-spec.ts` (3 journeys), `qa.statemachine`, `qa.concurrency`, `qa.access` | all pass (see FINAL_QA_REPORT for the final totals) |
| **Real built server** | `node dist/main` and **a separate `node dist/worker` process** on a fresh migrated database, driven over a TCP socket by a harness script (OTPs recovered from Redis with the test HMAC key) | **42 / 42 checks** |
| **Docker** | the production image: migrate container, API container, worker container, PostgreSQL and Redis containers on a private network; same harness | **42 / 42 checks** |

The harness is a scratch script outside the repository; the in-repo suites above are the repeatable evidence.

## 1. Customer journey (qa.journeys, then real server and Docker)

OTP login -> profile -> address -> **search** (finds nobody while the worker is unverified) -> admin **matching** -> chosen worker -> **booking** (MATCHED) ->
interview scheduled -> interview done -> worker confirmed (PENDING_PAYMENT) -> **payment** at the configured fee (never the client's amount) -> gateway webhook
(signed) -> booking CONFIRMED + receipt number -> notifications queued for both parties and **delivered by the worker process** -> service started ->
**attendance** recorded by the worker and visible, identical, to the customer -> completion -> **rating** (second rating refused) -> **support ticket** raised, assigned, closed ->
**replacement** on a second booking: request, staff approval, alternatives that exclude the current worker, selection, new MATCHED booking, old booking REPLACED.

Asserted at every step: the resulting state, the timeline (`NEW_REQUEST, MATCHED, INTERVIEW_TRIAL_SCHEDULED, INTERVIEW_TRIAL_COMPLETED, PENDING_PAYMENT, CONFIRMED, ACTIVE, COMPLETED`),
that the customer-facing search card never contains the worker's name or mobile number, and that the receipt exists only after the gateway confirmed.

## 2. Worker journey

OTP login -> profile -> categories -> availability -> submit (422 with the exact missing items first: `areas, timeWindows, engagementPreference`) -> verification check refused while
incomplete -> document upload (signed link, confirm) -> check submitted -> staff review -> approved -> `level: VERIFIED` -> **only now searchable and matchable** -> job offer
(JOB_OPPORTUNITY) -> booking -> attendance -> completion -> rating summary visible to the worker.

## 3. Admin journey

Login -> dashboard -> users, customers, workers, verification queue and requirements, bookings, payments, fees, notification templates and delivery log, support tickets and
categories, ratings, replacements, service areas and categories, roles and permissions, audit log, report catalogue and **all 13 reports** - every list answers 200 for the Super Admin
and the journey is visible in the audit log (`booking.create`, `payment.succeeded`, `verification.approve`, `attendance.record`, ...).

Seeded roles other than Super Admin hold no permission (see RBAC_MATRIX): this is asserted by `qa.journeys` ("SEEDED ROLES") so the state cannot change unnoticed.

## 4. Real server and Docker checks (42 each)

Platform: health live/ready (no connection strings in the body), OpenAPI served, unknown route -> envelope with the caller's `X-Request-Id` echoed, security headers.
Business: everything in sections 1-3 plus idempotent booking creation (201 then 200 with the same id), wrong webhook signature -> 401, duplicate webhook acknowledged, the
**worker process delivering 4 notifications** (JOB_OPPORTUNITY x1, BOOKING_CONFIRMED x2, PAYMENT_SUCCEEDED x1) with none failed, a report matching the one booking, refresh rotation,
**replayed refresh token refused and the session revoked**, logout invalidating the access token.
Logs (host run): 321 lines scanned against 15 secrets (OTPs, access and refresh tokens, the admin password, webhook secret and signature, mobile numbers): none present; no error/fatal lines.
In the Docker run the application runs with `NODE_ENV=test` (the production image refuses the test adapters and has no `pino-pretty`), so its logs are silent; the production-mode
log scan was done separately (API_SECURITY_AUDIT section 1).

## 5. Booking state machine - exhaustive

`qa.statemachine.int-spec.ts` drives a booking into each of the **11 states** and fires each of the **9 actions** as each of the **3 actors** (297 combinations) against the
real API, comparing HTTP status and resulting state with the FRD section 4 model written out independently in the test. Result: **297 / 297 as specified.**

| Outcome | Count | Meaning |
|---|---|---|
| 200 | 47 | a permitted transition (17 distinct, listed below) or a harmless repeat of the transition that already holds |
| 409 | 159 | the actor may do this, but not from this state (`INVALID_TRANSITION`) |
| 403 | 88 | the actor may never do this (`ACTION_NOT_ALLOWED`), e.g. a worker cancelling, a customer matching |
| 404 | 3 | a worker acting on a booking that has no worker (ownership is checked first) |

Permitted transitions (every other combination is refused):

| Action | From state | Customer | Worker | Admin |
|---|---|---|---|---|
| `cancel` | CONFIRMED | 200 -> CANCELLED | 403 | 200 -> CANCELLED |
| `cancel` | INTERVIEW_TRIAL_COMPLETED | 200 -> CANCELLED | 403 | 200 -> CANCELLED |
| `cancel` | INTERVIEW_TRIAL_SCHEDULED | 200 -> CANCELLED | 403 | 200 -> CANCELLED |
| `cancel` | MATCHED | 200 -> CANCELLED | 403 | 200 -> CANCELLED |
| `cancel` | NEW_REQUEST | 200 -> CANCELLED | 403 | 200 -> CANCELLED |
| `cancel` | PENDING_PAYMENT | 200 -> CANCELLED | 403 | 200 -> CANCELLED |
| `cancel` | REPLACEMENT_REQUESTED | 200 -> CANCELLED | 403 | 200 -> CANCELLED |
| `complete` | ACTIVE | 200 -> COMPLETED | 403 | 200 -> COMPLETED |
| `confirm-worker` | INTERVIEW_TRIAL_COMPLETED | 200 -> PENDING_PAYMENT | 403 | 200 -> PENDING_PAYMENT |
| `decline` | INTERVIEW_TRIAL_SCHEDULED | 403 | 200 -> MATCHED | 200 -> MATCHED |
| `decline` | MATCHED | 403 | 200 -> NEW_REQUEST | 200 -> NEW_REQUEST |
| `interview-complete` | INTERVIEW_TRIAL_SCHEDULED | 200 -> INTERVIEW_TRIAL_COMPLETED | 403 | 200 -> INTERVIEW_TRIAL_COMPLETED |
| `match` | NEW_REQUEST | 403 | 403 | 200 -> MATCHED |
| `reopen-matching` | INTERVIEW_TRIAL_COMPLETED | 200 -> MATCHED | 403 | 200 -> MATCHED |
| `reopen-matching` | INTERVIEW_TRIAL_SCHEDULED | 200 -> MATCHED | 403 | 200 -> MATCHED |
| `schedule` | MATCHED | 200 -> INTERVIEW_TRIAL_SCHEDULED | 200 -> INTERVIEW_TRIAL_SCHEDULED | 200 -> INTERVIEW_TRIAL_SCHEDULED |
| `start` | CONFIRMED | 200 -> ACTIVE | 200 -> ACTIVE | 200 -> ACTIVE |

Moves made by other modules, not by a person: `PENDING_PAYMENT -> CONFIRMED` (Payment, only after the gateway confirms), `ACTIVE -> REPLACEMENT_REQUESTED`,
`REPLACEMENT_REQUESTED -> ACTIVE | REPLACED | CANCELLED` (Replacement, plus cancellation through the booking hook). Tested in payment.api, replacement.api, qa.concurrency and qa.journeys.

**Concurrency on the state machine**

| Race | Result |
|---|---|
| Customer, worker and admin all `start` the same CONFIRMED booking, twice each | exactly one `CONFIRMED -> ACTIVE` event; every caller gets 200 |
| Six callers `complete` the same ACTIVE booking | exactly one `ACTIVE -> COMPLETED` event |
| Six callers `cancel` the same booking | exactly one `CANCELLED` event |
| Confirm, cancel and reopen-matching raced against one interview-completed booking | exactly one transition out of the state; every response 200 or 409; no corrupted row |
| Booking cancel vs withdrawing its replacement request (8 rounds), vs staff approve/reject (6), vs selecting the replacement worker (6) | **found a deadlock (S-01), fixed**; now 0 failures |
| Payment confirmation vs cancellation of the same booking (6 rounds) | payment always SUCCEEDED, booking CONFIRMED or CANCELLED, never inconsistent |
| Worker re-check (loses verified status) vs `confirm-worker` (4 rounds) | the booking is confirmed or refused with 422, never confirmed against an ineligible worker afterwards |

**Release decision, not a defect:** the state model implemented here is the *proposed* FRD section 4 model. The TRD and the architecture document describe different models
(C-02, Q-05, Q-55). The code matches the FRD exactly and is proven so; whether the FRD model is the client's final model is an **OPEN BUSINESS DECISION that blocks release**.
