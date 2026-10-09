# Requirements traceability (SRS / FRD) - final QA

Scope: every requirement ID of the SRS (sections 3-5) and the FRD acceptance criteria AC-01..AC-11, traced to the module, the API, the
workflow and the automated evidence. Backend only. Source documents are all Draft; where they conflict or are silent the row says so.

**Status vocabulary**

| Status | Meaning |
|---|---|
| PASS | Implemented as specified and covered by an executed test (named). |
| PARTIAL | Implemented, but part of the requirement is missing or interpreted; the gap is stated. |
| FAIL | Required by the specification, not implemented. |
| BLOCKED | Implemented behind an abstraction, but cannot work in production until an external provider is chosen/configured. |
| OPEN DECISION | The specification is silent or contradictory; the system applies a recorded, safe default and does **not** claim the rule is settled. |
| NOT APPLICABLE | Frontend, infrastructure or organisational requirement outside this repository. |

Test file names refer to `test/integration/*.int-spec.ts` unless stated. "qa.*" files were added in this phase.

## 3.1 Authentication (FR-AUTH)

| ID | Requirement | Module / API | Evidence | Status |
|---|---|---|---|---|
| FR-AUTH-001/002 | OTP login for customers and workers | Auth `POST /auth/otp/request`, `/auth/otp/verify` | auth.api (50 tests: expiry, attempts, lockout, single use, parallel guesses); qa.journeys; real server + Docker journeys | PASS for the code path. **BLOCKED for delivery**: only `disabled` and test `memory` SMS adapters exist (Q-36). |
| FR-AUTH-003 | Token-based sessions | Auth `POST /auth/token/refresh`, `/auth/logout`, `/auth/sessions` | auth.api (rotation, replay revokes the session, parallel refresh); qa.adversarial (forged/expired/none-alg tokens); real server (replay refused, new token revoked) | PASS |
| FR-AUTH-004 | Rate limiting and abuse protection on OTP and API | Auth OTP limits (Redis), global throttler | auth.api, throttling.e2e-spec, qa.adversarial (limit per mobile across addresses) | PARTIAL: OTP limits are Redis-backed and cluster-safe; the **global API throttle is in-memory per process** (see API_SECURITY_AUDIT S-04). |
| FR-AUTH-005 | Role-based admin login (4 roles) | Auth `POST /auth/admin/login`, Users roles | admin.api, users.api, security.api, qa.access | PARTIAL: four roles exist but only SUPER_ADMIN holds permissions until configured (Q-33, Q-62). Password only, no MFA (Q-18/Q-29). |
| FR-AUTH-006 (SRS text: store admin passwords and secrets securely) | scrypt password hashing; secrets from environment | Users/Auth | password-hasher unit tests; qa.adversarial (no hash in any response); Docker image scan (no secrets baked) | PASS (secrets management itself is deployment: READY WITH CONFIG) |

## 3.2 Customer registration and profile (FR-CUS)

| ID | Requirement | Evidence | Status |
|---|---|---|---|
| FR-CUS-001 | Register/login with OTP | auth.api, customers.api | PASS (delivery BLOCKED, see above) |
| FR-CUS-002 | Name, email, address, preferred language | customers.api (30 tests), qa.journeys | PASS |
| FR-CUS-003 | Several saved addresses (default, soft removal) | customers.api incl. parallel default race | PASS |
| FR-CUS-004 | Basic customer verification (mobile, address, basic profile) | admin can set `verificationStatus`; no automatic checks | OPEN DECISION (Q-26: the promotion rule is not specified) |
| FR-CUS-005 | Valid profile | customers.api validation | PASS |

## 3.3 Service discovery (FR-SD)

| ID | Requirement | Evidence | Status |
|---|---|---|---|
| FR-SD-001/002 | Select a service category (enabled masters only) | search.api, categories.api | PASS |
| FR-SD-003 | Full-time, part-time, daily, hourly or live-in | Only FULL_TIME / PART_TIME / LIVE_IN exist | PARTIAL / OPEN DECISION (Q-38, C-13: vocabulary conflict) |
| FR-SD-004 | Location, preferred timings, start date | Location = enabled service area; timings matched against availability windows; **start date is not matched** | PARTIAL (Q-47) |
| FR-SD-005 (budget) | Salary/budget range | Not a filter: salary has no period | OPEN DECISION (Q-39) |
| FR-SD-006 | Filter by category, location, availability | search.api (15), qa.journeys; EXPLAIN on 30k workers (PERFORMANCE_REVIEW) | PASS |

## 3.4 Worker discovery and matching (FR-WD)

| ID | Requirement | Evidence | Status |
|---|---|---|---|
| FR-WD-001/002 | Worker cards: photo, experience, skills, language, area, availability | search.api card allow-list | PARTIAL: **no photo** (FR-WON-002 not built) |
| FR-WD-003 | Rating and review summary on the card/profile | Ratings exist (worker, admin) but the summary is **not on the customer-facing card** | FAIL / OPEN DECISION (Q-52, Q-60: showing ratings to customers is undecided) |
| FR-WD-004 | Verification badges | Cards carry `verification: VERIFIED` only for fully verified workers | PASS |
| FR-WD-005 | Shortlist / favourite | **Not implemented** (Q-14 ownership undecided) | FAIL |
| FR-WD-006 | Paginated, fast search | search.api (pagination bounds, constant 6 statements), p50 22-60 ms on 30k workers | PASS (no numeric target exists, Q-06) |
| FR-WD-007 | Search and matching service; admin manual match | matching.api (11), qa.journeys | PASS |
| (SRS 3.4 last) | Never expose full identity documents or sensitive identity data on cards/profiles | qa.access KYC surface scan (28 surfaces), search.api exact card allow-list | PASS |
| AC-04 (FRD) | Customer can search/filter **and view profiles** | Search cards exist; there is **no customer endpoint that opens a worker profile** | PARTIAL |

## 3.5 Booking, interview, trial (FR-BK) and state model

| ID | Requirement | Evidence | Status |
|---|---|---|---|
| FR-BK-001/002 | Request interview/trial, choose date and time | booking.api (23), qa.journeys | PASS |
| FR-BK-003 | Customer confirms a worker | booking.api (re-checks eligibility at confirmation) | PASS |
| FR-BK-004/005 | Pay the booking/platform fee | payment.api, qa.journeys | PASS in code. **BLOCKED**: no gateway selected (fake adapter only). |
| FR-BK-006/007 | Status timeline to the customer | booking detail timeline (append-only table) | PASS |
| FR-BK-008/009 | State machine; admin actions (new request, match, interview, trial, confirm, cancel, replace) | booking.api; qa.access; every transition table below | **OPEN DECISION**: states follow the *proposed* FRD section 4 (C-02, Q-05, Q-55). Release blocker until the client confirms. |

## 3.6 Payments (FR-PAY)

| ID | Requirement | Evidence | Status |
|---|---|---|---|
| FR-PAY-001 | Indian gateway (UPI, cards, net banking) | Provider abstraction; `fake` and `disabled` adapters only | BLOCKED (vendor, Q-56) |
| FR-PAY-002 | Receipts | Receipt number + data in payment view; no PDF/printable document | PARTIAL |
| FR-PAY-003/004 | Transaction history, refund status | payment.api | PASS |
| FR-PAY-005/006 | Success/failure reflected on the booking | payment.api (webhook, verify, late success, cancelled booking); qa.journeys; real server + Docker | PASS |
| FR-PAY-007/008 | Amount, gateway reference, status, refund details recorded; admin exports | Recorded and listable/filterable; **no export file** | PARTIAL |
| FR-PAY-009 | Audit of payment changes | `payment.*` audit actions; qa.reports; security.api | PASS |
| FR-PAY-010 | Provider abstraction | `PaymentProvider` interface, 2 adapters | PASS |

## 3.7 - 3.10 Customer ongoing service, worker onboarding, profile, job workflow

| ID | Requirement | Evidence | Status |
|---|---|---|---|
| FR-ON-001/002 | Attendance visibility, service history | attendance.api, booking lists | PASS |
| FR-ON-003/004/005 | Support request, rate, request replacement | support.api, ratings.api, replacement.api, qa.journeys | PASS |
| FR-WON-001 | Worker OTP registration | auth.api | PASS (delivery BLOCKED) |
| FR-WON-002 | Profile photo | **Not implemented** | FAIL |
| FR-WON-003 | Upload Aadhaar/KYC documents | verification.api (signed-link flow); S3 adapter present, unverified against a live endpoint | PASS in code; **BLOCKED** until storage is configured and verified |
| FR-WON-004/005 | Address, emergency contact, previous employer | workers.api | PASS |
| FR-WON-006 | Short steps | Step-wise PATCH + `missingForSubmission` | PASS (API side) |
| FR-WON-007 | Assisted onboarding | Admin edits an existing worker; cannot create the account | PARTIAL / OPEN DECISION (Q-44) |
| FR-WP-001..006 | Roles, experience, languages, locations, salary, timings, preference | workers.api, availability.api | PASS; salary period (Q-39), weekdays (Q-37) OPEN |
| FR-WJ-001 | Job opportunities sent | JOB_OPPORTUNITY outbox event + worker booking list; real-worker-process delivery verified | PASS in code; push/SMS delivery BLOCKED |
| FR-WJ-002/004/005/007 | Requirement summary, schedule, confirmation + start date, job details | booking.api (worker view has no customer data) | PASS |
| FR-WJ-003 | Accept or decline | `decline` is explicit; acceptance is implicit in scheduling (no separate accept state) | PARTIAL / OPEN DECISION (Q-55) |
| FR-WJ-006 | Maintain attendance | attendance.api | PASS |
| FR-WJ-008 | Earnings / payment reference | **No worker-facing payment or earnings endpoint** | FAIL |
| FR-WJ-009 | Ratings received | ratings.api (worker summary + list) | PASS |
| FR-WJ-010 | Support / complaint | support.api (worker tickets) | PASS |
| FR-WJ-011 | Large buttons, local language | Frontend | NOT APPLICABLE |

## 3.11 - 3.13 Attendance, verification, replacement

| ID | Requirement | Evidence | Status |
|---|---|---|---|
| FR-ATT-001..003 | Status per date incl. exceptions; visible to both; no GPS/face | attendance.api (12) | PASS (status list configurability: Q-53) |
| FR-VER-001/002 | Mobile OTP verification | Auth | PASS |
| FR-VER-003..008 | Government ID (manual or partner), address, emergency contact, previous employment, police status | verification.api (34), qa.access | PASS manual; **no verification partner** (Q-51) |
| FR-VER-009 (customer verification) | Basic customer verification | see FR-CUS-004 | OPEN DECISION (Q-26) |
| FR-VER-010 | Review, approve/reject with remarks, expiry/re-check | verification.api (derived RECHECK_DUE) | PASS |
| FR-VER-011 | Not "verified" until configured checks approved | verification.api, search.api, qa.reports (independent SQL) | PASS; **the required set is empty until an admin sets it** (Q-04, Q-45): nobody is verified or searchable until then |
| FR-VER-012 | Audit trail, manual fallback, status shown to worker | verification.api, security.api | PASS |
| FR-REP-001..008 | Request, reason/notes, eligibility review, engagement status, alternatives, selection, confirmation with history | replacement.api (18), qa.journeys | PASS; the eligibility **rule** is OPEN (Q-09, Q-54) |

## 3.14 - 3.19 Support, notifications, ratings, admin, security, revenue

| ID | Requirement | Evidence | Status |
|---|---|---|---|
| FR-SUP-001..003 | Tickets by customers/workers; assignment, escalation, resolution with SLA tracking | support.api (15) | PARTIAL: tickets, assignment, escalation, closure exist; **no SLA targets or breach tracking** (Q-59) |
| FR-SUP-004/005 | Category, priority, owner, resolution; complaint history | support.api | PASS |
| FR-SUP-006 | Report/block, disputes and escalation by Support Executives | Escalation exists; **report/block not built** | PARTIAL / FAIL for report-block |
| FR-NOT-001 | Push through FCM | Interface + `disabled`/`memory` only; **no FCM adapter** | BLOCKED |
| FR-NOT-002/003 | SMS (optional) / WhatsApp | Interfaces + test adapters only | BLOCKED |
| FR-NOT-004 | Admin-configurable templates | notifications.api | PASS (no template is seeded: wording is unspecified) |
| FR-NOT-005 | Channel, template, status recorded | notifications table + admin log | PASS |
| FR-NOT-006 | Graceful retry | notifications.api; worker process in Docker | PASS |
| FR-RAT-001..004 | Rate; tied to completed engagements; summary on worker profiles; ratings shown to workers | ratings.api (13) | PASS for 001/002/004; 003 PARTIAL (Q-52/Q-60: customer-facing display undecided) |
| FR-REV-001..003 | Fee values configurable; support several revenue streams; no hard-coded prices | Only `BOOKING_FEE` (fee_configs); placement fee, subscription, verification fee, replacement plan, partnerships are **not modelled** | PARTIAL / OPEN DECISION (Q-01, Q-14) |
| FR-ADM-001..005 | Nine admin modules; customer and worker management; match/assign; configuration without code | admin.api, qa.journeys (21 admin endpoints answer), qa.access | PARTIAL: configuration covers categories, areas, fees (booking), notification templates, roles; **plans/subscriptions absent**; "blacklist" = suspension (semantics undefined) |
| FR-SEC-001/002 | RBAC; restricted sensitive screens | security.api, qa.access (every route, every actor), qa.inventory | PASS |
| FR-SEC-003/004 | KYC limited by role; no public ID documents | verification.api, qa.access, S3 private-bucket design | PASS (private bucket must be configured) |
| FR-SEC-005 | Emergency contact visible per policy | Owner and `worker.view` only | OPEN DECISION (Q-10) |
| FR-SEC-006 | Masking | masked mobile in admin lists; customer detail shows full (Q-35) | PARTIAL / OPEN DECISION (Q-35) |
| FR-SEC-007 | Suspension | users.api, security.api (suspended token 401) | PASS |
| FR-SEC-008 | Audit logs for critical admin actions | 16 modules write audit rows (API_SECURITY_AUDIT) | PASS |
| FR-RPT-001..012 | Twelve reports | reports.api, qa.reports (independent SQL on every report) | PASS technically; definitions are PROPOSED (Q-61) |

## 5 Non-functional, 4 interfaces, FRD acceptance

| ID | Requirement | Evidence | Status |
|---|---|---|---|
| NFR-SEC-001 | HTTPS everywhere | Application sends HSTS; TLS terminates at the load balancer | READY WITH CONFIG (deployment) |
| NFR-SEC-002 | Encryption at rest | Managed PostgreSQL / private bucket | NOT APPLICABLE to code - confirm in deployment |
| NFR-SEC-003/004/005 | RBAC, KYC restricted, masking | see FR-SEC | PASS |
| NFR-SEC-006 | Secrets stored securely | Environment only; none in image or repository (Docker history scan) | PASS in code; a secret manager is deployment |
| NFR-SEC-007 | Audit for verification, payment, user-status changes | security.api | PASS |
| NFR-SEC-008 | Rate limiting | see FR-AUTH-004 | PARTIAL |
| NFR-SEC-009 | Retention / deletion policy | None defined; nothing is ever deleted | OPEN DECISION (Q-02, Q-63) |
| NFR-SEC-010 | Legal review of terms/consent | Organisational | NOT APPLICABLE |
| NFR performance | Quick search, pagination, responsive | PERFORMANCE_REVIEW (p95 < 140 ms on hot paths at 30k workers / 164k bookings; deep offset pages slower) | PASS vs the only stated target ("quickly"); numeric targets OPEN (Q-06) |
| NFR-OPS-001..004 | Cloud, CI/CD, monitoring/alerting, backups | Docker + CI exist; cloud, monitoring and backups are not in the repository | READY WITH CONFIG / OPEN DECISION (Q-22) |
| NFR-OPS-005 | New categories via admin masters | categories.api | PASS |
| NFR-USA-001..003 | Low literacy, local-language readiness, short forms | Backend supports language codes and step-wise forms | NOT APPLICABLE (frontend) / PASS for the API part |
| EIR-SW-001 | Integrations fail gracefully and retry | notifications retry; payment 503 + resume; storage 503 | PASS |
| EIR-SW-002 | Provider abstraction | five interfaces | PASS |
| EIR-SW-003 | Sandbox early | External | BLOCKED (no vendor selected) |
| EIR-UI-001..004 | Apps / portal UX | Frontend | NOT APPLICABLE |
| AC-01 | New customer registers via OTP and has a valid profile | qa.journeys | PASS |
| AC-02 | Worker registers, uploads documents, defines preferences | qa.journeys, verification.api | PASS in code; documents depend on storage config |
| AC-03 | Admin approves/rejects verification items with remarks | verification.api | PASS |
| AC-04 | Customer can search/filter and **view profiles** | see FR-WD | PARTIAL |
| AC-05 | Request interview/trial, complete a booking | qa.journeys | PASS |
| AC-06 | Payment success/failure reflected on the booking | payment.api | PASS |
| AC-07 | Admin tracks and changes permitted booking states | booking.api admin actions | PASS (state model OPEN) |
| AC-08 | Customer raises replacement/support requests | qa.journeys | PASS |
| AC-09 | Ratings tied to completed engagements | ratings.api | PASS |
| AC-10 | Role restrictions on sensitive admin screens | security.api, qa.access | PASS |
| AC-11 | UAT on Android/iOS devices and browsers | Not executable here | NOT VERIFIED |

## Previously open questions Q-33 onward - effect on the release

| Question | Effect | Class |
|---|---|---|
| Q-33 / Q-62 permission matrix; Q-29 MFA | The three other admin roles are unusable until a Super Admin grants permissions through `PUT /admin/roles/{code}/permissions`; there is no approved matrix | OPEN DECISION + CONFIGURATION GAP |
| Q-34, Q-35 | OTP reveals "suspended"; customer detail unmasked and unaudited | OPEN DECISION |
| Q-36, Q-56, Q-57 | SMS / gateway / push / WhatsApp vendors | EXTERNAL PROVIDER GAP |
| Q-37..Q-44 | Availability, engagement, salary period, personal details, post-submit rules, worker visibility, areas, assisted onboarding | OPEN DECISION (documented defaults) |
| Q-45..Q-52 | Verification checklist, ranking, location semantics, visibility of in-progress workers, permissions, document handling, partner, card content | OPEN DECISION |
| Q-53..Q-55 | Attendance statuses, replacement eligibility, **booking state model** | OPEN DECISION (Q-55 is a release blocker) |
| Q-58..Q-64 | Rating scale, support SLA, rating visibility, report definitions, admin matrix, audit retention, abuse caps | OPEN DECISION |
