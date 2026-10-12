# MODULE_MAP

## Official high-level components (FACT: PRD §11.1, SRS §7.2)
12: Mobile API Gateway · Authentication · User/Profile · Worker Verification · Service/Category & Availability ·
Matching/Search · Booking · Payment · Notification · Support/Complaint · Reporting & Admin · Audit & Security Layer.
- *Mobile API Gateway* = edge/infrastructure (TLS, routing, first-line rate limit), not a Nest module.
- *Audit & Security Layer* = cross-cutting (`src/common/audit`, guards, filters), not a business module.
- BEA p3 decomposes these into finer **implementation domains** (21 named). They are internal boundaries inside the
  components below, NOT additional official modules, and a domain gets its own sub-folder only when it earns one.

## Implementation modules (`src/modules/<name>`) — dependency order fixed by user 2026-10-07
| # | Module | Covers (internal domains, BEA names) | Main reqs | Blocked by |
|---|---|---|---|---|
| 1 | auth | auth, sessions, device tokens, RBAC mechanism | FR-AUTH, FR-SEC-001/2 | Q-12 (limits → config) |
| 2 | user-profile | users, customers, workers (profile/skills/langs/areas) | FR-CUS, FR-WON, FR-WP | Q-12 |
| 3 | catalog-availability | categories, availability, areas | FR-SD, NFR-OPS-005 | Q-14 (area/master ownership) |
| 4 | worker-verification (IMPLEMENTED 2026-10-10: `src/modules/verification`) | verification cases/docs/checks, KYC | FR-VER, FR-SEC-003..005 | C-03, Q-04, Q-10, Q-02 |
| 5 | notification (IMPLEMENTED 2026-10-11: `src/modules/notifications`) | notifications, deliveries, templates | FR-NOT | Q-08 vendors, Q-20 |
| 6 | matching-search (IMPLEMENTED 2026-10-10: `src/modules/search`, `src/modules/matching`) | search, matching | FR-WD, FR-SD-005 | C-07 |
| 7 | booking-interview (IMPLEMENTED 2026-10-11: `src/modules/booking`; attendance `src/modules/attendance`; replacement `src/modules/replacement`) | bookings, interviews, trials, status history | FR-BK | C-02, C-04, C-08, Q-05 |
| 8 | payment (IMPLEMENTED 2026-10-11: `src/modules/payment`) | payments, events, refunds, webhooks, reconciliation | FR-PAY, FR-REV | C-02, C-05, Q-01, Q-17, Q-08 |
| 9 | attendance-ratings (attendance IMPLEMENTED 2026-10-11; ratings IMPLEMENTED 2026-10-12: `src/modules/ratings`) | attendance, engagements(?), ratings | FR-ATT, FR-RAT, FR-ON | C-04, Q-09, Q-58 |
| 10 | replacement | replacement requests | FR-REP | C-10, Q-09 |
| 11 | support-complaints (IMPLEMENTED 2026-10-12: `src/modules/support`; SLA/report-block not built) | tickets, SLA, report/block | FR-SUP | Q-59 |
| 12 | reporting-admin (IMPLEMENTED 2026-10-12: reports + dashboard `src/modules/reports`; admin accounts/roles in `src/modules/users`; audit viewer `src/common/audit`; config masters stay with their owning modules) | reports, admin users/roles, config masters (fees, plans, templates) | FR-RPT, FR-ADM, FR-REV | C-06, Q-11, Q-14, Q-61, Q-62 |

Replacement (FR-REP) and Attendance & Ratings (FR-ATT/RAT) are functional domains from PRD §5.5/§8.3 and SRS §3.11/3.13/3.16;
the PRD §11.1 list has no component of their own, so they are separate implementation modules by user decision, not by PRD §11.1.

## Cross-cutting (not modules)
audit (append-only; FR-SEC-008, NFR-SEC-007, DR-005) · config · request-id/logging · error envelope · validation ·
health/readiness · provider adapters (`src/integrations/*`) · Prisma/Redis/BullMQ infrastructure.

## Rules
- No module reads another module's tables; use exported services/events (BEA p3).
- `domain/` sub-folder only for real state machines/rules. Thin repository only where it adds value; Prisma access stays out of controllers.
- Gap G-02 partly addressed: config masters (fees/areas/plans/templates) proposed home = reporting-admin (module 12); areas also read by catalog-availability. Still needs confirmation (Q-14).
- Per-module README + `docs/testing/<module>/` created when the module starts.

## Remediation additions (2026-10-09) - actual files and routes
| Area | Files | Routes / commands |
|---|---|---|
| First Super Admin | `src/bootstrap-admin.ts`, `UsersService.bootstrapFirstSuperAdmin`, `UsersRepository.superAdminAssignmentCount` | `npm run bootstrap:admin` (CLI only, no HTTP) |
| Admin password change | `src/modules/auth/admin-account.controller.ts`, `AuthService.changeAdminPassword`, `SessionService.revokeOthersWith` | `POST /api/v1/admin/account/password` (ADMIN, no permission: acts on own account only; reviewed exception in `security.api`/`qa.inventory`) |
| Rate-limit storage | `src/infrastructure/cache/redis-throttler.storage.ts`, wired in `src/app.module.ts` | env `THROTTLE_STORAGE=memory|redis` |
| KYC content check | `src/modules/verification/document-signature.ts`, `StorageProvider.readObjectHead` (S3, memory, disabled adapters) | existing `POST /verification/documents/{id}/confirm` now returns 422 `DOCUMENT_CONTENT_MISMATCH` |
| Notification operations | `NotificationsService.health/retryFailed`, `OutboxService.backlog`, `NotificationsRepository.statusCounts/requeueFailed` | `GET /api/v1/admin/notifications/health`, `POST /api/v1/admin/notifications/{id}/retry` (`notification.manage`) |
| Migration | `prisma/migrations/20261014090000_fk_covering_indexes` | indexes only |

## Phase 2 additions (2026-10-09)
| Area | Files | Routes / jobs |
|---|---|---|
| Shared storage | `src/integrations/storage/storage.module.ts` | provider `STORAGE_PROVIDER` (one instance for KYC and photos) |
| Worker photo | `src/modules/worker-photo/*`, `WorkersService.setPhotoRef`, table `worker_profile_photos` | `POST /workers/me/photo`, `POST /workers/me/photo/{photoId}/confirm`, `GET /workers/me/photo` |
| Profile + cards | `src/modules/search/*` (`findVisibleByIds`, `ratingSummaries`, `getVisibleCards`) | `GET /search/workers/{workerId}` |
| Shortlist | `src/modules/shortlist/*`, table `customer_shortlist_items` | `GET /shortlist`, `PUT /shortlist/{workerId}`, `DELETE /shortlist/{workerId}` |
| Outbox recovery | `OutboxService.recordFailure/retryDeadLettered/backlog`, `NotificationsService.dispatchOutbox/retryOutboxEvent`, columns on `outbox_events` | `POST /admin/outbox-events/{eventId}/retry`; health shows `deadLettered` |
| Re-check reminder | `src/modules/verification/verification.worker.ts`, `VerificationService.notifyRecheckDue`, column `worker_verification_checks.recheck_notified_for`, event `RECHECK_DUE` | worker-process loop every 5 min |
| Migrations | `20261015090000_outbox_dead_letter`, `20261016090000_recheck_due_reminder`, `20261017090000_worker_photo_shortlist` | additive only |
