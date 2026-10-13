# Remaining gap backlog

Updated 2026-10-13. Only findings that are not fixed and verified. See `closure-register.md` for the rest and `decision-register.md` for the open questions.

## GAP-001 - Customer registers by OTP and creates a valid profile

* Requirement: AC-01 (PRD 19); Shared / Acceptance
* Disposition / priority: BLOCKED_BY_EXTERNAL_DEPENDENCY / P0
* Current behaviour: Backend flow tested
* Blocker / missing: Needs real SMS; Owner
* Acceptance (negative paths first): 401 unauthenticated, 403 wrong role, 404 foreign record, 400 malformed id, one effect for duplicate and concurrent calls, audit row; plus the behaviour above.

## GAP-002 - Payment success/failure reflected on booking

* Requirement: AC-06 (PRD 19); Shared / Acceptance
* Disposition / priority: BLOCKED_BY_EXTERNAL_DEPENDENCY / P0
* Current behaviour: Fake gateway journey tested
* Blocker / missing: Needs the real gateway; Owner
* Acceptance (negative paths first): 401 unauthenticated, 403 wrong role, 404 foreign record, 400 malformed id, one effect for duplicate and concurrent calls, audit row; plus the behaviour above.

## GAP-003 - OTP is delivered by a real SMS provider

* Requirement: AUTH-02 (PRD 5.1); Shared / Auth
* Disposition / priority: BLOCKED_BY_EXTERNAL_DEPENDENCY / P0
* Current behaviour: Twilio + MSG91 adapters (mocked HTTP tests); staging test OTP for allow-listed numbers
* Blocker / missing: No SMS account / sender / DLT template; Owner: provider account, sender, DLT template, real delivery test
* Acceptance (negative paths first): 401 unauthenticated, 403 wrong role, 404 foreign record, 400 malformed id, one effect for duplicate and concurrent calls, audit row; plus the behaviour above.

## GAP-004 - Worker process runs 6 loops and heartbeats

* Requirement: JB-01 (PRD 15); Operations / Jobs
* Disposition / priority: PARTIALLY_FIXED / P0
* Current behaviour: ROOT CAUSE FOUND AND FIXED 2026-10-12: the heartbeat lived 180 s but two loops tick every 5 and 15 minutes, so readiness always reported them missing; heartbeat TTL now follows each loop's interval
* Blocker / missing: Heartbeat lived 180 s but two loops tick every 5 and 15 minutes (false "missing"); Deploy, wait 15 minutes, read GET /admin/system/readiness
* Acceptance (negative paths first): 401 unauthenticated, 403 wrong role, 404 foreign record, 400 malformed id, one effect for duplicate and concurrent calls, audit row; plus the behaviour above.

## GAP-005 - HTTPS for all traffic

* Requirement: NF-01 (PRD 13); Operations / Security
* Disposition / priority: NOT_VERIFIED / P0
* Current behaviour: Render terminates TLS; TRUST_PROXY_HOPS
* Blocker / missing: TLS terminated by the host; Owner: confirm HTTPS redirect / HSTS on the live URL
* Acceptance (negative paths first): 401 unauthenticated, 403 wrong role, 404 foreign record, 400 malformed id, one effect for duplicate and concurrent calls, audit row; plus the behaviour above.

## GAP-006 - UPI/cards/net banking via the gateway

* Requirement: PAY-01 (PRD 5.6); Customer / Payments
* Disposition / priority: BLOCKED_BY_EXTERNAL_DEPENDENCY / P0
* Current behaviour: Razorpay adapter (test keys on live); checkout returns order
* Blocker / missing: No authorized sandbox session; local PAYMENT_PROVIDER=disabled; Owner: run check:providers with test keys, then one manual checkout + webhook + refund
* Acceptance (negative paths first): 401 unauthenticated, 403 wrong role, 404 foreign record, 400 malformed id, one effect for duplicate and concurrent calls, audit row; plus the behaviour above.

## GAP-007 - Cloud deployment

* Requirement: SC-05 (PRD 2.1, 11); Operations / Surfaces
* Disposition / priority: BLOCKED_BY_EXTERNAL_DEPENDENCY / P0
* Current behaviour: render.yaml; API + worker run on Render free plan (user-reported working 2026-10-12)
* Blocker / missing: Free hosting plan; no staging/production split; no CI run recorded; Owner: paid plan, second environment, run CI
* Acceptance (negative paths first): 401 unauthenticated, 403 wrong role, 404 foreign record, 400 malformed id, one effect for duplicate and concurrent calls, audit row; plus the behaviour above.

## GAP-008 - Automated database backups

* Requirement: SC-07 (PRD 2.1, 13); Operations / Surfaces
* Disposition / priority: BLOCKED_BY_EXTERNAL_DEPENDENCY / P0
* Current behaviour: Supabase-managed; no configuration or restore evidence in repo; runbook written
* Blocker / missing: Backups live in Supabase; Owner: enable backups and run a restore drill
* Acceptance (negative paths first): 401 unauthenticated, 403 wrong role, 404 foreign record, 400 malformed id, one effect for duplicate and concurrent calls, audit row; plus the behaviour above.

## GAP-009 - UAT on Android/iOS devices and browsers

* Requirement: AC-11 (PRD 19); Shared / Acceptance
* Disposition / priority: BLOCKED_BY_EXTERNAL_DEPENDENCY / P1 (product)
* Current behaviour: No apps
* Blocker / missing: No apps to run UAT on; Provide apps
* Acceptance (negative paths first): 401 unauthenticated, 403 wrong role, 404 foreign record, 400 malformed id, one effect for duplicate and concurrent calls, audit row; plus the behaviour above.

## GAP-010 - Rate limiting on OTP/API with shared Redis store and trusted proxy

* Requirement: AUTH-08 (PRD 13); Shared / Auth
* Disposition / priority: NOT_VERIFIED / P1
* Current behaviour: Throttler + Redis storage + TRUST_PROXY_HOPS mandatory in production; tests with Redis
* Blocker / missing: Multi-instance and Redis-outage runs were not performed; Run two API instances against one Redis; stop Redis mid-test
* Acceptance (negative paths first): 401 unauthenticated, 403 wrong role, 404 foreign record, 400 malformed id, one effect for duplicate and concurrent calls, audit row; plus the behaviour above.

## GAP-011 - Encryption at rest

* Requirement: NF-02 (PRD 13); Operations / Security
* Disposition / priority: NOT_VERIFIED / P1
* Current behaviour: Provider-managed
* Blocker / missing: Provider-managed encryption at rest; Owner: confirm in Supabase
* Acceptance (negative paths first): 401 unauthenticated, 403 wrong role, 404 foreign record, 400 malformed id, one effect for duplicate and concurrent calls, audit row; plus the behaviour above.

## GAP-012 - Push notifications (FCM)

* Requirement: NT-01 (PRD 2.1); Shared / Notifications
* Disposition / priority: BLOCKED_BY_EXTERNAL_DEPENDENCY / P1
* Current behaviour: fcm.provider (mocked)
* Blocker / missing: Firebase service account missing; Owner
* Acceptance (negative paths first): 401 unauthenticated, 403 wrong role, 404 foreign record, 400 malformed id, one effect for duplicate and concurrent calls, audit row; plus the behaviour above.

## GAP-013 - SMS notifications (transactional)

* Requirement: NT-02 (PRD 2.1); Shared / Notifications
* Disposition / priority: BLOCKED_BY_EXTERNAL_DEPENDENCY / P1
* Current behaviour: SMS provider shared with OTP
* Blocker / missing: SMS provider / DLT templates missing; Owner
* Acceptance (negative paths first): 401 unauthenticated, 403 wrong role, 404 foreign record, 400 malformed id, one effect for duplicate and concurrent calls, audit row; plus the behaviour above.

## GAP-014 - Refund status

* Requirement: PAY-04 (PRD 5.6); Customer / Payments
* Disposition / priority: BLOCKED_BY_DECISION / P1
* Current behaviour: Refund status fields; admin full refund; polling
* Blocker / missing: Partial / automatic refunds undecided (Q-77, Q-83); Client policy
* Acceptance (negative paths first): 401 unauthenticated, 403 wrong role, 404 foreign record, 400 malformed id, one effect for duplicate and concurrent calls, audit row; plus the behaviour above.

## GAP-015 - Customer Android/iOS application

* Requirement: SC-01 (PRD 2.1); Shared / Surfaces
* Disposition / priority: BLOCKED_BY_EXTERNAL_DEPENDENCY / P1 (product)
* Current behaviour: No mobile repository in the workspace
* Blocker / missing: No customer app repository in the workspace; Provide the repository
* Acceptance (negative paths first): 401 unauthenticated, 403 wrong role, 404 foreign record, 400 malformed id, one effect for duplicate and concurrent calls, audit row; plus the behaviour above.

## GAP-016 - Worker Android/iOS application

* Requirement: SC-02 (PRD 2.1); Shared / Surfaces
* Disposition / priority: BLOCKED_BY_EXTERNAL_DEPENDENCY / P1 (product)
* Current behaviour: No mobile repository in the workspace
* Blocker / missing: No worker app repository; Provide the repository
* Acceptance (negative paths first): 401 unauthenticated, 403 wrong role, 404 foreign record, 400 malformed id, one effect for duplicate and concurrent calls, audit row; plus the behaviour above.

## GAP-017 - Web Admin Panel

* Requirement: SC-03 (PRD 2.1); Shared / Surfaces
* Disposition / priority: BLOCKED_BY_EXTERNAL_DEPENDENCY / P1 (product)
* Current behaviour: No web repository in the workspace; 118 admin endpoints exist (docs/qa/data-api-traceability.md)
* Blocker / missing: No admin web repository; Provide the repository
* Acceptance (negative paths first): 401 unauthenticated, 403 wrong role, 404 foreign record, 400 malformed id, one effect for duplicate and concurrent calls, audit row; plus the behaviour above.

## GAP-018 - Production monitoring and error alerts

* Requirement: SC-06 (PRD 2.1, 13); Operations / Surfaces
* Disposition / priority: BLOCKED_BY_DECISION / P1
* Current behaviour: Health endpoints and admin alerts exist; no error-tracking SDK, no uptime/alert configuration
* Blocker / missing: Error-tracking tool is a dependency choice (Q-91); Choose a tool; configure an uptime monitor
* Acceptance (negative paths first): 401 unauthenticated, 403 wrong role, 404 foreign record, 400 malformed id, one effect for duplicate and concurrent calls, audit row; plus the behaviour above.

## GAP-019 - Choose engagement type (full, part, daily, hourly, live-in)

* Requirement: SD-02 (PRD 5.2); Customer / Discovery
* Disposition / priority: PARTIALLY_FIXED / P1
* Current behaviour: Enum supports all; no per-category restriction
* Blocker / missing: Engagement was not category-specific; Lists pending (Q-93)
* Acceptance (negative paths first): 401 unauthenticated, 403 wrong role, 404 foreign record, 400 malformed id, one effect for duplicate and concurrent calls, audit row; plus the behaviour above.

## GAP-020 - Profile photo on the card

* Requirement: WD-02 (PRD 5.3); Customer / Worker cards
* Disposition / priority: BLOCKED_BY_EXTERNAL_DEPENDENCY / P1
* Current behaviour: worker-photo module + signed link on card
* Blocker / missing: Photo upload disabled until PROFILE_PHOTO_MAX_BYTES is set on the service; Owner: set the variable; real-bucket photo test
* Acceptance (negative paths first): 401 unauthenticated, 403 wrong role, 404 foreign record, 400 malformed id, one effect for duplicate and concurrent calls, audit row; plus the behaviour above.

## GAP-021 - Profile photo upload, confirm, signature check, moderation

* Requirement: WK-02 (PRD 6.1); Worker / Onboarding
* Disposition / priority: BLOCKED_BY_EXTERNAL_DEPENDENCY / P1
* Current behaviour: worker-photo module
* Blocker / missing: Disabled by configuration (see WD-02); Owner action
* Acceptance (negative paths first): 401 unauthenticated, 403 wrong role, 404 foreign record, 400 malformed id, one effect for duplicate and concurrent calls, audit row; plus the behaviour above.

## GAP-022 - Worker list/detail, categories, status

* Requirement: AD-03 (PRD 7); Admin / Workers
* Disposition / priority: PARTIALLY_FIXED / P2
* Current behaviour: Filters: status, category, mobile, name, account status, registration date, service area, minimum rating; suspend via users (remaining.int-spec)
* Blocker / missing: Few admin worker filters; Blacklist as its own state is undefined (decision)
* Acceptance (negative paths first): 401 unauthenticated, 403 wrong role, 404 foreign record, 400 malformed id, one effect for duplicate and concurrent calls, audit row; plus the behaviour above.

## GAP-023 - Plans (subscription/replacement plan) configuration

* Requirement: AD-10 (PRD 7, 10); Admin / Config
* Disposition / priority: BLOCKED_BY_DECISION / P2
* Current behaviour: No plan entity
* Blocker / missing: Plans / subscriptions: PRD 10 names them as options; none chosen; Client chooses revenue models
* Acceptance (negative paths first): 401 unauthenticated, 403 wrong role, 404 foreign record, 400 malformed id, one effect for duplicate and concurrent calls, audit row; plus the behaviour above.

## GAP-024 - Stale-write protection on admin edits

* Requirement: AD-14 (PRD 7); Admin / Concurrency
* Disposition / priority: PARTIALLY_FIXED / P2
* Current behaviour: If-Match on worker edit, customer status, categories, service areas, notification templates (remaining.int-spec)
* Blocker / missing: No stale-write protection on admin edits; Fees, support categories, tickets, role changes rely on locks / state machines
* Acceptance (negative paths first): 401 unauthenticated, 403 wrong role, 404 foreign record, 400 malformed id, one effect for duplicate and concurrent calls, audit row; plus the behaviour above.

## GAP-025 - Admin password change and reset

* Requirement: AUTH-11 (PRD 13); Admin / Auth
* Disposition / priority: BLOCKED_BY_DECISION / P2
* Current behaviour: POST /admin/account/password; Super Admin POST /admin/users/{id}/password-reset (temporary password)
* Blocker / missing: MFA method and self-service reset undecided (Q-87); Client chooses MFA / reset method
* Acceptance (negative paths first): 401 unauthenticated, 403 wrong role, 404 foreign record, 400 malformed id, one effect for duplicate and concurrent calls, audit row; plus the behaviour above.

## GAP-026 - Unpaid PENDING_PAYMENT booking expiry

* Requirement: BK-11 (PRD 5.4); Customer / Booking
* Disposition / priority: BLOCKED_BY_DECISION / P2
* Current behaviour: Config-gated auto-cancel exists; period undecided (Q-78)
* Blocker / missing: Expiry period undefined (Q-78); Client sets PENDING_PAYMENT_AUTO_CANCEL_HOURS
* Acceptance (negative paths first): 401 unauthenticated, 403 wrong role, 404 foreign record, 400 malformed id, one effect for duplicate and concurrent calls, audit row; plus the behaviour above.

## GAP-027 - Each category stores its allowed engagement types

* Requirement: CAT-03 (PRD 4, 5.2); Shared / Catalogue
* Disposition / priority: PARTIALLY_FIXED / P2
* Current behaviour: FIXED 2026-10-12: table category_engagements (migration 20261020110000), PUT /admin/service-categories/{id}/engagements, allowedEngagements in category responses; scheduling.int-spec
* Blocker / missing: No table or validation for category engagement types; No default lists: the client must supply them (Q-93)
* Acceptance (negative paths first): 401 unauthenticated, 403 wrong role, 404 foreign record, 400 malformed id, one effect for duplicate and concurrent calls, audit row; plus the behaviour above.

## GAP-028 - Engagement type "Monthly" (Driver, Cook)

* Requirement: CAT-05 (PRD 4); Shared / Catalogue
* Disposition / priority: BLOCKED_BY_DECISION / P2
* Current behaviour: No MONTHLY value; unclear whether FULL_TIME means monthly (Q-38)
* Blocker / missing: "Monthly" has no value in the vocabulary (Q-38/Q-93); Client defines monthly vs full-time
* Acceptance (negative paths first): 401 unauthenticated, 403 wrong role, 404 foreign record, 400 malformed id, one effect for duplicate and concurrent calls, audit row; plus the behaviour above.

## GAP-029 - A worker can choose only engagement types allowed for the category

* Requirement: CAT-06 (PRD 4); Worker / Catalogue
* Disposition / priority: PARTIALLY_FIXED / P2
* Current behaviour: A worker is only matched when their single preference equals the requested engagement, and requests are limited per category (CAT-07)
* Blocker / missing: A worker holds one engagement preference across several categories; Validating the worker preference against category lists needs a client rule (Q-93)
* Acceptance (negative paths first): 401 unauthenticated, 403 wrong role, 404 foreign record, 400 malformed id, one effect for duplicate and concurrent calls, audit row; plus the behaviour above.

## GAP-030 - Address validated against enabled service area/pincode

* Requirement: CP-05 (PRD 5.1); Customer / Profile
* Disposition / priority: BLOCKED_BY_DECISION / P2
* Current behaviour: Booking checks address city equals area city (422 OUTSIDE_SERVICE_AREA); address creation itself accepts any city/pincode format-valid
* Blocker / missing: No pincode-to-area coverage master; Client supplies coverage rule
* Acceptance (negative paths first): 401 unauthenticated, 403 wrong role, 404 foreign record, 400 malformed id, one effect for duplicate and concurrent calls, audit row; plus the behaviour above.

## GAP-031 - Basic customer verification (mobile, address, profile checks)

* Requirement: CP-06 (PRD 5.1); Customer / Profile
* Disposition / priority: BLOCKED_BY_DECISION / P2
* Current behaviour: Interim auto-verification (profile + active address) with staff override; mobile is OTP-verified
* Blocker / missing: Customer verification rule undefined (Q-85); Client defines the rule
* Acceptance (negative paths first): 401 unauthenticated, 403 wrong role, 404 foreign record, 400 malformed id, one effect for duplicate and concurrent calls, audit row; plus the behaviour above.

## GAP-032 - Data retention/deletion policy

* Requirement: NF-06 (PRD 13); Shared / Security
* Disposition / priority: BLOCKED_BY_DECISION / P2
* Current behaviour: Deletion request recorded; no erasure (Q-88)
* Blocker / missing: Retention / erasure undefined (Q-88); Client policy
* Acceptance (negative paths first): 401 unauthenticated, 403 wrong role, 404 foreign record, 400 malformed id, one effect for duplicate and concurrent calls, audit row; plus the behaviour above.

## GAP-033 - Terms, privacy, consent flows

* Requirement: NF-07 (PRD 13); Shared / Security
* Disposition / priority: BLOCKED_BY_DECISION / P2
* Current behaviour: legal module: versions, accept, enforce flag
* Blocker / missing: Legal texts pending review; Legal
* Acceptance (negative paths first): 401 unauthenticated, 403 wrong role, 404 foreign record, 400 malformed id, one effect for duplicate and concurrent calls, audit row; plus the behaviour above.

## GAP-034 - WhatsApp (optional)

* Requirement: NT-03 (PRD 2.1); Shared / Notifications
* Disposition / priority: BLOCKED_BY_EXTERNAL_DEPENDENCY / P2
* Current behaviour: Twilio WhatsApp adapter
* Blocker / missing: WhatsApp provider (optional); Owner
* Acceptance (negative paths first): 401 unauthenticated, 403 wrong role, 404 foreign record, 400 malformed id, one effect for duplicate and concurrent calls, audit row; plus the behaviour above.

## GAP-035 - Support resolution SLA with due dates and breach alert

* Requirement: ON-06 (PRD 5.5, 7); Admin / Ongoing
* Disposition / priority: BLOCKED_BY_DECISION / P2
* Current behaviour: dueAt/slaBreach implemented; hours undecided
* Blocker / missing: SLA hours undefined (Q-59); Client sets SUPPORT_SLA_HOURS_*
* Acceptance (negative paths first): 401 unauthenticated, 403 wrong role, 404 foreign record, 400 malformed id, one effect for duplicate and concurrent calls, audit row; plus the behaviour above.

## GAP-036 - Earnings/payment reference

* Requirement: ONW-03 (PRD 6.4); Worker / Ongoing
* Disposition / priority: BLOCKED_BY_DECISION / P2
* Current behaviour: Worker sees stated budget and start date only
* Blocker / missing: Earnings model undefined; Client
* Acceptance (negative paths first): 401 unauthenticated, 403 wrong role, 404 foreign record, 400 malformed id, one effect for duplicate and concurrent calls, audit row; plus the behaviour above.

## GAP-037 - Payment receipts

* Requirement: PAY-02 (PRD 5.6); Customer / Payments
* Disposition / priority: BLOCKED_BY_DECISION / P2
* Current behaviour: receiptNumber and GET receipt data
* Blocker / missing: Receipt / tax-invoice format undefined; Finance defines the format
* Acceptance (negative paths first): 401 unauthenticated, 403 wrong role, 404 foreign record, 400 malformed id, one effect for duplicate and concurrent calls, audit row; plus the behaviour above.

## GAP-038 - Provider abstraction for payment/SMS/maps/OTP

* Requirement: RK-01 (PRD 20); Shared / Risk
* Disposition / priority: BLOCKED_BY_DECISION / P2
* Current behaviour: Interfaces for payment, SMS, push, WhatsApp, storage; maps interface only
* Blocker / missing: Maps provider undecided (Q-90); Client
* Acceptance (negative paths first): 401 unauthenticated, 403 wrong role, 404 foreign record, 400 malformed id, one effect for duplicate and concurrent calls, audit row; plus the behaviour above.

## GAP-039 - Placement fee, subscription, verification fee, replacement plan, B2B

* Requirement: RV-02 (PRD 10); Admin / Revenue
* Disposition / priority: BLOCKED_BY_DECISION / P2
* Current behaviour: No models
* Blocker / missing: Revenue models undecided; Client
* Acceptance (negative paths first): 401 unauthenticated, 403 wrong role, 404 foreign record, 400 malformed id, one effect for duplicate and concurrent calls, audit row; plus the behaviour above.

## GAP-040 - Emergency-contact visibility by policy

* Requirement: TS-07 (PRD 9.1); Shared / Trust
* Disposition / priority: BLOCKED_BY_DECISION / P2
* Current behaviour: Audited admin read only (Q-86)
* Blocker / missing: Reveal policy undecided (Q-86); Client policy
* Acceptance (negative paths first): 401 unauthenticated, 403 wrong role, 404 foreign record, 400 malformed id, one effect for duplicate and concurrent calls, audit row; plus the behaviour above.

## GAP-041 - Verification badge

* Requirement: WD-04 (PRD 5.3); Customer / Worker cards
* Disposition / priority: BLOCKED_BY_DECISION / P2
* Current behaviour: Card shows only fully-verified workers; no per-check badges
* Blocker / missing: Per-check badge design undefined; Client defines badges
* Acceptance (negative paths first): 401 unauthenticated, 403 wrong role, 404 foreign record, 400 malformed id, one effect for duplicate and concurrent calls, audit row; plus the behaviour above.

## GAP-042 - Malware scanning of documents

* Requirement: WK-04 (PRD 9); Worker / Onboarding
* Disposition / priority: BLOCKED_BY_DECISION / P2
* Current behaviour: Optional ClamAV adapter + fail-safe
* Blocker / missing: Scanner requirement undecided (Q-89); Decide, deploy clamd, set CLAMAV_HOST
* Acceptance (negative paths first): 401 unauthenticated, 403 wrong role, 404 foreign record, 400 malformed id, one effect for duplicate and concurrent calls, audit row; plus the behaviour above.

## GAP-043 - Expected salary (and period)

* Requirement: WP-04 (PRD 6.2); Worker / Work profile
* Disposition / priority: BLOCKED_BY_DECISION / P2
* Current behaviour: expectedSalary stored
* Blocker / missing: Salary period undefined (Q-39); Client
* Acceptance (negative paths first): 401 unauthenticated, 403 wrong role, 404 foreign record, 400 malformed id, one effect for duplicate and concurrent calls, audit row; plus the behaviour above.

## GAP-044 - Local-language readiness (data)

* Requirement: WP-07 (PRD 6.4); Worker / Work profile
* Disposition / priority: BLOCKED_BY_DECISION / P2
* Current behaviour: Languages reference + per-recipient template language
* Blocker / missing: Translated names are client content; Client supplies translations
* Acceptance (negative paths first): 401 unauthenticated, 403 wrong role, 404 foreign record, 400 malformed id, one effect for duplicate and concurrent calls, audit row; plus the behaviour above.
