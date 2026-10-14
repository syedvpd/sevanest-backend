# PRD implementation matrix

Updated 2026-10-13. Status: PASS (implemented and proven by a runtime test on a disposable local database), PARTIAL, MISSING, BLOCKED_BY_DECISION, NOT_VERIFIED, NOT_BACKEND_SCOPE. "Disposition" follows `closure-register.md`. PASS never means tested against a real provider.

| ID | Requirement | Status | Disposition | Priority | Evidence | Verification | Remaining gap |
|---|---|---|---|---|---|---|---|
| SC-01 | Customer Android/iOS application | NOT_BACKEND_SCOPE | BLOCKED_BY_EXTERNAL_DEPENDENCY | P1 (product) | No mobile repository in the workspace | NONE | App not available to audit; API contract only |
| SC-02 | Worker Android/iOS application | NOT_BACKEND_SCOPE | BLOCKED_BY_EXTERNAL_DEPENDENCY | P1 (product) | No mobile repository in the workspace | NONE | As above |
| SC-03 | Web Admin Panel | NOT_BACKEND_SCOPE | BLOCKED_BY_EXTERNAL_DEPENDENCY | P1 (product) | No web repository in the workspace; 118 admin endpoints exist (docs/qa/data-api-traceability.md) | NONE | UI not available to audit |
| SC-04 | Backend/API (NestJS modular monolith) | PASS | (PASS, unchanged) | - | src/modules (24 modules), 212 controller routes, 51 Prisma models, 15 migrations | INT | - |
| SC-05 | Cloud deployment | PARTIAL | BLOCKED_BY_EXTERNAL_DEPENDENCY | P0 | render.yaml; API + worker run on Render free plan (user-reported working 2026-10-12) | NONE | Free plan sleeps; no staging/production split; no CI run evidence |
| SC-06 | Production monitoring and error alerts | MISSING | BLOCKED_BY_DECISION | P1 | Health endpoints and admin alerts exist; no error-tracking SDK, no uptime/alert configuration | NONE | See PO-03 |
| SC-07 | Automated database backups | NOT_VERIFIED | BLOCKED_BY_EXTERNAL_DEPENDENCY | P0 | Supabase-managed; no configuration or restore evidence in repo; runbook written | NONE | Enable and drill a restore |
| CAT-01 | Six V1 categories exist (House Maid, Driver, Cook, Babysitter, Elderly Care Helper, Cleaning Helper) | PASS | (PASS, unchanged) | - | category-seed.service.ts seeds the six idempotently; live readiness shows 6 enabled | INT | - |
| CAT-02 | Admin can create, edit, enable and disable categories | PASS | (PASS, unchanged) | - | service-categories controller (/admin/service-categories), audited | INT | - |
| CAT-03 | Each category stores its allowed engagement types | PARTIAL | PARTIALLY_FIXED | P2 | FIXED 2026-10-12: table category_engagements (migration 20261020110000), PUT /admin/service-categories/{id}/engagements, allowedEngagements in category responses; scheduling.int-spec | INT | No default lists are applied (PRD says 'typical' engagement; client must confirm each list, and 'Monthly' is undefined, Q-38): a category stays unrestricted until an administrator sets it |
| CAT-04 | Engagement vocabulary covers full-time, part-time, live-in, hourly, daily, shift, one-time | PASS | (PASS, unchanged) | - | ENGAGEMENTS in search.types.ts; Prisma enum EngagementPreference | INT | - |
| CAT-05 | Engagement type "Monthly" (Driver, Cook) | BLOCKED_BY_DECISION | BLOCKED_BY_DECISION | P2 | No MONTHLY value; unclear whether FULL_TIME means monthly (Q-38) | STATIC | Client must define monthly vs full-time |
| CAT-06 | A worker can choose only engagement types allowed for the category | PARTIAL | PARTIALLY_FIXED | P2 | A worker is only matched when their single preference equals the requested engagement, and requests are limited per category (CAT-07) | INT | The worker's own preference is not validated against category lists (single preference across several categories needs a client rule) |
| CAT-07 | A customer can request only allowed category/engagement combinations | PASS | FIXED_VERIFIED | - | Booking create, search and matching refuse an engagement the category does not offer (422 ENGAGEMENT_NOT_OFFERED) once configured | INT | Applies to configured categories only |
| CAT-08 | Disabled category rejects new bookings; existing bookings stay consistent | PASS | (PASS, unchanged) | - | requireEnabledByCode -> 422 CATEGORY_NOT_AVAILABLE; bookings keep FK | INT | - |
| CAT-09 | Categories and areas are available to the apps as reference data | PASS | (PASS, unchanged) | - | GET /app-config, GET /reference-data (meta module) | INT | Languages list is configuration only |
| CAT-10 | New services can be added later through admin masters without app change | PASS | (PASS, unchanged) | - | Category CRUD; apps read reference-data | INT | Engagement mapping (CAT-03) not configurable |
| AUTH-01 | Request OTP for an Indian mobile (customer and worker apps) | PASS | (PASS, unchanged) | - | auth.controller otp/request, OtpService; format validation | INT | - |
| AUTH-02 | OTP is delivered by a real SMS provider | PARTIAL | BLOCKED_BY_EXTERNAL_DEPENDENCY | P0 | Twilio + MSG91 adapters (mocked HTTP tests); staging test OTP for allow-listed numbers | UNIT | Provider keys, sender and DLT template not configured; NOT delivered against a real provider |
| AUTH-03 | OTP is hashed, expires, is single use, attempts and resends are limited | PASS | (PASS, unchanged) | - | otp.service.ts; integration tests auth.api, security | INT | - |
| AUTH-04 | Provider failure never leaves a usable code or reports success | PASS | (PASS, unchanged) | - | OtpService error path (503 SMS_NOT_CONFIGURED/PROVIDER); tested | INT | - |
| AUTH-05 | Verification creates the account on first login; concurrent first logins create one user | PASS | (PASS, unchanged) | - | findOrCreateByMobile with unique-violation re-read | INT | - |
| AUTH-06 | Access/refresh tokens, single-use rotation with replay detection, logout, sessions list | PASS | (PASS, unchanged) | - | session.service.ts | INT | - |
| AUTH-07 | Suspended user cannot use an existing token (403 ACCOUNT_SUSPENDED) and sessions are revoked | PASS | (PASS, unchanged) | - | jwt-auth.guard.ts, SessionService status event | INT | - |
| AUTH-08 | Rate limiting on OTP/API with shared Redis store and trusted proxy | PARTIAL | NOT_VERIFIED | P1 | Throttler + Redis storage + TRUST_PROXY_HOPS mandatory in production; tests with Redis | INT | Production still on memory throttle if THROTTLE_STORAGE=memory; multi-replica not tested; Redis outage behaviour tested only partially |
| AUTH-09 | Admin email/password login with lockout | PASS | (PASS, unchanged) | - | auth.controller admin/login, AdminLoginThrottle | INT | - |
| AUTH-10 | First Super Admin can be created safely in production | PASS | (PASS, unchanged) | - | npm run bootstrap:admin (hidden prompt/secret file, strength check, one-time); used on live DB | INT | The live admin password was reset by direct SQL and is weak: it must be changed |
| AUTH-11 | Admin password change and reset | PARTIAL | BLOCKED_BY_DECISION | P2 | POST /admin/account/password; Super Admin POST /admin/users/{id}/password-reset (temporary password) | INT | No self-service forgot-password, no MFA (Q-87) |
| CP-01 | Customer name, email, preferred language stored and returned | PASS | (PASS, unchanged) | - | customers module; DTO validation; language allow-list | INT | - |
| CP-02 | Profile fields reject invalid input and protected fields (status, ids) cannot be set | PASS | (PASS, unchanged) | - | whitelist validation pipe; mass-assignment tests | INT | - |
| CP-03 | Saved addresses: create, list, get, update, set default, remove | PASS | (PASS, unchanged) | - | customer-addresses.service.ts; one-default invariant in DB | INT | - |
| CP-04 | Addresses are private to their customer (cross-customer access is 404) | PASS | (PASS, unchanged) | - | Scoped by profile id | INT | - |
| CP-05 | Address validated against enabled service area/pincode | PARTIAL | BLOCKED_BY_DECISION | P2 | Booking checks address city equals area city (422 OUTSIDE_SERVICE_AREA); address creation itself accepts any city/pincode format-valid | INT | No pincode-to-area master; coverage rule undefined |
| CP-06 | Basic customer verification (mobile, address, profile checks) | PARTIAL | BLOCKED_BY_DECISION | P2 | Interim auto-verification (profile + active address) with staff override; mobile is OTP-verified | INT | Rule is an interim default (D-59/Q-85); no address document check |
| CP-07 | Admin approves/rejects customer verification with remarks and cannot be bypassed by the customer | PASS | (PASS, unchanged) | - | PATCH admin/customers/{id}/verification-status (audited, If-Match) | INT | Remarks are optional (note), not required |
| CP-08 | Concurrent profile/address edits are safe | PASS | FIXED_VERIFIED | - | FIXED 2026-10-13: ETag + If-Match on GET/PATCH /customers/me and on addresses, profile locked during the edit; parallel edits: one 200, one 412 (remaining.int-spec) | INT | - |
| SD-01 | Select service category | PASS | (PASS, unchanged) | - | search filter category; reference-data | INT | - |
| SD-02 | Choose engagement type (full, part, daily, hourly, live-in) | PARTIAL | PARTIALLY_FIXED | P1 | Enum supports all; no per-category restriction | INT | See CAT-03 |
| SD-03 | Enter location (saved address / area) | PASS | (PASS, unchanged) | - | areaId + addressId on search/booking | INT | No geo/distance |
| SD-04 | Preferred timings | PASS | (PASS, unchanged) | - | availableFrom/To validation, worker window intersection | INT | Day-of-week not modelled (not specified) |
| SD-05 | Start date in the request | PASS | (PASS, unchanged) | - | requestedStartDate with past-date rejection (India date) | INT | - |
| SD-06 | Salary/budget range in the request | PASS | (PASS, unchanged) | - | budgetMin/Max/Period with reversed/negative checks | INT | Search/matching do not compare budget to worker salary (Q-39) |
| SD-07 | Search results are revalidated at booking time | PASS | (PASS, unchanged) | - | assertEligible in booking create/assign/confirm | INT | - |
| WD-01 | Worker cards list (paginated, filters, sort allow-list) | PASS | (PASS, unchanged) | - | search.controller, sort EXPERIENCE_DESC/ASC, RATING_DESC | INT | - |
| WD-02 | Profile photo on the card | PARTIAL | BLOCKED_BY_EXTERNAL_DEPENDENCY | P1 | worker-photo module + signed link on card | INT | Off until PROFILE_PHOTO_MAX_BYTES set (live: not set) |
| WD-03 | Experience, skills, languages, areas, availability on the card | PASS | (PASS, unchanged) | - | search card allow-list | INT | - |
| WD-04 | Verification badge | PARTIAL | BLOCKED_BY_DECISION | P2 | Card shows only fully-verified workers; no per-check badges | INT | Badge detail undefined |
| WD-05 | Rating average/count and review summary | PASS | (PASS, unchanged) | - | WorkerRatingSummary joined; RATING_DESC sort; min rating filter | INT | Review text list on profile limited to non-hidden |
| WD-06 | Private data never exposed (mobile, address, emergency contact, KYC keys, user id) | PASS | (PASS, unchanged) | - | Allow-listed DTO; adversarial tests | INT | - |
| WD-07 | Shortlist/favourite: add, list, remove, idempotent, capped, shows unavailable | PASS | (PASS, unchanged) | - | shortlist module | INT | Cap is an engineering value |
| WD-08 | Shortlist entry cannot bypass booking eligibility | PASS | (PASS, unchanged) | - | Booking re-checks eligibility | INT | - |
| BK-01 | Create booking request (category, engagement, area, timing) | PASS | (PASS, unchanged) | - | booking.service create | INT | - |
| BK-02 | Request interview or trial with preferred date/time | PASS | (PASS, unchanged) | - | schedule action with INTERVIEW/TRIAL type | INT | Both types share one state; distinct trial workflow undefined (Q-05) |
| BK-03 | Reschedule the interview/trial | PASS | (PASS, unchanged) | - | schedule allowed again in INTERVIEW_TRIAL_SCHEDULED | INT | - |
| BK-04 | Worker explicit accept/decline with reason, deadline | PASS | (PASS, unchanged) | - | accept/decline actions, respondBy config | INT | Deadline off until WORKER_RESPONSE_HOURS set |
| BK-05 | Confirm worker (state PENDING_PAYMENT) with eligibility re-check | PASS | (PASS, unchanged) | - | confirm-worker | INT | - |
| BK-06 | Pay booking/platform fee; amount server-authoritative | PASS | (PASS, unchanged) | - | payment.service; FeeConfig | INT | Live fee not configured (readiness shows configured on live DB) |
| BK-07 | Booking status timeline | PASS | (PASS, unchanged) | - | BookingEvent timeline in detail view | INT | - |
| BK-08 | Invalid/concurrent transitions are refused consistently | PASS | (PASS, unchanged) | - | 297-combination matrix + concurrency tests | INT | - |
| BK-09 | Service cannot start before the agreed start date | PASS | (PASS, unchanged) | - | assertNotTooEarly, BOOKING_START_EARLY_DAYS | INT | Tolerance undecided (Q-84) |
| BK-10 | Admin creates a booking on behalf of a customer | PASS | (PASS, unchanged) | - | POST /admin/bookings (audited) | INT | - |
| BK-11 | Unpaid PENDING_PAYMENT booking expiry | BLOCKED_BY_DECISION | BLOCKED_BY_DECISION | P2 | Config-gated auto-cancel exists; period undecided (Q-78) | INT | Off until PENDING_PAYMENT_AUTO_CANCEL_HOURS set |
| ON-01 | Attendance/status visible to customer | PASS | (PASS, unchanged) | - | attendance module customer list | INT | - |
| ON-02 | Month summary of attendance | PASS | (PASS, unchanged) | - | GET .../summary?month= | INT | - |
| ON-03 | Customer raises attendance exception; admin corrects with history | PASS | (PASS, unchanged) | - | attendance.service | INT | - |
| ON-04 | Service history (completed, cancelled, active) and replacement chain | PASS | FIXED_VERIFIED | - | GET /bookings with filters + FIXED 2026-10-13: GET /bookings/{id}/replacement-chain and the admin equivalent (recursive query); remaining.int-spec | INT | - |
| ON-05 | Support ticket create, thread, staff reply, internal note, escalation, close | PASS | (PASS, unchanged) | - | support module | INT | No attachments; no reopen (Q-59) |
| ON-06 | Support resolution SLA with due dates and breach alert | BLOCKED_BY_DECISION | BLOCKED_BY_DECISION | P2 | dueAt/slaBreach implemented; hours undecided | INT | Off until SUPPORT_SLA_HOURS_* set |
| ON-07 | Rate worker once per completed booking; aggregates; hide/restore | PASS | (PASS, unchanged) | - | ratings module | INT | - |
| ON-08 | Replacement request, approval, candidates, selection, audit | PASS | (PASS, unchanged) | - | replacement module; policy: ACTIVE bookings only | INT | Eligibility rule is minimal (Q-?) |
| PAY-01 | UPI/cards/net banking via the gateway | PARTIAL | BLOCKED_BY_EXTERNAL_DEPENDENCY | P0 | Razorpay adapter (test keys on live); checkout returns order | UNIT | Never exercised end to end against Razorpay; live KYC not done |
| PAY-02 | Payment receipts | PARTIAL | BLOCKED_BY_DECISION | P2 | receiptNumber and GET receipt data | INT | No PDF/GST invoice |
| PAY-03 | Transaction history | PASS | (PASS, unchanged) | - | GET /payments | INT | - |
| PAY-04 | Refund status | PARTIAL | BLOCKED_BY_DECISION | P1 | Refund status fields; admin full refund; polling | INT | Partial/automatic refunds blocked (Q-77, Q-83) |
| PAY-05 | Webhook signature, replay, out-of-order, unknown order replay | PASS | (PASS, unchanged) | - | payments.recovery tests; live unsigned webhook -> 401 | INT | Real Razorpay webhook never received |
| PAY-06 | Lost callback recovered by gateway lookup | PASS | (PASS, unchanged) | - | payment-recovery.service (claim queue, backoff) | INT | Against fake gateway only |
| PAY-07 | Cancellation vs payment consistency, exceptions queue | PASS | (PASS, unchanged) | - | payment_exceptions, hook in cancel tx | INT | Money action manual |
| PAY-08 | Payments CSV export for finance | PASS | (PASS, unchanged) | - | GET /admin/payments-export | INT | Tax invoice format undefined |
| WK-01 | OTP registration, role separation from customer | PASS | (PASS, unchanged) | - | findOrCreateByMobile type; MOBILE_IN_USE | INT | - |
| WK-02 | Profile photo upload, confirm, signature check, moderation | PARTIAL | BLOCKED_BY_EXTERNAL_DEPENDENCY | P1 | worker-photo module | INT | Disabled in live (PROFILE_PHOTO_MAX_BYTES unset); no moderation UI state beyond approve |
| WK-03 | Aadhaar/KYC upload with whole-file validation, hash, integrity re-check | PASS | (PASS, unchanged) | - | verification.service confirm | INT | Real S3 bucket not exercised |
| WK-04 | Malware scanning of documents | PARTIAL | BLOCKED_BY_DECISION | P2 | Optional ClamAV adapter + fail-safe | UNIT | Not enabled; no clamd deployed; requirement undecided (Q-89) |
| WK-05 | Address and emergency contact captured | PASS | (PASS, unchanged) | - | workers module; admin reads audited | INT | Reveal policy undecided (Q-86) |
| WK-06 | Previous employer/reference captured (one or several) | PASS | FIXED_VERIFIED | - | FIXED 2026-10-13: worker_references (migration 20261021090000), GET/PUT /workers/me/references (max 5, each mobile once), staff read audited; remaining.int-spec | INT | Contacting references to verify them is not specified |
| WK-07 | Admin-assisted onboarding (create worker for a mobile) | PASS | (PASS, unchanged) | - | POST /admin/workers | INT | Maker-checker rule undefined |
| WP-01 | Select role(s) (categories) | PASS | (PASS, unchanged) | - | PUT workers/me/categories | INT | - |
| WP-02 | Experience, languages | PASS | (PASS, unchanged) | - | workers DTO | INT | - |
| WP-03 | Preferred locations and available timings | PASS | (PASS, unchanged) | - | availability module | INT | - |
| WP-04 | Expected salary (and period) | PARTIAL | BLOCKED_BY_DECISION | P2 | expectedSalary stored | INT | Period undefined (Q-39) |
| WP-05 | Full-time/part-time/live-in preference | PASS | (PASS, unchanged) | - | engagementPreference | INT | Single preference only |
| WP-06 | Profile submission gate (missingForSubmission) and searchability only after approval | PASS | (PASS, unchanged) | - | submit + verified condition in search SQL | INT | - |
| WP-07 | Local-language readiness (data) | PARTIAL | BLOCKED_BY_DECISION | P2 | Languages reference + per-recipient template language | INT | No translated names for categories/areas |
| JW-01 | Receive job opportunities | PASS | FIXED_VERIFIED | - | FIXED 2026-10-12: GET /workers/me/opportunities (matched jobs awaiting an answer, privacy-safe) + notification; scheduling.int-spec | INT | Model is one matched worker per booking (no parallel offers) - parallel offers would need a client decision |
| JW-02 | Customer requirement summary without PII | PASS | (PASS, unchanged) | - | WorkerBookingView allow-list | INT | - |
| JW-03 | Accept/decline | PASS | (PASS, unchanged) | - | see BK-04 | INT | - |
| JW-04 | Interview/trial schedule visible, slot proposal by worker | PASS | FIXED_VERIFIED | - | FIXED 2026-10-13: PUT /workers/me/bookings/{id}/slot-proposal, customer/staff accept or reject (bookings.proposed_slot_at); remaining.int-spec | INT | Single open proposal at a time (a client rule on multiple proposals is not needed) |
| JW-05 | Job confirmation and start date visible | PASS | (PASS, unchanged) | - | startDate in worker view; start action | INT | Worker cannot explicitly confirm start date |
| ONW-01 | Record own attendance (today only) | PASS | (PASS, unchanged) | - | workers/me/attendance | INT | - |
| ONW-02 | Current job details | PASS | (PASS, unchanged) | - | workers/me/bookings | INT | - |
| ONW-03 | Earnings/payment reference | BLOCKED_BY_DECISION | BLOCKED_BY_DECISION | P2 | Worker sees stated budget and start date only | STATIC | Wage/earnings model undefined (platform has no payroll in V1) |
| ONW-04 | Own ratings | PASS | (PASS, unchanged) | - | workers/me/ratings | INT | - |
| ONW-05 | Support/complaint and report/block | PASS | (PASS, unchanged) | - | support + safety modules | INT | Block effect on active booking undefined (Q-74) |
| ONW-06 | Clear suspended-account state | PASS | (PASS, unchanged) | - | 403 ACCOUNT_SUSPENDED | INT | - |
| AD-01 | Dashboard counts (bookings, workers, KYC, complaints, replacements, collections, alerts) | PASS | (PASS, unchanged) | - | reports/dashboard.service | INT | - |
| AD-02 | Customer list/filters, detail, status, notes, history | PASS | FIXED_VERIFIED | - | Filters (name, status, city, date), detail, verification, notes; bookings via GET /admin/bookings?customerUserId=; tickets via GET /admin/support/tickets?creatorUserId= | INT | History is composed from filtered lists, not one combined endpoint |
| AD-03 | Worker list/detail, categories, status | PARTIAL | PARTIALLY_FIXED | P2 | Filters: status, category, mobile, name, account status, registration date, service area, minimum rating; suspend via users (remaining.int-spec) | INT | Blacklist as a separate permanent state is undefined (decision) |
| AD-04 | Queue, requirements, review, remarks, expiry/recheck | PASS | (PASS, unchanged) | - | verification module | INT | No reviewer assignment, no aging SLA |
| AD-05 | Match, schedule, confirm, cancel, replace; filters | PASS | (PASS, unchanged) | - | admin/bookings | INT | No manual reassign action for no-response (uses decline/reopen) |
| AD-06 | Transactions, refunds, exceptions, reconcile, export | PASS | (PASS, unchanged) | - | payment admin controller | INT | - |
| AD-07 | Assign, escalate, priority, close, reply | PASS | (PASS, unchanged) | - | support admin | INT | - |
| AD-08 | Twelve PRD reports exist (13 routes) and CSV export | PASS | (PASS, unchanged) | - | reports module | INT | Definitions PROPOSED (Q-61) |
| AD-09 | Categories, areas, fees, templates, roles | PASS | (PASS, unchanged) | - | admin controllers | INT | - |
| AD-10 | Plans (subscription/replacement plan) configuration | MISSING | BLOCKED_BY_DECISION | P2 | No plan entity | STATIC | Revenue models undecided |
| AD-11 | Role-based access on every admin route | PASS | (PASS, unchanged) | - | Permissions guard; route inventory + RBAC tests | INT | Role matrix is PROPOSED (Q-70) |
| AD-12 | Audit logs for critical actions, readable by Super Admin | PASS | (PASS, unchanged) | - | audit-log.controller | INT | No tamper-evidence (hash chain) |
| AD-13 | Admin alert inbox for stuck work | PASS | (PASS, unchanged) | - | alerts module | INT | - |
| AD-14 | Stale-write protection on admin edits | PARTIAL | PARTIALLY_FIXED | P2 | If-Match on worker edit, customer status, categories, service areas, notification templates (remaining.int-spec) | INT | Fees, support categories, ticket operations and role changes rely on locks / state machines, not If-Match |
| TS-01 | Never show "fully verified" before approval | PASS | (PASS, unchanged) | - | verifiedWorkerCondition SQL | INT | - |
| TS-02 | Verification kinds: mobile, identity, address, emergency, employment, police | PASS | (PASS, unchanged) | - | CHECK_TYPES | INT | Police is status/document tracking only |
| TS-03 | Expiry/re-verification | PASS | (PASS, unchanged) | - | recheckAt + reminder loop + search exclusion | INT | - |
| TS-04 | Report/Block | PASS | (PASS, unchanged) | - | safety module; block hides pair in search | INT | - |
| TS-05 | Suspension of customer/worker | PASS | (PASS, unchanged) | - | PATCH admin/users/{id}/status | INT | - |
| TS-06 | Complaint history per user | PASS | FIXED_VERIFIED | - | FIXED 2026-10-12: GET /admin/support/tickets?creatorUserId= (scheduling.int-spec) | INT | - |
| TS-07 | Emergency-contact visibility by policy | BLOCKED_BY_DECISION | BLOCKED_BY_DECISION | P2 | Audited admin read only (Q-86) | INT | Policy undecided |
| TS-08 | Sensitive-document access limited by role, short-lived audited links | PASS | (PASS, unchanged) | - | DocumentLinkResponse, permission check | INT | - |
| TS-09 | No public exposure of identity documents | PASS | (PASS, unchanged) | - | opaque keys, private bucket | INT | Real bucket privacy not verified |
| NF-01 | HTTPS for all traffic | NOT_VERIFIED | NOT_VERIFIED | P0 | Render terminates TLS; TRUST_PROXY_HOPS | NONE | Not checked beyond live health calls |
| NF-02 | Encryption at rest | NOT_VERIFIED | NOT_VERIFIED | P1 | Provider-managed | NONE | No evidence |
| NF-03 | Masked sensitive info in routine screens | PASS | (PASS, unchanged) | - | maskMobile in lists | INT | - |
| NF-04 | Secrets stored securely | PASS | (PASS, unchanged) | - | scrypt hashes; env-only secrets | INT | Secrets pasted in chat must be rotated |
| NF-05 | Audit for verification, payment, user-status changes | PASS | (PASS, unchanged) | - | AuditService calls | INT | - |
| NF-06 | Data retention/deletion policy | BLOCKED_BY_DECISION | BLOCKED_BY_DECISION | P2 | Deletion request recorded; no erasure (Q-88) | INT | Policy undefined |
| NF-07 | Terms, privacy, consent flows | PARTIAL | BLOCKED_BY_DECISION | P2 | legal module: versions, accept, enforce flag | INT | Texts/versions not configured; legal review pending |
| NF-08 | Graceful failure and retry of integrations | PASS | (PASS, unchanged) | - | ProviderError classification, outbox retry/dead-letter | INT | - |
| NT-01 | Push notifications (FCM) | PARTIAL | BLOCKED_BY_EXTERNAL_DEPENDENCY | P1 | fcm.provider (mocked) | UNIT | No Firebase credentials; app does not register tokens in audit scope |
| NT-02 | SMS notifications (transactional) | PARTIAL | BLOCKED_BY_EXTERNAL_DEPENDENCY | P1 | SMS provider shared with OTP | UNIT | Needs DLT templates (MSG91) |
| NT-03 | WhatsApp (optional) | PARTIAL | BLOCKED_BY_EXTERNAL_DEPENDENCY | P2 | Twilio WhatsApp adapter | UNIT | Not configured |
| NT-04 | In-app inbox | PASS | (PASS, unchanged) | - | /notifications + unread-count | INT | - |
| NT-05 | Event coverage for booking lifecycle | PASS | (PASS, unchanged) | - | every event in notification-events.ts has a starter in-app template except the staff-only payment alert | INT | Templates for push/SMS not seeded |
| JB-01 | Worker process runs 6 loops and heartbeats | PARTIAL | PARTIALLY_FIXED | P0 | ROOT CAUSE FOUND AND FIXED 2026-10-12: the heartbeat lived 180 s but two loops tick every 5 and 15 minutes, so readiness always reported them missing; heartbeat TTL now follows each loop's interval | UNIT | Must be re-checked on the deployed service after the next deploy |
| RP-01 | New customers; worker registrations; funnel; demand by category/area; utilization; interview conversion; cancellation; replacement; collections; support; top rated; repeat | PASS | (PASS, unchanged) | - | reports.service (13 endpoints) | INT | Definitions proposed |
| RP-02 | Report exports | PASS | (PASS, unchanged) | - | GET /admin/reports/export/{report} | INT | - |
| RV-01 | Configurable booking fee | PASS | (PASS, unchanged) | - | PUT /admin/fees/{code} | INT | - |
| RV-02 | Placement fee, subscription, verification fee, replacement plan, B2B | MISSING | BLOCKED_BY_DECISION | P2 | No models | STATIC | Revenue models undecided |
| RK-01 | Provider abstraction for payment/SMS/maps/OTP | PARTIAL | BLOCKED_BY_DECISION | P2 | Interfaces for payment, SMS, push, WhatsApp, storage; maps interface only | STATIC | No maps adapter |
| LM-01 | Hyderabad pilot areas seeded | PASS | (PASS, unchanged) | - | seed-launch (5 pilot areas; live has 9 areas) | INT | - |
| BK-12 | A worker already booked for a time cannot be booked for an overlapping time (same dates, overlapping hours); free again after the service ends; other hours/other workers stay bookable | PASS | FIXED_VERIFIED | - | FIXED 2026-10-12: common/scheduling/worker-busy.ts; checks in booking create, match, confirm-worker (per-worker advisory lock), replacement; hidden from search and matching; optional BOOKING_TRAVEL_BUFFER_MINUTES | INT | Unpaid PENDING_PAYMENT bookings hold the worker until paid/cancelled (expiry undecided, Q-78) |
| BK-13 | Worker can propose another interview/trial time; customer accepts or keeps the original | PASS | FIXED_VERIFIED | - | FIXED 2026-10-13 (see JW-04); notifications BOOKING_SLOT_PROPOSED / BOOKING_SLOT_ANSWERED | INT | - |
| BK-14 | Replacement history is traceable as one chain | PASS | FIXED_VERIFIED | - | FIXED 2026-10-13 (see ON-04) | INT | - |
| AC-01 | Customer registers by OTP and creates a valid profile | PARTIAL | BLOCKED_BY_EXTERNAL_DEPENDENCY | P0 | Backend flow tested | INT | Real SMS missing |
| AC-02 | Worker registers, uploads documents, defines preferences | PASS | (PASS, unchanged) | - | workforce tests | INT | - |
| AC-03 | Admin approves/rejects verification with remarks | PASS | (PASS, unchanged) | - | verification tests | INT | - |
| AC-04 | Customer searches/filter and views profiles | PASS | (PASS, unchanged) | - | search tests | INT | - |
| AC-05 | Interview/trial and completed booking | PASS | (PASS, unchanged) | - | qa.journeys | INT | - |
| AC-06 | Payment success/failure reflected on booking | PARTIAL | BLOCKED_BY_EXTERNAL_DEPENDENCY | P0 | Fake gateway journey tested | INT | Real gateway never exercised |
| AC-07 | Admin tracks and changes permitted booking states | PASS | (PASS, unchanged) | - | admin bookings | INT | - |
| AC-08 | Replacement/support requests | PASS | (PASS, unchanged) | - | modules tests | INT | - |
| AC-09 | Ratings tied to completed engagements | PASS | (PASS, unchanged) | - | ratings tests | INT | - |
| AC-10 | Role restrictions on sensitive screens | PASS | (PASS, unchanged) | - | qa.access tests | INT | - |
| AC-11 | UAT on Android/iOS devices and browsers | NOT_BACKEND_SCOPE | BLOCKED_BY_EXTERNAL_DEPENDENCY | P1 (product) | No apps | NONE | Not auditable here |

## Customer-app additions (2026-10-13)
| Requirement | Status | Evidence |
|---|---|---|
| PRD 5.3 worker reviews and rating scale | PASS_VERIFIED | `appfeedback`, `contract.openapi` |
| PRD 5.1 Home summary | PASS_VERIFIED | `appgaps2` Home cases |
| PRD 5.4 interview/trial list, free slots, allowed actions | PASS_VERIFIED | `interview`, `appgaps2` |
| PRD 5.2 price guidance | PARTIAL | endpoint built, data not supplied (decision) |
| PRD 5.1 area from position | PARTIAL | centre and radius only |
| PRD 5.1 customer photo | BLOCKED_BY_DECISION | not in FR-CUS |

## 2026-10-14 customer Active Service, History and Rating
| Requirement | Source | Status | Evidence |
|---|---|---|---|
| Customer sees attendance/status (FR-ATT-002, FR-ON-001) | SRS 3.11 | IMPLEMENTED, now with LATE/LEAVE, check-in/out times, scheduled window, worker identity (D-76, D-77, D-81) | customer.active-service.int-spec |
| Customer or admin can raise an exception (FM-09 alternate flow) | FRD FM-09 | IMPLEMENTED and tested incl. concurrency (D-83) | customer.active-service.int-spec |
| Service history (FRD FM-09 step 3, wireframe "Service History") | FRD, Wireframes | IMPLEMENTED: history list, totals, filters (D-78) | customer.history-rating.int-spec |
| Ratings tied to completed/eligible engagements (FM-10) | FRD | IMPLEMENTED: server rule, eligibility API, allowedActions; "otherwise eligible" open (Q-102) | customer.history-rating.int-spec, rating-eligibility.spec |
| Review length limit (FM-10) | FRD | IMPLEMENTED: configurable, default 300 (D-80) | customer.history-rating.int-spec |
| Rating tags | none | NOT SPECIFIED: not built (Q-103) | - |
| Hire the same worker again | design only | IMPLEMENTED through normal booking creation (D-82; Q-106) | customer.history-rating.int-spec |
