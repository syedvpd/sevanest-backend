# RISK_REGISTER

Sev: H/M/L. Do not solve here; each gets mitigation in the owning module design. Source = doc or INFERENCE.

| ID | Area | Risk | Sev | Source |
|---|---|---|---|---|
| R-01 | Spec | No document is signed off; 3 incompatible state models → schema churn after migrations | H | FRD/TRD/BEA conflicts C-02,C-03 |
| R-02 | Authz | Server-side RBAC + object-level checks (IDOR): customer/worker must only reach own bookings, tickets, attendance, payments; workers must never see other users' docs | H | FR-SEC, BEA p5,9 |
| R-03 | Sensitive data | Aadhaar/KYC docs: private storage, signed URLs, masking, audit, retention undefined; Indian personal-data law applies (INFERENCE) | H | FR-SEC-003..005, Q-02 |
| R-04 | Trust | Wrongly showing "Verified"; badge must derive only from approved checks by authorized user | H | FR-VER-009 |
| R-05 | Payments | Double charge, lost webhook, forged webhook, client-trusted success, refund mistakes | H | BEA p7, FR-PAY |
| R-06 | Concurrency | Double-booking a worker, duplicate accept, concurrent admin edits, illegal transitions; needs row locking/optimistic versioning | H | FRD FM-14 alt flow, FR-BK-009 |
| R-07 | State machines | Transition + history + audit must commit atomically; notify after commit only | H | BEA p6 |
| R-08 | Auth | OTP brute force/SMS pumping/cost abuse, refresh-token theft/rotation races | H | NFR-SEC-008, BEA p5 |
| R-09 | Providers | Payment/SMS/verification/maps outage or vendor choice late; sandboxes not yet obtained | M-H | SRS §2.7, §12 |
| R-10 | Uploads | Malware/oversize/wrong type, unreadable images, weak networks | M | WFA p7 |
| R-11 | Migrations | Irreversible schema before states frozen; Prisma migration review/rollback discipline | H | DR-003 |
| R-12 | Schedule | 16-week plan, 2 backend devs, 12 components / many sub-domains; scope creep | H | PRD §15,§20 |
| R-13 | Perf | No numeric targets; search by category+area+availability needs indexes/pagination | M | SRS §5.2 |
| R-14 | Reliability | Queue dead-letters, replay idempotency, reconciliation, backups untested | M | BEA p8, NFR-OPS-003 |
| R-15 | Compliance | Retention/consent/legal review undefined; facial attendance excluded | M | NFR-SEC-009/010 |
| R-16 | Governance | External pack's Spring Boot/SQS claims could mislead agents; the pack is outside the repo (D-11), so root MAP.md/CLAUDE.md state precedence | L | C-01, D-11 |
| R-17 | Adoption | Low-literacy workers; assisted onboarding path unspecified on admin side | M | FR-WON-007 |
| R-18 | Coupling | Search reads tables owned by other modules through raw SQL; a schema change there can break Search silently at runtime | M | D-26; mitigated by integration tests that exercise every filter and by the shared verified fragment |
| R-19 | KYC | No malware scanning, retention policy, encryption confirmation or storage vendor yet; documents are metadata + signed links only | H | Q-02, Q-08, Q-50 |
| R-20 | Operations | The required-check set is empty by default: until an administrator sets it no worker is searchable or matchable | M | Q-04, Q-45 |
| R-21 | Operations | Notification delivery and the outbox dispatch loop run only in the worker process; if it is down notifications wait (nothing is lost, the outbox is durable) | M | D-31 |
| R-22 | Payments | Only a fake gateway exists; the real vendor's webhook format, signature scheme and retry behaviour are unverified | H | Q-56 |
| R-23 | State model | Booking schema and transitions follow a PROPOSED model; a different final model means a migration | H | R-01, Q-55 |
| R-24 | Coupling | Reports and the dashboard read other modules' tables through raw SQL; a schema change there can break a report at runtime (like R-18) | M | Mitigated by integration tests that run every report against real data and by the READ ONLY transaction |
| R-25 | Compliance | Report definitions are PROPOSED; numbers shown to the business may change when definitions are confirmed | M | Q-61 |
| R-26 | Operations | Three of four admin roles hold no permissions until a Super Admin configures them; the bootstrap Super Admin is dev-only | H | Q-33, Q-62, Q-29 |
| R-27 | Audit volume | Every refused request by a signed-in user writes an audit row; the global per-IP throttle is the only brake, and there is no retention or archiving | M | Q-63, Q-64 |
| R-28 | Availability | Booking cannot reach CONFIRMED and nobody can log in in production until payment and SMS vendors exist (Q-08) | H | QA B-2, B-3 |
| R-29 | Process | The first Super Admin could not be created in production. MITIGATED 2026-10-09: `npm run bootstrap:admin` (D-40), verified on a disposable database; the procedure still needs client approval | M | QA B-5, S-06, Q-66 |
| R-30 | Security | Global HTTP throttler is per process (replicas multiply the limit); TRUST_PROXY_HOPS defaults to 0 behind a proxy | M | QA S-04, S-05 |
| R-31 | Data | KYC `s3` adapter never verified against a real bucket; presigned PUT cannot cap size or type | H | QA B-4, S-08 |
| R-32 | Process | GitHub workflow never executed on GitHub; only reproduced locally from a clean copy | M | QA R-4 |
| R-33 | Concurrency | Cross-module lock order: always lock the BOOKING first (S-01 deadlock found and fixed in Replacement) | M | `qa.concurrency.int-spec.ts` |
| R-34 | Process | Password RESET and MFA do not exist for admins; a forgotten password needs a Super Admin or a database procedure; a stolen admin password is protected only by the lockout and unique sessions | H | Q-66; release blocker until decided |
| R-35 | Security | KYC files are checked by signature and size only: no malware scanning, no bucket-side size/type cap, no retention policy | H | Q-69, Q-50; release blocker for real KYC data |
| R-36 | Operations | `THROTTLE_STORAGE=memory` is still the default and `TRUST_PROXY_HOPS=0`; a multi-replica or proxied deployment that keeps the defaults has weaker per-IP limits | M | Q-67; mitigated by the Redis store and the production start-up warning |
| R-37 | Operations | Failed notifications can be retried by hand but nothing alerts on a growing failed count or outbox backlog; no metrics/alerting stack exists | M | Q-68; `/admin/notifications/health` gives the numbers, a monitor must poll it |
| R-38 | Product | Earnings view (FR-WJ-008) and report/block (FR-SUP-006) are Must requirements still unbuilt because their meaning is undecided | H | Q-73, Q-74; release blocker unless descoped in writing |
| R-39 | Privacy | Customers receive a short-lived signed link to a worker photo with each card/profile; links are not audited per view and there is no photo moderation or malware scan | M | Q-71; needs sign-off |
| R-40 | Operations | A dead-lettered outbox event or FAILED notification waits for a human; nothing pages | M | Q-68; `/admin/notifications/health` must be polled by monitoring |
