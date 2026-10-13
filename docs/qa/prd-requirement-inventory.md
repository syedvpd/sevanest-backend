# PRD requirement inventory

Audit of 2026-10-12, updated 2026-10-13. Source: `docs/project-specifications/SevaNest_PRD.pdf`. One row per independently verifiable feature behaviour (160 rows); field-level validation lives in the negative-path register and the integration suites. Status and evidence: `prd-implementation-matrix.md`.

| ID | Source | Surface | Module | Atomic requirement |
|---|---|---|---|---|
| SC-01 | PRD 2.1 | Shared | Surfaces | Customer Android/iOS application |
| SC-02 | PRD 2.1 | Shared | Surfaces | Worker Android/iOS application |
| SC-03 | PRD 2.1 | Shared | Surfaces | Web Admin Panel |
| SC-04 | PRD 2.1, 11 | Shared | Surfaces | Backend/API (NestJS modular monolith) |
| SC-05 | PRD 2.1, 11 | Operations | Surfaces | Cloud deployment |
| SC-06 | PRD 2.1, 13 | Operations | Surfaces | Production monitoring and error alerts |
| SC-07 | PRD 2.1, 13 | Operations | Surfaces | Automated database backups |
| CAT-01 | PRD 4 | Shared | Catalogue | Six V1 categories exist (House Maid, Driver, Cook, Babysitter, Elderly Care Helper, Cleaning Helper) |
| CAT-02 | PRD 4 | Admin | Catalogue | Admin can create, edit, enable and disable categories |
| CAT-03 | PRD 4, 5.2 | Shared | Catalogue | Each category stores its allowed engagement types |
| CAT-04 | PRD 4 | Shared | Catalogue | Engagement vocabulary covers full-time, part-time, live-in, hourly, daily, shift, one-time |
| CAT-05 | PRD 4 | Shared | Catalogue | Engagement type "Monthly" (Driver, Cook) |
| CAT-06 | PRD 4 | Worker | Catalogue | A worker can choose only engagement types allowed for the category |
| CAT-07 | PRD 4 | Customer | Catalogue | A customer can request only allowed category/engagement combinations |
| CAT-08 | PRD 4 | Customer | Catalogue | Disabled category rejects new bookings; existing bookings stay consistent |
| CAT-09 | PRD 4 | Shared | Catalogue | Categories and areas are available to the apps as reference data |
| CAT-10 | PRD 4 | Admin | Catalogue | New services can be added later through admin masters without app change |
| AUTH-01 | PRD 5.1, 6.1 | Shared | Auth | Request OTP for an Indian mobile (customer and worker apps) |
| AUTH-02 | PRD 5.1 | Shared | Auth | OTP is delivered by a real SMS provider |
| AUTH-03 | PRD 5.1 | Shared | Auth | OTP is hashed, expires, is single use, attempts and resends are limited |
| AUTH-04 | PRD 5.1, 13 | Shared | Auth | Provider failure never leaves a usable code or reports success |
| AUTH-05 | PRD 5.1 | Shared | Auth | Verification creates the account on first login; concurrent first logins create one user |
| AUTH-06 | PRD 5.1 | Shared | Auth | Access/refresh tokens, single-use rotation with replay detection, logout, sessions list |
| AUTH-07 | PRD 9.1, 13 | Shared | Auth | Suspended user cannot use an existing token (403 ACCOUNT_SUSPENDED) and sessions are revoked |
| AUTH-08 | PRD 13 | Shared | Auth | Rate limiting on OTP/API with shared Redis store and trusted proxy |
| AUTH-09 | PRD 3, 13 | Admin | Auth | Admin email/password login with lockout |
| AUTH-10 | PRD 13 | Admin | Auth | First Super Admin can be created safely in production |
| AUTH-11 | PRD 13 | Admin | Auth | Admin password change and reset |
| CP-01 | PRD 5.1 | Customer | Profile | Customer name, email, preferred language stored and returned |
| CP-02 | PRD 5.1 | Customer | Profile | Profile fields reject invalid input and protected fields (status, ids) cannot be set |
| CP-03 | PRD 5.1 | Customer | Profile | Saved addresses: create, list, get, update, set default, remove |
| CP-04 | PRD 5.1 | Customer | Profile | Addresses are private to their customer (cross-customer access is 404) |
| CP-05 | PRD 5.1 | Customer | Profile | Address validated against enabled service area/pincode |
| CP-06 | PRD 5.1 | Customer | Profile | Basic customer verification (mobile, address, profile checks) |
| CP-07 | PRD 5.1, 9 | Admin | Profile | Admin approves/rejects customer verification with remarks and cannot be bypassed by the customer |
| CP-08 | PRD 5.1 | Customer | Profile | Concurrent profile/address edits are safe |
| SD-01 | PRD 5.2 | Customer | Discovery | Select service category |
| SD-02 | PRD 5.2 | Customer | Discovery | Choose engagement type (full, part, daily, hourly, live-in) |
| SD-03 | PRD 5.2 | Customer | Discovery | Enter location (saved address / area) |
| SD-04 | PRD 5.2 | Customer | Discovery | Preferred timings |
| SD-05 | PRD 5.2 | Customer | Discovery | Start date in the request |
| SD-06 | PRD 5.2 | Customer | Discovery | Salary/budget range in the request |
| SD-07 | PRD 5.2 | Customer | Discovery | Search results are revalidated at booking time |
| WD-01 | PRD 5.3 | Customer | Worker cards | Worker cards list (paginated, filters, sort allow-list) |
| WD-02 | PRD 5.3 | Customer | Worker cards | Profile photo on the card |
| WD-03 | PRD 5.3 | Customer | Worker cards | Experience, skills, languages, areas, availability on the card |
| WD-04 | PRD 5.3 | Customer | Worker cards | Verification badge |
| WD-05 | PRD 5.3 | Customer | Worker cards | Rating average/count and review summary |
| WD-06 | PRD 5.3 | Customer | Worker cards | Private data never exposed (mobile, address, emergency contact, KYC keys, user id) |
| WD-07 | PRD 5.3 | Customer | Worker cards | Shortlist/favourite: add, list, remove, idempotent, capped, shows unavailable |
| WD-08 | PRD 5.3 | Customer | Worker cards | Shortlist entry cannot bypass booking eligibility |
| BK-01 | PRD 5.4 | Customer | Booking | Create booking request (category, engagement, area, timing) |
| BK-02 | PRD 5.4 | Customer | Booking | Request interview or trial with preferred date/time |
| BK-03 | PRD 5.4 | Customer | Booking | Reschedule the interview/trial |
| BK-04 | PRD 5.4, 6.3 | Worker | Booking | Worker explicit accept/decline with reason, deadline |
| BK-05 | PRD 5.4 | Customer | Booking | Confirm worker (state PENDING_PAYMENT) with eligibility re-check |
| BK-06 | PRD 5.4 | Customer | Booking | Pay booking/platform fee; amount server-authoritative |
| BK-07 | PRD 5.4 | Customer | Booking | Booking status timeline |
| BK-08 | PRD 5.4 | Customer | Booking | Invalid/concurrent transitions are refused consistently |
| BK-09 | PRD 8.1 | Customer | Booking | Service cannot start before the agreed start date |
| BK-10 | PRD 5.4 | Admin | Booking | Admin creates a booking on behalf of a customer |
| BK-11 | PRD 5.4 | Customer | Booking | Unpaid PENDING_PAYMENT booking expiry |
| ON-01 | PRD 5.5 | Customer | Ongoing | Attendance/status visible to customer |
| ON-02 | PRD 5.5 | Customer | Ongoing | Month summary of attendance |
| ON-03 | PRD 5.5 | Customer | Ongoing | Customer raises attendance exception; admin corrects with history |
| ON-04 | PRD 5.5 | Customer | Ongoing | Service history (completed, cancelled, active) and replacement chain |
| ON-05 | PRD 5.5 | Customer | Ongoing | Support ticket create, thread, staff reply, internal note, escalation, close |
| ON-06 | PRD 5.5, 7 | Admin | Ongoing | Support resolution SLA with due dates and breach alert |
| ON-07 | PRD 5.5 | Customer | Ongoing | Rate worker once per completed booking; aggregates; hide/restore |
| ON-08 | PRD 5.5, 8.3 | Customer | Ongoing | Replacement request, approval, candidates, selection, audit |
| PAY-01 | PRD 5.6 | Customer | Payments | UPI/cards/net banking via the gateway |
| PAY-02 | PRD 5.6 | Customer | Payments | Payment receipts |
| PAY-03 | PRD 5.6 | Customer | Payments | Transaction history |
| PAY-04 | PRD 5.6 | Customer | Payments | Refund status |
| PAY-05 | PRD 5.6 | Shared | Payments | Webhook signature, replay, out-of-order, unknown order replay |
| PAY-06 | PRD 5.6 | Shared | Payments | Lost callback recovered by gateway lookup |
| PAY-07 | PRD 5.6 | Shared | Payments | Cancellation vs payment consistency, exceptions queue |
| PAY-08 | PRD 10 | Admin | Payments | Payments CSV export for finance |
| WK-01 | PRD 6.1 | Worker | Onboarding | OTP registration, role separation from customer |
| WK-02 | PRD 6.1 | Worker | Onboarding | Profile photo upload, confirm, signature check, moderation |
| WK-03 | PRD 6.1 | Worker | Onboarding | Aadhaar/KYC upload with whole-file validation, hash, integrity re-check |
| WK-04 | PRD 9 | Worker | Onboarding | Malware scanning of documents |
| WK-05 | PRD 6.1 | Worker | Onboarding | Address and emergency contact captured |
| WK-06 | PRD 6.1 | Worker | Onboarding | Previous employer/reference captured (one or several) |
| WK-07 | PRD 6.1 | Admin | Onboarding | Admin-assisted onboarding (create worker for a mobile) |
| WP-01 | PRD 6.2 | Worker | Work profile | Select role(s) (categories) |
| WP-02 | PRD 6.2 | Worker | Work profile | Experience, languages |
| WP-03 | PRD 6.2 | Worker | Work profile | Preferred locations and available timings |
| WP-04 | PRD 6.2 | Worker | Work profile | Expected salary (and period) |
| WP-05 | PRD 6.2 | Worker | Work profile | Full-time/part-time/live-in preference |
| WP-06 | PRD 6.2 | Worker | Work profile | Profile submission gate (missingForSubmission) and searchability only after approval |
| WP-07 | PRD 6.4 | Worker | Work profile | Local-language readiness (data) |
| JW-01 | PRD 6.3 | Worker | Job workflow | Receive job opportunities |
| JW-02 | PRD 6.3 | Worker | Job workflow | Customer requirement summary without PII |
| JW-03 | PRD 6.3 | Worker | Job workflow | Accept/decline |
| JW-04 | PRD 6.3 | Worker | Job workflow | Interview/trial schedule visible, slot proposal by worker |
| JW-05 | PRD 6.3 | Worker | Job workflow | Job confirmation and start date visible |
| ONW-01 | PRD 6.4 | Worker | Ongoing | Record own attendance (today only) |
| ONW-02 | PRD 6.4 | Worker | Ongoing | Current job details |
| ONW-03 | PRD 6.4 | Worker | Ongoing | Earnings/payment reference |
| ONW-04 | PRD 6.4 | Worker | Ongoing | Own ratings |
| ONW-05 | PRD 6.4, 9.1 | Worker | Ongoing | Support/complaint and report/block |
| ONW-06 | PRD 6.4 | Worker | Ongoing | Clear suspended-account state |
| AD-01 | PRD 7 | Admin | Dashboard | Dashboard counts (bookings, workers, KYC, complaints, replacements, collections, alerts) |
| AD-02 | PRD 7 | Admin | Customers | Customer list/filters, detail, status, notes, history |
| AD-03 | PRD 7 | Admin | Workers | Worker list/detail, categories, status |
| AD-04 | PRD 7 | Admin | Verification | Queue, requirements, review, remarks, expiry/recheck |
| AD-05 | PRD 7 | Admin | Bookings | Match, schedule, confirm, cancel, replace; filters |
| AD-06 | PRD 7 | Admin | Payments | Transactions, refunds, exceptions, reconcile, export |
| AD-07 | PRD 7 | Admin | Support | Assign, escalate, priority, close, reply |
| AD-08 | PRD 14 | Admin | Reports | Twelve PRD reports exist (13 routes) and CSV export |
| AD-09 | PRD 7 | Admin | Config | Categories, areas, fees, templates, roles |
| AD-10 | PRD 7, 10 | Admin | Config | Plans (subscription/replacement plan) configuration |
| AD-11 | PRD 13 | Admin | RBAC | Role-based access on every admin route |
| AD-12 | PRD 9.1, 13 | Admin | Audit | Audit logs for critical actions, readable by Super Admin |
| AD-13 | PRD 7 | Admin | Alerts | Admin alert inbox for stuck work |
| AD-14 | PRD 7 | Admin | Concurrency | Stale-write protection on admin edits |
| TS-01 | PRD 9 | Shared | Trust | Never show "fully verified" before approval |
| TS-02 | PRD 9 | Shared | Trust | Verification kinds: mobile, identity, address, emergency, employment, police |
| TS-03 | PRD 9 | Shared | Trust | Expiry/re-verification |
| TS-04 | PRD 9.1 | Shared | Trust | Report/Block |
| TS-05 | PRD 9.1 | Shared | Trust | Suspension of customer/worker |
| TS-06 | PRD 9.1 | Shared | Trust | Complaint history per user |
| TS-07 | PRD 9.1 | Shared | Trust | Emergency-contact visibility by policy |
| TS-08 | PRD 9.1 | Shared | Trust | Sensitive-document access limited by role, short-lived audited links |
| TS-09 | PRD 9.1 | Shared | Trust | No public exposure of identity documents |
| NF-01 | PRD 13 | Operations | Security | HTTPS for all traffic |
| NF-02 | PRD 13 | Operations | Security | Encryption at rest |
| NF-03 | PRD 13 | Shared | Security | Masked sensitive info in routine screens |
| NF-04 | PRD 13 | Shared | Security | Secrets stored securely |
| NF-05 | PRD 13 | Shared | Security | Audit for verification, payment, user-status changes |
| NF-06 | PRD 13 | Shared | Security | Data retention/deletion policy |
| NF-07 | PRD 13 | Shared | Security | Terms, privacy, consent flows |
| NF-08 | PRD 13.1 | Shared | Reliability | Graceful failure and retry of integrations |
| NT-01 | PRD 2.1 | Shared | Notifications | Push notifications (FCM) |
| NT-02 | PRD 2.1 | Shared | Notifications | SMS notifications (transactional) |
| NT-03 | PRD 2.1 | Shared | Notifications | WhatsApp (optional) |
| NT-04 | PRD 2.1 | Shared | Notifications | In-app inbox |
| NT-05 | PRD 8 | Shared | Notifications | Event coverage for booking lifecycle |
| JB-01 | PRD 15 | Operations | Jobs | Worker process runs 6 loops and heartbeats |
| RP-01 | PRD 14 | Admin | Reports | New customers; worker registrations; funnel; demand by category/area; utilization; interview conversion; cancellation; replacement; collections; support; top rated; repeat |
| RP-02 | PRD 14 | Admin | Reports | Report exports |
| RV-01 | PRD 10 | Admin | Revenue | Configurable booking fee |
| RV-02 | PRD 10 | Admin | Revenue | Placement fee, subscription, verification fee, replacement plan, B2B |
| RK-01 | PRD 20 | Shared | Risk | Provider abstraction for payment/SMS/maps/OTP |
| LM-01 | PRD 22 | Operations | Launch | Hyderabad pilot areas seeded |
| BK-12 | PRD 5.4, user rule | Customer | Booking | A worker already booked for a time cannot be booked for an overlapping time (same dates, overlapping hours); free again after the service ends; other hours/other workers stay bookable |
| BK-13 | PRD 6.3, FRD schedule conflict | Worker | Booking | Worker can propose another interview/trial time; customer accepts or keeps the original |
| BK-14 | PRD 8.3 | Shared | Booking | Replacement history is traceable as one chain |
| AC-01 | PRD 19 | Shared | Acceptance | Customer registers by OTP and creates a valid profile |
| AC-02 | PRD 19 | Shared | Acceptance | Worker registers, uploads documents, defines preferences |
| AC-03 | PRD 19 | Shared | Acceptance | Admin approves/rejects verification with remarks |
| AC-04 | PRD 19 | Shared | Acceptance | Customer searches/filter and views profiles |
| AC-05 | PRD 19 | Shared | Acceptance | Interview/trial and completed booking |
| AC-06 | PRD 19 | Shared | Acceptance | Payment success/failure reflected on booking |
| AC-07 | PRD 19 | Shared | Acceptance | Admin tracks and changes permitted booking states |
| AC-08 | PRD 19 | Shared | Acceptance | Replacement/support requests |
| AC-09 | PRD 19 | Shared | Acceptance | Ratings tied to completed engagements |
| AC-10 | PRD 19 | Shared | Acceptance | Role restrictions on sensitive screens |
| AC-11 | PRD 19 | Shared | Acceptance | UAT on Android/iOS devices and browsers |
