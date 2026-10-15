# IMPLEMENTATION_STATUS

Verified 2026-10-08. Evidence for every "VERIFIED" row is in CURRENT_STATE.md.

| Area | Status |
|---|---|
| Toolchain (Node 24, Nest 11, TS 5.9.3, Prisma 7.10.0, Jest 30) | VERIFIED, exact-pinned, unchanged |
| Foundation (config, errors, request id, validation, logging, health, OpenAPI, guards, audit, Redis, BullMQ, Docker, CI) | VERIFIED, unchanged apart from the additive items below |
| **Module 1 Auth** | DONE for the supported requirements: OTP request/verify, rate limits, lockout, sessions, refresh rotation + replay detection, logout, session list/revoke, device tokens, admin login + brute-force protection. Real SMS delivery BLOCKED (no vendor, Q-36) |
| **Module 2 Users** | DONE: identity, status (ACTIVE/SUSPENDED), admin creation, suspension with session revocation, RBAC seed (Super Admin full; D-71 least-privilege starting sets for the other roles, 2026-10-14) |
| **Module 3 Customers** | DONE: profile, addresses (default consistency, soft removal), admin list/detail/status/notes. Verification promotion rule OPEN (Q-26) |
| Database: 2 migrations (foundation + `20261008120000_auth_users_customers`) | VERIFIED on dev DB, test DB and an empty CI-style DB; no drift |
| Docker image / compose with the new modules | NOT re-run after Modules 1-3 (Dockerfile unchanged; `npm run build` includes `dist/seed.js`) |
| GitHub CI workflow | env block extended with the new required variables; sequence VERIFIED locally on an empty DB; never run on GitHub |
| Workers, Service Categories, Availability (Modules 4-6) | DONE (results in docs/testing); photo upload, KYC, customer-facing worker view NOT built |
| Business modules 7-12 (see MODULE_MAP.md) | IMPLEMENTED (see the per-module rows below and CURRENT_STATE.md) |

## Requirement-to-code matrix (Modules 1-3)

| Requirement | Implementation | Test |
|---|---|---|
| FR-AUTH-001/002, FR-CUS-001/002 OTP login | `POST /auth/otp/request`, `/auth/otp/verify` | auth.api (OTP request/verify groups) |
| FR-AUTH-003 token sessions | access JWT + hashed rotating refresh, `sessions` | auth.api (sessions, refresh) |
| FR-AUTH-004 / NFR-SEC-008 rate limiting, abuse protection | OtpService limits, AdminLoginThrottle, global throttler | auth.api (limits, lockouts, parallel) |
| FR-AUTH-005 admin role login | `POST /auth/admin/login` | auth.api (admin group), users.api |
| FR-AUTH-006 / NFR-SEC-006 secure admin passwords | scrypt `PasswordHasher` | password-hasher spec, users.api |
| FR-CUS-003/004/006 profile | `/customers/me` | customers.api (profile) |
| FR-CUS-005 multiple addresses, default | `/customers/me/addresses` | customers.api (addresses) |
| FR-CUS-005 basic customer verification | admin-controlled PENDING/VERIFIED (rule OPEN) | customers.api (admin) |
| FR-SEC-001/002 RBAC | guards + seeded roles/permissions + `RequireUserType` | users.api (RBAC), customers.api |
| FR-SEC-006 masking | masked mobile in admin lists/user view | users.api, customers.api |
| FR-SEC-007 suspension | `PATCH /admin/users/{id}/status` | users.api, customers.api, journey |
| FR-SEC-008 / NFR-SEC-007 audit | 16 audit actions across the modules | auth/users/customers audit assertions |
| FR-WON-001 worker OTP registration | worker account creation via `appType=WORKER` (profile = Workers module, not built) | auth.api |

Ambiguous/under-specified (unchanged plus the new Q-25..Q-36): FR-BK-006 (states), FR-REP-003/FR-RAT-002 (eligibility), FR-SEC-007 (policy), NFR performance, field limits.
Update per module when work starts: NOT STARTED / IN PROGRESS / DONE-with-evidence.

| **Module 7 Search** | DONE for supported requirements: customer worker search by category/area/availability/engagement/language/experience, paginated, card allow-list. No ranking (Q-46), photo/rating absent |
| **Module 8 Matching** | DONE: admin candidate selection for a full requirement, audited, unranked, built on Search eligibility. No assignment/booking |
| **Module 9 Verification** | DONE for supported requirements: checks, signed-link documents (no storage vendor), review workflow, history, re-check, required set. Partner, retention, notifications OPEN (Q-50, Q-51) |

| **Module 10 Booking** | DONE on the PROPOSED FRD state model: create/idempotency, lifecycle, decline/match, cancel, timeline, eligibility checks. State model, outcome values, cancel fees OPEN (Q-55) |
| **Module 11 Payment** | DONE behind the provider abstraction with a fake adapter: fee config, order, verification, webhook + replay protection, reconciliation, refunds. Vendor/fees/refund policy OPEN (Q-56) |
| **Module 12 Notifications** | DONE: outbox, templates, queue, delivery log, retry, adapters (disabled/test). Vendors/wording OPEN (Q-57) |
| **Module 13 Attendance** | DONE: status per booking/date, worker/customer/admin paths, corrections with history. Configurable statuses OPEN (Q-53) |
| **Module 14 Replacement** | DONE: request, review, candidates, selection, linked replacement booking, policy boundary. Eligibility rule OPEN (Q-54) |

| **Module 15 Ratings** | DONE for the documented rules: rate a COMPLETED booking once, worker view and totals, admin hide/restore. Scale value, eligibility beyond COMPLETED, edit/delete OPEN (Q-58, Q-60) |
| **Module 16 Support** | DONE: tickets for customers and workers, own-booking link, staff assign/priority/escalate/close with resolution, append-only history, configured categories. SLA, auto-assignment, reopen, attachments, report/block effect NOT built (Q-59) |
| **Module 17 Reports** | DONE: the 12 FR-RPT reports (13 endpoints) read-only in READ ONLY transactions, with stated definitions. Definitions are PROPOSED (Q-61); no export |
| **Module 18 Admin** | DONE: admin account list, admin role change, role/permission administration (privilege-escalation guards), operations dashboard with permission-scoped sections, audit-log viewer. Existing module admin endpoints unchanged. Permission matrix values are configured by the Super Admin, not seeded (Q-62) |
| **Module 19 Audit and security hardening** | DONE for the obvious gaps: refused access and wrong-OTP audit events, stronger redaction (keys and secret-looking values, also on read), audit viewer with two new indexes, Super-Admin-only permissions, automated route inventory and permission-bypass matrix over every endpoint. Exhaustive security audit is the next phase |
| Business modules 1-19 | ALL IMPLEMENTED. Remaining work is the QA / security / E2E / performance / production-readiness audit and the open questions |

### Requirement-to-code matrix (Modules 15-19)

| Requirement | Implementation | Test |
|---|---|---|
| FR-RAT-001/002, AC-09 rate completed engagements only | `POST /ratings`, `RATING_POLICY` | ratings.api (creating) |
| FR-RAT-003/004 aggregate on profile, shown to worker | `worker_rating_summaries`, `/workers/me/ratings[/summary]` | ratings.api (reading, moderation) |
| FRD FM-10 admin moderation | `POST /admin/ratings/{id}/hide|unhide` | ratings.api (administration) |
| FR-SUP-001..006, AC-08 | `/support/*`, `/admin/support/*` | support.api |
| FR-RPT-001..012 | `/admin/reports/*` | reports.api |
| FRD FM-14 dashboard, FR-ADM-001..005 | `/admin/dashboard`, `/admin/users` (list, role), existing module admin routes | admin.api |
| FRD FM-15 / FR-SEC-001/002/008, AC-10 | `/admin/roles*`, `/admin/permissions`, `/admin/audit-logs`, `security.access_denied`, route inventory | admin.api, security.api |
| NFR-SEC-005/006/007/008 | redaction, error envelope, throttling, audit | security.api, audit.service spec |

## Final QA phase (see `docs/qa/`)
Traceability, API/RBAC audit, journeys, performance and production-readiness evidence in `docs/qa/*`; overall status READY WITH BLOCKERS. Final-tree CI simulation: unit 187, e2e 27, integration 594, all exit 0.

## Backend gap-remediation phase (2026-10-09) - verified status, details in `docs/qa/backend-gap-remediation.md`
| Area | Status | Evidence |
|---|---|---|
| First production Super Admin | DONE (procedure awaits client approval, Q-66): `npm run bootstrap:admin`, one-time, audited, no default | users.bootstrap.spec, remediation.admin.int-spec, real CLI run on a disposable database (create, refuse repeat, seed refuses production) |
| Admin password change | DONE (self-service). Password RESET and MFA NOT built: business decision + channel (Q-66) | remediation.admin.int-spec; real HTTP smoke against the production build |
| Role-permission matrix | STILL OPEN: only SUPER_ADMIN holds permissions; proposal recorded, not applied (Q-70) | `docs/qa/RBAC_MATRIX.md` |
| Global rate limit across replicas | DONE as opt-in `THROTTLE_STORAGE=redis`; default still per process (Q-67) | remediation.throttle.int-spec, env.validation.spec |
| KYC content check | DONE: file-signature check on confirm. Malware scan, bucket size cap, retention NOT built (Q-69, Q-50) | document-signature.spec, verification.api (content mismatch) |
| Notification operations | DONE: health summary + manual retry of FAILED. Alerting/metrics NOT built (Q-68) | remediation.notifications.int-spec |
| FK covering indexes | DONE for 5 joined FKs (migration 20261014090000) | migration applied to a fresh database, `prisma migrate diff` shows no drift |
| Shortlist, customer worker-profile view, worker photo, worker earnings, report/block, receipts/exports | STILL MISSING; each needs a product decision first (Q-42, Q-52, Q-59, Q-65) | REQUIREMENTS_TRACEABILITY |
| Payment, SMS, push, WhatsApp vendors; real bucket; GitHub CI run; TLS/proxy; backup restore | STILL BLOCKED externally; unchanged | `docs/qa/OPEN_BLOCKERS.md` |

## Gap-remediation phase 2 (2026-10-09) - details in `docs/qa/backend-gap-remediation.md` (Phase 2)
| Candidate gap | Result |
|---|---|
| Customer-safe worker profile | DONE `GET /search/workers/{workerId}` (+ rating aggregate and photo link on cards) |
| Shortlist / favourites | DONE `GET/PUT/DELETE /shortlist` (cap 100 is a technical guard, Q-72) |
| Worker profile photo | DONE `POST /workers/me/photo`, `POST /workers/me/photo/{id}/confirm`, `GET /workers/me/photo`; needs `PROFILE_PHOTO_MAX_BYTES` (Q-71); no malware scan |
| Worker earnings / payment history | NOT BUILT: meaning undecided, no wage or payout data exists (Q-73) |
| Report / block | NOT BUILT: effect undecided (Q-74) |
| Verification expiry + scheduled re-checks | Expiry exclusion already implemented and now proven; reminder scheduler DONE (worker only; admin recipients undecided, Q-75) |
| Customer verification lifecycle | IMPLEMENTED per D-19 (admin-controlled PENDING/VERIFIED); more states undecided (Q-26) |
| Booking cancel / refund / replacement edges | IMPLEMENTED and tested (state matrix, concurrency, late payment success after cancel); fee and refund rules undecided (Q-17, Q-21) |
| Support reopen / assignment / escalation / privacy | assignment, escalation, privacy IMPLEMENTED; reopen undecided (Q-59) |
| Reports | IMPLEMENTED; definitions PROPOSED (Q-61) |
| Failed outbox events | DONE: per-event isolation, backoff, dead-letter, visibility, manual retry |
| Production configuration | DONE: Redis throttle default in production, optional photo limit, demo seed guarded against non-local databases |

## Phase 1 production readiness (2026-10-12)
| Area | Status |
|---|---|
| SMS/OTP providers (Twilio, MSG91), WhatsApp (Twilio) | IMPLEMENTED, unit-tested with faked HTTP; NOT delivered against a real provider (credentials, DLT: Q-76) |
| Razorpay payment adapter (order, verify, webhook, lookup by order, refunds) | IMPLEMENTED, tested with faked HTTP and the fake gateway; NOT run against Razorpay (Q-79) |
| Cancellation x payment consistency, `payment_exceptions`, admin list/resolve/summary | IMPLEMENTED, integration-tested (races included); refund policy BLOCKED (Q-77) |
| Payment/refund recovery sweeper, UNKNOWN_ORDER replay | IMPLEMENTED, integration-tested (lost webhook, outage, exhaustion, concurrent workers); unpaid-booking expiry BLOCKED (Q-78) |
| KYC whole-file validation, hash, delete rejected, review-time integrity, abandoned sweeper | IMPLEMENTED, integration-tested with in-memory storage; malware scan BLOCKED (Q-81) |
| TRUST_PROXY_HOPS mandatory in production; Redis throttle default | IMPLEMENTED (config specs); hop count is an operator decision (Q-82) |
| First Super Admin bootstrap (hidden prompt / secret file, strength check) | IMPLEMENTED, CLI run locally on a throwaway DB; must be run once on the production service |
| Migration `20261018090000_payment_recovery_kyc_integrity` | VERIFIED on empty DB + after 11 migrations, no drift |

## Small items and interim defaults (2026-10-12)
| Area | Status |
|---|---|
| Attendance summary, list filters, report CSV, admin-created booking/worker | IMPLEMENTED, integration-tested |
| Generic Idempotency-Key; If-Match (worker edit, customer status) | IMPLEMENTED, integration-tested; If-Match not on other admin resources |
| Start-date guard; customer auto-verification; Super Admin password reset; audited sensitive reads | IMPLEMENTED as interim defaults (D-59), switchable |
| ClamAV malware scanning | IMPLEMENTED (adapter + fail-safe), unit/integration with fakes; no scanner deployed |
| Automatic refunds/fees, earnings, MFA, erasure/retention, maps, error tracking | NOT BUILT: decisions Q-83..Q-91 |
| Full PRD audit | `docs/qa/prd-implementation-matrix.md` (157 rows) and `remaining-gap-backlog.md` (59 tickets) |

## Audit closure (2026-10-12)
| Area | Status |
|---|---|
| Worker double-booking / availability by hour | IMPLEMENTED, integration-tested incl. concurrent confirmation (D-63) |
| Category engagement restrictions | IMPLEMENTED (mechanism + enforcement); no default lists (Q-93) |
| Opportunity feed | IMPLEMENTED |
| Heartbeat / readiness false negative | FIXED in code; confirm after deploy |
| Remaining findings | `docs/qa/closure-register.md`, `docs/qa/remaining-gap-backlog.md` |

## Second closure run (2026-10-13)
| Area | Status |
|---|---|
| Worker references; slot proposals; replacement chain; customer versioning | IMPLEMENTED, integration-tested (remaining.int-spec) |
| Availability edge cases (buffer, races, releases) | IMPLEMENTED and tested (scheduling.buffer.int-spec) |
| Provider check command | IMPLEMENTED; run locally: storage OK, others not configured |
| Decisions | `docs/qa/decision-register.md` |
| Worker photo pipeline (2026-10-14) | DONE: WebP renditions without metadata, optional malware scan, stable cache key (D-69) |
| Receipt PDF (2026-10-14) | DONE: `GET /payments/{id}/receipt/pdf`, plain receipt, not a GST invoice (Q-100 open) |
| Customer Active Service / History / Rating (2026-10-14) | DONE: attendance LATE/LEAVE + check-in/out + window, history and totals, rating eligibility + allowedActions, review limit, rebook, worker identity on bookings (D-76..D-83). Rating tags NOT built (Q-103) |
| Customer support / safety / notifications / push (2026-10-14, asks 45-54) | DONE where policy-independent: ticket min length and closed history types, report/block idempotency and target check, device-token unbind, dead-token cleanup, push route keys, unread `{count,unread}`, mark-unread (D-84, D-85). NOT built: FAQ, ticket photos, preferences, delete, reopen, extra route types (Q-107..Q-111). FCM unverified live |
| Admin session / permission consistency (2026-10-14) | DONE: permissions in admin login and refresh responses, 16 integration tests; frontend must use `worker.view` (see docs/qa/admin-session-permissions.md) |
| Customer-app gap closure (2026-10-15, requests 1-57) | DONE where policy-independent: booking-fee quote, customer own profile photo (migration `20261029090000`), worker decline reason hidden from the customer timeline, `minRating` bounded by the rating scale, blank legal URL = unset; everything else verified against code and tests. Traceability: `docs/qa/customer-app-backend-gap-closure.md`. Blocked: account deletion (Q-112), photo visibility (Q-113), policy text/refund (Q-114), slot enforcement (Q-115), budget filter/weekday matching/price data (Q-76/Q-77) |
