# RBAC matrix - final QA

Built from the running application (route metadata), not from the specification. The six actors:

| Actor | How it exists in the system |
|---|---|
| Customer | user type CUSTOMER (OTP login) |
| Worker | user type WORKER (OTP login) |
| Super Admin | user type ADMIN with role SUPER_ADMIN: **all 32 permissions** (seeded) |
| Operations Admin | user type ADMIN with role OPERATIONS_ADMIN: **no permission seeded** |
| Verification Executive | user type ADMIN with role VERIFICATION_EXECUTIVE: **no permission seeded** |
| Support Executive | user type ADMIN with role SUPPORT_EXECUTIVE: **no permission seeded** |

**Important (S-07, Q-33, Q-62):** the specification's role matrix (FRD section 2) is "proposed" and inconsistent with itself (it says the Verification Executive
cannot approve, while FM-05 says they approve and reject). The seed therefore grants nothing to the three other admin roles. Until a Super Admin configures them with
`PUT /admin/roles/{code}/permissions`, those three actors can sign in and see the dashboard shell, and nothing else. This is a safe default and an operational gap;
it is **not** a bug. The columns marked * in the per-route table show that seeded state, not a recommendation.

## Permissions (32) and where they are used

| Permission | Guards (routes) | SUPER_ADMIN | OPERATIONS_ADMIN | VERIFICATION_EXECUTIVE | SUPPORT_EXECUTIVE |
|---|---|---|---|---|---|
| `admin.manage_users` | 2 | granted | not granted | not granted | not granted |
| `area.manage` | 4 | granted | not granted | not granted | not granted |
| `attendance.manage` | 2 | granted | not granted | not granted | not granted |
| `attendance.view` | 1 | granted | not granted | not granted | not granted |
| `audit.view` | 1 | granted | not granted | not granted | not granted |
| `booking.manage` | 1 | granted | not granted | not granted | not granted |
| `booking.view` | 2 | granted | not granted | not granted | not granted |
| `category.manage` | 4 | granted | not granted | not granted | not granted |
| `customer.manage` | 2 | granted | not granted | not granted | not granted |
| `customer.view` | 3 | granted | not granted | not granted | not granted |
| `matching.run` | 2 | granted | not granted | not granted | not granted |
| `notification.manage` | 6 | granted | not granted | not granted | not granted |
| `payment.manage` | 2 | granted | not granted | not granted | not granted |
| `payment.refund` | 1 | granted | not granted | not granted | not granted |
| `payment.view` | 3 | granted | not granted | not granted | not granted |
| `rating.moderate` | 2 | granted | not granted | not granted | not granted |
| `rating.view` | 3 | granted | not granted | not granted | not granted |
| `replacement.manage` | 3 | granted | not granted | not granted | not granted |
| `replacement.view` | 3 | granted | not granted | not granted | not granted |
| `report.view` | 14 | granted | not granted | not granted | not granted |
| `role.manage` | 4 | granted | not granted | not granted | not granted |
| `support.category.manage` | 2 | granted | not granted | not granted | not granted |
| `support.manage` | 4 | granted | not granted | not granted | not granted |
| `support.view` | 3 | granted | not granted | not granted | not granted |
| `user.status.manage` | 1 | granted | not granted | not granted | not granted |
| `user.view` | 2 | granted | not granted | not granted | not granted |
| `verification.configure` | 1 | granted | not granted | not granted | not granted |
| `verification.decide` | 3 | granted | not granted | not granted | not granted |
| `verification.document.view` | 1 | granted | not granted | not granted | not granted |
| `verification.review` | 4 | granted | not granted | not granted | not granted |
| `worker.manage` | 3 | granted | not granted | not granted | not granted |
| `worker.view` | 3 | granted | not granted | not granted | not granted |

Every permission guards at least one route and every permission used by a route exists in the catalog (checked by `security.api`).

## What is tested for every route

| Probe | Expected | Test |
|---|---|---|
| No token | 401 | security.api (all non-public routes) |
| Forged / expired / malformed token | 401 | security.api, qa.adversarial |
| Wrong user type (customer on worker/admin areas, worker on customer/admin areas, admin on customer/worker areas) | 403 | security.api |
| Admin with no permission | 403 | security.api |
| Admin holding other permissions but not the required one | 403 | security.api |
| Correct caller (customer / worker / admin with exactly the route's permissions) | not 401, not 403, not 5xx | qa.access |
| Another user's resource | 404, data unchanged | qa.access + each module suite |
| Suspended user with a still-valid token | 401 | security.api, users.api, real server |
| A refusal is audited with actor, route pattern and reason, and no ids, query or body | yes | security.api |

## Matrix per route (159)

| Method | Path | Customer | Worker | Super Admin | Operations Admin* | Verification Exec.* | Support Exec.* | Requires |
|---|---|---|---|---|---|---|---|---|
| PATCH | `/api/v1/admin/attendance/:attendanceId` | - | - | yes | no (no permissions seeded) | no (no permissions seeded) | no (no permissions seeded) | attendance.manage |
| GET | `/api/v1/admin/attendance/bookings/:bookingId` | - | - | yes | no (no permissions seeded) | no (no permissions seeded) | no (no permissions seeded) | attendance.view |
| POST | `/api/v1/admin/attendance/bookings/:bookingId` | - | - | yes | no (no permissions seeded) | no (no permissions seeded) | no (no permissions seeded) | attendance.manage |
| GET | `/api/v1/admin/audit-logs` | - | - | yes | no (no permissions seeded) | no (no permissions seeded) | no (no permissions seeded) | audit.view |
| POST | `/api/v1/admin/bookings/:bookingId/:action` | - | - | yes | no (no permissions seeded) | no (no permissions seeded) | no (no permissions seeded) | booking.manage |
| GET | `/api/v1/admin/bookings/:bookingId` | - | - | yes | no (no permissions seeded) | no (no permissions seeded) | no (no permissions seeded) | booking.view |
| GET | `/api/v1/admin/bookings` | - | - | yes | no (no permissions seeded) | no (no permissions seeded) | no (no permissions seeded) | booking.view |
| GET | `/api/v1/admin/customers/:customerId/notes` | - | - | yes | no (no permissions seeded) | no (no permissions seeded) | no (no permissions seeded) | customer.view |
| POST | `/api/v1/admin/customers/:customerId/notes` | - | - | yes | no (no permissions seeded) | no (no permissions seeded) | no (no permissions seeded) | customer.manage |
| PATCH | `/api/v1/admin/customers/:customerId/verification-status` | - | - | yes | no (no permissions seeded) | no (no permissions seeded) | no (no permissions seeded) | customer.manage |
| GET | `/api/v1/admin/customers/:customerId` | - | - | yes | no (no permissions seeded) | no (no permissions seeded) | no (no permissions seeded) | customer.view |
| GET | `/api/v1/admin/customers` | - | - | yes | no (no permissions seeded) | no (no permissions seeded) | no (no permissions seeded) | customer.view |
| GET | `/api/v1/admin/dashboard` | - | - | yes | yes (no permission needed) | yes (no permission needed) | yes (no permission needed) | ADMIN |
| PUT | `/api/v1/admin/fees/booking-fee` | - | - | yes | no (no permissions seeded) | no (no permissions seeded) | no (no permissions seeded) | payment.manage |
| GET | `/api/v1/admin/fees` | - | - | yes | no (no permissions seeded) | no (no permissions seeded) | no (no permissions seeded) | payment.view |
| POST | `/api/v1/admin/matching/candidates` | - | - | yes | no (no permissions seeded) | no (no permissions seeded) | no (no permissions seeded) | matching.run |
| GET | `/api/v1/admin/notification-events` | - | - | yes | no (no permissions seeded) | no (no permissions seeded) | no (no permissions seeded) | notification.manage |
| GET | `/api/v1/admin/notification-templates/:templateId` | - | - | yes | no (no permissions seeded) | no (no permissions seeded) | no (no permissions seeded) | notification.manage |
| PATCH | `/api/v1/admin/notification-templates/:templateId` | - | - | yes | no (no permissions seeded) | no (no permissions seeded) | no (no permissions seeded) | notification.manage |
| GET | `/api/v1/admin/notification-templates` | - | - | yes | no (no permissions seeded) | no (no permissions seeded) | no (no permissions seeded) | notification.manage |
| POST | `/api/v1/admin/notification-templates` | - | - | yes | no (no permissions seeded) | no (no permissions seeded) | no (no permissions seeded) | notification.manage |
| GET | `/api/v1/admin/notifications` | - | - | yes | no (no permissions seeded) | no (no permissions seeded) | no (no permissions seeded) | notification.manage |
| POST | `/api/v1/admin/payments/:paymentId/reconcile` | - | - | yes | no (no permissions seeded) | no (no permissions seeded) | no (no permissions seeded) | payment.manage |
| POST | `/api/v1/admin/payments/:paymentId/refund` | - | - | yes | no (no permissions seeded) | no (no permissions seeded) | no (no permissions seeded) | payment.refund |
| GET | `/api/v1/admin/payments/:paymentId` | - | - | yes | no (no permissions seeded) | no (no permissions seeded) | no (no permissions seeded) | payment.view |
| GET | `/api/v1/admin/payments` | - | - | yes | no (no permissions seeded) | no (no permissions seeded) | no (no permissions seeded) | payment.view |
| GET | `/api/v1/admin/permissions` | - | - | yes | no (no permissions seeded) | no (no permissions seeded) | no (no permissions seeded) | role.manage |
| POST | `/api/v1/admin/ratings/:ratingId/hide` | - | - | yes | no (no permissions seeded) | no (no permissions seeded) | no (no permissions seeded) | rating.moderate |
| POST | `/api/v1/admin/ratings/:ratingId/unhide` | - | - | yes | no (no permissions seeded) | no (no permissions seeded) | no (no permissions seeded) | rating.moderate |
| GET | `/api/v1/admin/ratings/:ratingId` | - | - | yes | no (no permissions seeded) | no (no permissions seeded) | no (no permissions seeded) | rating.view |
| GET | `/api/v1/admin/ratings/workers/:workerId/summary` | - | - | yes | no (no permissions seeded) | no (no permissions seeded) | no (no permissions seeded) | rating.view |
| GET | `/api/v1/admin/ratings` | - | - | yes | no (no permissions seeded) | no (no permissions seeded) | no (no permissions seeded) | rating.view |
| POST | `/api/v1/admin/replacement-requests/:requestId/approve` | - | - | yes | no (no permissions seeded) | no (no permissions seeded) | no (no permissions seeded) | replacement.manage |
| GET | `/api/v1/admin/replacement-requests/:requestId/candidates` | - | - | yes | no (no permissions seeded) | no (no permissions seeded) | no (no permissions seeded) | replacement.view, matching.run |
| POST | `/api/v1/admin/replacement-requests/:requestId/reject` | - | - | yes | no (no permissions seeded) | no (no permissions seeded) | no (no permissions seeded) | replacement.manage |
| POST | `/api/v1/admin/replacement-requests/:requestId/select` | - | - | yes | no (no permissions seeded) | no (no permissions seeded) | no (no permissions seeded) | replacement.manage |
| GET | `/api/v1/admin/replacement-requests/:requestId` | - | - | yes | no (no permissions seeded) | no (no permissions seeded) | no (no permissions seeded) | replacement.view |
| GET | `/api/v1/admin/replacement-requests` | - | - | yes | no (no permissions seeded) | no (no permissions seeded) | no (no permissions seeded) | replacement.view |
| GET | `/api/v1/admin/reports/booking-funnel` | - | - | yes | no (no permissions seeded) | no (no permissions seeded) | no (no permissions seeded) | report.view |
| GET | `/api/v1/admin/reports/cancellation-rate` | - | - | yes | no (no permissions seeded) | no (no permissions seeded) | no (no permissions seeded) | report.view |
| GET | `/api/v1/admin/reports/demand-by-area` | - | - | yes | no (no permissions seeded) | no (no permissions seeded) | no (no permissions seeded) | report.view |
| GET | `/api/v1/admin/reports/demand-by-category` | - | - | yes | no (no permissions seeded) | no (no permissions seeded) | no (no permissions seeded) | report.view |
| GET | `/api/v1/admin/reports/interview-conversion` | - | - | yes | no (no permissions seeded) | no (no permissions seeded) | no (no permissions seeded) | report.view |
| GET | `/api/v1/admin/reports/new-customers` | - | - | yes | no (no permissions seeded) | no (no permissions seeded) | no (no permissions seeded) | report.view |
| GET | `/api/v1/admin/reports/payment-collections` | - | - | yes | no (no permissions seeded) | no (no permissions seeded) | no (no permissions seeded) | report.view |
| GET | `/api/v1/admin/reports/repeat-customers` | - | - | yes | no (no permissions seeded) | no (no permissions seeded) | no (no permissions seeded) | report.view |
| GET | `/api/v1/admin/reports/replacement-rate` | - | - | yes | no (no permissions seeded) | no (no permissions seeded) | no (no permissions seeded) | report.view |
| GET | `/api/v1/admin/reports/support-tickets` | - | - | yes | no (no permissions seeded) | no (no permissions seeded) | no (no permissions seeded) | report.view |
| GET | `/api/v1/admin/reports/top-rated-workers` | - | - | yes | no (no permissions seeded) | no (no permissions seeded) | no (no permissions seeded) | report.view |
| GET | `/api/v1/admin/reports/worker-registrations` | - | - | yes | no (no permissions seeded) | no (no permissions seeded) | no (no permissions seeded) | report.view |
| GET | `/api/v1/admin/reports/worker-utilization` | - | - | yes | no (no permissions seeded) | no (no permissions seeded) | no (no permissions seeded) | report.view |
| GET | `/api/v1/admin/reports` | - | - | yes | no (no permissions seeded) | no (no permissions seeded) | no (no permissions seeded) | report.view |
| PUT | `/api/v1/admin/roles/:roleCode/permissions` | - | - | yes | no (no permissions seeded) | no (no permissions seeded) | no (no permissions seeded) | role.manage |
| GET | `/api/v1/admin/roles/:roleCode` | - | - | yes | no (no permissions seeded) | no (no permissions seeded) | no (no permissions seeded) | role.manage |
| GET | `/api/v1/admin/roles` | - | - | yes | no (no permissions seeded) | no (no permissions seeded) | no (no permissions seeded) | role.manage |
| GET | `/api/v1/admin/service-areas/:areaId` | - | - | yes | no (no permissions seeded) | no (no permissions seeded) | no (no permissions seeded) | area.manage |
| PATCH | `/api/v1/admin/service-areas/:areaId` | - | - | yes | no (no permissions seeded) | no (no permissions seeded) | no (no permissions seeded) | area.manage |
| GET | `/api/v1/admin/service-areas` | - | - | yes | no (no permissions seeded) | no (no permissions seeded) | no (no permissions seeded) | area.manage |
| POST | `/api/v1/admin/service-areas` | - | - | yes | no (no permissions seeded) | no (no permissions seeded) | no (no permissions seeded) | area.manage |
| GET | `/api/v1/admin/service-categories/:categoryId` | - | - | yes | no (no permissions seeded) | no (no permissions seeded) | no (no permissions seeded) | category.manage |
| PATCH | `/api/v1/admin/service-categories/:categoryId` | - | - | yes | no (no permissions seeded) | no (no permissions seeded) | no (no permissions seeded) | category.manage |
| GET | `/api/v1/admin/service-categories` | - | - | yes | no (no permissions seeded) | no (no permissions seeded) | no (no permissions seeded) | category.manage |
| POST | `/api/v1/admin/service-categories` | - | - | yes | no (no permissions seeded) | no (no permissions seeded) | no (no permissions seeded) | category.manage |
| PATCH | `/api/v1/admin/support/categories/:categoryId` | - | - | yes | no (no permissions seeded) | no (no permissions seeded) | no (no permissions seeded) | support.category.manage |
| GET | `/api/v1/admin/support/categories` | - | - | yes | no (no permissions seeded) | no (no permissions seeded) | no (no permissions seeded) | support.view |
| POST | `/api/v1/admin/support/categories` | - | - | yes | no (no permissions seeded) | no (no permissions seeded) | no (no permissions seeded) | support.category.manage |
| POST | `/api/v1/admin/support/tickets/:ticketId/assign` | - | - | yes | no (no permissions seeded) | no (no permissions seeded) | no (no permissions seeded) | support.manage |
| POST | `/api/v1/admin/support/tickets/:ticketId/close` | - | - | yes | no (no permissions seeded) | no (no permissions seeded) | no (no permissions seeded) | support.manage |
| POST | `/api/v1/admin/support/tickets/:ticketId/escalate` | - | - | yes | no (no permissions seeded) | no (no permissions seeded) | no (no permissions seeded) | support.manage |
| POST | `/api/v1/admin/support/tickets/:ticketId/priority` | - | - | yes | no (no permissions seeded) | no (no permissions seeded) | no (no permissions seeded) | support.manage |
| GET | `/api/v1/admin/support/tickets/:ticketId` | - | - | yes | no (no permissions seeded) | no (no permissions seeded) | no (no permissions seeded) | support.view |
| GET | `/api/v1/admin/support/tickets` | - | - | yes | no (no permissions seeded) | no (no permissions seeded) | no (no permissions seeded) | support.view |
| PUT | `/api/v1/admin/users/:userId/role` | - | - | yes | no (no permissions seeded) | no (no permissions seeded) | no (no permissions seeded) | admin.manage_users |
| PATCH | `/api/v1/admin/users/:userId/status` | - | - | yes | no (no permissions seeded) | no (no permissions seeded) | no (no permissions seeded) | user.status.manage |
| GET | `/api/v1/admin/users/:userId` | - | - | yes | no (no permissions seeded) | no (no permissions seeded) | no (no permissions seeded) | user.view |
| GET | `/api/v1/admin/users` | - | - | yes | no (no permissions seeded) | no (no permissions seeded) | no (no permissions seeded) | user.view |
| POST | `/api/v1/admin/users` | - | - | yes | no (no permissions seeded) | no (no permissions seeded) | no (no permissions seeded) | admin.manage_users |
| POST | `/api/v1/admin/verification/checks/:checkId/approve` | - | - | yes | no (no permissions seeded) | no (no permissions seeded) | no (no permissions seeded) | verification.decide |
| POST | `/api/v1/admin/verification/checks/:checkId/recheck` | - | - | yes | no (no permissions seeded) | no (no permissions seeded) | no (no permissions seeded) | verification.decide |
| POST | `/api/v1/admin/verification/checks/:checkId/reject` | - | - | yes | no (no permissions seeded) | no (no permissions seeded) | no (no permissions seeded) | verification.decide |
| POST | `/api/v1/admin/verification/checks/:checkId/start-review` | - | - | yes | no (no permissions seeded) | no (no permissions seeded) | no (no permissions seeded) | verification.review |
| GET | `/api/v1/admin/verification/documents/:documentId/link` | - | - | yes | no (no permissions seeded) | no (no permissions seeded) | no (no permissions seeded) | verification.document.view |
| GET | `/api/v1/admin/verification/queue` | - | - | yes | no (no permissions seeded) | no (no permissions seeded) | no (no permissions seeded) | verification.review |
| GET | `/api/v1/admin/verification/requirements` | - | - | yes | no (no permissions seeded) | no (no permissions seeded) | no (no permissions seeded) | verification.review |
| PUT | `/api/v1/admin/verification/requirements` | - | - | yes | no (no permissions seeded) | no (no permissions seeded) | no (no permissions seeded) | verification.configure |
| GET | `/api/v1/admin/workers/:workerId/availability` | - | - | yes | no (no permissions seeded) | no (no permissions seeded) | no (no permissions seeded) | worker.view |
| PATCH | `/api/v1/admin/workers/:workerId/availability` | - | - | yes | no (no permissions seeded) | no (no permissions seeded) | no (no permissions seeded) | worker.manage |
| PUT | `/api/v1/admin/workers/:workerId/categories` | - | - | yes | no (no permissions seeded) | no (no permissions seeded) | no (no permissions seeded) | worker.manage |
| GET | `/api/v1/admin/workers/:workerId/verification` | - | - | yes | no (no permissions seeded) | no (no permissions seeded) | no (no permissions seeded) | verification.review |
| GET | `/api/v1/admin/workers/:workerId` | - | - | yes | no (no permissions seeded) | no (no permissions seeded) | no (no permissions seeded) | worker.view |
| PATCH | `/api/v1/admin/workers/:workerId` | - | - | yes | no (no permissions seeded) | no (no permissions seeded) | no (no permissions seeded) | worker.manage |
| GET | `/api/v1/admin/workers` | - | - | yes | no (no permissions seeded) | no (no permissions seeded) | no (no permissions seeded) | worker.view |
| POST | `/api/v1/attendance/bookings/:bookingId/exceptions` | yes | - | - | - | - | - | CUSTOMER |
| GET | `/api/v1/attendance/bookings/:bookingId` | yes | - | - | - | - | - | CUSTOMER |
| POST | `/api/v1/auth/admin/login` | public | public | public | public | public | public | any signed-in |
| PUT | `/api/v1/auth/device-token` | yes | yes | - | - | - | - | CUSTOMER, WORKER |
| POST | `/api/v1/auth/logout` | yes | yes | - | - | - | - | any signed-in |
| POST | `/api/v1/auth/otp/request` | public | public | public | public | public | public | any signed-in |
| POST | `/api/v1/auth/otp/verify` | public | public | public | public | public | public | any signed-in |
| DELETE | `/api/v1/auth/sessions/:sessionId` | yes | yes | - | - | - | - | any signed-in |
| GET | `/api/v1/auth/sessions` | yes | yes | - | - | - | - | any signed-in |
| POST | `/api/v1/auth/token/refresh` | public | public | public | public | public | public | any signed-in |
| POST | `/api/v1/bookings/:bookingId/:action` | yes | - | - | - | - | - | CUSTOMER |
| GET | `/api/v1/bookings/:bookingId` | yes | - | - | - | - | - | CUSTOMER |
| GET | `/api/v1/bookings` | yes | - | - | - | - | - | CUSTOMER |
| POST | `/api/v1/bookings` | yes | - | - | - | - | - | CUSTOMER |
| PUT | `/api/v1/customers/me/addresses/:addressId/default` | yes | - | - | - | - | - | CUSTOMER |
| DELETE | `/api/v1/customers/me/addresses/:addressId` | yes | - | - | - | - | - | CUSTOMER |
| GET | `/api/v1/customers/me/addresses/:addressId` | yes | - | - | - | - | - | CUSTOMER |
| PATCH | `/api/v1/customers/me/addresses/:addressId` | yes | - | - | - | - | - | CUSTOMER |
| GET | `/api/v1/customers/me/addresses` | yes | - | - | - | - | - | CUSTOMER |
| POST | `/api/v1/customers/me/addresses` | yes | - | - | - | - | - | CUSTOMER |
| GET | `/api/v1/customers/me` | yes | - | - | - | - | - | CUSTOMER |
| PATCH | `/api/v1/customers/me` | yes | - | - | - | - | - | CUSTOMER |
| POST | `/api/v1/customers/me` | yes | - | - | - | - | - | CUSTOMER |
| POST | `/api/v1/payments/:paymentId/verify` | yes | - | - | - | - | - | CUSTOMER |
| GET | `/api/v1/payments/:paymentId` | yes | - | - | - | - | - | CUSTOMER |
| GET | `/api/v1/payments` | yes | - | - | - | - | - | CUSTOMER |
| POST | `/api/v1/payments` | yes | - | - | - | - | - | CUSTOMER |
| GET | `/api/v1/ratings/:ratingId` | yes | - | - | - | - | - | CUSTOMER |
| GET | `/api/v1/ratings/bookings/:bookingId` | yes | - | - | - | - | - | CUSTOMER |
| GET | `/api/v1/ratings` | yes | - | - | - | - | - | CUSTOMER |
| POST | `/api/v1/ratings` | yes | - | - | - | - | - | CUSTOMER |
| POST | `/api/v1/replacement-requests/:requestId/cancel` | yes | - | - | - | - | - | CUSTOMER |
| POST | `/api/v1/replacement-requests/:requestId/select` | yes | - | - | - | - | - | CUSTOMER |
| GET | `/api/v1/replacement-requests/:requestId` | yes | - | - | - | - | - | CUSTOMER |
| GET | `/api/v1/replacement-requests` | yes | - | - | - | - | - | CUSTOMER |
| POST | `/api/v1/replacement-requests` | yes | - | - | - | - | - | CUSTOMER |
| GET | `/api/v1/search/workers` | yes | - | - | - | - | - | CUSTOMER |
| GET | `/api/v1/service-areas/:areaId` | yes | yes | - | - | - | - | any signed-in |
| GET | `/api/v1/service-areas` | yes | yes | - | - | - | - | any signed-in |
| GET | `/api/v1/service-categories/:categoryId` | yes | yes | - | - | - | - | any signed-in |
| GET | `/api/v1/service-categories` | yes | yes | - | - | - | - | any signed-in |
| GET | `/api/v1/support/categories` | yes | yes | - | - | - | - | CUSTOMER, WORKER |
| GET | `/api/v1/support/tickets/:ticketId` | yes | yes | - | - | - | - | CUSTOMER, WORKER |
| GET | `/api/v1/support/tickets` | yes | yes | - | - | - | - | CUSTOMER, WORKER |
| POST | `/api/v1/support/tickets` | yes | yes | - | - | - | - | CUSTOMER, WORKER |
| GET | `/api/v1/users/me` | yes | yes | - | - | - | - | any signed-in |
| POST | `/api/v1/webhooks/payments` | public | public | public | public | public | public | any signed-in |
| GET | `/api/v1/workers/me/attendance/bookings/:bookingId` | - | yes | - | - | - | - | WORKER |
| POST | `/api/v1/workers/me/attendance/bookings/:bookingId` | - | yes | - | - | - | - | WORKER |
| GET | `/api/v1/workers/me/availability` | - | yes | - | - | - | - | WORKER |
| PATCH | `/api/v1/workers/me/availability` | - | yes | - | - | - | - | WORKER |
| POST | `/api/v1/workers/me/bookings/:bookingId/:action` | - | yes | - | - | - | - | WORKER |
| GET | `/api/v1/workers/me/bookings/:bookingId` | - | yes | - | - | - | - | WORKER |
| GET | `/api/v1/workers/me/bookings` | - | yes | - | - | - | - | WORKER |
| PUT | `/api/v1/workers/me/categories` | - | yes | - | - | - | - | WORKER |
| GET | `/api/v1/workers/me/ratings/summary` | - | yes | - | - | - | - | WORKER |
| GET | `/api/v1/workers/me/ratings` | - | yes | - | - | - | - | WORKER |
| POST | `/api/v1/workers/me/submit` | - | yes | - | - | - | - | WORKER |
| POST | `/api/v1/workers/me/verification/checks/:checkType/documents` | - | yes | - | - | - | - | WORKER |
| POST | `/api/v1/workers/me/verification/checks/:checkType/submit` | - | yes | - | - | - | - | WORKER |
| POST | `/api/v1/workers/me/verification/documents/:documentId/confirm` | - | yes | - | - | - | - | WORKER |
| GET | `/api/v1/workers/me/verification` | - | yes | - | - | - | - | WORKER |
| GET | `/api/v1/workers/me` | - | yes | - | - | - | - | WORKER |
| PATCH | `/api/v1/workers/me` | - | yes | - | - | - | - | WORKER |
| POST | `/api/v1/workers/me` | - | yes | - | - | - | - | WORKER |
| GET | `/health/live` | public | public | public | public | public | public | any signed-in |
| GET | `/health/ready` | public | public | public | public | public | public | any signed-in |

`yes (no permission needed)` = the dashboard only. `public` = authenticated by something other than a session (OTP, credentials, refresh token, gateway signature, health probe).
