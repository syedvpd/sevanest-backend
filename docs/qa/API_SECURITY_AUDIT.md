# API and security audit - final QA

Evidence base: the live route inventory read from the running application (`test/integration/qa.inventory.int-spec.ts`), the existing
`security.api.int-spec.ts`, the adversarial and access suites added in this phase (`qa.access`, `qa.adversarial`), and the real HTTP
server and Docker runs (END_TO_END_JOURNEYS.md).

## 1. Result in one table

| Check | Evidence | Result |
|---|---|---|
| Complete inventory | 159 operations: 92 admin, 29 customer, 18 worker, 13 shared (customer+worker or any signed-in), 7 public | recorded in section 4 |
| Every route is under `/api/v1` | inventory test (the two health probes are deliberately unversioned: `/health/live`, `/health/ready`) | PASS |
| No duplicate method+path, no shadowed route | inventory test. One real shadowing bug was found and fixed earlier in the project (`/bookings/:id/:action` swallowed payments and attendance) | PASS |
| Only 7 public operations, all reviewed | OTP request, OTP verify, token refresh, admin login, payment webhook, 2 health probes | PASS |
| Every `/admin` route needs a permission | all but one; the exception is `GET /admin/dashboard`, which returns only the sections the caller's permissions allow | PASS (reviewed exception) |
| Every operation is in OpenAPI | inventory test compares router and OpenAPI in both directions; only the webhook (`@ApiExcludeEndpoint`) and health are absent | PASS |
| Unknown routes / wrong methods use the one error envelope with a request id | inventory test, real server | PASS |
| Missing, invalid, expired, forged, none-alg, wrong-secret tokens; refresh used as access; token after logout | qa.adversarial (13 token shapes), real server | PASS - all 401 |
| Wrong user type -> 403, missing permission -> 403, anonymous -> 401 on EVERY protected route | security.api (router sweep) | PASS |
| The correct caller is admitted on EVERY protected route (no false 401/403/5xx) | qa.access positive sweep (customer, worker, admin holding exactly the route permissions) | PASS |
| Cross-user access (IDOR) | qa.access matrix: second customer / second worker against bookings, payments, ratings, attendance, tickets, replacement requests, addresses, KYC documents, sessions; plus every module suite | PASS - 404 everywhere, data untouched |
| Privilege escalation | qa.adversarial: forged admin claims; an admin without `role.manage` cannot edit roles or self-promote | PASS |
| Malformed identifiers | qa.adversarial: every route with an id answers 400; traversal, null byte, SQL text and 5000-character ids are plain bad input | PASS |
| Injection | SQL text in query strings, filters, search and free text: no 5xx, tables intact, hostile text stored literally | PASS |
| Mass assignment | qa.adversarial sends forged `role / status / type / userId / amountMinor / ...` to every mutating route: never echoed, never applied, no 5xx | PASS |
| Oversized / wrongly typed input | qa.adversarial, security.api (body size limit) | PASS |
| Helmet, CORS, information disclosure | headers present in the real server and in the Docker image; no CORS grant to an unlisted origin; no stack, SQL or path in any error | PASS |
| Account enumeration | admin login: identical answer for unknown user and wrong password; OTP: identical for registered and new numbers, except the deliberate "suspended" message (Q-34) | PASS / OPEN DECISION |
| Webhook security | qa.adversarial + payment.api: unsigned, wrongly signed, tampered, wrong content type, oversized, session-authenticated -> 401; replay and duplicates safe | PASS |
| Logging redaction | real server (321 lines, 15 secrets incl. OTPs, tokens, a password, signatures, mobile numbers) and production-mode container (JSON logs, 248 lines, 9 sentinels): zero occurrences | PASS |
| Secrets in the image | Docker history, environment and filesystem scan | PASS - none |

## 2. Findings

| ID | Severity | Class | Finding | Status |
|---|---|---|---|---|
| S-01 | P1 | CODE DEFECT | **Deadlock between Booking and Replacement.** Cancelling a booking locks the booking and then (hook) the replacement request; withdrawing, approving, rejecting or selecting a replacement locked the request and then the booking. Run together they deadlock and the loser answered HTTP 500. Reproduced in 8/8 and 6/6 rounds. | **FIXED**: Replacement now locks the booking first (`BookingService.lockBooking`). Regression: `qa.concurrency.int-spec.ts` (5 race pairs). |
| S-02 | P1 (CI) | CODE DEFECT | **The committed tree failed `npm run lint` and `npm run format:check`** (found by the clean CI simulation): two lint errors in the new S3 adapter spec, and four files committed with CRLF line endings / unformatted (`app-config.service.ts`, `env.validation.ts`, `env.validation.spec.ts`, `verification.module.ts`) while Prettier requires LF. CI would have been red. | **FIXED in the working tree** (uncommitted): spec corrected, files normalised to LF. |
| S-03 | P3 | DOCUMENTATION | The worker process logged "no queue processors registered yet" although Notifications registers one. | FIXED |
| S-04 | P2 | CODE / CONFIG GAP | The **global API throttler uses the in-memory store**: limits are per process. With N replicas the effective limit is N times higher and a restart resets it. OTP and admin-login limits are Redis-backed and are not affected. | OPEN - move the throttler storage to Redis before running more than one replica (adds a dependency; not done here). |
| S-05 | P2 | CONFIG GAP | `TRUST_PROXY_HOPS` defaults to 0. Behind a load balancer every client then shares one address for per-IP limits, and the OTP per-IP cap would lock out unrelated users. It must be set to the real number of proxies. | OPEN - deployment setting |
| S-06 | P2 | OPEN BUSINESS DECISION | **No way to create the first Super Admin in production.** The seed refuses the bootstrap in production ("provisioning is an open decision", Q-18/Q-29) and no other tool exists. | OPEN - release blocker for the first deployment |
| S-07 | P2 | OPEN DECISION + CONFIG GAP | Only SUPER_ADMIN holds permissions. Operations, Verification and Support executives get 403 on everything except the dashboard until a Super Admin sets their permissions (`PUT /admin/roles/{code}/permissions`). There is no approved matrix (Q-33, Q-62). | OPEN |
| S-08 | P2 | EXTERNAL / CONFIG | **S3 adapter (added during this phase):** a presigned PUT cannot cap the body size or check the content, so a client can place an oversized or wrong-type object in the bucket; `confirm` rejects it afterwards but the object stays (no delete is exposed, retention undefined). The file is never read, so there is no content sniffing or malware scan. The adapter was exercised offline only (presigning and error mapping, 4 unit tests) and has **not** been run against a live endpoint. | OPEN - set a bucket size/type policy and a lifecycle rule; run a live smoke test with real credentials |
| S-09 | P2 | DESIGN NOTE | Every refused request by a signed-in user writes an audit row (R-27). The per-IP throttle is the only brake; there is no retention or archiving. | OPEN (Q-63, Q-64) |
| S-10 | P3 | CONFIG | `.env.example` sets `SWAGGER_ENABLED=true`. The code default is false and production start only warns if it is on. | recommendation: fail closed in production |
| S-11 | P3 | CODE | The production image contains `typescript` (414 MB `node_modules`). Image size only. | OPEN |
| S-12 | P3 | CODE | 17 foreign-key columns have no covering index (admin/actor user references, `bookings.area_id / category_id / cancelled_by_user_id`, `payment_events.payment_id`, `notifications.outbox_event_id / template_id`, ...). Parents are never deleted (RESTRICT), so only joins and filters on them would benefit. | OPEN (add when a query needs them) |
| S-13 | P3 | CODE | An expected 503 (`SMS_NOT_CONFIGURED`) is logged at ERROR as "Unhandled exception" with a stack. No sensitive data, but it will page. | OPEN |
| S-14 | P3 | CODE | Offset pagination on `audit_logs` costs O(offset): 420 ms at offset 500,000 of 600,000 rows. Keyset pagination is the fix if deep pages matter. | OPEN |

No finding in this phase was a confirmed data leak, authentication bypass or injection.

## 3. Audit actions written (from the source)

| Module | Audit actions written |
|---|---|
| attendance | `attendance.correct`, `attendance.record` |
| audit | `security.access_denied` |
| auth | `auth.admin_login_failed`, `auth.login`, `auth.logout`, `auth.otp_failed`, `auth.refresh_token_reuse`, `auth.session_revoke` |
| availability | `availability.update`, `service_area.create`, `service_area.update` |
| booking | `booking.confirm`, `booking.create`, `booking.replaced`, `booking.replacement_closed`, `booking.replacement_requested` |
| customers | `customer.address_create`, `customer.address_deactivate`, `customer.address_set_default`, `customer.address_update`, `customer.note_add`, `customer.profile_create`, `customer.profile_update`, `customer.verification_status_change` |
| matching | `matching.candidates` |
| notifications | `notification_template.create`, `notification_template.update` |
| payment | `payment.create`, `payment.failed`, `payment.fee_set`, `payment.refund_request`, `payment.refunded`, `payment.report_ignored`, `payment.succeeded` |
| ratings | `rating.create` |
| replacement | `replacement.cancel`, `replacement.complete`, `replacement.request` |
| service-categories | `service_category.create`, `service_category.update` |
| support | `support_category.create`, `support_category.update`, `ticket.create` |
| users | `admin.create`, `admin.role_change`, `role.permissions_set`, `user.register`, `user.status_change` |
| verification | `verification.approve`, `verification.check_submit`, `verification.document_confirm`, `verification.document_request`, `verification.document_view`, `verification.recheck`, `verification.reject`, `verification.requirements_set`, `verification.start_review` |
| workers | `worker.categories_set`, `worker.profile_create`, `worker.profile_submit`, `worker.profile_update` |

`booking.<action>` is written for every booking action (`booking.match`, `.schedule`, `.decline`, `.reopen-matching`, `.interview-complete`, `.confirm-worker`, `.start`,
`.complete`, `.cancel`); the table above lists only the literal names found by static search. Free-text remarks, document keys, links and personal data are kept out of the
audit metadata (security.api, verification.api, qa.access).

## 4. Full API inventory (generated from the running application)

Columns: authentication, user type, permission, ownership rule, request DTO, whether the list is paginated (page + limit, limit capped at 100) and the handler.
All error responses use the single envelope `{ code, message, details?, requestId }`; every success body is a DTO class, never a database entity.

| # | Method | Path | Auth | User type | Permission | Ownership / scope | Input DTO | Paginated | Controller.handler |
|---|---|---|---|---|---|---|---|---|---|
| 1 | PATCH | `/api/v1/admin/attendance/:attendanceId` | JWT + live session | ADMIN | attendance.manage | permission-scoped (no per-record owner) | CorrectAttendanceDto | - | AdminAttendanceController.correct |
| 2 | GET | `/api/v1/admin/attendance/bookings/:bookingId` | JWT + live session | ADMIN | attendance.view | permission-scoped (no per-record owner) | AttendanceListQuery (query) | yes | AdminAttendanceController.list |
| 3 | POST | `/api/v1/admin/attendance/bookings/:bookingId` | JWT + live session | ADMIN | attendance.manage | permission-scoped (no per-record owner) | RecordAttendanceDto | - | AdminAttendanceController.record |
| 4 | GET | `/api/v1/admin/audit-logs` | JWT + live session | ADMIN | audit.view | permission-scoped (no per-record owner) | AuditLogQuery (query) | yes | AuditLogController.search |
| 5 | POST | `/api/v1/admin/bookings/:bookingId/:action` | JWT + live session | ADMIN | booking.manage | permission-scoped (no per-record owner) | BookingActionDto | - | AdminBookingsController.act |
| 6 | GET | `/api/v1/admin/bookings/:bookingId` | JWT + live session | ADMIN | booking.view | permission-scoped (no per-record owner) | - | - | AdminBookingsController.get |
| 7 | GET | `/api/v1/admin/bookings` | JWT + live session | ADMIN | booking.view | permission-scoped (no per-record owner) | BookingListQuery (query) | yes | AdminBookingsController.list |
| 8 | GET | `/api/v1/admin/customers/:customerId/notes` | JWT + live session | ADMIN | customer.view | permission-scoped (no per-record owner) | PageQueryDto (query) | yes | AdminCustomersController.listNotes |
| 9 | POST | `/api/v1/admin/customers/:customerId/notes` | JWT + live session | ADMIN | customer.manage | permission-scoped (no per-record owner) | CreateCustomerNoteDto | - | AdminCustomersController.addNote |
| 10 | PATCH | `/api/v1/admin/customers/:customerId/verification-status` | JWT + live session | ADMIN | customer.manage | permission-scoped (no per-record owner) | UpdateVerificationStatusDto | - | AdminCustomersController.setVerificationStatus |
| 11 | GET | `/api/v1/admin/customers/:customerId` | JWT + live session | ADMIN | customer.view | permission-scoped (no per-record owner) | - | - | AdminCustomersController.get |
| 12 | GET | `/api/v1/admin/customers` | JWT + live session | ADMIN | customer.view | permission-scoped (no per-record owner) | AdminCustomerListQuery (query) | yes | AdminCustomersController.list |
| 13 | GET | `/api/v1/admin/dashboard` | JWT + live session | ADMIN | - | permission-scoped (no per-record owner) | - | - | DashboardController.get |
| 14 | PUT | `/api/v1/admin/fees/booking-fee` | JWT + live session | ADMIN | payment.manage | permission-scoped (no per-record owner) | SetFeeDto | - | AdminPaymentsController.setBookingFee |
| 15 | GET | `/api/v1/admin/fees` | JWT + live session | ADMIN | payment.view | permission-scoped (no per-record owner) | - | - | AdminPaymentsController.fees |
| 16 | POST | `/api/v1/admin/matching/candidates` | JWT + live session | ADMIN | matching.run | permission-scoped (no per-record owner) | MatchRequirementDto | - | MatchingController.candidates |
| 17 | GET | `/api/v1/admin/notification-events` | JWT + live session | ADMIN | notification.manage | permission-scoped (no per-record owner) | TemplateListQuery (query) | yes | AdminNotificationsController.events |
| 18 | GET | `/api/v1/admin/notification-templates/:templateId` | JWT + live session | ADMIN | notification.manage | permission-scoped (no per-record owner) | - | - | AdminNotificationsController.get |
| 19 | PATCH | `/api/v1/admin/notification-templates/:templateId` | JWT + live session | ADMIN | notification.manage | permission-scoped (no per-record owner) | UpdateTemplateDto | - | AdminNotificationsController.update |
| 20 | GET | `/api/v1/admin/notification-templates` | JWT + live session | ADMIN | notification.manage | permission-scoped (no per-record owner) | TemplateListQuery (query) | yes | AdminNotificationsController.list |
| 21 | POST | `/api/v1/admin/notification-templates` | JWT + live session | ADMIN | notification.manage | permission-scoped (no per-record owner) | CreateTemplateDto | - | AdminNotificationsController.create |
| 22 | GET | `/api/v1/admin/notifications` | JWT + live session | ADMIN | notification.manage | permission-scoped (no per-record owner) | DeliveryListQuery (query) | yes | AdminNotificationsController.deliveries |
| 23 | POST | `/api/v1/admin/payments/:paymentId/reconcile` | JWT + live session | ADMIN | payment.manage | permission-scoped (no per-record owner) | - | - | AdminPaymentsController.reconcile |
| 24 | POST | `/api/v1/admin/payments/:paymentId/refund` | JWT + live session | ADMIN | payment.refund | permission-scoped (no per-record owner) | RefundDto | - | AdminPaymentsController.refund |
| 25 | GET | `/api/v1/admin/payments/:paymentId` | JWT + live session | ADMIN | payment.view | permission-scoped (no per-record owner) | - | - | AdminPaymentsController.get |
| 26 | GET | `/api/v1/admin/payments` | JWT + live session | ADMIN | payment.view | permission-scoped (no per-record owner) | PaymentListQuery (query) | yes | AdminPaymentsController.list |
| 27 | GET | `/api/v1/admin/permissions` | JWT + live session | ADMIN | role.manage | permission-scoped (no per-record owner) | - | - | AdminRolesController.permissions |
| 28 | POST | `/api/v1/admin/ratings/:ratingId/hide` | JWT + live session | ADMIN | rating.moderate | permission-scoped (no per-record owner) | ModerationDto | - | AdminRatingsController.hide |
| 29 | POST | `/api/v1/admin/ratings/:ratingId/unhide` | JWT + live session | ADMIN | rating.moderate | permission-scoped (no per-record owner) | ModerationDto | - | AdminRatingsController.unhide |
| 30 | GET | `/api/v1/admin/ratings/:ratingId` | JWT + live session | ADMIN | rating.view | permission-scoped (no per-record owner) | - | - | AdminRatingsController.get |
| 31 | GET | `/api/v1/admin/ratings/workers/:workerId/summary` | JWT + live session | ADMIN | rating.view | permission-scoped (no per-record owner) | - | - | AdminRatingsController.summary |
| 32 | GET | `/api/v1/admin/ratings` | JWT + live session | ADMIN | rating.view | permission-scoped (no per-record owner) | RatingListQuery (query) | yes | AdminRatingsController.list |
| 33 | POST | `/api/v1/admin/replacement-requests/:requestId/approve` | JWT + live session | ADMIN | replacement.manage | permission-scoped (no per-record owner) | DecisionDto | - | AdminReplacementsController.approve |
| 34 | GET | `/api/v1/admin/replacement-requests/:requestId/candidates` | JWT + live session | ADMIN | replacement.view, matching.run | permission-scoped (no per-record owner) | PageQueryDto (query) | - | AdminReplacementsController.candidates |
| 35 | POST | `/api/v1/admin/replacement-requests/:requestId/reject` | JWT + live session | ADMIN | replacement.manage | permission-scoped (no per-record owner) | DecisionDto | - | AdminReplacementsController.reject |
| 36 | POST | `/api/v1/admin/replacement-requests/:requestId/select` | JWT + live session | ADMIN | replacement.manage | permission-scoped (no per-record owner) | SelectReplacementWorkerDto | - | AdminReplacementsController.select |
| 37 | GET | `/api/v1/admin/replacement-requests/:requestId` | JWT + live session | ADMIN | replacement.view | permission-scoped (no per-record owner) | - | - | AdminReplacementsController.get |
| 38 | GET | `/api/v1/admin/replacement-requests` | JWT + live session | ADMIN | replacement.view | permission-scoped (no per-record owner) | ReplacementListQuery (query) | yes | AdminReplacementsController.list |
| 39 | GET | `/api/v1/admin/reports/booking-funnel` | JWT + live session | ADMIN | report.view | permission-scoped (no per-record owner) | ReportSeriesQuery (query) | - | ReportsController.bookingFunnel |
| 40 | GET | `/api/v1/admin/reports/cancellation-rate` | JWT + live session | ADMIN | report.view | permission-scoped (no per-record owner) | ReportRangeQuery (query) | - | ReportsController.cancellationRate |
| 41 | GET | `/api/v1/admin/reports/demand-by-area` | JWT + live session | ADMIN | report.view | permission-scoped (no per-record owner) | ReportPagedQuery (query) | - | ReportsController.demandByArea |
| 42 | GET | `/api/v1/admin/reports/demand-by-category` | JWT + live session | ADMIN | report.view | permission-scoped (no per-record owner) | ReportRangeQuery (query) | - | ReportsController.demandByCategory |
| 43 | GET | `/api/v1/admin/reports/interview-conversion` | JWT + live session | ADMIN | report.view | permission-scoped (no per-record owner) | ReportRangeQuery (query) | - | ReportsController.interviewConversion |
| 44 | GET | `/api/v1/admin/reports/new-customers` | JWT + live session | ADMIN | report.view | permission-scoped (no per-record owner) | ReportSeriesQuery (query) | - | ReportsController.newCustomers |
| 45 | GET | `/api/v1/admin/reports/payment-collections` | JWT + live session | ADMIN | report.view | permission-scoped (no per-record owner) | ReportSeriesQuery (query) | - | ReportsController.paymentCollections |
| 46 | GET | `/api/v1/admin/reports/repeat-customers` | JWT + live session | ADMIN | report.view | permission-scoped (no per-record owner) | ReportPagedQuery (query) | - | ReportsController.repeatCustomers |
| 47 | GET | `/api/v1/admin/reports/replacement-rate` | JWT + live session | ADMIN | report.view | permission-scoped (no per-record owner) | ReportRangeQuery (query) | - | ReportsController.replacementRate |
| 48 | GET | `/api/v1/admin/reports/support-tickets` | JWT + live session | ADMIN | report.view | permission-scoped (no per-record owner) | ReportSeriesQuery (query) | - | ReportsController.supportTickets |
| 49 | GET | `/api/v1/admin/reports/top-rated-workers` | JWT + live session | ADMIN | report.view | permission-scoped (no per-record owner) | TopRatedQuery (query) | - | ReportsController.topRatedWorkers |
| 50 | GET | `/api/v1/admin/reports/worker-registrations` | JWT + live session | ADMIN | report.view | permission-scoped (no per-record owner) | ReportSeriesQuery (query) | - | ReportsController.workerRegistrations |
| 51 | GET | `/api/v1/admin/reports/worker-utilization` | JWT + live session | ADMIN | report.view | permission-scoped (no per-record owner) | - | - | ReportsController.workerUtilization |
| 52 | GET | `/api/v1/admin/reports` | JWT + live session | ADMIN | report.view | permission-scoped (no per-record owner) | ReportSeriesQuery (query) | - | ReportsController.catalog |
| 53 | PUT | `/api/v1/admin/roles/:roleCode/permissions` | JWT + live session | ADMIN | role.manage | permission-scoped (no per-record owner) | SetRolePermissionsDto | - | AdminRolesController.setPermissions |
| 54 | GET | `/api/v1/admin/roles/:roleCode` | JWT + live session | ADMIN | role.manage | permission-scoped (no per-record owner) | - | - | AdminRolesController.role |
| 55 | GET | `/api/v1/admin/roles` | JWT + live session | ADMIN | role.manage | permission-scoped (no per-record owner) | - | - | AdminRolesController.roles |
| 56 | GET | `/api/v1/admin/service-areas/:areaId` | JWT + live session | ADMIN | area.manage | permission-scoped (no per-record owner) | - | - | AdminServiceAreasController.get |
| 57 | PATCH | `/api/v1/admin/service-areas/:areaId` | JWT + live session | ADMIN | area.manage | permission-scoped (no per-record owner) | UpdateServiceAreaDto | - | AdminServiceAreasController.update |
| 58 | GET | `/api/v1/admin/service-areas` | JWT + live session | ADMIN | area.manage | permission-scoped (no per-record owner) | ServiceAreaListQuery (query) | yes | AdminServiceAreasController.list |
| 59 | POST | `/api/v1/admin/service-areas` | JWT + live session | ADMIN | area.manage | permission-scoped (no per-record owner) | CreateServiceAreaDto | - | AdminServiceAreasController.create |
| 60 | GET | `/api/v1/admin/service-categories/:categoryId` | JWT + live session | ADMIN | category.manage | permission-scoped (no per-record owner) | - | - | AdminServiceCategoriesController.get |
| 61 | PATCH | `/api/v1/admin/service-categories/:categoryId` | JWT + live session | ADMIN | category.manage | permission-scoped (no per-record owner) | UpdateServiceCategoryDto | - | AdminServiceCategoriesController.update |
| 62 | GET | `/api/v1/admin/service-categories` | JWT + live session | ADMIN | category.manage | permission-scoped (no per-record owner) | PageQueryDto (query) | yes | AdminServiceCategoriesController.list |
| 63 | POST | `/api/v1/admin/service-categories` | JWT + live session | ADMIN | category.manage | permission-scoped (no per-record owner) | CreateServiceCategoryDto | - | AdminServiceCategoriesController.create |
| 64 | PATCH | `/api/v1/admin/support/categories/:categoryId` | JWT + live session | ADMIN | support.category.manage | permission-scoped (no per-record owner) | UpdateSupportCategoryDto | - | AdminSupportController.updateCategory |
| 65 | GET | `/api/v1/admin/support/categories` | JWT + live session | ADMIN | support.view | permission-scoped (no per-record owner) | - | - | AdminSupportController.categories |
| 66 | POST | `/api/v1/admin/support/categories` | JWT + live session | ADMIN | support.category.manage | permission-scoped (no per-record owner) | CreateSupportCategoryDto | - | AdminSupportController.createCategory |
| 67 | POST | `/api/v1/admin/support/tickets/:ticketId/assign` | JWT + live session | ADMIN | support.manage | permission-scoped (no per-record owner) | AssignTicketDto | - | AdminSupportController.assign |
| 68 | POST | `/api/v1/admin/support/tickets/:ticketId/close` | JWT + live session | ADMIN | support.manage | permission-scoped (no per-record owner) | CloseTicketDto | - | AdminSupportController.close |
| 69 | POST | `/api/v1/admin/support/tickets/:ticketId/escalate` | JWT + live session | ADMIN | support.manage | permission-scoped (no per-record owner) | EscalateTicketDto | - | AdminSupportController.escalate |
| 70 | POST | `/api/v1/admin/support/tickets/:ticketId/priority` | JWT + live session | ADMIN | support.manage | permission-scoped (no per-record owner) | SetPriorityDto | - | AdminSupportController.priority |
| 71 | GET | `/api/v1/admin/support/tickets/:ticketId` | JWT + live session | ADMIN | support.view | permission-scoped (no per-record owner) | - | - | AdminSupportController.get |
| 72 | GET | `/api/v1/admin/support/tickets` | JWT + live session | ADMIN | support.view | permission-scoped (no per-record owner) | MyTicketListQuery (query) | yes | AdminSupportController.list |
| 73 | PUT | `/api/v1/admin/users/:userId/role` | JWT + live session | ADMIN | admin.manage_users | permission-scoped (no per-record owner) | ChangeAdminRoleDto | - | AdminUsersController.changeRole |
| 74 | PATCH | `/api/v1/admin/users/:userId/status` | JWT + live session | ADMIN | user.status.manage | permission-scoped (no per-record owner) | UpdateUserStatusDto | - | AdminUsersController.changeStatus |
| 75 | GET | `/api/v1/admin/users/:userId` | JWT + live session | ADMIN | user.view | permission-scoped (no per-record owner) | - | - | AdminUsersController.getUser |
| 76 | GET | `/api/v1/admin/users` | JWT + live session | ADMIN | user.view | permission-scoped (no per-record owner) | AdminUserListQuery (query) | yes | AdminUsersController.listUsers |
| 77 | POST | `/api/v1/admin/users` | JWT + live session | ADMIN | admin.manage_users | permission-scoped (no per-record owner) | CreateAdminDto | - | AdminUsersController.createAdmin |
| 78 | POST | `/api/v1/admin/verification/checks/:checkId/approve` | JWT + live session | ADMIN | verification.decide | permission-scoped (no per-record owner) | ApproveCheckDto | - | AdminVerificationController.approve |
| 79 | POST | `/api/v1/admin/verification/checks/:checkId/recheck` | JWT + live session | ADMIN | verification.decide | permission-scoped (no per-record owner) | RemarksDto | - | AdminVerificationController.recheck |
| 80 | POST | `/api/v1/admin/verification/checks/:checkId/reject` | JWT + live session | ADMIN | verification.decide | permission-scoped (no per-record owner) | RemarksDto | - | AdminVerificationController.reject |
| 81 | POST | `/api/v1/admin/verification/checks/:checkId/start-review` | JWT + live session | ADMIN | verification.review | permission-scoped (no per-record owner) | - | - | AdminVerificationController.startReview |
| 82 | GET | `/api/v1/admin/verification/documents/:documentId/link` | JWT + live session | ADMIN | verification.document.view | permission-scoped (no per-record owner) | - | - | AdminVerificationController.documentLink |
| 83 | GET | `/api/v1/admin/verification/queue` | JWT + live session | ADMIN | verification.review | permission-scoped (no per-record owner) | VerificationQueueQuery (query) | yes | AdminVerificationController.queue |
| 84 | GET | `/api/v1/admin/verification/requirements` | JWT + live session | ADMIN | verification.review | permission-scoped (no per-record owner) | - | - | AdminVerificationController.requirements |
| 85 | PUT | `/api/v1/admin/verification/requirements` | JWT + live session | ADMIN | verification.configure | permission-scoped (no per-record owner) | SetRequirementsDto | - | AdminVerificationController.setRequirements |
| 86 | GET | `/api/v1/admin/workers/:workerId/availability` | JWT + live session | ADMIN | worker.view | permission-scoped (no per-record owner) | - | - | AdminWorkerAvailabilityController.get |
| 87 | PATCH | `/api/v1/admin/workers/:workerId/availability` | JWT + live session | ADMIN | worker.manage | permission-scoped (no per-record owner) | UpdateServiceAreaDto | - | AdminWorkerAvailabilityController.update |
| 88 | PUT | `/api/v1/admin/workers/:workerId/categories` | JWT + live session | ADMIN | worker.manage | permission-scoped (no per-record owner) | SetWorkerCategoriesDto | - | AdminWorkersController.setCategories |
| 89 | GET | `/api/v1/admin/workers/:workerId/verification` | JWT + live session | ADMIN | verification.review | permission-scoped (no per-record owner) | - | - | AdminWorkerVerificationController.get |
| 90 | GET | `/api/v1/admin/workers/:workerId` | JWT + live session | ADMIN | worker.view | permission-scoped (no per-record owner) | - | - | AdminWorkersController.get |
| 91 | PATCH | `/api/v1/admin/workers/:workerId` | JWT + live session | ADMIN | worker.manage | permission-scoped (no per-record owner) | UpdateWorkerProfileDto | - | AdminWorkersController.update |
| 92 | GET | `/api/v1/admin/workers` | JWT + live session | ADMIN | worker.view | permission-scoped (no per-record owner) | AdminWorkerListQuery (query) | yes | AdminWorkersController.list |
| 93 | POST | `/api/v1/attendance/bookings/:bookingId/exceptions` | JWT + live session | CUSTOMER | - | owner only (other users get 404) | RaiseExceptionDto | - | CustomerAttendanceController.raise |
| 94 | GET | `/api/v1/attendance/bookings/:bookingId` | JWT + live session | CUSTOMER | - | owner only (other users get 404) | AttendanceListQuery (query) | yes | CustomerAttendanceController.list |
| 95 | POST | `/api/v1/auth/admin/login` | PUBLIC | any signed-in | - | n/a (public) | AdminLoginDto | - | AuthController.adminLogin |
| 96 | PUT | `/api/v1/auth/device-token` | JWT + live session | CUSTOMER, WORKER | - | caller's own records (list is scoped to the token subject) | RegisterDeviceTokenDto | - | AuthController.registerDeviceToken |
| 97 | POST | `/api/v1/auth/logout` | JWT + live session | any signed-in | - | reference data / own session | - | - | AuthController.logout |
| 98 | POST | `/api/v1/auth/otp/request` | PUBLIC | any signed-in | - | n/a (public) | RequestOtpDto | - | AuthController.requestOtp |
| 99 | POST | `/api/v1/auth/otp/verify` | PUBLIC | any signed-in | - | n/a (public) | VerifyOtpDto | - | AuthController.verifyOtp |
| 100 | DELETE | `/api/v1/auth/sessions/:sessionId` | JWT + live session | any signed-in | - | reference data / own session | - | - | AuthController.revokeSession |
| 101 | GET | `/api/v1/auth/sessions` | JWT + live session | any signed-in | - | reference data / own session | - | - | AuthController.listSessions |
| 102 | POST | `/api/v1/auth/token/refresh` | PUBLIC | any signed-in | - | n/a (public) | RefreshTokenDto | - | AuthController.refresh |
| 103 | POST | `/api/v1/bookings/:bookingId/:action` | JWT + live session | CUSTOMER | - | owner only (other users get 404) | BookingActionDto | - | BookingsController.act |
| 104 | GET | `/api/v1/bookings/:bookingId` | JWT + live session | CUSTOMER | - | owner only (other users get 404) | - | - | BookingsController.get |
| 105 | GET | `/api/v1/bookings` | JWT + live session | CUSTOMER | - | caller's own records (list is scoped to the token subject) | BookingListQuery (query) | yes | BookingsController.list |
| 106 | POST | `/api/v1/bookings` | JWT + live session | CUSTOMER | - | caller's own records (list is scoped to the token subject) | CreateBookingDto | - | BookingsController.create |
| 107 | PUT | `/api/v1/customers/me/addresses/:addressId/default` | JWT + live session | CUSTOMER | - | caller's own records only (other ids answer 404) | - | - | CustomersController.setDefaultAddress |
| 108 | DELETE | `/api/v1/customers/me/addresses/:addressId` | JWT + live session | CUSTOMER | - | caller's own records only (other ids answer 404) | - | - | CustomersController.deleteAddress |
| 109 | GET | `/api/v1/customers/me/addresses/:addressId` | JWT + live session | CUSTOMER | - | caller's own records only (other ids answer 404) | - | - | CustomersController.getAddress |
| 110 | PATCH | `/api/v1/customers/me/addresses/:addressId` | JWT + live session | CUSTOMER | - | caller's own records only (other ids answer 404) | UpdateAddressDto | - | CustomersController.updateAddress |
| 111 | GET | `/api/v1/customers/me/addresses` | JWT + live session | CUSTOMER | - | caller's own record (token subject) | - | - | CustomersController.listAddresses |
| 112 | POST | `/api/v1/customers/me/addresses` | JWT + live session | CUSTOMER | - | caller's own record (token subject) | CreateAddressDto | - | CustomersController.createAddress |
| 113 | GET | `/api/v1/customers/me` | JWT + live session | CUSTOMER | - | caller's own record (token subject) | - | - | CustomersController.getProfile |
| 114 | PATCH | `/api/v1/customers/me` | JWT + live session | CUSTOMER | - | caller's own record (token subject) | UpdateCustomerProfileDto | - | CustomersController.updateProfile |
| 115 | POST | `/api/v1/customers/me` | JWT + live session | CUSTOMER | - | caller's own record (token subject) | CreateCustomerProfileDto | - | CustomersController.createProfile |
| 116 | POST | `/api/v1/payments/:paymentId/verify` | JWT + live session | CUSTOMER | - | owner only (other users get 404) | VerifyPaymentDto | - | PaymentsController.verify |
| 117 | GET | `/api/v1/payments/:paymentId` | JWT + live session | CUSTOMER | - | owner only (other users get 404) | - | - | PaymentsController.get |
| 118 | GET | `/api/v1/payments` | JWT + live session | CUSTOMER | - | caller's own records (list is scoped to the token subject) | PaymentListQuery (query) | yes | PaymentsController.list |
| 119 | POST | `/api/v1/payments` | JWT + live session | CUSTOMER | - | caller's own records (list is scoped to the token subject) | CreatePaymentDto | - | PaymentsController.create |
| 120 | GET | `/api/v1/ratings/:ratingId` | JWT + live session | CUSTOMER | - | owner only (other users get 404) | - | - | RatingsController.get |
| 121 | GET | `/api/v1/ratings/bookings/:bookingId` | JWT + live session | CUSTOMER | - | owner only (other users get 404) | - | - | RatingsController.forBooking |
| 122 | GET | `/api/v1/ratings` | JWT + live session | CUSTOMER | - | caller's own records (list is scoped to the token subject) | RatingListQuery (query) | yes | RatingsController.list |
| 123 | POST | `/api/v1/ratings` | JWT + live session | CUSTOMER | - | caller's own records (list is scoped to the token subject) | CreateRatingDto | - | RatingsController.create |
| 124 | POST | `/api/v1/replacement-requests/:requestId/cancel` | JWT + live session | CUSTOMER | - | owner only (other users get 404) | - | - | ReplacementsController.cancel |
| 125 | POST | `/api/v1/replacement-requests/:requestId/select` | JWT + live session | CUSTOMER | - | owner only (other users get 404) | SelectReplacementWorkerDto | - | ReplacementsController.select |
| 126 | GET | `/api/v1/replacement-requests/:requestId` | JWT + live session | CUSTOMER | - | owner only (other users get 404) | - | - | ReplacementsController.get |
| 127 | GET | `/api/v1/replacement-requests` | JWT + live session | CUSTOMER | - | caller's own records (list is scoped to the token subject) | ReplacementListQuery (query) | yes | ReplacementsController.list |
| 128 | POST | `/api/v1/replacement-requests` | JWT + live session | CUSTOMER | - | caller's own records (list is scoped to the token subject) | CreateReplacementDto | - | ReplacementsController.create |
| 129 | GET | `/api/v1/search/workers` | JWT + live session | CUSTOMER | - | caller's own records (list is scoped to the token subject) | SearchWorkersQuery (query) | yes | SearchController.find |
| 130 | GET | `/api/v1/service-areas/:areaId` | JWT + live session | any signed-in | - | reference data / own session | - | - | ServiceAreasController.get |
| 131 | GET | `/api/v1/service-areas` | JWT + live session | any signed-in | - | reference data / own session | ServiceAreaListQuery (query) | yes | ServiceAreasController.list |
| 132 | GET | `/api/v1/service-categories/:categoryId` | JWT + live session | any signed-in | - | reference data / own session | - | - | ServiceCategoriesController.get |
| 133 | GET | `/api/v1/service-categories` | JWT + live session | any signed-in | - | reference data / own session | PageQueryDto (query) | yes | ServiceCategoriesController.list |
| 134 | GET | `/api/v1/support/categories` | JWT + live session | CUSTOMER, WORKER | - | caller's own records (list is scoped to the token subject) | - | - | SupportController.categories |
| 135 | GET | `/api/v1/support/tickets/:ticketId` | JWT + live session | CUSTOMER, WORKER | - | owner only (other users get 404) | - | - | SupportController.get |
| 136 | GET | `/api/v1/support/tickets` | JWT + live session | CUSTOMER, WORKER | - | caller's own records (list is scoped to the token subject) | MyTicketListQuery (query) | yes | SupportController.list |
| 137 | POST | `/api/v1/support/tickets` | JWT + live session | CUSTOMER, WORKER | - | caller's own records (list is scoped to the token subject) | CreateTicketDto | - | SupportController.create |
| 138 | GET | `/api/v1/users/me` | JWT + live session | any signed-in | - | caller's own record (token subject) | - | - | UsersController.me |
| 139 | POST | `/api/v1/webhooks/payments` | PUBLIC | any signed-in | - | gateway signature over the raw body | - | - | PaymentWebhookController.webhook |
| 140 | GET | `/api/v1/workers/me/attendance/bookings/:bookingId` | JWT + live session | WORKER | - | caller's own records only (other ids answer 404) | AttendanceListQuery (query) | yes | WorkerAttendanceController.list |
| 141 | POST | `/api/v1/workers/me/attendance/bookings/:bookingId` | JWT + live session | WORKER | - | caller's own records only (other ids answer 404) | RecordAttendanceDto | - | WorkerAttendanceController.record |
| 142 | GET | `/api/v1/workers/me/availability` | JWT + live session | WORKER | - | caller's own record (token subject) | - | - | WorkerAvailabilityController.get |
| 143 | PATCH | `/api/v1/workers/me/availability` | JWT + live session | WORKER | - | caller's own record (token subject) | UpdateServiceAreaDto | - | WorkerAvailabilityController.update |
| 144 | POST | `/api/v1/workers/me/bookings/:bookingId/:action` | JWT + live session | WORKER | - | caller's own records only (other ids answer 404) | BookingActionDto | - | WorkerBookingsController.act |
| 145 | GET | `/api/v1/workers/me/bookings/:bookingId` | JWT + live session | WORKER | - | caller's own records only (other ids answer 404) | - | - | WorkerBookingsController.get |
| 146 | GET | `/api/v1/workers/me/bookings` | JWT + live session | WORKER | - | caller's own record (token subject) | BookingListQuery (query) | yes | WorkerBookingsController.list |
| 147 | PUT | `/api/v1/workers/me/categories` | JWT + live session | WORKER | - | caller's own record (token subject) | SetWorkerCategoriesDto | - | WorkersController.setCategories |
| 148 | GET | `/api/v1/workers/me/ratings/summary` | JWT + live session | WORKER | - | caller's own record (token subject) | - | - | WorkerRatingsController.summary |
| 149 | GET | `/api/v1/workers/me/ratings` | JWT + live session | WORKER | - | caller's own record (token subject) | RatingListQuery (query) | yes | WorkerRatingsController.list |
| 150 | POST | `/api/v1/workers/me/submit` | JWT + live session | WORKER | - | caller's own record (token subject) | - | - | WorkersController.submit |
| 151 | POST | `/api/v1/workers/me/verification/checks/:checkType/documents` | JWT + live session | WORKER | - | caller's own record (token subject) | RequestDocumentUploadDto | - | WorkerVerificationController.requestUpload |
| 152 | POST | `/api/v1/workers/me/verification/checks/:checkType/submit` | JWT + live session | WORKER | - | caller's own record (token subject) | - | - | WorkerVerificationController.submit |
| 153 | POST | `/api/v1/workers/me/verification/documents/:documentId/confirm` | JWT + live session | WORKER | - | caller's own records only (other ids answer 404) | - | - | WorkerVerificationController.confirm |
| 154 | GET | `/api/v1/workers/me/verification` | JWT + live session | WORKER | - | caller's own record (token subject) | - | - | WorkerVerificationController.get |
| 155 | GET | `/api/v1/workers/me` | JWT + live session | WORKER | - | caller's own record (token subject) | - | - | WorkersController.get |
| 156 | PATCH | `/api/v1/workers/me` | JWT + live session | WORKER | - | caller's own record (token subject) | UpdateWorkerProfileDto | - | WorkersController.update |
| 157 | POST | `/api/v1/workers/me` | JWT + live session | WORKER | - | caller's own record (token subject) | CreateWorkerProfileDto | - | WorkersController.create |
| 158 | GET | `/health/live (unversioned)` | PUBLIC | any signed-in | - | n/a (public) | - | - | HealthController.live |
| 159 | GET | `/health/ready (unversioned)` | PUBLIC | any signed-in | - | n/a (public) | - | - | HealthController.ready |
