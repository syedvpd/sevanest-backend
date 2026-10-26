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
| Q-34 (CLOSED 2026-10-14: D-72) | Is revealing "registered but suspended" at OTP request acceptable (user-friendly message vs enumeration)? | C | Revealed (FRD FM-01 asks for a clear message). |
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
| Q-70 (CLOSED 2026-10-14: D-71) | Approve, amend or replace the PROPOSED (NOT applied) admin permission matrix in `docs/qa/backend-gap-remediation.md` section 4 (extends Q-11, Q-33, Q-49, Q-62) | C | The seed still maps only SUPER_ADMIN |

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
| Q-83 | Cancellation fee and automatic refund rules (who is refunded how much and when) (extends Q-17, Q-21, Q-77) | C | Interim D-59: fee 0, no automatic refund; paid + cancelled raises a `PaymentException` for a person with `payment.refund` |
| Q-84 | How early may a service start before its agreed start date | C | `BOOKING_START_EARLY_DAYS` (default 0); staff can always start |
| Q-85 | What makes a customer VERIFIED (extends Q-26) | C | `CUSTOMER_AUTO_VERIFY`: complete profile + active address; staff decisions are final |
| Q-86 | Who may see a worker's emergency contact and address, and when (extends Q-74) | C | Any admin with `worker.view`; each read audited |
| Q-87 | Admin MFA method and forgotten-password process (extends Q-66) | C | Self-service change exists; a Super Admin can set a temporary password for another admin; no MFA |
| Q-88 | Data erasure and retention periods for personal data, documents, audit logs (extends Q-69) | C+V | Deletion requests are recorded for staff (`/me/deletion-request`); nothing is erased automatically |
| Q-89 | Is malware scanning of documents required, and with which scanner | C+V | Optional ClamAV via `CLAMAV_HOST`; without it documents are validated but not scanned (readiness warns) |
| Q-90 | Maps provider (geocoding, distance) and whether matching uses distance | C+U | Not integrated; addresses keep optional coordinates |
| Q-91 | Error monitoring tool and backup/restore targets | U | Infrastructure: `docs/qa/OPERATIONS_RUNBOOK.md` |
| Q-92 | Travel/turnaround time a worker needs between two jobs on the same day; whether an unpaid confirmed booking should hold the worker (and for how long) (extends Q-78) | C | `BOOKING_TRAVEL_BUFFER_MINUTES=0`; an unpaid PENDING_PAYMENT booking holds the worker until paid or cancelled |
| Q-93 | The engagement types each of the six categories offers (PRD 4 says "typical") and what "Monthly" means (extends Q-38) | C | No list applied: every category accepts every engagement until an administrator sets it |

## Raised by the customer-app team - 2026-10-13
| ID | Question | Owner | Current behaviour (no value invented) |
|---|---|---|---|
| Q-76 | Price guidance for the budget step: who owns the numbers and what is the model (category x area x engagement -> min/max/period/basis)? | C | Nothing exists; no endpoint. See `docs/qa/customer-app-api-gaps.md` #4 |
| Q-77 | Budget filter in search and matching days of week / start date (extends Q-37, Q-39, Q-47) | C | Budget is stored on bookings as a label only; search filters on time-of-day windows only |
| Q-78 | Resolve coordinates to a service area: boundary data and overlap rules | C+U | Areas have no geometry; not built |
| Q-79 | Customer profile photo: in V1 scope? | C | Not in SRS 3.2 / FRD FM-02; not built |
| Q-80 | Rating filter (`minRating`): include or hide unrated workers; any ranking (extends Q-46) | C | Not built; reviews are listed to customers (Q-60 sign-off needed) |

## Customer-app decisions needed (2026-10-13)
* **Q-94 Price bands**: who supplies and maintains typical price bands (category x engagement x area, amount, period)? Safe now: `GET /pricing/guidance` answers 404 until an admin enters bands. Impact: the app hides the guidance card.
* **Q-95 Budget filter**: what period does a worker's expected salary use (hour, day, month), and may search hide workers above the customer's budget? Safe now: budget is a label on the booking. Impact: the budget range does not filter search.
* **Q-96 Weekday availability**: are workers available on specific weekdays? Safe now: availability is time of day only; `startDate` and busy hours are matched. Impact: weekdays in the requirement are not matched.
* **Q-97 Customer photo**: is a customer profile photo in V1? Safe now: not built (FR-CUS-001..006 do not list it). Impact: no "Add a photo".
* **Q-98 Map provider / area boundaries**: polygons or a geocoder for exact area lookup. Safe now: admin-set centre and radius per area, then exact name. Impact: some positions need a manual area pick.
* **Q-99 Interview length and horizon**: client sign-off on 60 minutes and 14 days (current defaults of `/slots`).
* **Q-100 Receipt / invoice document**: is a downloadable receipt required in V1, and is it a GST tax invoice (legal entity name, GSTIN, address, SAC code, tax split, invoice numbering series) or a plain payment receipt? Safe now: `GET /payments/{id}/receipt` returns the data; no PDF is generated. Impact: the app renders the receipt on screen only. Owner: C (client finance).
* **Q-101 Attendance states and times**: does the client approve LATE and LEAVE as statuses and check-in/check-out times (FRD FM-09 lists present/absent/exception "configurable"; SRS FR-ATT-003 keeps V1 status-based)? Safe now: implemented additively (D-76, D-77); times are server-stamped only on the worker's explicit check-in/out. Impact: if rejected, hide Late/Leave and the time rows in the app.
* **Q-102 Ended-early ratings**: may a REPLACED booking ("Ended early") be rated, and after how long? Safe now: not rateable (D-79); `RATING_ALLOW_ENDED_EARLY` switches it on without code changes.
* **Q-103 Rating tags**: is there a fixed tag catalogue (for example punctual, polite)? Safe now: none; no tags are stored or accepted. Impact: the app must not show tag chips.
* **Q-104 "Total spent" and "services"**: confirm that spent = money still held (successful payments and unreturned refunds) across all the customer's bookings, and that a service = COMPLETED or REPLACED (D-78). Safe now: that definition, documented in the API.
* **Q-105 Review length and worker name display**: confirm 300 characters (D-80) and that showing the first name and last initial from the interview stage on is acceptable (D-81; the specs keep search cards anonymous).
* **Q-106 Rebook rules**: may a CANCELLED or REPLACED booking's worker be hired again, and does hiring again need a new interview? Safe now: COMPLETED only, new booking starts MATCHED (D-82).
* **Q-107 Ticket photos**: may customers/workers attach up to 3 photos to a ticket, and who may see them, for how long are they kept, and are they scanned? Safe now: nothing is accepted (no URL-as-proof); an upload route reusing the photo pipeline can follow the answer.
* **Q-108 Ticket states for the customer**: does the client want "Waiting for you" / "Resolved" states or reopening of a closed ticket (FRD FM-12 lists none; Q-59)? Safe now: OPEN, IN_PROGRESS, ESCALATED (internal, still being worked), CLOSED (final); new ticket instead of reopen. Also: is a safety-category ticket prioritised automatically (and what may the app promise)?
* **Q-109 Notification preferences and deletion**: channel defaults, which messages are mandatory (safety, payment), and the retention/deletion rule for inbox items. Safe now: no preferences and no delete are stored; mark-unread exists (D-85).
* **Q-110 Route types in push/inbox**: should interview, payment and replacement events route to their own screens (`interview`, `payment`, `replacement`) instead of `booking`? Safe now: unchanged (booking/ticket only emitted); the app can already handle more types. Also: should a rating prompt notification exist (nothing emits `RATING_RECEIVED` today)?
* **Q-111 FAQ/help content and support contact**: supply the approved FAQ text (and whether staff maintain it) and the real `SUPPORT_CONTACT_PHONE` / `SUPPORT_CONTACT_EMAIL`. Safe now: no FAQ endpoint, contact `null`.
* **Q-112 Account deletion** (customer-app request 56): what must happen to bookings, payments, ratings, support tickets and audit records when a customer asks to delete the account (retention periods, anonymise vs keep, legal holds, refund of an open booking)? Safe now: `/me/deletion-request` records the request for staff (blocked while a booking or payment is open); nothing is erased; extends Q-88.
* **Q-113 Customer photo scope** (request 8): is a customer photo in V1, and may workers (after a booking) or staff see it? Safe now: the photo is stored and readable by its owner only; no other response contains it. Not in SRS 3.2 / FRD FM-02.
* **Q-114 Booking terms text** (requests 12-13): the approved cancellation, refund and replacement policy text, fixed cancellation reasons, and whether a cancellation fee or refund applies. Safe now: the fee amount is quoted (`GET /fees/booking`), refund state is read from the payment (`GET /payments?bookingId=`), `cancel` takes a free-text reason; no policy text, reason list or refund promise is served (extends Q-77, Q-83).
* **Q-115 Interview/schedule slot enforcement** (request 9): should `schedule` / `POST /interviews` reject times outside the worker's availability windows or beyond the 14-day horizon that `GET /search/workers/{id}/slots` advertises? Safe now: only "in the future" is enforced there; double-booking of the worker is enforced at booking creation and confirmation (D-63). Also: may a scheduled interview be rescheduled through `POST /bookings/{id}/schedule` (today: 409, use `/interviews/{id}/reschedule`)?
* **Q-116 Worker/staff free text in the customer timeline**: staff cancellation reasons and interview notes are shown to the customer on their own booking (existing behaviour); a worker's decline reason no longer is (D-86). Confirm whether staff free text should also be withheld.

* **Q-117 Criminal self-declaration meaning**: the specs do not define it. Built as the worker's own yes/no statement ("I have / I do not have a criminal record or pending case") plus optional details when yes, with a consent flag and server-stamped time (D-87). Needed from the client/legal: exact assertion, label and consent wording; whether it is mandatory before profile submission; what staff must do with a "yes" (nothing is blocked today); retention; whether it must be re-confirmed.
* **Q-118 Mandatory/optional checks and category variation**: still Q-04/Q-45. The required set is a single global admin-configured set; there is no per-category or per-service-type requirement. Needed: which of IDENTITY, ADDRESS, EMERGENCY_CONTACT, PREVIOUS_EMPLOYMENT, POLICE_VERIFICATION, SKILL_CERTIFICATE, LICENSE are mandatory, whether that differs by category, whether a certificate/licence only applies to some categories (today a worker of any category can submit them), who may approve overall onboarding (today: no separate approval; VERIFIED = every required check APPROVED and not past `recheckAt`), and what a rejected/expired mandatory check does to an already-visible worker (today: they drop out of search at once).
* **Q-119 Document rules**: accepted types are the env set (`VERIFICATION_DOCUMENT_CONTENT_TYPES`, subset of pdf/jpeg/png) and `VERIFICATION_DOCUMENT_MAX_BYTES`; up to 10 open documents per check is a technical guard. Needed: the approved types, size and per-check document count; whether certificates may carry an expiry date (`recheckAt` is set by the reviewer today, not read from the document).
* **Q-120 Real provider verification**: SMS (Twilio/MSG91) and FCM were never exercised against a live provider (no credentials/test number in this workspace). Owner action: set provider secrets on the target environment and run `npm run check:providers` plus one real OTP and one real push to a registered device.
* **Q-121 Rating tag rules** (extends Q-103): confirm the nine-tag catalogue and whether tags must match the score (positive for 4-5, negative for 1-2). Safe now: any tag with any score is accepted.
* **Q-122 `neededFrom` meaning** (extends Q-107): should the date drive the replacement booking start, the review time or the fee? Safe now: stored and shown only.
* **Q-123 (ANSWERED 2026-10-26, D-90)** Worker-level verification decision: is a single "approve application" step wanted on top of per-check approval (states, who may do it, what `CORRECTIONS_REQUESTED` maps to)? Safe now: no such state; the overall result is the derived `level`; a rejected check lets the worker resubmit it. See `docs/qa/worker-verification-api-gap-audit.md`.
* **Q-124 (ANSWERED, D-90)** Application number: is a human-readable application reference required (format, series, when created)? Safe now: none; `workerId` is the application identity and `applicationSubmittedAt` its submission time.
* **Q-125 (ANSWERED, D-90)** Reviewer reassignment: who may take a case from another reviewer, and is there release after inactivity? Safe now: a claimed check answers 409 `CHECK_ALREADY_ASSIGNED`; no override.
* **Q-126 (ANSWERED, D-90)** Rejection reason codes / approval evidence: the reason-code list and which checks need notes before approval. Safe now: free-text remarks only (mandatory on reject and recheck).
* **Q-127 (ANSWERED, D-90)** Verification-completed handoff: who is told, how, and is a new outbox topic wanted (the outbox is notification-only; admin routing is Q-57)? Safe now: no event; `GET /admin/workers?verified=true` lists verified workers.
* **Q-128 (ANSWERED, D-90)** Worker activation: is a separate operations activation step required after verification (new state and permission)? Safe now: none; suspension is `PATCH /admin/users/{userId}/status`.
* **Q-129 (ANSWERED, D-90)** Verification SLA: due time, calendar and overdue rule. Safe now: no `dueAt` / `isOverdue`.
* **Q-130 Terminal rejection codes**: the client named CRIMINAL_RECORD_DISQUALIFIED and "FRAUDULENT_DOCUMENT" as disqualifying, but the approved code list has no FRAUDULENT_DOCUMENT. Built: CRIMINAL_RECORD_DISQUALIFIED and SUSPECTED_TAMPERING are final. Confirm or change.
* **Q-131 Client text mentions things the backend does not have**: `ResubmitDocumentScreen` and `DisplayFormatters` are app code; the status names UNDER_REVIEW / ACTION_REQUIRED are served as `applicationStatus` while the per-check statuses keep SUBMITTED / IN_REVIEW / REJECTED. Confirm the app maps the two levels this way.
* **Q-132 Alert recipients and city managers**: the ops alert at sign-off goes to holders of `worker.activate` (no city/area manager role exists). Alerts carry the application reference only, no name, city or category (alerts must not hold personal data). Confirm.
* **Q-133 Document number for Aadhaar**: only the last four characters are stored. The worker app should send the number only when the worker types it; the backend never invents digits.
* **Q-134 Claim SLA clock**: the 2-hour claim SLA is counted in clock hours (not business hours). Confirm.
* **Q-130 Worker names before any booking**: confirm that search cards, profile and shortlist may show first name and last initial (D-91; the specs kept cards anonymous, Q-42). Safe now: shown as built; revert by removing `name` and `initials` in `toCard`.
* **Q-131 Worker pricing and "View all"**: where does a card price come from (worker expected pay needs a period and a range, Q-39, and a decision to show it to customers), and should "View all" on Home show open and finished bookings together (`GET /bookings`)? Safe now: no price returned; "View all" uses `GET /bookings`.
