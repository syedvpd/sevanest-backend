# Backend performance test results

Generated 2026-10-14T10:34:26.233Z. **Performance, not load**: one client, strictly sequential, 15 full iterations of every module's lifecycle.

## How it was measured

* Target: the real API on a real HTTP port (loopback), NestJS 11, on a fresh local PostgreSQL 17 and Redis 7 (Docker), same machine as the client. Numbers include JSON parsing, guards, validation, database and audit writes; they exclude network latency and TLS, so a hosted deployment adds its round trip.
* Machine: 11th Gen Intel(R) Core(TM) i7-1185G7 @ 3.00GHz, 8 logical CPUs, 16 GB RAM, Node v24.21.0, win32.
* Each iteration creates fresh users and data and walks the modules in lifecycle order: create, read, list, update, state changes, delete. The same operation is therefore hit once per iteration.
* **1st hit** = iteration 1 (first call after the process started: cold caches, query plans, JIT). **2nd hit** = iteration 2. p50/p95/p99, min, avg, max use all 15 samples (nearest-rank; with 15 samples p95 and p99 equal the slowest sample).
* Times are end-to-end milliseconds for the HTTP call including reading the whole body.

## Summary

| | value |
|---|---|
| Operations in the API | 267 |
| Operations exercised | 265 (99.3 %) |
| Requests timed | 4416 |
| Overall p50 / p95 / p99 (all requests) | 24.4 / 75.3 / 435 ms |
| Warm requests only (iteration 3 onwards) p50 / p95 / p99 | 24.3 / 75.2 / 435 ms |
| 1st-hit median across operations | 27.4 ms |
| 2nd-hit median across operations | 23.4 ms |
| Operations with p95 above 100 ms | 18 |
| Operations with p95 above 250 ms | 4 |
| Operations whose status was not the expected one | 0 |

### Reading the numbers

* Operations whose median is above 300 ms: POST /auth/admin/login, POST /admin/users, POST /admin/users/{userId}/password-reset, POST /admin/account/password. These verify or create a password hash, which is deliberately expensive; they set the overall p99.
* Without them: p50 / p95 / p99 = 24.1 / 70.2 / 98.5 ms over 4356 requests.
* Cold start is small: the 1st-hit median across operations is 27.4 ms against 23.4 ms for the 2nd hit; only a few operations lose more than 20 ms on their first call (table below).
* Read endpoints (GET) dominate the sample and answer in a few tens of milliseconds; the slowest non-hashing operations are state changes that write several rows, send outbox events and audit records in one transaction (interviews, bookings, replacements, payments).
* Run history: an earlier identical run was discarded because the host machine stalled for about 4 minutes during iteration 13 (one call took 266 s and two requests got 500 from connections broken by the stall; the database and Redis logs show no error). This is the clean rerun: no failed iteration, no unexpected status, no sample above 3 s.

### Slowest 15 operations by p95 (ms)

| Operation | 1st | 2nd | p50 | p95 | max |
|---|---|---|---|---|---|
| POST /admin/account/password | 951 | 845 | 885 | 1107 | 1107 |
| POST /admin/users/{userId}/password-reset | 478 | 431 | 449 | 684 | 684 |
| POST /admin/users | 473 | 436 | 449 | 609 | 609 |
| POST /auth/admin/login | 522 | 410 | 439 | 583 | 583 |
| POST /admin/interviews/{interviewId}/reschedule | 80.0 | 62.4 | 62.4 | 194 | 194 |
| POST /replacement-requests/{requestId}/select | 105 | 103 | 102 | 157 | 157 |
| POST /admin/interviews/{interviewId}/confirm | 100 | 53.3 | 55.9 | 155 | 155 |
| POST /admin/bookings/{bookingId}/{action} | 86.0 | 67.1 | 67.1 | 144 | 144 |
| POST /admin/bookings | 80.7 | 73.3 | 80.7 | 136 | 136 |
| GET /admin/reports/worker-utilization | 21.3 | 18.2 | 28.2 | 134 | 134 |
| POST /bookings/rebook | 125 | 92.8 | 75.2 | 125 | 125 |
| GET /admin/system/readiness | 80.1 | 94.4 | 80.1 | 124 | 124 |
| PATCH /admin/service-areas/{areaId} | 59.7 | 30.3 | 32.7 | 120 | 120 |
| POST /bookings | 143 | 80.3 | 67.9 | 111 | 143 |
| POST /admin/interviews/{interviewId}/accept-proposal | 98.4 | 53.9 | 56.1 | 106 | 106 |

### Largest cold-start penalty (1st hit minus p50, ms)

| Operation | 1st | 2nd | p50 | p95 | max |
|---|---|---|---|---|---|
| POST /auth/admin/login | 522 | 410 | 439 | 583 | 583 |
| POST /bookings | 143 | 80.3 | 67.9 | 111 | 143 |
| POST /admin/account/password | 951 | 845 | 885 | 1107 | 1107 |
| POST /bookings/rebook | 125 | 92.8 | 75.2 | 125 | 125 |
| POST /admin/payments/{paymentId}/refund | 95.3 | 67.7 | 46.0 | 95.3 | 95.3 |
| POST /admin/interviews/{interviewId}/confirm | 100 | 53.3 | 55.9 | 155 | 155 |
| GET /search/workers/{workerId}/slots | 66.7 | 25.3 | 23.6 | 66.7 | 66.7 |
| PATCH /admin/service-categories/{categoryId} | 74.7 | 29.0 | 31.8 | 74.7 | 74.7 |
| POST /admin/interviews/{interviewId}/accept-proposal | 98.4 | 53.9 | 56.1 | 106 | 106 |
| GET /customers/me/home | 52.6 | 18.4 | 14.4 | 52.6 | 52.6 |

## Every operation, by module

Columns are milliseconds. "Status" lists the HTTP statuses seen and how often (e.g. 200x15).

### Account

| Operation | n | 1st | 2nd | min | avg | p50 | p95 | p99 | max | Status |
|---|---|---|---|---|---|---|---|---|---|---|
| POST /me/deletion-request | 15 | 28.9 | 24.6 | 19.7 | 29.3 | 28.9 | 45.4 | 45.4 | 45.4 | 201x15 |
| GET /me/deletion-request | 15 | 6.78 | 5.71 | 5.71 | 8.58 | 8.38 | 13.1 | 13.1 | 13.1 | 200x15 |
| DELETE /me/deletion-request | 15 | 20.1 | 22.3 | 13.0 | 21.8 | 20.1 | 35.7 | 35.7 | 35.7 | 204x15 |

### Admin - Account deletion

| Operation | n | 1st | 2nd | min | avg | p50 | p95 | p99 | max | Status |
|---|---|---|---|---|---|---|---|---|---|---|
| GET /admin/deletion-requests | 15 | 16.4 | 22.4 | 12.2 | 17.5 | 16.6 | 23.3 | 23.3 | 23.3 | 200x15 |

### Admin - Alerts

| Operation | n | 1st | 2nd | min | avg | p50 | p95 | p99 | max | Status |
|---|---|---|---|---|---|---|---|---|---|---|
| GET /admin/alerts | 15 | 33.1 | 30.6 | 29.6 | 42.4 | 31.2 | 104 | 104 | 104 | 200x15 |
| GET /admin/alerts/summary | 15 | 28.5 | 25.6 | 22.7 | 39.0 | 28.5 | 88.8 | 88.8 | 88.8 | 200x15 |
| POST /admin/alerts/{alertId}/acknowledge | 15 | 47.3 | 41.3 | 32.2 | 48.8 | 43.1 | 94.1 | 94.1 | 94.1 | 200x15 |
| POST /admin/alerts/{alertId}/resolve | 15 | 40.7 | 34.3 | 30.1 | 43.3 | 36.9 | 87.7 | 87.7 | 87.7 | 200x15 |

### Admin - Attendance

| Operation | n | 1st | 2nd | min | avg | p50 | p95 | p99 | max | Status |
|---|---|---|---|---|---|---|---|---|---|---|
| POST /admin/attendance/bookings/{bookingId} | 15 | 45.3 | 45.3 | 30.7 | 39.1 | 38.3 | 48.8 | 48.8 | 48.8 | 201x15 |
| GET /admin/attendance/bookings/{bookingId} | 15 | 21.3 | 31.8 | 17.1 | 22.5 | 20.3 | 31.8 | 31.8 | 31.8 | 200x15 |
| GET /admin/attendance/bookings/{bookingId}/summary | 15 | 17.2 | 21.6 | 13.4 | 18.0 | 17.2 | 22.9 | 22.9 | 22.9 | 200x15 |
| PATCH /admin/attendance/{attendanceId} | 15 | 45.7 | 53.6 | 32.8 | 44.7 | 39.5 | 83.4 | 83.4 | 83.4 | 200x15 |

### Admin - Audit

| Operation | n | 1st | 2nd | min | avg | p50 | p95 | p99 | max | Status |
|---|---|---|---|---|---|---|---|---|---|---|
| GET /admin/audit-logs | 15 | 24.4 | 24.7 | 24.4 | 30.4 | 27.1 | 41.9 | 41.9 | 41.9 | 200x15 |

### Admin - Bookings

| Operation | n | 1st | 2nd | min | avg | p50 | p95 | p99 | max | Status |
|---|---|---|---|---|---|---|---|---|---|---|
| GET /admin/bookings | 15 | 43.0 | 24.7 | 15.9 | 22.5 | 19.4 | 43.0 | 43.0 | 43.0 | 200x15 |
| GET /admin/bookings/{bookingId} | 15 | 33.2 | 28.5 | 16.6 | 21.1 | 19.2 | 33.2 | 33.2 | 33.2 | 200x15 |
| GET /admin/bookings/{bookingId}/replacement-chain | 15 | 38.5 | 26.7 | 16.3 | 22.7 | 20.5 | 38.5 | 38.5 | 38.5 | 200x15 |
| POST /admin/bookings | 15 | 80.7 | 73.3 | 70.4 | 85.9 | 80.7 | 136 | 136 | 136 | 201x15 |
| POST /admin/bookings/{bookingId}/{action} | 15 | 86.0 | 67.1 | 55.1 | 77.3 | 67.1 | 144 | 144 | 144 | 200x15 |
| POST /admin/bookings/{bookingId}/slot-proposal/{answer} | 15 | 28.3 | 25.5 | 18.8 | 26.5 | 25.5 | 35.2 | 35.2 | 35.2 | 409x15 |

### Admin - Customers

| Operation | n | 1st | 2nd | min | avg | p50 | p95 | p99 | max | Status |
|---|---|---|---|---|---|---|---|---|---|---|
| GET /admin/customers | 15 | 17.5 | 17.8 | 13.6 | 18.5 | 17.7 | 25.5 | 25.5 | 25.5 | 200x15 |
| GET /admin/customers/{customerId} | 15 | 16.5 | 15.3 | 14.5 | 18.6 | 16.5 | 25.0 | 25.0 | 25.0 | 200x15 |
| PATCH /admin/customers/{customerId}/verification-status | 15 | 37.4 | 25.4 | 24.4 | 35.4 | 35.2 | 52.4 | 52.4 | 52.4 | 200x15 |
| POST /admin/customers/{customerId}/notes | 15 | 30.0 | 29.7 | 23.4 | 31.6 | 30.0 | 44.8 | 44.8 | 44.8 | 201x15 |
| GET /admin/customers/{customerId}/notes | 15 | 17.6 | 16.8 | 13.8 | 18.1 | 17.0 | 27.5 | 27.5 | 27.5 | 200x15 |

### Admin - Dashboard

| Operation | n | 1st | 2nd | min | avg | p50 | p95 | p99 | max | Status |
|---|---|---|---|---|---|---|---|---|---|---|
| GET /admin/dashboard | 15 | 41.5 | 31.8 | 26.0 | 34.2 | 33.9 | 41.5 | 41.5 | 41.5 | 200x15 |

### Admin - Interviews and trials

| Operation | n | 1st | 2nd | min | avg | p50 | p95 | p99 | max | Status |
|---|---|---|---|---|---|---|---|---|---|---|
| GET /admin/bookings/{bookingId}/interviews | 15 | 27.7 | 19.5 | 12.8 | 17.8 | 16.0 | 28.4 | 28.4 | 28.4 | 200x15 |
| GET /admin/interviews | 15 | 26.4 | 25.1 | 12.8 | 17.9 | 15.1 | 26.9 | 26.9 | 26.9 | 200x15 |
| GET /admin/interviews/{interviewId} | 15 | 45.7 | 46.3 | 19.2 | 26.0 | 22.8 | 46.3 | 46.3 | 46.3 | 200x15 |
| POST /admin/interviews | 15 | 90.4 | 47.1 | 40.0 | 58.4 | 52.6 | 91.1 | 91.1 | 91.1 | 201x15 |
| POST /admin/interviews/{interviewId}/confirm | 15 | 100 | 53.3 | 47.2 | 72.5 | 55.9 | 155 | 155 | 155 | 200x15 |
| POST /admin/interviews/{interviewId}/reschedule | 15 | 80.0 | 62.4 | 45.5 | 72.8 | 62.4 | 194 | 194 | 194 | 200x15 |
| POST /admin/interviews/{interviewId}/reject-proposal | 15 | 73.4 | 55.3 | 39.8 | 52.7 | 49.0 | 73.4 | 73.4 | 73.4 | 200x15 |
| POST /admin/interviews/{interviewId}/accept-proposal | 15 | 98.4 | 53.9 | 46.4 | 71.1 | 56.1 | 106 | 106 | 106 | 200x15 |
| POST /admin/interviews/{interviewId}/complete | 15 | 69.1 | 62.3 | 46.0 | 66.5 | 63.0 | 94.9 | 94.9 | 94.9 | 200x15 |
| POST /admin/interviews/{interviewId}/cancel | 15 | 45.3 | 44.1 | 38.1 | 48.7 | 45.3 | 71.8 | 71.8 | 71.8 | 200x15 |

### Admin - Matching

| Operation | n | 1st | 2nd | min | avg | p50 | p95 | p99 | max | Status |
|---|---|---|---|---|---|---|---|---|---|---|
| POST /admin/matching/candidates | 15 | 63.2 | 61.0 | 50.0 | 72.0 | 68.8 | 97.0 | 97.0 | 97.0 | 200x15 |

### Admin - Notifications

| Operation | n | 1st | 2nd | min | avg | p50 | p95 | p99 | max | Status |
|---|---|---|---|---|---|---|---|---|---|---|
| POST /admin/notification-templates | 15 | 45.8 | 25.4 | 23.0 | 32.9 | 34.5 | 45.8 | 45.8 | 45.8 | 201x15 |
| GET /admin/notification-templates | 15 | 25.9 | 17.0 | 14.2 | 19.9 | 17.0 | 32.4 | 32.4 | 32.4 | 200x15 |
| GET /admin/notification-templates/{templateId} | 15 | 23.9 | 14.3 | 11.7 | 17.6 | 15.9 | 26.6 | 26.6 | 26.6 | 200x15 |
| PATCH /admin/notification-templates/{templateId} | 15 | 43.1 | 28.4 | 24.4 | 35.0 | 30.2 | 64.2 | 64.2 | 64.2 | 200x15 |
| GET /admin/notification-events | 15 | 13.6 | 11.8 | 9.23 | 13.2 | 12.3 | 23.9 | 23.9 | 23.9 | 200x15 |
| GET /admin/notifications | 15 | 18.7 | 15.1 | 13.6 | 19.5 | 16.0 | 27.9 | 27.9 | 27.9 | 200x15 |
| POST /admin/notifications/{notificationId}/retry | 15 | 23.6 | 20.2 | 19.3 | 25.4 | 21.2 | 40.0 | 40.0 | 40.0 | 409x15 |
| GET /admin/notifications/health | 15 | 17.3 | 13.8 | 13.5 | 17.5 | 15.5 | 25.6 | 25.6 | 25.6 | 200x15 |

### Admin - Payments

| Operation | n | 1st | 2nd | min | avg | p50 | p95 | p99 | max | Status |
|---|---|---|---|---|---|---|---|---|---|---|
| GET /admin/fees | 15 | 17.7 | 14.5 | 11.2 | 15.1 | 14.5 | 20.9 | 20.9 | 20.9 | 200x15 |
| PUT /admin/fees/booking-fee | 15 | 41.6 | 31.5 | 22.0 | 33.2 | 31.8 | 48.7 | 48.7 | 48.7 | 200x15 |
| PUT /admin/fees/{code} | 15 | 39.1 | 29.9 | 24.2 | 32.5 | 29.9 | 42.1 | 42.1 | 42.1 | 200x15 |
| GET /admin/payments | 15 | 41.9 | 23.4 | 14.2 | 18.8 | 16.4 | 41.9 | 41.9 | 41.9 | 200x15 |
| GET /admin/payments/{paymentId} | 15 | 25.3 | 25.0 | 10.5 | 16.2 | 15.3 | 25.3 | 25.3 | 25.3 | 200x15 |
| POST /admin/payments/{paymentId}/reconcile | 15 | 63.8 | 58.5 | 26.7 | 39.3 | 37.8 | 63.8 | 63.8 | 63.8 | 200x15 |
| GET /admin/payments-export | 15 | 55.2 | 43.8 | 22.9 | 31.5 | 28.0 | 55.2 | 55.2 | 55.2 | 200x15 |
| POST /admin/payments/{paymentId}/refund | 15 | 95.3 | 67.7 | 41.3 | 55.2 | 46.0 | 95.3 | 95.3 | 95.3 | 200x15 |
| GET /admin/payment-exceptions | 15 | 35.4 | 26.0 | 11.1 | 19.3 | 18.0 | 35.4 | 35.4 | 35.4 | 200x15 |
| GET /admin/payment-recovery/summary | 15 | 37.4 | 27.1 | 14.5 | 24.2 | 21.6 | 37.9 | 37.9 | 37.9 | 200x15 |

### Admin - Ratings

| Operation | n | 1st | 2nd | min | avg | p50 | p95 | p99 | max | Status |
|---|---|---|---|---|---|---|---|---|---|---|
| GET /admin/ratings | 15 | 25.7 | 16.3 | 13.4 | 18.0 | 16.6 | 27.7 | 27.7 | 27.7 | 200x15 |
| GET /admin/ratings/{ratingId} | 15 | 21.5 | 15.4 | 10.6 | 16.2 | 15.4 | 21.5 | 21.5 | 21.5 | 200x15 |
| POST /admin/ratings/{ratingId}/hide | 15 | 51.3 | 36.5 | 30.3 | 39.0 | 35.2 | 53.3 | 53.3 | 53.3 | 200x15 |
| POST /admin/ratings/{ratingId}/unhide | 15 | 47.4 | 47.2 | 31.1 | 41.2 | 37.4 | 59.7 | 59.7 | 59.7 | 200x15 |
| GET /admin/ratings/workers/{workerId}/summary | 15 | 16.0 | 19.8 | 10.7 | 16.3 | 15.4 | 23.6 | 23.6 | 23.6 | 200x15 |

### Admin - Replacements

| Operation | n | 1st | 2nd | min | avg | p50 | p95 | p99 | max | Status |
|---|---|---|---|---|---|---|---|---|---|---|
| GET /admin/replacement-requests | 15 | 21.2 | 18.7 | 17.8 | 23.2 | 21.9 | 35.1 | 35.1 | 35.1 | 200x15 |
| GET /admin/replacement-requests/{requestId} | 15 | 25.4 | 17.7 | 13.9 | 18.6 | 17.7 | 25.4 | 25.4 | 25.4 | 200x15 |
| GET /admin/replacement-requests/{requestId}/candidates | 15 | 62.9 | 60.9 | 60.1 | 71.0 | 72.6 | 80.2 | 80.2 | 80.2 | 200x15 |
| POST /admin/replacement-requests/{requestId}/reject | 15 | 77.6 | 63.9 | 59.9 | 70.9 | 69.9 | 90.9 | 90.9 | 90.9 | 200x15 |
| POST /admin/replacement-requests/{requestId}/approve | 30 | 50.6 | 50.1 | 39.8 | 58.4 | 54.3 | 82.7 | 84.2 | 84.2 | 200x30 |
| POST /admin/replacement-requests/{requestId}/select | 15 | 94.3 | 59.7 | 48.5 | 71.1 | 63.4 | 94.3 | 94.3 | 94.3 | 409x15 |

### Admin - Reports

| Operation | n | 1st | 2nd | min | avg | p50 | p95 | p99 | max | Status |
|---|---|---|---|---|---|---|---|---|---|---|
| GET /admin/reports | 15 | 12.8 | 9.08 | 9.08 | 13.6 | 12.8 | 23.1 | 23.1 | 23.1 | 200x15 |
| GET /admin/reports/new-customers | 15 | 20.6 | 18.3 | 17.2 | 23.4 | 21.1 | 34.6 | 34.6 | 34.6 | 200x15 |
| GET /admin/reports/worker-registrations | 15 | 23.8 | 25.7 | 19.3 | 27.9 | 23.8 | 43.7 | 43.7 | 43.7 | 200x15 |
| GET /admin/reports/booking-funnel | 15 | 23.1 | 23.1 | 20.5 | 25.9 | 23.1 | 47.0 | 47.0 | 47.0 | 200x15 |
| GET /admin/reports/demand-by-category | 15 | 19.6 | 20.8 | 17.0 | 22.9 | 21.2 | 41.1 | 41.1 | 41.1 | 200x15 |
| GET /admin/reports/demand-by-area | 15 | 25.7 | 20.6 | 17.8 | 24.2 | 21.4 | 44.0 | 44.0 | 44.0 | 200x15 |
| GET /admin/reports/worker-utilization | 15 | 21.3 | 18.2 | 18.2 | 46.2 | 28.2 | 134 | 134 | 134 | 200x15 |
| GET /admin/reports/interview-conversion | 15 | 18.1 | 17.0 | 16.6 | 25.0 | 18.4 | 59.4 | 59.4 | 59.4 | 200x15 |
| GET /admin/reports/cancellation-rate | 15 | 17.5 | 17.2 | 14.5 | 22.1 | 18.4 | 31.6 | 31.6 | 31.6 | 200x15 |
| GET /admin/reports/replacement-rate | 15 | 33.5 | 19.1 | 18.3 | 26.1 | 25.7 | 42.1 | 42.1 | 42.1 | 200x15 |
| GET /admin/reports/payment-collections | 15 | 24.9 | 26.8 | 17.3 | 26.7 | 25.4 | 49.3 | 49.3 | 49.3 | 200x15 |
| GET /admin/reports/support-tickets | 15 | 27.9 | 24.2 | 20.0 | 30.4 | 29.6 | 43.3 | 43.3 | 43.3 | 200x15 |
| GET /admin/reports/top-rated-workers | 15 | 22.0 | 25.2 | 18.4 | 26.1 | 25.2 | 38.0 | 38.0 | 38.0 | 200x15 |
| GET /admin/reports/repeat-customers | 15 | 21.0 | 28.6 | 18.4 | 26.2 | 26.4 | 33.0 | 33.0 | 33.0 | 200x15 |
| GET /admin/reports/export/{report} | 15 | 26.9 | 24.6 | 22.3 | 30.2 | 29.1 | 40.4 | 40.4 | 40.4 | 200x15 |

### Admin - Roles

| Operation | n | 1st | 2nd | min | avg | p50 | p95 | p99 | max | Status |
|---|---|---|---|---|---|---|---|---|---|---|
| GET /admin/roles | 15 | 33.4 | 16.9 | 16.4 | 21.3 | 20.6 | 33.4 | 33.4 | 33.4 | 200x15 |
| GET /admin/permissions | 15 | 19.7 | 12.2 | 11.8 | 16.5 | 16.0 | 24.9 | 24.9 | 24.9 | 200x15 |
| GET /admin/roles/{roleCode} | 15 | 34.4 | 16.9 | 15.6 | 21.8 | 21.3 | 34.4 | 34.4 | 34.4 | 200x15 |
| PUT /admin/roles/{roleCode}/permissions | 15 | 72.5 | 39.4 | 33.2 | 48.3 | 39.5 | 89.8 | 89.8 | 89.8 | 200x15 |

### Admin - Safety

| Operation | n | 1st | 2nd | min | avg | p50 | p95 | p99 | max | Status |
|---|---|---|---|---|---|---|---|---|---|---|
| GET /admin/safety/reports | 15 | 16.1 | 14.9 | 13.3 | 16.8 | 15.3 | 27.6 | 27.6 | 27.6 | 200x15 |
| GET /admin/safety/blocks | 15 | 18.2 | 15.5 | 11.2 | 15.2 | 14.8 | 24.3 | 24.3 | 24.3 | 200x15 |
| POST /admin/safety/blocks | 15 | 33.0 | 33.9 | 29.9 | 35.9 | 33.5 | 55.1 | 55.1 | 55.1 | 200x15 |
| DELETE /admin/safety/blocks/{blockId} | 15 | 34.0 | 24.5 | 22.3 | 28.4 | 27.2 | 39.3 | 39.3 | 39.3 | 204x15 |

### Admin - Service Areas

| Operation | n | 1st | 2nd | min | avg | p50 | p95 | p99 | max | Status |
|---|---|---|---|---|---|---|---|---|---|---|
| POST /admin/service-areas | 15 | 41.4 | 27.5 | 23.8 | 35.7 | 31.3 | 60.1 | 60.1 | 60.1 | 201x15 |
| GET /admin/service-areas | 15 | 20.0 | 13.9 | 12.8 | 20.6 | 16.7 | 63.3 | 63.3 | 63.3 | 200x15 |
| GET /admin/service-areas/{areaId} | 15 | 19.8 | 13.1 | 12.2 | 22.2 | 14.8 | 79.2 | 79.2 | 79.2 | 200x15 |
| PATCH /admin/service-areas/{areaId} | 15 | 59.7 | 30.3 | 24.1 | 44.0 | 32.7 | 120 | 120 | 120 | 200x15 |

### Admin - Service Categories

| Operation | n | 1st | 2nd | min | avg | p50 | p95 | p99 | max | Status |
|---|---|---|---|---|---|---|---|---|---|---|
| POST /admin/service-categories | 15 | 41.2 | 25.8 | 21.0 | 34.2 | 26.4 | 81.1 | 81.1 | 81.1 | 201x15 |
| GET /admin/service-categories | 15 | 34.5 | 15.7 | 14.7 | 21.1 | 19.6 | 34.5 | 34.5 | 34.5 | 200x15 |
| GET /admin/service-categories/{categoryId} | 15 | 33.2 | 14.5 | 12.2 | 19.1 | 15.6 | 33.2 | 33.2 | 33.2 | 200x15 |
| PATCH /admin/service-categories/{categoryId} | 15 | 74.7 | 29.0 | 28.0 | 37.4 | 31.8 | 74.7 | 74.7 | 74.7 | 200x15 |
| PUT /admin/service-categories/{categoryId}/engagements | 15 | 63.9 | 34.8 | 30.7 | 43.4 | 40.6 | 65.3 | 65.3 | 65.3 | 200x15 |
| PUT /admin/pricing-guidance | 15 | 47.7 | 30.7 | 24.5 | 37.0 | 32.8 | 63.3 | 63.3 | 63.3 | 200x15 |
| GET /admin/pricing-guidance | 15 | 24.4 | 15.5 | 12.7 | 18.1 | 16.1 | 26.7 | 26.7 | 26.7 | 200x15 |
| DELETE /admin/pricing-guidance/{id} | 15 | 35.7 | 25.7 | 23.7 | 30.5 | 30.2 | 45.6 | 45.6 | 45.6 | 204x15 |

### Admin - Support

| Operation | n | 1st | 2nd | min | avg | p50 | p95 | p99 | max | Status |
|---|---|---|---|---|---|---|---|---|---|---|
| POST /admin/support/categories | 15 | 40.3 | 29.2 | 23.2 | 30.6 | 28.0 | 45.4 | 45.4 | 45.4 | 201x15 |
| GET /admin/support/categories | 15 | 15.9 | 15.3 | 10.5 | 17.1 | 15.6 | 30.1 | 30.1 | 30.1 | 200x15 |
| PATCH /admin/support/categories/{categoryId} | 15 | 36.6 | 28.3 | 22.0 | 33.4 | 30.2 | 52.2 | 52.2 | 52.2 | 200x15 |
| GET /admin/support/tickets | 15 | 19.1 | 25.9 | 16.2 | 22.3 | 22.6 | 31.1 | 31.1 | 31.1 | 200x15 |
| GET /admin/support/tickets/{ticketId} | 15 | 18.0 | 19.7 | 13.7 | 21.6 | 19.8 | 33.4 | 33.4 | 33.4 | 200x15 |
| POST /admin/support/tickets/{ticketId}/assign | 15 | 58.1 | 51.2 | 38.4 | 62.5 | 58.1 | 101 | 101 | 101 | 200x15 |
| POST /admin/support/tickets/{ticketId}/priority | 15 | 39.5 | 41.9 | 29.9 | 47.5 | 41.9 | 78.2 | 78.2 | 78.2 | 200x15 |
| POST /admin/support/tickets/{ticketId}/escalate | 15 | 41.6 | 38.6 | 33.1 | 50.4 | 47.7 | 76.5 | 76.5 | 76.5 | 200x15 |
| POST /admin/support/tickets/{ticketId}/messages | 15 | 34.8 | 32.7 | 31.2 | 41.5 | 40.1 | 60.8 | 60.8 | 60.8 | 201x15 |
| GET /admin/support/tickets/{ticketId}/messages | 15 | 18.2 | 18.7 | 14.9 | 21.1 | 18.7 | 34.2 | 34.2 | 34.2 | 200x15 |
| POST /admin/support/tickets/{ticketId}/close | 15 | 41.6 | 42.4 | 36.3 | 49.2 | 42.4 | 86.0 | 86.0 | 86.0 | 200x15 |

### Admin - System

| Operation | n | 1st | 2nd | min | avg | p50 | p95 | p99 | max | Status |
|---|---|---|---|---|---|---|---|---|---|---|
| GET /admin/system/readiness | 15 | 80.1 | 94.4 | 66.5 | 87.6 | 80.1 | 124 | 124 | 124 | 200x15 |

### Admin - Users

| Operation | n | 1st | 2nd | min | avg | p50 | p95 | p99 | max | Status |
|---|---|---|---|---|---|---|---|---|---|---|
| POST /admin/users | 15 | 473 | 436 | 415 | 472 | 449 | 609 | 609 | 609 | 201x15 |
| GET /admin/users | 15 | 35.4 | 21.7 | 17.1 | 25.0 | 21.9 | 40.4 | 40.4 | 40.4 | 200x15 |
| GET /admin/users/{userId} | 15 | 18.5 | 18.5 | 12.1 | 18.0 | 17.1 | 30.5 | 30.5 | 30.5 | 200x15 |
| PUT /admin/users/{userId}/role | 15 | 66.4 | 43.9 | 35.3 | 53.2 | 52.7 | 77.4 | 77.4 | 77.4 | 200x15 |
| POST /admin/users/{userId}/password-reset | 15 | 478 | 431 | 414 | 475 | 449 | 684 | 684 | 684 | 200x15 |
| PATCH /admin/users/{userId}/status | 15 | 60.5 | 38.9 | 29.6 | 39.7 | 38.9 | 60.5 | 60.5 | 60.5 | 200x15 |

### Admin - Verification

| Operation | n | 1st | 2nd | min | avg | p50 | p95 | p99 | max | Status |
|---|---|---|---|---|---|---|---|---|---|---|
| GET /admin/verification/requirements | 15 | 20.9 | 15.0 | 11.1 | 16.0 | 15.0 | 26.1 | 26.1 | 26.1 | 200x15 |
| PUT /admin/verification/requirements | 15 | 40.3 | 24.5 | 20.9 | 30.1 | 28.1 | 45.8 | 45.8 | 45.8 | 200x15 |
| GET /admin/verification/queue | 15 | 34.8 | 17.8 | 13.0 | 22.4 | 21.3 | 36.6 | 36.6 | 36.6 | 200x15 |
| GET /admin/workers/{workerId}/verification | 15 | 27.4 | 23.0 | 16.3 | 26.0 | 23.9 | 45.0 | 45.0 | 45.0 | 200x15 |
| POST /admin/verification/checks/{checkId}/start-review | 30 | 44.5 | 43.7 | 32.0 | 44.3 | 41.7 | 62.5 | 80.2 | 80.2 | 200x30 |
| POST /admin/verification/checks/{checkId}/approve | 15 | 50.9 | 40.4 | 34.5 | 53.5 | 50.9 | 84.9 | 84.9 | 84.9 | 200x15 |
| GET /admin/verification/documents/{documentId}/link | 15 | 30.1 | 25.3 | 19.9 | 35.6 | 29.3 | 93.0 | 93.0 | 93.0 | 200x15 |
| POST /admin/verification/checks/{checkId}/reject | 15 | 50.3 | 44.1 | 40.1 | 47.4 | 45.0 | 59.8 | 59.8 | 59.8 | 200x15 |
| POST /admin/verification/checks/{checkId}/recheck | 15 | 45.1 | 36.2 | 32.1 | 48.0 | 46.3 | 69.6 | 69.6 | 69.6 | 200x15 |

### Admin - Worker Availability

| Operation | n | 1st | 2nd | min | avg | p50 | p95 | p99 | max | Status |
|---|---|---|---|---|---|---|---|---|---|---|
| GET /admin/workers/{workerId}/availability | 15 | 23.6 | 22.7 | 17.9 | 21.8 | 20.1 | 30.5 | 30.5 | 30.5 | 200x15 |
| PATCH /admin/workers/{workerId}/availability | 15 | 60.8 | 51.3 | 37.5 | 57.2 | 52.1 | 90.5 | 90.5 | 90.5 | 200x15 |

### Admin - Workers

| Operation | n | 1st | 2nd | min | avg | p50 | p95 | p99 | max | Status |
|---|---|---|---|---|---|---|---|---|---|---|
| GET /admin/workers | 15 | 30.2 | 18.2 | 18.2 | 27.0 | 22.4 | 58.0 | 58.0 | 58.0 | 200x15 |
| POST /admin/workers | 15 | 60.6 | 43.9 | 42.4 | 59.9 | 53.4 | 98.5 | 98.5 | 98.5 | 201x15 |
| GET /admin/workers/{workerId} | 15 | 39.0 | 27.3 | 25.7 | 32.3 | 31.1 | 51.0 | 51.0 | 51.0 | 200x15 |
| PATCH /admin/workers/{workerId} | 15 | 79.4 | 44.0 | 37.4 | 53.5 | 54.7 | 79.4 | 79.4 | 79.4 | 200x15 |
| PUT /admin/workers/{workerId}/categories | 15 | 70.2 | 51.1 | 43.0 | 56.7 | 55.8 | 71.3 | 71.3 | 71.3 | 200x15 |
| GET /admin/workers/{workerId}/references | 15 | 31.6 | 27.4 | 21.9 | 28.1 | 27.4 | 34.2 | 34.2 | 34.2 | 200x15 |

### Admin account

| Operation | n | 1st | 2nd | min | avg | p50 | p95 | p99 | max | Status |
|---|---|---|---|---|---|---|---|---|---|---|
| POST /admin/account/password | 15 | 951 | 845 | 730 | 897 | 885 | 1107 | 1107 | 1107 | 200x15 |

### App

| Operation | n | 1st | 2nd | min | avg | p50 | p95 | p99 | max | Status |
|---|---|---|---|---|---|---|---|---|---|---|
| GET /app-config | 15 | 5.65 | 1.66 | 1.00 | 1.75 | 1.33 | 5.65 | 5.65 | 5.65 | 200x15 |
| GET /reference-data | 15 | 2.70 | 1.38 | 0.83 | 1.19 | 1.10 | 2.70 | 2.70 | 2.70 | 200x15 |

### Attendance

| Operation | n | 1st | 2nd | min | avg | p50 | p95 | p99 | max | Status |
|---|---|---|---|---|---|---|---|---|---|---|
| POST /workers/me/attendance/bookings/{bookingId}/check-in | 15 | 40.4 | 37.6 | 21.5 | 30.1 | 30.6 | 40.4 | 40.4 | 40.4 | 201x15 |
| POST /workers/me/attendance/bookings/{bookingId}/check-out | 15 | 40.8 | 32.3 | 28.5 | 34.1 | 32.6 | 40.8 | 40.8 | 40.8 | 201x15 |
| GET /workers/me/attendance/bookings/{bookingId} | 15 | 18.4 | 22.4 | 13.7 | 17.6 | 17.0 | 23.2 | 23.2 | 23.2 | 200x15 |
| GET /workers/me/attendance/bookings/{bookingId}/summary | 15 | 21.8 | 22.7 | 13.3 | 17.0 | 15.5 | 25.7 | 25.7 | 25.7 | 200x15 |
| POST /workers/me/attendance/bookings/{bookingId} | 15 | 19.6 | 24.9 | 12.6 | 18.0 | 15.7 | 26.6 | 26.6 | 26.6 | 201x15 |
| GET /attendance/bookings/{bookingId} | 15 | 13.2 | 15.7 | 8.74 | 11.6 | 10.5 | 16.6 | 16.6 | 16.6 | 200x15 |
| GET /attendance/bookings/{bookingId}/summary | 15 | 12.5 | 19.6 | 11.2 | 14.5 | 13.6 | 19.6 | 19.6 | 19.6 | 200x15 |
| POST /attendance/bookings/{bookingId}/exceptions | 15 | 32.4 | 31.1 | 19.1 | 27.1 | 29.8 | 35.9 | 35.9 | 35.9 | 201x15 |

### Auth

| Operation | n | 1st | 2nd | min | avg | p50 | p95 | p99 | max | Status |
|---|---|---|---|---|---|---|---|---|---|---|
| POST /auth/admin/login | 15 | 522 | 410 | 404 | 457 | 439 | 583 | 583 | 583 | 200x15 |
| POST /auth/otp/request | 60 | 15.3 | 11.1 | 6.02 | 9.83 | 9.07 | 13.9 | 18.8 | 18.8 | 200x60 |
| POST /auth/otp/verify | 60 | 46.5 | 45.0 | 20.9 | 30.5 | 28.7 | 45.0 | 54.2 | 54.2 | 200x60 |
| POST /auth/token/refresh | 15 | 10.1 | 9.27 | 7.14 | 9.13 | 9.13 | 13.3 | 13.3 | 13.3 | 200x15 |
| GET /auth/sessions | 30 | 10.9 | 7.68 | 5.90 | 8.60 | 8.23 | 12.0 | 13.2 | 13.2 | 200x30 |
| PUT /auth/device-token | 15 | 24.3 | 25.0 | 11.8 | 16.8 | 15.4 | 25.0 | 25.0 | 25.0 | 204x15 |
| DELETE /auth/device-token | 15 | 10.2 | 11.4 | 6.22 | 9.45 | 8.91 | 13.8 | 13.8 | 13.8 | 204x15 |
| DELETE /auth/sessions/{sessionId} | 15 | 12.0 | 9.15 | 7.75 | 11.1 | 10.4 | 15.7 | 15.7 | 15.7 | 404x15 |
| POST /auth/logout | 15 | 16.0 | 16.6 | 12.4 | 16.9 | 16.0 | 22.3 | 22.3 | 22.3 | 204x15 |

### Bookings

| Operation | n | 1st | 2nd | min | avg | p50 | p95 | p99 | max | Status |
|---|---|---|---|---|---|---|---|---|---|---|
| POST /bookings | 30 | 143 | 80.3 | 49.6 | 75.1 | 67.9 | 111 | 143 | 143 | 201x30 |
| GET /bookings | 15 | 17.5 | 17.4 | 10.4 | 15.5 | 13.9 | 29.1 | 29.1 | 29.1 | 200x15 |
| GET /bookings/{bookingId} | 15 | 16.2 | 19.4 | 11.5 | 15.3 | 15.0 | 23.0 | 23.0 | 23.0 | 200x15 |
| GET /workers/me/bookings | 15 | 21.9 | 16.3 | 11.3 | 15.4 | 15.3 | 21.9 | 21.9 | 21.9 | 200x15 |
| GET /workers/me/bookings/{bookingId} | 15 | 17.0 | 16.7 | 9.96 | 15.3 | 14.9 | 20.6 | 20.6 | 20.6 | 200x15 |
| POST /workers/me/bookings/{bookingId}/{action} | 45 | 61.1 | 41.0 | 39.6 | 52.1 | 47.4 | 77.6 | 80.2 | 80.2 | 200x45 |
| POST /bookings/{bookingId}/{action} | 90 | 19.4 | 32.6 | 10.9 | 44.3 | 45.0 | 81.1 | 100 | 100 | 200x75 409x15 |
| GET /bookings/{bookingId}/replacement-chain | 15 | 15.3 | 16.5 | 11.5 | 14.3 | 13.4 | 20.9 | 20.9 | 20.9 | 200x15 |
| POST /bookings/rebook | 15 | 125 | 92.8 | 68.0 | 82.4 | 75.2 | 125 | 125 | 125 | 201x15 |
| PUT /workers/me/bookings/{bookingId}/slot-proposal | 15 | 22.9 | 20.2 | 17.1 | 23.6 | 22.0 | 36.9 | 36.9 | 36.9 | 409x15 |
| POST /bookings/{bookingId}/slot-proposal/{answer} | 15 | 12.6 | 14.1 | 9.65 | 13.5 | 13.1 | 21.0 | 21.0 | 21.0 | 409x15 |

### Customer

| Operation | n | 1st | 2nd | min | avg | p50 | p95 | p99 | max | Status |
|---|---|---|---|---|---|---|---|---|---|---|
| GET /customers/me/home | 15 | 52.6 | 18.4 | 9.22 | 16.6 | 14.4 | 52.6 | 52.6 | 52.6 | 200x15 |
| GET /customers/me/booking-history | 15 | 47.7 | 45.9 | 29.9 | 38.8 | 37.3 | 51.0 | 51.0 | 51.0 | 200x15 |
| GET /customers/me/booking-history/summary | 15 | 9.39 | 31.5 | 7.13 | 11.8 | 9.82 | 31.5 | 31.5 | 31.5 | 200x15 |

### Customers

| Operation | n | 1st | 2nd | min | avg | p50 | p95 | p99 | max | Status |
|---|---|---|---|---|---|---|---|---|---|---|
| POST /customers/me | 15 | 25.6 | 16.2 | 15.3 | 18.9 | 16.5 | 29.2 | 29.2 | 29.2 | 201x15 |
| GET /customers/me | 15 | 11.6 | 7.16 | 6.12 | 8.46 | 7.33 | 13.7 | 13.7 | 13.7 | 200x15 |
| PATCH /customers/me | 15 | 29.4 | 22.7 | 18.5 | 24.4 | 22.3 | 34.5 | 34.5 | 34.5 | 200x15 |
| GET /customers/me/onboarding | 15 | 16.3 | 11.2 | 6.83 | 11.2 | 10.4 | 23.9 | 23.9 | 23.9 | 200x15 |
| POST /customers/me/addresses | 30 | 50.9 | 23.0 | 16.8 | 27.8 | 25.8 | 51.8 | 59.1 | 59.1 | 201x30 |
| GET /customers/me/addresses | 15 | 12.0 | 10.5 | 7.47 | 10.5 | 10.4 | 17.0 | 17.0 | 17.0 | 200x15 |
| GET /customers/me/addresses/{addressId} | 15 | 11.3 | 8.61 | 7.38 | 10.2 | 9.47 | 15.8 | 15.8 | 15.8 | 200x15 |
| PATCH /customers/me/addresses/{addressId} | 15 | 25.5 | 28.1 | 15.1 | 23.4 | 22.9 | 39.3 | 39.3 | 39.3 | 200x15 |
| PUT /customers/me/addresses/{addressId}/default | 15 | 16.5 | 13.7 | 12.1 | 17.1 | 16.0 | 37.5 | 37.5 | 37.5 | 200x15 |
| DELETE /customers/me/addresses/{addressId} | 15 | 26.9 | 20.1 | 17.7 | 23.6 | 21.4 | 35.2 | 35.2 | 35.2 | 204x15 |

### Interviews and trials

| Operation | n | 1st | 2nd | min | avg | p50 | p95 | p99 | max | Status |
|---|---|---|---|---|---|---|---|---|---|---|
| POST /interviews | 60 | 59.2 | 38.9 | 23.6 | 34.2 | 32.6 | 46.2 | 59.2 | 59.2 | 201x60 |
| GET /interviews | 15 | 14.3 | 16.6 | 7.25 | 10.6 | 9.97 | 16.6 | 16.6 | 16.6 | 200x15 |
| GET /bookings/{bookingId}/interviews | 15 | 13.6 | 12.3 | 7.69 | 12.2 | 11.6 | 17.8 | 17.8 | 17.8 | 200x15 |
| GET /interviews/{interviewId} | 15 | 10.7 | 9.45 | 7.48 | 10.6 | 10.3 | 15.6 | 15.6 | 15.6 | 200x15 |
| POST /interviews/{interviewId}/reject-proposal | 15 | 56.9 | 55.5 | 24.6 | 39.8 | 37.1 | 71.1 | 71.1 | 71.1 | 200x15 |
| POST /interviews/{interviewId}/reschedule | 15 | 66.3 | 62.0 | 33.1 | 48.5 | 45.6 | 85.2 | 85.2 | 85.2 | 200x15 |
| POST /interviews/{interviewId}/accept-proposal | 15 | 61.2 | 43.4 | 32.4 | 47.0 | 45.1 | 69.2 | 69.2 | 69.2 | 200x15 |
| POST /interviews/{interviewId}/complete | 15 | 60.0 | 51.3 | 32.3 | 48.5 | 49.2 | 71.5 | 71.5 | 71.5 | 200x15 |
| POST /interviews/{interviewId}/cancel | 15 | 19.3 | 15.9 | 13.2 | 17.7 | 18.6 | 24.2 | 24.2 | 24.2 | 409x15 |

### Legal

| Operation | n | 1st | 2nd | min | avg | p50 | p95 | p99 | max | Status |
|---|---|---|---|---|---|---|---|---|---|---|
| GET /legal/current | 15 | 2.44 | 2.21 | 1.09 | 1.60 | 1.43 | 2.77 | 2.77 | 2.77 | 200x15 |
| GET /legal/status | 15 | 13.9 | 8.73 | 6.04 | 9.03 | 8.70 | 13.9 | 13.9 | 13.9 | 200x15 |
| POST /legal/accept | 15 | 11.5 | 5.47 | 4.90 | 7.30 | 7.06 | 13.1 | 13.1 | 13.1 | 409x15 |

### Notifications

| Operation | n | 1st | 2nd | min | avg | p50 | p95 | p99 | max | Status |
|---|---|---|---|---|---|---|---|---|---|---|
| GET /notifications | 15 | 18.0 | 14.3 | 8.93 | 13.1 | 12.4 | 19.7 | 19.7 | 19.7 | 200x15 |
| GET /notifications/unread-count | 15 | 7.16 | 6.42 | 5.76 | 8.11 | 7.25 | 11.2 | 11.2 | 11.2 | 200x15 |
| POST /notifications/{notificationId}/read | 3 | 13.4 | 10.4 | 10.4 | 12.4 | 13.4 | 13.4 | 13.4 | 13.4 | 204x3 |
| POST /notifications/{notificationId}/unread | 3 | 11.2 | 8.95 | 8.95 | 10.4 | 10.9 | 11.2 | 11.2 | 11.2 | 204x3 |
| POST /notifications/read-all | 15 | 10.9 | 9.46 | 5.84 | 8.49 | 7.91 | 15.2 | 15.2 | 15.2 | 200x15 |

### Payments

| Operation | n | 1st | 2nd | min | avg | p50 | p95 | p99 | max | Status |
|---|---|---|---|---|---|---|---|---|---|---|
| POST /payments | 15 | 63.6 | 61.4 | 34.8 | 45.1 | 43.6 | 63.6 | 63.6 | 63.6 | 201x15 |
| GET /payments/{paymentId} | 15 | 9.27 | 14.3 | 6.16 | 9.27 | 8.88 | 14.3 | 14.3 | 14.3 | 200x15 |
| GET /payments | 15 | 12.7 | 9.91 | 7.04 | 10.2 | 9.91 | 15.8 | 15.8 | 15.8 | 200x15 |
| GET /payments/{paymentId}/receipt | 30 | 11.0 | 9.19 | 5.92 | 8.75 | 9.14 | 11.0 | 11.8 | 11.8 | 200x15 409x15 |
| POST /payments/{paymentId}/verify | 15 | 79.3 | 73.9 | 48.1 | 62.2 | 59.8 | 79.3 | 79.3 | 79.3 | 200x15 |
| GET /payments/{paymentId}/receipt/pdf | 15 | 12.0 | 16.1 | 6.85 | 8.99 | 8.17 | 16.1 | 16.1 | 16.1 | 200x15 |

### Pricing

| Operation | n | 1st | 2nd | min | avg | p50 | p95 | p99 | max | Status |
|---|---|---|---|---|---|---|---|---|---|---|
| GET /pricing/guidance | 15 | 14.6 | 8.40 | 6.89 | 10.7 | 9.72 | 17.3 | 17.3 | 17.3 | 404x15 |

### Ratings

| Operation | n | 1st | 2nd | min | avg | p50 | p95 | p99 | max | Status |
|---|---|---|---|---|---|---|---|---|---|---|
| GET /ratings/bookings/{bookingId}/eligibility | 30 | 16.5 | 12.8 | 7.49 | 11.8 | 10.7 | 17.2 | 20.4 | 20.4 | 200x30 |
| POST /ratings | 15 | 28.8 | 25.5 | 20.7 | 25.1 | 25.5 | 28.8 | 28.8 | 28.8 | 201x15 |
| GET /ratings | 15 | 14.6 | 9.36 | 6.74 | 9.37 | 8.99 | 14.6 | 14.6 | 14.6 | 200x15 |
| GET /ratings/bookings/{bookingId} | 15 | 10.3 | 5.85 | 5.75 | 8.53 | 8.62 | 10.6 | 10.6 | 10.6 | 200x15 |
| GET /ratings/{ratingId} | 15 | 9.17 | 11.5 | 6.24 | 8.81 | 9.17 | 13.3 | 13.3 | 13.3 | 200x15 |
| GET /workers/me/ratings | 15 | 17.0 | 17.6 | 10.0 | 14.0 | 14.0 | 18.7 | 18.7 | 18.7 | 200x15 |
| GET /workers/me/ratings/summary | 15 | 14.3 | 17.3 | 8.43 | 12.1 | 11.7 | 19.1 | 19.1 | 19.1 | 200x15 |

### Replacements

| Operation | n | 1st | 2nd | min | avg | p50 | p95 | p99 | max | Status |
|---|---|---|---|---|---|---|---|---|---|---|
| POST /replacement-requests | 60 | 58.5 | 45.6 | 37.5 | 49.7 | 46.2 | 71.7 | 106 | 106 | 201x60 |
| GET /replacement-requests | 15 | 13.3 | 9.23 | 7.76 | 9.97 | 9.23 | 16.3 | 16.3 | 16.3 | 200x15 |
| GET /replacement-requests/{requestId} | 15 | 16.1 | 12.4 | 8.11 | 12.4 | 11.6 | 16.1 | 16.1 | 16.1 | 200x15 |
| POST /replacement-requests/{requestId}/cancel | 15 | 44.2 | 42.4 | 33.1 | 46.1 | 42.4 | 74.7 | 74.7 | 74.7 | 200x15 |
| GET /replacement-requests/{requestId}/alternatives | 15 | 49.9 | 49.3 | 47.7 | 65.9 | 59.9 | 103 | 103 | 103 | 200x15 |
| POST /replacement-requests/{requestId}/select | 15 | 105 | 103 | 79.6 | 105 | 102 | 157 | 157 | 157 | 200x15 |

### Safety

| Operation | n | 1st | 2nd | min | avg | p50 | p95 | p99 | max | Status |
|---|---|---|---|---|---|---|---|---|---|---|
| POST /safety/blocks | 15 | 23.0 | 19.9 | 17.2 | 21.4 | 20.6 | 38.2 | 38.2 | 38.2 | 200x15 |
| GET /safety/blocks | 15 | 12.6 | 10.5 | 8.64 | 12.3 | 11.7 | 19.0 | 19.0 | 19.0 | 200x15 |
| DELETE /safety/blocks/{blockId} | 15 | 16.5 | 15.0 | 11.1 | 15.0 | 13.9 | 23.9 | 23.9 | 23.9 | 204x15 |
| POST /safety/reports | 15 | 24.1 | 24.4 | 21.0 | 25.5 | 24.1 | 42.2 | 42.2 | 42.2 | 201x15 |

### Search

| Operation | n | 1st | 2nd | min | avg | p50 | p95 | p99 | max | Status |
|---|---|---|---|---|---|---|---|---|---|---|
| GET /search/workers | 15 | 33.5 | 29.0 | 19.9 | 27.5 | 23.0 | 38.2 | 38.2 | 38.2 | 200x15 |
| GET /search/workers/{workerId} | 15 | 22.3 | 14.9 | 11.2 | 17.2 | 15.0 | 26.9 | 26.9 | 26.9 | 200x15 |
| GET /search/workers/{workerId}/slots | 15 | 66.7 | 25.3 | 19.1 | 27.0 | 23.6 | 66.7 | 66.7 | 66.7 | 200x15 |
| GET /search/workers/{workerId}/ratings | 15 | 56.4 | 36.3 | 13.7 | 24.2 | 21.4 | 56.4 | 56.4 | 56.4 | 200x15 |

### Service Areas

| Operation | n | 1st | 2nd | min | avg | p50 | p95 | p99 | max | Status |
|---|---|---|---|---|---|---|---|---|---|---|
| GET /service-areas | 15 | 9.88 | 6.58 | 5.65 | 9.22 | 8.84 | 14.7 | 14.7 | 14.7 | 200x15 |
| GET /service-areas/{areaId} | 15 | 9.04 | 8.82 | 5.64 | 8.96 | 8.88 | 14.4 | 14.4 | 14.4 | 200x15 |
| GET /locations/service-area | 15 | 15.5 | 11.4 | 8.71 | 13.2 | 12.5 | 24.1 | 24.1 | 24.1 | 200x15 |

### Service Categories

| Operation | n | 1st | 2nd | min | avg | p50 | p95 | p99 | max | Status |
|---|---|---|---|---|---|---|---|---|---|---|
| GET /service-categories | 15 | 14.3 | 12.6 | 8.16 | 12.1 | 12.2 | 16.9 | 16.9 | 16.9 | 200x15 |
| GET /service-categories/{categoryId} | 15 | 11.6 | 9.71 | 6.93 | 10.3 | 9.46 | 14.2 | 14.2 | 14.2 | 200x15 |

### Shortlist

| Operation | n | 1st | 2nd | min | avg | p50 | p95 | p99 | max | Status |
|---|---|---|---|---|---|---|---|---|---|---|
| PUT /shortlist/{workerId} | 15 | 42.0 | 31.9 | 25.7 | 34.2 | 31.9 | 46.6 | 46.6 | 46.6 | 204x15 |
| GET /shortlist | 15 | 26.3 | 22.1 | 15.4 | 21.1 | 19.2 | 30.2 | 30.2 | 30.2 | 200x15 |
| DELETE /shortlist/{workerId} | 15 | 10.6 | 15.8 | 6.83 | 10.0 | 9.14 | 16.2 | 16.2 | 16.2 | 204x15 |

### Support

| Operation | n | 1st | 2nd | min | avg | p50 | p95 | p99 | max | Status |
|---|---|---|---|---|---|---|---|---|---|---|
| POST /support/tickets | 30 | 45.9 | 25.0 | 19.9 | 31.3 | 28.7 | 46.0 | 47.4 | 47.4 | 201x30 |
| GET /support/categories | 15 | 7.90 | 8.54 | 5.70 | 8.39 | 8.43 | 11.4 | 11.4 | 11.4 | 200x15 |
| GET /support/tickets | 15 | 13.8 | 12.3 | 8.13 | 12.0 | 11.8 | 17.4 | 17.4 | 17.4 | 200x15 |
| GET /support/tickets/{ticketId} | 15 | 14.4 | 12.2 | 8.47 | 12.6 | 12.2 | 18.0 | 18.0 | 18.0 | 200x15 |
| POST /support/tickets/{ticketId}/messages | 15 | 22.7 | 22.6 | 17.3 | 27.3 | 25.4 | 45.5 | 45.5 | 45.5 | 201x15 |
| GET /support/tickets/{ticketId}/messages | 15 | 15.4 | 12.4 | 10.8 | 14.8 | 14.3 | 21.2 | 21.2 | 21.2 | 200x15 |

### Users

| Operation | n | 1st | 2nd | min | avg | p50 | p95 | p99 | max | Status |
|---|---|---|---|---|---|---|---|---|---|---|
| GET /users/me | 15 | 31.9 | 14.1 | 9.71 | 14.8 | 13.6 | 31.9 | 31.9 | 31.9 | 200x15 |

### Verification

| Operation | n | 1st | 2nd | min | avg | p50 | p95 | p99 | max | Status |
|---|---|---|---|---|---|---|---|---|---|---|
| GET /workers/me/verification | 15 | 17.9 | 12.9 | 9.30 | 15.3 | 13.6 | 24.1 | 24.1 | 24.1 | 200x15 |
| POST /workers/me/verification/checks/{checkType}/documents | 15 | 47.2 | 26.7 | 21.1 | 34.3 | 30.6 | 53.0 | 53.0 | 53.0 | 201x15 |
| POST /workers/me/verification/documents/{documentId}/confirm | 15 | 42.2 | 29.7 | 26.4 | 37.0 | 31.6 | 62.2 | 62.2 | 62.2 | 200x15 |
| POST /workers/me/verification/checks/{checkType}/submit | 15 | 53.1 | 36.4 | 33.4 | 43.8 | 39.5 | 63.7 | 63.7 | 63.7 | 200x15 |

### Worker Availability

| Operation | n | 1st | 2nd | min | avg | p50 | p95 | p99 | max | Status |
|---|---|---|---|---|---|---|---|---|---|---|
| PATCH /workers/me/availability | 15 | 66.4 | 47.0 | 30.8 | 48.2 | 46.3 | 66.4 | 66.4 | 66.4 | 200x15 |
| GET /workers/me/availability | 15 | 23.3 | 14.4 | 10.2 | 15.8 | 14.7 | 23.3 | 23.3 | 23.3 | 200x15 |

### Worker bookings

| Operation | n | 1st | 2nd | min | avg | p50 | p95 | p99 | max | Status |
|---|---|---|---|---|---|---|---|---|---|---|
| GET /workers/me/opportunities | 15 | 22.0 | 19.8 | 11.9 | 16.5 | 14.9 | 23.4 | 23.4 | 23.4 | 200x15 |

### Worker interviews and trials

| Operation | n | 1st | 2nd | min | avg | p50 | p95 | p99 | max | Status |
|---|---|---|---|---|---|---|---|---|---|---|
| GET /workers/me/interviews | 15 | 19.0 | 20.8 | 10.9 | 14.8 | 14.2 | 20.8 | 20.8 | 20.8 | 200x15 |
| GET /workers/me/interviews/{interviewId} | 15 | 14.8 | 19.6 | 11.5 | 15.0 | 14.8 | 19.6 | 19.6 | 19.6 | 200x15 |
| POST /workers/me/interviews/{interviewId}/accept | 30 | 68.3 | 59.1 | 35.6 | 52.8 | 50.0 | 76.1 | 81.4 | 81.4 | 200x30 |
| POST /workers/me/interviews/{interviewId}/propose | 60 | 42.9 | 52.0 | 26.2 | 39.1 | 35.3 | 58.9 | 69.7 | 69.7 | 200x60 |
| POST /workers/me/interviews/{interviewId}/decline | 15 | 44.2 | 28.8 | 27.1 | 35.0 | 30.2 | 62.6 | 62.6 | 62.6 | 200x15 |
| POST /workers/me/interviews/{interviewId}/cancel | 15 | 48.4 | 37.6 | 35.1 | 41.5 | 38.1 | 61.5 | 61.5 | 61.5 | 200x15 |

### Worker onboarding

| Operation | n | 1st | 2nd | min | avg | p50 | p95 | p99 | max | Status |
|---|---|---|---|---|---|---|---|---|---|---|
| GET /workers/me/onboarding | 15 | 26.6 | 15.2 | 12.6 | 17.9 | 16.8 | 26.6 | 26.6 | 26.6 | 200x15 |

### Worker photo

| Operation | n | 1st | 2nd | min | avg | p50 | p95 | p99 | max | Status |
|---|---|---|---|---|---|---|---|---|---|---|
| POST /workers/me/photo | 15 | 29.8 | 23.4 | 17.2 | 25.4 | 24.4 | 38.1 | 38.1 | 38.1 | 201x15 |
| POST /workers/me/photo/{photoId}/confirm | 15 | 66.6 | 51.2 | 45.9 | 58.5 | 57.1 | 76.9 | 76.9 | 76.9 | 200x15 |
| GET /workers/me/photo | 15 | 19.4 | 13.1 | 9.35 | 14.5 | 13.1 | 24.4 | 24.4 | 24.4 | 200x15 |

### Workers

| Operation | n | 1st | 2nd | min | avg | p50 | p95 | p99 | max | Status |
|---|---|---|---|---|---|---|---|---|---|---|
| POST /workers/me | 15 | 51.2 | 24.0 | 18.9 | 27.0 | 26.9 | 51.2 | 51.2 | 51.2 | 201x15 |
| PATCH /workers/me | 15 | 69.0 | 33.6 | 31.1 | 39.9 | 34.6 | 69.0 | 69.0 | 69.0 | 200x15 |
| PUT /workers/me/categories | 15 | 48.0 | 38.3 | 32.3 | 42.6 | 40.0 | 64.4 | 64.4 | 64.4 | 200x15 |
| PUT /workers/me/references | 15 | 49.5 | 36.2 | 21.6 | 33.2 | 34.0 | 49.5 | 49.5 | 49.5 | 200x15 |
| GET /workers/me/references | 15 | 14.9 | 11.5 | 9.53 | 12.7 | 13.3 | 15.8 | 15.8 | 15.8 | 200x15 |
| POST /workers/me/submit | 15 | 39.4 | 32.4 | 27.6 | 40.5 | 36.8 | 61.8 | 61.8 | 61.8 | 200x15 |
| GET /workers/me | 15 | 15.3 | 13.1 | 10.9 | 14.5 | 14.9 | 18.9 | 18.9 | 18.9 | 200x15 |

### health

| Operation | n | 1st | 2nd | min | avg | p50 | p95 | p99 | max | Status |
|---|---|---|---|---|---|---|---|---|---|---|
| GET /health/live | 15 | 37.2 | 1.98 | 1.04 | 3.80 | 1.33 | 37.2 | 37.2 | 37.2 | 200x15 |
| GET /health/ready | 15 | 22.8 | 3.91 | 2.39 | 4.78 | 3.32 | 22.8 | 22.8 | 22.8 | 200x15 |

## Not exercised (2)

* POST /admin/outbox-events/{eventId}/retry
* POST /admin/payment-exceptions/{exceptionId}/resolve

Steps skipped because a prerequisite was missing in at least one iteration: outbox retry; notification steps.

