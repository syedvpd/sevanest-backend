# End-to-end workflow matrix

Audit date 2026-10-12. Each step is traced across API, rules, database, event and test. "Runtime" means an integration test on a disposable local database exercised it (journeys: `test/integration/qa.journeys.int-spec.ts`, `modules.journey`, `qa.statemachine`, `booking.api`, `payment.api`, `payments.recovery`, `replacement.api`, `gap.closing`, `small.items`). No step was run through a mobile app or the web admin (none available), and no step used a real SMS, payment, push or storage provider.

Result codes: PASS = backend path complete and runtime-tested; PARTIAL = path works but a part is missing or relies on an unconfigured provider; MISSING; BLOCKED = needs a decision.

## 8.1 Customer journey (PRD 8.1)

| # | Step | Result | Evidence / break point |
|---|---|---|---|
| 1 | Login with OTP | PARTIAL | `POST /auth/otp/request` + `/verify`; real SMS not configured (staging test OTP only for allow-listed numbers) |
| 2 | Select service | PASS | `GET /reference-data`, categories seeded |
| 3 | Choose engagement and timing | PASS | Engagement limited per category once configured (422 ENGAGEMENT_NOT_OFFERED); workers already booked for the hours are hidden / refused (409 WORKER_UNAVAILABLE) |
| 4 | Enter location | PASS | saved address + service area; no distance/maps |
| 5 | View verified workers | PASS | `GET /search/workers` (only fully verified), card with photo link (photo off until size limit set) |
| 6 | Shortlist / request interview | PASS | `PUT /shortlist`, booking create with `workerId` or admin match; a worker booked for overlapping hours is refused |
| 7 | Confirm worker | PASS | `confirm-worker` re-checks eligibility |
| 8 | Pay platform fee | PARTIAL | `POST /payments` + verify + webhook; only the fake gateway has been run end to end |
| 9 | Worker starts service | PASS | `start` blocked before the agreed start date for customer/worker |
| 10 | Track / rate / replace | PASS | timeline, attendance, ratings, replacement |

## 8.2 Worker journey (PRD 8.2)

| # | Step | Result | Evidence / break point |
|---|---|---|---|
| 11 | Register with OTP | PARTIAL | as step 1 |
| 12 | Complete profile | PASS | `PATCH /workers/me`, categories, languages |
| 13 | Upload KYC | PASS | presigned upload, whole-file validation, hash; real bucket not exercised; malware scan optional and off |
| 14 | Skills, areas, availability | PASS | availability module (single engagement preference) |
| 15 | Admin verification | PASS | verification queue, approve/reject with remarks, recheck |
| 16 | Receive job match | PASS | `GET /workers/me/opportunities` + in-app notification (one matched worker per booking) |
| 17 | Accept opportunity | PASS | `accept` / `decline` with reason |
| 18 | Attend interview/trial | PARTIAL | schedule visible; worker can now propose another time and the customer answers (POST slot-proposal); no interview attendance record |
| 19 | Job confirmation | PASS | confirm-worker by customer/admin; worker sees start date |
| 20 | Start service and attendance | PASS | start, today-only attendance, month summary |

## 8.3 Replacement journey (PRD 8.3)

| # | Step | Result | Evidence / break point |
|---|---|---|---|
| 21 | Customer requests replacement | PASS | `POST /replacement-requests` (ACTIVE bookings only) |
| 22 | Reason and notes captured | PARTIAL | free-text reason; no reason master |
| 23 | Support/Admin reviews eligibility | PARTIAL | approve/reject exists; eligibility rule is only "booking is ACTIVE" (client rule undefined) |
| 24 | Engagement status updated | PASS | REPLACEMENT_REQUESTED, cancelled on withdrawal |
| 25 | Alternatives matched | PASS | `POST /admin/matching/candidates` + candidates on request |
| 26 | Customer selects replacement | PASS | `select`, offered-list check |
| 27 | New worker confirmed, history auditable | PASS | REPLACED chain, audit, and `GET /bookings/{id}/replacement-chain` |

## Cross-workflow journeys

| Journey | Result | Notes |
|---|---|---|
| Booking cancelled while payment pending / succeeded / late webhook | PASS (runtime, fake gateway) | payment exception + admin alert; refund manual (Q-77) |
| Lost payment callback | PASS (runtime, fake gateway) | recovery loop claims and checks by order |
| Worker suspended mid-booking | PARTIAL | sessions revoked; booking not reassigned automatically |
| Customer blocks worker | PASS | search/shortlist/match/booking exclude the pair |
| Support ticket to resolution | PASS | thread, escalation, close; reopen undecided |
| Account deletion | BLOCKED | request recorded, nothing erased (Q-88) |
| Admin forgot password | PARTIAL | Super Admin temporary password; no self-service/MFA |
| Cold deploy on a new environment | PARTIAL | `GET /admin/system/readiness` lists prerequisites; first run shows SMS and two loops missing |
