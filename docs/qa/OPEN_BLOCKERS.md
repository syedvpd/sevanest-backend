# Open blockers and findings - final QA

Priority: **P0** security/data loss/system-breaking - **P1** production-blocking - **P2** important, releasable with mitigation - **P3** improvement.
Class: CODE DEFECT - CONFIGURATION GAP - EXTERNAL PROVIDER GAP - OPEN BUSINESS DECISION - DOCUMENTATION GAP.

No P0 is open. Details and evidence for S-xx are in `API_SECURITY_AUDIT.md`, for P-x in `PERFORMANCE_REVIEW.md`.

## 1. Release blockers (P1)

| ID | Class | Blocker | Needed to clear it |
|---|---|---|---|
| B-1 | OPEN BUSINESS DECISION | **Booking state model is the proposed FRD section 4 model**; TRD and architecture document differ (C-02, Q-05, Q-55). Implemented and proven exactly (297/297), but not confirmed as final. | Client confirms or replaces the model. |
| B-2 | EXTERNAL PROVIDER GAP | **No payment gateway** (Q-08, Q-56). Only `fake` (refused in production). No booking can be confirmed in production. | Vendor, credentials, adapter, sandbox end-to-end test. |
| B-3 | EXTERNAL PROVIDER GAP | **No SMS vendor.** Nobody can receive an OTP in production, so nobody can sign in. | Vendor, sender registration, adapter. |
| B-4 | CONFIGURATION GAP | **KYC storage adapter (`s3`) never verified against a real bucket** and cannot cap upload size/type (S-08). | Create private bucket; run live upload/confirm/download; set bucket limits. |
| B-5 | OPEN BUSINESS DECISION | ~~No way to create the first Super Admin in production~~ **Mitigated 2026-10-09**: `npm run bootstrap:admin` (D-40) exists and is verified on a disposable database. Still open: client approval of the procedure, password reset and MFA (Q-66). | Approve the procedure; decide reset/MFA. |
| B-6 | OPEN BUSINESS DECISION | **Only SUPER_ADMIN holds permissions.** Operations Admin, Verification Executive and Support Executive can log in but every protected admin route answers 403 (S-07, Q-33, Q-62). | Client supplies the role-to-permission matrix; then seed it (data change, no code). |
| B-7 | OPEN BUSINESS DECISION (partly closed in phase 2) | **Shortlist, customer worker-profile view and worker photo are now built** (D-46..D-48). Still missing, each blocked by an undecided meaning: worker earnings/payment reference (Q-73), report/block (Q-74), receipt PDF/exports, fee types beyond `BOOKING_FEE`. Original text: **Required features missing** (REQUIREMENTS_TRACEABILITY): shortlist/favourites (FR-WD-005), customer view of a worker profile (AC-04), worker photo (FR-WON-002), worker earnings/payment view (FR-WJ-008), report/block (FR-SUP), receipt PDF/exports, fee types beyond `BOOKING_FEE`, rating summary on search card. | Product decides which are release scope; build the accepted ones. These were not built here because this phase forbids feature development. |

## 2. Important findings (P2)

| ID | Class | Finding | Mitigation |
|---|---|---|---|
| S-04 | CONFIGURATION GAP | Global HTTP throttler is in memory per process by default; limit multiplies with replicas. **Redis store now available** (`THROTTLE_STORAGE=redis`, D-42) but is not the default. | Set `THROTTLE_STORAGE=redis` for multi-replica deployments. |
| S-05 | CONFIGURATION GAP | `TRUST_PROXY_HOPS` defaults to 0: behind a proxy all clients share one IP for OTP/throttle limits. | Set to the real proxy depth. |
| S-08 | CONFIGURATION GAP | Presigned PUT cannot enforce size/type. | Bucket policy. |
| P-5 | CONFIGURATION GAP | About 10 authentication/permission statements on every request; DB connections are the first scaling limit. | Pooler, permission/session cache later. |
| R-1 | OPEN BUSINESS DECISION | Data retention/erasure undefined (Q-02, Q-50, Q-63); audit and notification tables grow without bound. | Decide policy; add archive job. |
| R-2 | OPEN BUSINESS DECISION | Refund authority and cancellation fees undefined (Q-17, Q-21). Staff full refunds exist. | Decide. |
| R-3 | EXTERNAL PROVIDER GAP | Push (FCM) and WhatsApp have no adapters (Q-08). | See PRODUCTION_READINESS. |
| R-4 | CONFIGURATION GAP | CI workflow never executed on GitHub; no deploy pipeline; no monitoring/alerting. | Run it on GitHub; add platform monitoring. |
| R-5 | CONFIGURATION GAP | Backups/restore drill and RPO/RTO undefined. | Managed PITR; decide targets. |

## 3. Improvements (P3)

| ID | Class | Finding |
|---|---|---|
| S-09 | CODE DEFECT (design) | Each refused request writes an audit row (R-27): volume risk under attack. |
| S-10 | CONFIGURATION GAP | `.env.example` has `SWAGGER_ENABLED=true`; set false in production. |
| S-11 | CONFIGURATION GAP | `typescript` present in the production image; size/attack-surface only. |
| S-12 / P-4 | CODE DEFECT (minor) | 17 foreign keys have no covering index. |
| S-13 | CODE DEFECT (minor) | An expected 503 is logged at ERROR as "Unhandled exception". |
| S-14 / P-1 | CODE DEFECT (minor) | Audit log offset pagination costs O(offset): 561 ms at page 5000. |
| P-2, P-3, P-6 | CODE DEFECT (minor) | Unfiltered newest-bookings is a seq scan; dashboard/funnel 330 ms; single dispatch loop poll interval. |

## 4. Defects found during this phase and fixed

| ID | Priority | Defect | Root cause | Fix | Regression test |
|---|---|---|---|---|---|
| S-01 | P1 | **Deadlock** between booking cancellation and replacement withdraw/select/decide under concurrency. | Replacement locked its row first then the booking; booking cancel locked booking then replacement (opposite lock order). | `BookingService.lockBooking`; Replacement now locks the booking first in `cancel`, `select`, `decide`. | `qa.concurrency.int-spec.ts` (3 races, 0 failures after fix) |
| S-02 | P2 | CI would fail on lint and `format:check`. | User S3 changes committed with CRLF; mangled table in attendance README. | Prettier normalised the files; README repaired; no config touched. | CI sequence rerun, exit 0 |
| S-03 | P3 | Worker start log text claimed behaviour that no longer exists. | Stale message. | Text and comment corrected. | - |

## 5. Not verified (cannot be proven here)
GitHub Actions run; any real payment/SMS/push/WhatsApp provider; real S3/Supabase bucket; behaviour behind a real reverse proxy and TLS; load/soak throughput; managed-database latency; backup restore.

## 6. Remaining issues after phase 2 - what each one needs
Columns: requirement or decision - current implementation and evidence - risk and release impact - what is needed (CODE / DECISION / CREDENTIAL / INFRA).

| # | Requirement or unresolved decision | Current implementation and evidence | Risk and release impact | Needed |
|---|---|---|---|---|
| 1 | FR-WJ-008 worker earnings / payment reference (Q-73): what is shown, from which authoritative data | None. `payments` holds only the customer booking fee; no wage or payout model exists in SRS/FRD/data model | A Must requirement is absent; release blocker unless descoped in writing | DECISION, then CODE |
| 2 | FR-SUP-006 report/block (Q-74): effect, symmetry, review, abuse cap | None; support tickets are the only channel | A Must safety feature is absent; release blocker unless descoped | DECISION, then CODE |
| 3 | Admin permission matrix (Q-70, Q-62) | Only Super Admin holds permissions; proposal in `backend-gap-remediation.md` section 4 NOT applied | Three admin roles cannot work; release blocker | DECISION (then API call or seed change) |
| 4 | Booking state model (Q-55) | FRD section 4 model, 297 transitions proven | A different final model means a migration; release blocker | DECISION |
| 5 | Payment, SMS, push, WhatsApp vendors (Q-08, Q-56, Q-36, Q-57) | Interfaces, `disabled` and test adapters; fakes refused in production | Nobody can log in or pay; release blocker | CREDENTIAL + CODE (adapter) |
| 6 | KYC/photo storage: real bucket, malware scan, size cap at the bucket, retention (Q-69, Q-50, Q-71) | Private-storage boundary, signed links, size + signature checks, audit; S3 adapter never run against a real bucket; no scanner | Real identity documents cannot be accepted safely; release blocker | CREDENTIAL + INFRA + DECISION |
| 7 | Admin password reset and MFA (Q-66) | Bootstrap CLI and self-service password change exist | Forgotten password needs manual help; MFA absent | DECISION (+ channel) |
| 8 | Re-check reminder recipients and lead time (Q-75) | Worker reminded once when the date is reached | Admins are not told; low | DECISION |
| 9 | Shortlist cap/notification (Q-72), photo limit/mandatory (Q-71) | 100-entry technical guard; photo feature OFF until `PROFILE_PHOTO_MAX_BYTES` is set | Low; photo is unusable until configured | DECISION + CONFIG |
| 10 | Reopen of support tickets, SLA, attachments (Q-59) | assignment, escalation, resolution, privacy exist | Medium | DECISION |
| 11 | Refund authority and cancellation fees (Q-17, Q-21) | Staff full refunds; no automatic fees | Medium | DECISION |
| 12 | Rating shown to customers (Q-60) | Aggregate (average, count) now appears on cards and profile because FR-WD-003 requires it | Needs sign-off | DECISION |
| 13 | Retention/erasure for audit, notifications, KYC, outbox (Q-02, Q-63) | Nothing is deleted | Unbounded growth | DECISION + CODE |
| 14 | Deployment: proxy depth, replicas, Redis topology, TLS, backups, monitoring/alerting, GitHub Actions run, SLOs | Production defaults to the Redis throttle store; health endpoints and counts exist; nothing exercised on real infrastructure | Cannot be proven here | INFRA |
