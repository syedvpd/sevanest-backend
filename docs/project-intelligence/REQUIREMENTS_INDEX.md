# REQUIREMENTS_INDEX

Pointers only; read the cited section for wording. Canonical IDs = SRS §3–§9 (priority "Must" unless noted).
Note: SRS PDF tables render multi-line cells offset; ID→text mapping was reconstructed positionally and cross-checked
against BEA citations (FR-AUTH-003, FR-PAY-008, FR-BK-009, FR-VER-009/011, FR-REP-008, FR-SEC-003/004/005, FR-WD-005/007,
FR-NOT-006, DR-003/004/005 all matched). Confidence: high; re-verify any ID before quoting it externally.

| ID range | Subject | Source | FRD module |
|---|---|---|---|
| FR-AUTH-001..005 | Mobile OTP (cust/worker), token sessions, rate limit/abuse, admin role login (4 roles), secure admin pwd/secrets | SRS §3.1 | FM-01 |
| FR-CUS-001..006 | Cust OTP register, name/email/address/lang, multi addresses, basic customer verification, valid profile | SRS §3.2 | FM-02 |
| FR-SD-001..005 | Category, engagement type (FT/PT/daily/hourly/live-in), location/timing/start, budget, filter by category+location+availability | SRS §3.3 | FM-03 |
| FR-WD-001..007 | Worker cards, badges, rating summary, shortlist, paginated search, search+manual admin match, never expose full ID docs | SRS §3.4 | FM-03 |
| FR-BK-001..009 | Interview/trial request, slot, confirm worker, pay fee, timeline, **state machine**, admin actions, record outcome, admin only permitted states | SRS §3.5 | FM-06 |
| FR-PAY-001..009 | Indian gateway (UPI/card/NB), receipts, history, refund status, reflect success/fail on booking, record amount/ref, admin exports, audit, provider abstraction | SRS §3.6 | FM-07 |
| FR-ON-001..005 | Customer: attendance view, history, support, rate, replacement | SRS §3.7 | FM-09/10/11 |
| FR-WON-001..007 | Worker OTP register, photo, Aadhaar/KYC upload, address+emergency contact, prev employer, short steps, assisted onboarding | SRS §3.8 | FM-04 |
| FR-WP-001..006 | Roles, experience/languages, locations, salary, timings, FT/PT/live-in pref | SRS §3.9 | FM-04 |
| FR-WJ-001..011 | Opportunities, requirement summary, accept/decline, schedule, confirmation, attendance, current job, earnings ref, ratings, support, large-button UX | SRS §3.10 | FM-08 |
| FR-ATT-001..003 | Per-date status incl. exceptions; visible to both; V1 status-based only (no GPS/face) | SRS §3.11 | FM-09 |
| FR-VER-001..012 | OTP, gov ID (manual/partner), address, emergency contact, prev employment, police status, customer verif, doc review/approve/reject/remarks/recheck, not "verified" until approved, audit trail, **manual fallback (011)**, show status to worker | SRS §3.12 | FM-05 |
| FR-REP-001..008 | Replacement request, reason/notes, eligibility review, update engagement, match, select, confirm+auditable, record reason/approval/replacement booking | SRS §3.13 | FM-11 |
| FR-SUP-001..006 | Tickets (cust+worker), assign/escalate/SLA, category/priority/owner/resolution, complaint history, report/block, disputes | SRS §3.14 | FM-12 |
| FR-NOT-001..006 | FCM push, SMS, WhatsApp (**optional**), admin templates, record channel/template/status, retry | SRS §3.15 | FM-13 |
| FR-RAT-001..004 | Rate/review, tied to completed/eligible engagement, aggregate on profile, shown to worker | SRS §3.16 | FM-10 |
| FR-ADM-001..005 | 9 admin modules, customer mgmt, worker mgmt (blacklist), match/assign, config masters w/o code | SRS §3.17 | FM-14/16 |
| FR-SEC-001..008 | RBAC, role-restricted screens, KYC by role, no public ID docs, masking, suspension, emergency-contact policy, audit logs | SRS §3.18 | FM-15 |
| FR-REV-001..003 | Fees configurable, 7 revenue models, no hard-coded price | SRS §3.19 | FM-16 |
| FR-RPT-001..012 | 12 reports (new customers … top-rated/repeat) | SRS §9; FRD §7 defs (Proposed) | — |
| EIR-UI-001..004, EIR-SW-001..003 | UX simplicity; graceful integration failure+retry, provider abstraction, early sandboxes | SRS §4 | — |
| NFR-SEC-001..010 | HTTPS, encrypt at rest, RBAC, KYC restricted, masking, secrets, audit, rate limit, **retention policy (open)**, legal review | SRS §5.1 | — |
| NFR-OPS-001..005 | AWS/Azure+CI/CD+envs, monitoring/alerts, scheduled backups, multi-city scalable, categories via masters | SRS §5.3 | — |
| NFR-USA-001..003 | Low-literacy worker app, l10n-ready (Telugu/Hindi = Phase 2), short forms | SRS §5.4 | — |
| DR-001..006 | Relational DB, object storage restricted, schema+migrations deliverable, booking/replacement history auditable, audit retention, retention rules (open) | SRS §6.2 | — |
| AC-01..AC-11 | Acceptance criteria | SRS §11 = FRD §8 = PRD §19 | — |

Performance: no numeric targets in any source (SRS §5.2, §14 item 7). Out of scope V1: PRD §2.2 / SRS §2.8.
Proposed-only (not in PRD): FRD field rules, §2 role matrix, §4 booking states, §5 verification states, §6 notification matrix, §7 report definitions.

## Implemented by Modules 7-9 (traceability)
- FR-SD-005, FR-WD-005 -> `src/modules/search` (filter by category, location, availability; paginated).
- FR-WD-001/002/004/007 -> worker card (no photo/rating yet; badge = VERIFIED only; no identity data).
- FR-WD-006/007 -> `src/modules/matching` (admin candidate selection; no assignment yet).
- FR-VER-004..012, FR-SEC-003/004 -> `src/modules/verification`. FR-VER-002/003 (mobile OTP, customer verification) stay with Auth/Customers (Q-26).

## Remediation traceability (2026-10-09)
| Requirement | Implementation | Negative-path evidence | Status |
|---|---|---|---|
| FR-AUTH-005 secure admin credentials; FR-AUTH-004 admin role login | scrypt hashes, lockout, `bootstrap:admin`, `POST /admin/account/password` | bootstrap refused when a Super Admin exists (sequential and 6 concurrent); wrong current password 422 + lockout 429; short/same password refused; unauthenticated 401 | Implemented; reset and MFA undecided (Q-66) |
| FR-SEC-001/002 RBAC | permission guards, role API | `security.api`, `qa.access`, `qa.inventory` route inventory | Implemented; matrix values undecided (Q-70) |
| FR-SEC-003/004 private documents, signed links | `StorageProvider`, verification service | content mismatch refused and audited, stays unconfirmed; size mismatch; foreign document answers 404 | Implemented; scanning/retention undecided (Q-69) |
| FR-AUTH-003 rate limiting, NFR-SEC-006 | OTP/admin Redis limits; global throttle | shared across instances with `THROTTLE_STORAGE=redis`; Redis outage degrades to per-process counting | Implemented; defaults need deployment decision (Q-67) |
| FR-NOT-005/006, BEA p8 reliable delivery | outbox, queue, delivery log, health, retry | retry only FAILED (409 otherwise), 404/400/401/403 | Implemented; alerting not built (Q-68) |
| FR-WD-005 shortlist, AC-04 customer worker view, FR-WON-002 photo, FR-WJ-008 earnings, FR-SUP report/block | none | n/a | CONFIRMED_MISSING; scope/privacy decisions needed first (Q-42, Q-52, Q-59, Q-65) |

## Phase 2 traceability (2026-10-09)
| Requirement | Implementation | Negative-path evidence | Status |
|---|---|---|---|
| FR-WD-001/003 card photo + rating summary | `decorate()` in Search: aggregate rating, signed photo link | exact key allow-list; no reviewer data; storage failure yields no link | Implemented (rating shown to customers pending Q-60 sign-off) |
| FR-WD-005 shortlist | `/shortlist` | invisible/unknown 404 identical, malformed 400, 401/403, other customer isolated, 10 parallel adds = 1 row, suspended customer 401 | Implemented; cap and notification undecided (Q-72) |
| FRD FM-03 step 6 / AC-04 worker profile | `GET /search/workers/{id}` | unknown/draft/unverified/suspended/re-check-due all 404 identically; 400/401/403 | Implemented |
| FR-WON-002 profile photo | `/workers/me/photo*` | wrong type 422, oversize 413, unconfigured 503, content mismatch 422 + audit, foreign photo 404, pending cap, parallel confirm = 1 audit row, mass assignment of the reference ignored | Implemented; limit/mandatory/moderation undecided (Q-71) |
| FR-VER-010 / FRD s5 expiry and re-check | `verifiedWorkerCondition` + reminder loop | re-check date reached = not visible, concurrent runs remind once, status untouched, new due date = new reminder | Implemented; admin recipients undecided (Q-75) |
| FR-WJ-008 earnings / payment reference | none | n/a | BLOCKED by decision (Q-73) |
| FR-SUP-006 report/block | none | n/a | BLOCKED by decision (Q-74) |
| BEA p8 reliable delivery | per-event outbox isolation, dead-letter, retry | poison event does not block others, 5 attempts then dead-lettered, retry once (409 after), 400/401/403 | Implemented |
