# Data / API traceability

Audit date 2026-10-12. Module level: requirement area -> controller routes -> tables -> events and jobs -> tests. Route counts come from a source scan of `*.controller.ts` (static; `GET /api/v1/...`, global prefix `api`, URI version `v1`). Runtime route existence is also pinned by `test/integration/qa.inventory.int-spec.ts` and the e2e route inventory.

| Area (PRD) | Controller (routes / of which /admin) | Main tables | Events / jobs | Tests |
|---|---|---|---|---|
| Auth, sessions (5.1, 6.1) | auth (8/0), admin-account (1/1) | users, sessions, device_tokens, audit_logs | worker: none | auth.api, security-related in qa.adversarial, test.otp |
| Users, RBAC (3, 7) | users (11/10) | users, roles, permissions, role_permissions, user_roles | status-changed and password-reset events revoke sessions | users.api, admin.api, qa.access |
| Customers (5.1) | customers (14/5) | customer_profiles, customer_addresses, customer_notes | auto-verification audit | customers.api, small.items |
| Catalogue and areas (4, 5.2) | service-categories (6/4), availability (10/6) | service_categories, service_areas, worker_work_preferences, worker_preferred_areas, worker_time_windows | seed on start | categories.api, availability.api |
| Workers (6.1, 6.2) | workers (10/5), worker-photo (3/0) | worker_profiles, worker_skills, worker_languages, worker_profile_photos | - | workers.api, modules.workforce |
| Verification (9) | verification (13/9) | verification_requirements, worker_verification_checks, worker_verification_events, verification_documents | loops: recheck-reminders, abandoned-uploads | verification.api, kyc.integrity |
| Search, matching, shortlist (5.2, 5.3) | search (2/0), matching (1/1), shortlist (3/0) | reads workers, ratings, blocks; customer_shortlist_items | - | search.api, matching.api, remediation2.discovery |
| Booking (5.4, 6.3) | booking (11/4) | bookings, booking_events | loop: booking-checks; outbox events | booking.api, qa.statemachine, qa.journeys, gap.closing |
| Payments (5.6, 10) | payment (16/11, one public webhook) | payments, payment_events, payment_exceptions, fee_configs | loop: payment-recovery; payment webhook | payment.api, payments.recovery |
| Attendance (5.5, 6.4) | attendance (10/4) | attendance_records, attendance_events | - | attendance.api, small.items |
| Ratings (5.5) | ratings (11/5) | ratings, worker_rating_summaries | - | ratings.api |
| Replacement (8.3) | replacement (11/6) | replacement_requests | cancellation hook | replacement.api |
| Support (5.5, 7) | support (17/11) | support_categories, support_tickets, support_ticket_events, support_messages | loop: support-sla | support.api, gap.closing |
| Notifications (2.1) | notifications (13/9) | notification_templates, notifications, outbox_events | loop: notifications (BullMQ + outbox) | notifications.api, remediation.notifications |
| Alerts | alerts (4/4) | admin_alerts | raised by payments, bookings, support, safety, deletion | gap.closing |
| Safety (9.1) | safety (8/4) | user_blocks, safety_reports | alert | gap.closing |
| Legal, deletion (13) | legal (7/1, one public) | legal_acceptances, deletion_requests | alert | gap.closing |
| Reports, dashboard (14) | reports (15/15), dashboard (1/1) | read-only over all tables | - | reports.api, qa.reports, small.items |
| App config, reference data | meta (2/0, public) | - | - | gap.closing |
| Readiness | system (1/1) | reads config, templates, fees, heartbeats | heartbeats from all loops | small.items |
| Audit log | audit-log (1/1) | audit_logs | - | admin.api |
| Idempotency, concurrency | decorator on payment, replacement, support, ratings, attendance, booking actions | idempotency_keys | purge in booking-checks loop | small.items |

Added 2026-10-13: `GET/PUT /workers/me/references` and `GET /admin/workers/{id}/references` (table worker_references); `PUT /workers/me/bookings/{id}/slot-proposal`, `POST /bookings/{id}/slot-proposal/{accept|reject}`, `POST /admin/bookings/{id}/slot-proposal/{accept|reject}` (bookings.proposed_slot_at / proposed_slot_note; events BOOKING_SLOT_PROPOSED / BOOKING_SLOT_ANSWERED); `GET /bookings/{id}/replacement-chain`, `GET /admin/bookings/{id}/replacement-chain`; `GET /workers/me/opportunities`; `PUT /admin/service-categories/{id}/engagements` (category_engagements); ETag / If-Match on customer profile, customer address, category, area, notification template; `npm run check:providers`.

Known contract gaps (details in the gap backlog): no plans / subscriptions (undecided); no erasure job (Q-88); no pincode master; no parallel job offers (one matched worker per booking); If-Match not on fees, support categories, tickets or role changes.
