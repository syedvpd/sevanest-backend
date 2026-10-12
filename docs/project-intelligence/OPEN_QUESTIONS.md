# OPEN_QUESTIONS

Owner: C=client/business, U=user(tech lead), L=legal, V=vendor. "Blocks" = earliest work that cannot be safely done.

## Source-declared open (SRS §14 / FRD §9)
| ID | Question | Owner | Blocks |
|---|---|---|---|
| Q-01 | Fee/pricing values (configurable; no hard-code) | C | payments seed data only |
| Q-02 | Data retention/deletion policy (KYC, audit, OTP, logs) | C+L | KYC storage lifecycle, schema deletion fields |
| Q-03 | Legal review: terms/privacy/consent; trademark | L | go-live |
| Q-04 | Verification partner + which checks are mandatory for "Verified" badge (FRD §9 #11); police verification process | C | verification module config |
| Q-05 | Final booking state list + transitions (conflict C-02) | C+U | bookings/payments/search schema |
| Q-06 | Numeric perf/availability targets | C | perf tests/capacity |
| Q-07 | Device/OS + browser matrix | C | QA |
| Q-08 | Cloud, payment, SMS, WhatsApp, maps vendors | C+U | adapters, infra, IaC |
| Q-09 | Replacement & rating eligibility rules | C | replacements, ratings |
| Q-10 | Emergency-contact visibility + sensitive-doc access policy by role | C | KYC access, FR-SEC-007 |
| Q-11 | Confirm role-permission matrix (FRD §2 proposed) | C | RBAC seed |
| Q-12 | Field limits: OTP length/expiry/attempts/resend, file sizes/types, text lengths | C+U | auth, uploads |

## Found during discovery
| ID | Question | Owner |
|---|---|---|
| Q-13 | Written client approval of NestJS (BEA says not approved) | C |
| Q-14 | Which module owns config masters (areas, fees, plans, templates), shortlist, report/block, engagements? (G-02) | U |
| Q-15 | Booking vs Engagement: one entity or two? Where do ACTIVE/COMPLETED/REPLACED live? (C-04) | U+C |
| Q-16 | May customers book "verification-in-progress" workers? (FRD FM-06 "as configured" vs FM-04/PRD "verified") (C-07) | C |
| Q-17 | Who may refund? FRD gives Ops Admin payments=View only; Super Admin only refunder? (C-06) | C |
| Q-18 | Admin auth: password only or MFA? Account creation by Super Admin (FRD FM-01); WIRE says mechanism unspecified | C |
| Q-19 | Admin React app architecture doc—will one be provided? (G-01) | U |
| Q-20 | Email channel (TRD §9) in V1? Not in SRS | C |
| Q-21 | Customer fee on cancel / refund rules ("per configured rules" FRD FM-06) | C |
| Q-22 | Mono-repo vs separate repos for backend/apps/admin; Node & dependency versions; hosting region (data residency) | U |
| Q-23 | RESOLVED 2026-10-08: repo initialised; governance pack stays external/local and gitignored (D-11) | U |
| Q-24 | OTP SMS in India typically needs regulated sender/template registration — vendor & timeline? (INFERENCE, not in specs) | C+V |

## Raised by Modules 1-3 (Auth, Users, Customers) - 2026-10-08
| ID | Question | Owner | Current behaviour (no value invented) |
|---|---|---|---|
| Q-25 | May one mobile number hold both a Customer and a Worker account? | C | One mobile = one account of one type (existing unique constraint). The other app gets 409 ACCOUNT_TYPE_MISMATCH. |
| Q-26 | Customer verification: which states exist beyond pending/verified, and what promotes PENDING to VERIFIED (FRD FM-02 "basic customer verification")? | C | PENDING on creation; only an authorised admin changes it; no automatic promotion; audit keeps before/after; no history table. |
| Q-27 | Does "blocked/blacklisted" (FRD FM-01, FR-ADM-003) differ from suspended, and how? | C | Only ACTIVE/SUSPENDED exist. |
| Q-28 | Approved OTP length/expiry/attempts/resend/send limits/lockout, admin lockout values, token lifetimes (refines Q-12) | C+U | All required configuration with no default; dev/test placeholders only; production must set reviewed values. |
| Q-29 | Admin password policy, MFA, password change/reset, and how the first production Super Admin is provisioned (extends Q-18) | C+U | Min length is configuration; no MFA/change/reset flow; seed bootstrap works only outside production. |
| Q-30 | Refresh token: absolute or sliding lifetime? Confirm replay revokes the session (user-directed 2026-10-08) | U | Absolute expiry; replay of a rotated token revokes the session and is audited; simultaneous double refresh therefore revokes too. |
| Q-31 | Default address: should the first address auto-default; after removing the default, promote another? | C | Neither; default is explicit only. |
| Q-32 | Supported language list; maximum saved addresses; field length limits (refines Q-12) | C | Language: format check + optional SUPPORTED_LANGUAGES allow-list; no address cap; technical length caps only. |
| Q-33 | Role-to-permission matrix (Q-11): only Super Admin is mapped (5 permission codes). | C | Other three admin roles hold no permissions yet. |
| Q-34 | Is revealing "registered but suspended" at OTP request acceptable (user-friendly message vs enumeration)? | C | Revealed (FRD FM-01 asks for a clear message). |
| Q-35 | Masking/audit policy for admin access to customer personal data (mobile shown in full in customer detail; detail views not audited) | C+L | List masked, detail full, no read audit. |
| Q-36 | SMS vendor (Q-08) and sender/template registration (Q-24) | C+V | Interface + `disabled` + test-only `memory` adapter; real OTP delivery impossible until chosen. |

## Raised by Modules 4-6 (Workers, Service Categories, Availability) - 2026-10-09
| ID | Question | Current behaviour (no value invented) |
|---|---|---|
| Q-37 | Availability granularity: weekdays, effective dates, recurring vs one-time, overnight windows, a temporary "not available" switch | Daily time-of-day windows only (start < end within a day, no overlap); no weekdays/dates |
| Q-38 | Engagement preference: single or multiple? Engagement-type vocabulary conflict (FR-SD-003 vs PRD table: Monthly/Shift/One-time) (C-13) | Single value FULL_TIME/PART_TIME/LIVE_IN per FRD "Select"; categories carry no engagement types |
| Q-39 | Expected salary: period (monthly/daily/hourly) and currency semantics | Positive rupee amount, no period |
| Q-40 | Worker "Personal Details" fields beyond name; experience display unit | Only `name`; experience stored as months |
| Q-41 | Post-submission rules: lock or re-review after edits; worker status model (C-03); photo upload flow; KYC gating | Two states DRAFT/SUBMITTED; edits allowed after submit; photo/KYC not handled |
| Q-42 | Customer-facing worker visibility and emergency-contact policy (Q-10/Q-16) | No worker data exposed to customers; private fields to owner and `worker.view` only |
| Q-43 | Service-area catalogue (launch areas) and ownership of config masters (Q-14) | Area master lives in Availability, empty until an admin creates areas; categories seeded from the documents |
| Q-44 | Assisted onboarding scope: may an admin create the worker account itself? | Admin edits an existing worker's profile/availability only |

## Raised by Modules 7-9 (Search, Matching, Verification) - 2026-10-10
| ID | Question | Current behaviour (no value invented) |
|---|---|---|
| Q-45 | Verification checklist: which check types exist, which need documents, which document types are accepted (extends Q-04, C-03) | Five types from FRD FM-05 (PROPOSED): IDENTITY, ADDRESS, EMERGENCY_CONTACT, PREVIOUS_EMPLOYMENT, POLICE_VERIFICATION; mobile OTP is verified by Auth. Identity/address/police need an uploaded document, the other two need the profile data. No document-type vocabulary. Required set is EMPTY until an administrator sets it, so nobody counts as verified (fails closed) |
| Q-46 | Search ranking, relevance, matching score/weights | None defined. Search sorts by experience (stable, id tie-break); Matching orders by earliest submitted profile and answers `ranked: false` |
| Q-47 | Location and availability semantics: area match vs radius/geo, partial time overlap, weekdays, start date, customer daily/hourly engagement | Exact match on the worker's preferred service area; a worker matches when ONE availability window covers the whole requested range; no radius, weekday or start date; engagement limited to FULL_TIME/PART_TIME/LIVE_IN (Q-37, Q-38) |
| Q-48 | May customers see verification-in-progress workers? (C-07, Q-16) | No: customers and Matching see only fully verified workers; there is no "as configured" mode |
| Q-49 | Verification permissions: FRD section 2 matrix says Verification Executive cannot approve, FM-05 says the executive approves/rejects | Four permissions (`verification.review`, `.decide`, `.document.view`, `.configure`) plus `matching.run`; only SUPER_ADMIN is mapped (Q-11, Q-33) |
| Q-50 | KYC document handling: file size, accepted types, number of documents, link lifetime, encryption at rest, malware scanning, retention/deletion (Q-02, Q-12) | Size, types and link lifetime are REQUIRED environment values with no default; 10 open documents per check is a technical abuse guard; no deletion is exposed; scanning and encryption are the storage vendor's concern (none selected, Q-08) |
| Q-51 | External verification partner and worker notification of outcomes (Q-04, FM-05 step 5) | Manual review only; the provider abstraction is unused; no notification is sent (Notifications module not built) |
| Q-52 | Worker card content: name or first name, photo, rating summary, salary/budget filter (FR-WD-001..004, FR-SD-004) | Card shows experience, skills, languages, areas, availability and the badge only; no name, photo (not built), rating (module not built) or salary filter (no period, Q-39) |

## Raised by Modules 10-14 (Booking, Payment, Notifications, Attendance, Replacement) - 2026-10-11
| ID | Question | Current behaviour (no value invented) |
|---|---|---|
| Q-53 | Attendance: is the status list configurable (FRD FM-09 says so)? How far into the past may a worker record? Dispute handling | Fixed PRESENT / ABSENT / EXCEPTION; a worker records today only; staff and customers (exception only) from the booking start date to today; disputes belong to Support (not built) |
| Q-54 | Replacement: eligibility rule (Q-09), reason list, whether the replacement booking needs a new interview or fee, who may select | `REPLACEMENT_POLICY` boundary whose default only requires an ACTIVE booking; free-text reason; the replacement booking starts MATCHED and follows the normal lifecycle; customer or staff may select after staff approval |
| Q-55 | Booking (C-02/Q-05, C-04/Q-15): final state model; worker acceptance as its own state; interview/trial outcome values; gating by schedule/start date; one worker for several customers; customer address vs service area | FRD section 4 states used as the working model; accept is implicit in scheduling; outcome is a free note; no date gating; no worker double-booking rule; location = enabled service area; one live booking per customer, worker and service |
| Q-56 | Payment: gateway vendor and its webhook format (Q-08), status vocabulary (C-05), fee types and amounts (Q-01), who may refund and cancellation fee rules (Q-17, Q-21), partial refunds, reconciliation schedule | Provider abstraction with `disabled` and a test-only `fake` adapter; booking fee only (`BOOKING_FEE`, empty until an administrator sets it); full refunds by staff with `payment.refund`; nothing refunded automatically; reconciliation on demand |
| Q-57 | Notifications: vendors and credentials (Q-08), template language per user, wording, email (Q-20), events whose producers do not exist yet (ticket, re-check due), retry numbers | Adapters `disabled` / test-only `memory`; templates are admin data and none are seeded; language `en`; platform retry defaults (5 attempts, exponential backoff) |

## Raised by Modules 15-19 (Ratings, Support, Reports, Admin, Audit/Security) - 2026-10-12
| ID | Question | Current behaviour (no value invented) |
|---|---|---|
| Q-58 | Ratings: the "configured scale", what "completed or otherwise eligible" adds beyond COMPLETED (FRD FM-10, section 9), review length limit | `RATING_SCALE_MAX` is required configuration (1..max, no default); eligibility is the `RATING_POLICY` boundary and only accepts a COMPLETED booking with a worker (a REPLACED booking is not rateable); review capped at 2000 characters as a technical guard |
| Q-59 | Support: SLA targets and breach escalation, owner auto-assignment, priority scale and rules, reopening, attachments, safety-incident route to Operations/Super Admin, the effect of "report/block", the category list | Manual assignment; PROPOSED priority LOW/MEDIUM/HIGH set by staff; OPEN, IN_PROGRESS, ESCALATED, CLOSED with resolution required; no reopen, SLA, attachment, chat or block; categories are admin data and none are seeded (no ticket can be raised until one exists) |
| Q-60 | Ratings: may a customer edit or delete a rating? Does the worker see who rated, may the worker reply, may the rating be shown to other customers (Q-52)? | No customer edit or delete; the worker sees score, review and date only; ratings are not shown to customers or used by Search/Matching; admin can hide and restore with a reason |
| Q-61 | Reports: the FRD section 7 definitions are PROPOSED; reporting periods, "top-rated" minimum, whether cancelled requests count as repeat, exports | Definitions stated in every response; date range required and capped at 366 days (technical guard); top-rated has an optional `minRatings` (default 1); every request counts as a booking for repeat customers; no export |
| Q-62 | Admin permission matrix (extends Q-11, Q-33) and role administration: which permissions do Operations Admin, Verification Executive and Support Executive hold; may roles be created beyond the four (FM-16 "role"); password change/reset, MFA (Q-29) | Seed still maps only Super Admin. The Super Admin sets the other three roles through `PUT /admin/roles/{code}/permissions` (audited, immediate). `role.manage`, `audit.view`, `admin.manage_users` can only be held by Super Admin. No custom roles. Dashboard sections follow the permissions a role holds |
| Q-63 | Audit: retention and archiving (DR-005, NFR-SEC-009), whether reading the audit log or customer detail is itself audited (Q-35), alerting on repeated denials | Append-only, kept indefinitely; refused access (role, user type, permission) and wrong-OTP attempts are recorded; reads are not audited |
| Q-64 | Abuse limits for write endpoints that users can call repeatedly (tickets, ratings): per-user daily caps or stricter throttles | Only the global per-IP throttle and the data rules (one rating per booking, ticket needs a configured category) apply |
| Q-65 | Is the FRD section 4 booking state model final (release blocker, C-02/Q-05/Q-55); which missing features are release scope (shortlist, worker profile view for customers, worker photo, worker earnings view, report/block, receipts); how is the first Super Admin created in production; performance targets (Q-06) | None invented. See `docs/qa/OPEN_BLOCKERS.md` |

## Raised by the backend gap-remediation phase - 2026-10-09
| ID | Question | Owner | Current behaviour (no value invented) |
|---|---|---|---|
| Q-66 | Approve the first-Super-Admin procedure (`npm run bootstrap:admin`: env-supplied credentials, one-time, audited). Is MFA mandatory for admins? How is a forgotten admin password reset (channel, approver)? (extends Q-18, Q-29, B-5) | C+U | Bootstrap CLI and self-service password change exist and are tested. There is NO password reset and NO MFA: both need a decision and, for reset, a delivery channel (email is not in V1 scope, Q-20). Until then a locked-out admin needs a Super Admin to create a replacement account, or an operator database procedure |
| Q-67 | Deployment topology for rate limits: number of API replicas, reverse-proxy depth (`TRUST_PROXY_HOPS`), `THROTTLE_STORAGE` (extends S-04, S-05) | U | `THROTTLE_STORAGE=memory` is the default (per process); `redis` is available and tested; production start-up warns when the proxy depth is 0 or the storage is `memory` |
| Q-68 | Who may retry failed notifications; how long failed rows and BullMQ failed jobs are kept; does a failed critical message need paging (extends Q-57, Q-63) | C+U | `notification.manage` holders may retry a FAILED notification (audited); nothing is deleted; no paging |
| Q-69 | KYC upload content rules: malware-scan vendor and fail-closed policy, whether further types (e.g. HEIC) are accepted, bucket-side size cap (extends Q-50, S-08) | C+V | Content is verified against the file signature for PDF/JPEG/PNG; a mismatch is refused and audited; no scanner; a presigned PUT cannot cap size at the bucket |
| Q-70 | Approve, amend or replace the PROPOSED (NOT applied) admin permission matrix in `docs/qa/backend-gap-remediation.md` section 4 (extends Q-11, Q-33, Q-49, Q-62) | C | The seed still maps only SUPER_ADMIN |

## Raised by gap-remediation phase 2 - 2026-10-09
| ID | Question | Owner | Current behaviour (no value invented) |
|---|---|---|---|
| Q-71 | Profile photo: size limit, accepted types beyond JPEG/PNG, whether a photo is mandatory before submission (FRD FM-04 says "Yes, size limit applies"), moderation of photos (extends Q-12, Q-41) | C | `PROFILE_PHOTO_MAX_BYTES` is optional configuration with no default: while unset, photo upload answers 503 `PHOTO_NOT_CONFIGURED`. JPEG/PNG only, signature-checked. Not required for submission. No moderation and no malware scan |
| Q-72 | Shortlist: maximum entries per customer, whether a shortlisted worker is notified, whether shortlisting should feed matching or the interview request (FRD FM-03 postcondition "proceed to interview/trial request") | C | Technical guard of 100 entries per customer (`SHORTLIST_FULL`); no notification; booking does not read the shortlist |
| Q-73 | Worker "earnings / payment reference where applicable" (FR-WJ-008, FRD FM-08): what is it? The only money the platform records is the customer's booking fee (`payments`); wages and any worker payout are not in the data model or the specs | C | No worker-facing earnings or payment endpoint. A worker can see their bookings and ratings only. Exposing the customer's payment record to the worker would be a privacy decision |
| Q-74 | Report/Block (FR-SUP-006, FRD FM-12): what blocking does (hide the pair from each other's search/matching, refuse bookings, stop notifications), whether it is symmetric, whether a report must also open a ticket, who reviews and lifts a block, and the abuse cap | C | Not built; no table. Support tickets (customer or worker) are the only reporting channel |
| Q-75 | Re-check reminder recipients: the FRD matrix says Worker AND Admin; which admins, through which channel (extends Q-57)? Reminder lead time before the date? | C | The worker is reminded once when the date is reached; no admin is notified; no lead time |

## Raised by Phase 1 production readiness - 2026-10-12
| ID | Question | Owner | Current behaviour (no value invented) |
|---|---|---|---|
| Q-76 | SMS vendor and India DLT registration: Twilio or MSG91 (or another)? Principal Entity ID, approved sender (header) and approved templates for the OTP and for each transactional SMS (extends Q-08) | C | Adapters for BOTH exist and are selected by `SMS_PROVIDER`; production OTP works only once the client supplies credentials and a DLT-approved OTP template. MSG91 refuses any SMS without a mapped template; only the OTP template is mapped |
| Q-77 | Cancelling a booking the customer already paid for (and a payment that arrives after cancellation): refund or not, fee, deadline, who decides (extends Q-17, Q-21) | C | Nothing is refunded automatically. A `PAID_BOOKING_CANCELLED` / `LATE_PAYMENT_BOOKING_NOT_PENDING` exception is raised with amount, gateway refs and states; a person with `payment.refund` refunds in full and a person with `payment.manage` closes the item |
| Q-78 | Expiry of an unpaid `PENDING_PAYMENT` booking: after how long is it cancelled, and is the open gateway order abandoned? (extends Q-55) | C | No expiry job exists; such bookings stay open and hold the customer/worker/category slot until the customer or an admin cancels |
| Q-79 | Razorpay account set-up: live KYC, auto-capture on, payment methods, webhook events, partial refunds, refund speed (normal vs optimum) | C+U | Test keys only. Auto-capture assumed (an authorized payment is never treated as paid). Full refunds only, normal speed |
| Q-80 | Who is alerted about money problems, through which channel, and how fast; how long resolved items are kept (extends Q-57, Q-63, Q-68) | C | `PAYMENT_EXCEPTION_ALERT` goes to active admins holding `payment.manage` via the notification pipeline only if a template for that event exists (none seeded); `GET /admin/payment-exceptions` is the source of truth |
| Q-81 | KYC malware scanning vendor, quarantine instead of delete, retention of confirmed documents (extends Q-69) | C+V | No scanner. Structural validation (type, size, end-of-file marker), SHA-256 recorded at confirmation and re-checked before a reviewer gets a link; rejected uploads are deleted; uploads never confirmed are deleted after 24 h (engineering default, not a retention rule); confirmed documents are never deleted |
| Q-82 | Real proxy topology per environment (Render only, or CDN in front) to set `TRUST_PROXY_HOPS` | U | Production refuses to start without an explicit value; `render.yaml` template uses 1 |
