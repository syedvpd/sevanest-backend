# Backend performance test results

Generated 2026-11-03T04:00:13.301Z. **Performance, not load**: one client, strictly sequential, 10 iterations of every module's lifecycle.

## How it was measured

* Target: the real API on a real HTTP port (loopback), NestJS 11, on a fresh local PostgreSQL 17 and Redis 7 (Docker), same machine as the client. Numbers include JSON parsing, guards, validation, database and audit writes; they exclude network latency and TLS, so a hosted deployment adds its round trip.
* Machine: 11th Gen Intel(R) Core(TM) i7-1185G7 @ 3.00GHz, 8 logical CPUs, 16 GB RAM, Node v24.21.0, win32.
* Each iteration creates fresh users and data and walks the modules in lifecycle order: create, read, list, update, state changes, delete. The same operation is therefore hit once per iteration.
* **1st hit** = iteration 1 (first call after the process started: cold caches, query plans, JIT). **2nd hit** = iteration 2. p50/p95/p99, min, avg, max use all 10 samples (nearest-rank; with 10 samples p95 and p99 equal the slowest sample).
* Times are end-to-end milliseconds for the HTTP call including reading the whole body.

## Summary

| | value |
|---|---|
| Operations in the API | 304 |
| Operations exercised | 206 (67.8 %) |
| Requests timed | 2238 |
| Overall p50 / p95 / p99 (all requests) | 25.2 / 99.5 / 509 ms |
| Warm requests only (iteration 3 onwards) p50 / p95 / p99 | 24.3 / 94.3 / 503 ms |
| 1st-hit median across operations | 27.4 ms |
| 2nd-hit median across operations | 31.2 ms |
| Operations with p95 above 100 ms | 38 |
| Operations with p95 above 250 ms | 11 |
| Operations whose status was not the expected one | 6 |

### Reading the numbers

* Operations whose median is above 300 ms: POST /auth/admin/login, POST /admin/users, POST /admin/users/{userId}/password-reset, POST /admin/account/password. These verify or create a password hash, which is deliberately expensive; they set the overall p99.
* Without them: p50 / p95 / p99 = 24.7 / 83.9 / 151 ms over 2198 requests.
* Cold start is small: the 1st-hit median across operations is 27.4 ms against 31.2 ms for the 2nd hit; only a few operations lose more than 20 ms on their first call (table below).
* Read endpoints (GET) dominate the sample and answer in a few tens of milliseconds; the slowest non-hashing operations are state changes that write several rows, send outbox events and audit records in one transaction (interviews, bookings, replacements, payments).
* Run history: an earlier identical run was discarded because the host machine stalled for about 4 minutes during iteration 13 (one call took 266 s and two requests got 500 from connections broken by the stall; the database and Redis logs show no error). This is the clean rerun: no failed iteration, no unexpected status, no sample above 3 s.

### Slowest 15 operations by p95 (ms)

| Operation | 1st | 2nd | p50 | p95 | max |
|---|---|---|---|---|---|
| POST /admin/account/password | 874 | 1498 | 874 | 1498 | 1498 |
| POST /auth/admin/login | 577 | 393 | 395 | 771 | 771 |
| POST /admin/users | 583 | 498 | 438 | 724 | 724 |
| POST /admin/users/{userId}/password-reset | 467 | 543 | 435 | 618 | 618 |
| POST /workers/me/photo/{photoId}/confirm | 74.5 | 51.6 | 60.4 | 537 | 537 |
| POST /admin/bookings | 171 | 191 | 108 | 479 | 479 |
| POST /replacement-requests/{requestId}/select | 116 | 336 | 116 | 336 | 336 |
| GET /admin/reports/worker-utilization | 21.9 | 27.6 | 17.9 | 319 | 319 |
| POST /admin/replacement-requests/{requestId}/reject | 103 | 285 | 85.1 | 285 | 285 |
| GET /customers/me/home | 156 | 79.0 | 67.8 | 262 | 262 |
| DELETE /customers/me/addresses/{addressId} | 36.6 | 31.3 | 25.8 | 257 | 257 |
| PUT /workers/me/categories | 67.4 | 51.1 | 45.3 | 231 | 231 |
| POST /admin/workers | 55.5 | 72.3 | 55.8 | 219 | 219 |
| GET /admin/dashboard | 59.2 | 201 | 53.0 | 201 | 201 |
| GET /replacement-requests/{requestId}/alternatives | 58.6 | 188 | 71.6 | 188 | 188 |

### Largest cold-start penalty (1st hit minus p50, ms)

| Operation | 1st | 2nd | p50 | p95 | max |
|---|---|---|---|---|---|
| POST /auth/admin/login | 577 | 393 | 395 | 771 | 771 |
| POST /admin/users | 583 | 498 | 438 | 724 | 724 |
| PUT /workers/me/bookings/{bookingId}/slot-proposal | 113 | 29.3 | 22.4 | 113 | 113 |
| GET /customers/me/home | 156 | 79.0 | 67.8 | 262 | 262 |
| PUT /admin/workers/{workerId}/categories | 136 | 55.1 | 63.7 | 136 | 136 |
| POST /admin/bookings | 171 | 191 | 108 | 479 | 479 |
| GET /health/live | 51.0 | 2.67 | 2.29 | 51.0 | 51.0 |
| POST /admin/replacement-requests/{requestId}/select | 113 | 106 | 70.2 | 113 | 113 |
| DELETE /admin/pricing-guidance/{id} | 68.4 | 38.4 | 27.1 | 122 | 122 |
| POST /workers/me/bookings/{bookingId}/{action} | 102 | 68.5 | 62.4 | 107 | 112 |

## Every operation, by module

Columns are milliseconds. "Status" lists the HTTP statuses seen and how often (e.g. 200x15).

### Account

| Operation | n | 1st | 2nd | min | avg | p50 | p95 | p99 | max | Status |
|---|---|---|---|---|---|---|---|---|---|---|
| POST /me/deletion-request | 10 | 32.0 | 90.9 | 21.5 | 34.7 | 27.7 | 90.9 | 90.9 | 90.9 | 201x10 |
| GET /me/deletion-request | 10 | 8.45 | 17.3 | 6.45 | 8.96 | 7.96 | 17.3 | 17.3 | 17.3 | 200x10 |
| DELETE /me/deletion-request | 10 | 23.6 | 41.9 | 13.9 | 21.3 | 18.8 | 41.9 | 41.9 | 41.9 | 204x10 |

### Admin - Account deletion

| Operation | n | 1st | 2nd | min | avg | p50 | p95 | p99 | max | Status |
|---|---|---|---|---|---|---|---|---|---|---|
| GET /admin/deletion-requests | 10 | 12.4 | 23.5 | 9.77 | 13.5 | 12.3 | 23.5 | 23.5 | 23.5 | 200x10 |

### Admin - Alerts

| Operation | n | 1st | 2nd | min | avg | p50 | p95 | p99 | max | Status |
|---|---|---|---|---|---|---|---|---|---|---|
| GET /admin/alerts | 10 | 39.0 | 106 | 24.9 | 53.3 | 28.9 | 173 | 173 | 173 | 200x10 |
| GET /admin/alerts/summary | 10 | 33.0 | 99.5 | 22.1 | 36.5 | 30.4 | 99.5 | 99.5 | 99.5 | 200x10 |
| POST /admin/alerts/{alertId}/acknowledge | 10 | 47.8 | 133 | 31.4 | 53.4 | 41.0 | 133 | 133 | 133 | 200x10 |
| POST /admin/alerts/{alertId}/resolve | 10 | 44.2 | 67.0 | 31.9 | 47.6 | 35.3 | 110 | 110 | 110 | 200x10 |

### Admin - Audit

| Operation | n | 1st | 2nd | min | avg | p50 | p95 | p99 | max | Status |
|---|---|---|---|---|---|---|---|---|---|---|
| GET /admin/audit-logs | 10 | 26.0 | 66.0 | 11.2 | 30.4 | 20.1 | 86.7 | 86.7 | 86.7 | 200x10 |

### Admin - Bookings

| Operation | n | 1st | 2nd | min | avg | p50 | p95 | p99 | max | Status |
|---|---|---|---|---|---|---|---|---|---|---|
| POST /admin/bookings | 10 | 171 | 191 | 75.1 | 155 | 108 | 479 | 479 | 479 | 201x10 |
| POST /admin/bookings/{bookingId}/{action} | 10 | 88.6 | 118 | 56.8 | 84.3 | 66.7 | 135 | 135 | 135 | 200x10 |
| POST /admin/bookings/{bookingId}/slot-proposal/{answer} | 10 | 33.4 | 35.5 | 17.0 | 27.1 | 24.3 | 35.6 | 35.6 | 35.6 | 409x10 |

### Admin - Customers

| Operation | n | 1st | 2nd | min | avg | p50 | p95 | p99 | max | Status |
|---|---|---|---|---|---|---|---|---|---|---|
| GET /admin/customers | 10 | 16.8 | 32.3 | 10.7 | 15.1 | 13.3 | 32.3 | 32.3 | 32.3 | 200x10 |
| GET /admin/customers/{customerId} | 10 | 16.5 | 32.7 | 10.2 | 15.9 | 14.8 | 32.7 | 32.7 | 32.7 | 200x10 |
| PATCH /admin/customers/{customerId}/verification-status | 10 | 35.1 | 53.5 | 23.0 | 32.3 | 25.4 | 53.5 | 53.5 | 53.5 | 200x10 |
| POST /admin/customers/{customerId}/notes | 10 | 47.6 | 52.7 | 21.9 | 32.3 | 27.8 | 52.7 | 52.7 | 52.7 | 201x10 |
| GET /admin/customers/{customerId}/notes | 10 | 21.5 | 26.6 | 11.1 | 15.8 | 13.4 | 26.6 | 26.6 | 26.6 | 200x10 |

### Admin - Dashboard

| Operation | n | 1st | 2nd | min | avg | p50 | p95 | p99 | max | Status |
|---|---|---|---|---|---|---|---|---|---|---|
| GET /admin/dashboard | 10 | 59.2 | 201 | 25.0 | 61.3 | 53.0 | 201 | 201 | 201 | 200x10 |

### Admin - Interviews and trials

| Operation | n | 1st | 2nd | min | avg | p50 | p95 | p99 | max | Status |
|---|---|---|---|---|---|---|---|---|---|---|
| POST /admin/interviews | 10 | 85.6 | 67.0 | 44.3 | 61.0 | 54.3 | 85.9 | 85.9 | 85.9 | 201x10 |
| POST /admin/interviews/{interviewId}/confirm | 10 | 80.9 | 94.5 | 46.7 | 65.0 | 58.2 | 94.5 | 94.5 | 94.5 | 200x10 |
| POST /admin/interviews/{interviewId}/reschedule | 10 | 73.8 | 84.0 | 46.8 | 59.5 | 54.3 | 84.0 | 84.0 | 84.0 | 200x10 |
| POST /admin/interviews/{interviewId}/reject-proposal | 10 | 66.6 | 72.2 | 34.8 | 48.4 | 42.1 | 72.2 | 72.2 | 72.2 | 200x10 |
| POST /admin/interviews/{interviewId}/accept-proposal | 10 | 69.3 | 80.2 | 46.0 | 60.4 | 54.8 | 82.0 | 82.0 | 82.0 | 200x10 |
| POST /admin/interviews/{interviewId}/complete | 10 | 66.6 | 93.1 | 46.5 | 65.6 | 54.4 | 105 | 105 | 105 | 200x10 |
| POST /admin/interviews/{interviewId}/cancel | 10 | 50.1 | 83.3 | 33.2 | 51.4 | 46.7 | 83.3 | 83.3 | 83.3 | 200x10 |

### Admin - Matching

| Operation | n | 1st | 2nd | min | avg | p50 | p95 | p99 | max | Status |
|---|---|---|---|---|---|---|---|---|---|---|
| POST /admin/matching/candidates | 10 | 97.0 | 88.0 | 63.3 | 84.9 | 74.2 | 149 | 149 | 149 | 200x10 |

### Admin - Notifications

| Operation | n | 1st | 2nd | min | avg | p50 | p95 | p99 | max | Status |
|---|---|---|---|---|---|---|---|---|---|---|
| POST /admin/notification-templates | 10 | 34.8 | 32.6 | 21.1 | 29.1 | 28.3 | 39.1 | 39.1 | 39.1 | 201x10 |
| GET /admin/notification-templates | 10 | 19.4 | 14.0 | 11.5 | 14.7 | 13.5 | 19.4 | 19.4 | 19.4 | 200x10 |
| GET /admin/notification-templates/{templateId} | 10 | 14.3 | 12.1 | 8.66 | 11.8 | 11.0 | 19.3 | 19.3 | 19.3 | 200x10 |
| PATCH /admin/notification-templates/{templateId} | 10 | 44.1 | 32.3 | 23.6 | 30.2 | 27.6 | 44.1 | 44.1 | 44.1 | 200x10 |
| GET /admin/notification-events | 10 | 9.11 | 22.2 | 6.31 | 9.32 | 7.23 | 22.2 | 22.2 | 22.2 | 200x10 |
| GET /admin/notifications | 10 | 14.1 | 26.2 | 10.0 | 13.9 | 11.8 | 26.2 | 26.2 | 26.2 | 200x10 |
| POST /admin/notifications/{notificationId}/retry | 10 | 24.9 | 81.9 | 15.6 | 26.0 | 18.4 | 81.9 | 81.9 | 81.9 | 409x10 |
| GET /admin/notifications/health | 10 | 13.6 | 26.6 | 9.11 | 12.4 | 10.6 | 26.6 | 26.6 | 26.6 | 200x10 |

### Admin - Payments

| Operation | n | 1st | 2nd | min | avg | p50 | p95 | p99 | max | Status |
|---|---|---|---|---|---|---|---|---|---|---|
| GET /admin/fees | 10 | 21.9 | 15.0 | 9.74 | 14.7 | 11.4 | 30.9 | 30.9 | 30.9 | 200x10 |
| PUT /admin/fees/booking-fee | 10 | 57.0 | 80.7 | 26.9 | 40.8 | 32.3 | 80.7 | 80.7 | 80.7 | 200x10 |
| PUT /admin/fees/{code} | 10 | 55.7 | 69.0 | 21.3 | 34.2 | 28.2 | 69.0 | 69.0 | 69.0 | 400x10 (!) |
| GET /admin/payment-exceptions | 10 | 17.7 | 12.2 | 12.0 | 15.1 | 14.0 | 20.7 | 20.7 | 20.7 | 200x10 |
| GET /admin/payment-recovery/summary | 10 | 25.9 | 18.9 | 14.3 | 21.0 | 19.0 | 30.4 | 30.4 | 30.4 | 200x10 |

### Admin - Replacements

| Operation | n | 1st | 2nd | min | avg | p50 | p95 | p99 | max | Status |
|---|---|---|---|---|---|---|---|---|---|---|
| GET /admin/replacement-requests | 10 | 16.4 | 151 | 16.0 | 34.2 | 19.6 | 151 | 151 | 151 | 200x10 |
| GET /admin/replacement-requests/{requestId} | 10 | 14.3 | 69.6 | 12.3 | 21.0 | 14.3 | 69.6 | 69.6 | 69.6 | 200x10 |
| GET /admin/replacement-requests/{requestId}/candidates | 10 | 76.9 | 176 | 66.5 | 102 | 82.1 | 176 | 176 | 176 | 200x10 |
| POST /admin/replacement-requests/{requestId}/reject | 10 | 103 | 285 | 58.7 | 107 | 85.1 | 285 | 285 | 285 | 200x10 |
| POST /admin/replacement-requests/{requestId}/approve | 20 | 59.0 | 55.7 | 40.6 | 66.0 | 56.5 | 128 | 129 | 129 | 200x20 |
| POST /admin/replacement-requests/{requestId}/select | 10 | 113 | 106 | 53.8 | 75.5 | 70.2 | 113 | 113 | 113 | 409x10 |

### Admin - Reports

| Operation | n | 1st | 2nd | min | avg | p50 | p95 | p99 | max | Status |
|---|---|---|---|---|---|---|---|---|---|---|
| GET /admin/reports | 10 | 11.9 | 12.4 | 7.32 | 9.66 | 8.30 | 13.2 | 13.2 | 13.2 | 200x10 |
| GET /admin/reports/new-customers | 10 | 24.5 | 29.3 | 12.9 | 20.5 | 15.8 | 32.1 | 32.1 | 32.1 | 200x10 |
| GET /admin/reports/worker-registrations | 10 | 23.9 | 48.1 | 13.8 | 24.3 | 19.2 | 48.1 | 48.1 | 48.1 | 200x10 |
| GET /admin/reports/booking-funnel | 10 | 27.4 | 39.4 | 13.8 | 22.1 | 17.7 | 39.4 | 39.4 | 39.4 | 200x10 |
| GET /admin/reports/demand-by-category | 10 | 19.9 | 27.0 | 12.1 | 18.4 | 16.4 | 27.0 | 27.0 | 27.0 | 200x10 |
| GET /admin/reports/demand-by-area | 10 | 23.6 | 29.1 | 15.4 | 21.7 | 20.6 | 29.1 | 29.1 | 29.1 | 200x10 |
| GET /admin/reports/worker-utilization | 10 | 21.9 | 27.6 | 14.0 | 50.5 | 17.9 | 319 | 319 | 319 | 200x10 |
| GET /admin/reports/interview-conversion | 10 | 21.2 | 35.5 | 13.2 | 19.6 | 18.1 | 35.5 | 35.5 | 35.5 | 200x10 |
| GET /admin/reports/cancellation-rate | 10 | 18.0 | 46.2 | 12.1 | 19.6 | 16.0 | 46.2 | 46.2 | 46.2 | 200x10 |
| GET /admin/reports/replacement-rate | 10 | 21.2 | 27.8 | 14.5 | 20.9 | 17.3 | 33.4 | 33.4 | 33.4 | 200x10 |
| GET /admin/reports/payment-collections | 10 | 19.6 | 30.7 | 15.6 | 21.4 | 19.6 | 30.7 | 30.7 | 30.7 | 200x10 |
| GET /admin/reports/support-tickets | 10 | 22.6 | 36.2 | 19.2 | 30.3 | 22.6 | 73.6 | 73.6 | 73.6 | 200x10 |
| GET /admin/reports/top-rated-workers | 10 | 19.9 | 29.8 | 15.0 | 20.7 | 18.4 | 29.8 | 29.8 | 29.8 | 200x10 |
| GET /admin/reports/repeat-customers | 10 | 19.5 | 29.6 | 16.1 | 21.9 | 18.2 | 40.4 | 40.4 | 40.4 | 200x10 |
| GET /admin/reports/export/{report} | 10 | 24.5 | 31.2 | 15.1 | 23.6 | 18.4 | 40.5 | 40.5 | 40.5 | 200x10 |

### Admin - Roles

| Operation | n | 1st | 2nd | min | avg | p50 | p95 | p99 | max | Status |
|---|---|---|---|---|---|---|---|---|---|---|
| GET /admin/roles | 10 | 31.6 | 19.7 | 12.1 | 18.3 | 15.9 | 31.6 | 31.6 | 31.6 | 200x10 |
| GET /admin/permissions | 10 | 16.5 | 11.9 | 8.65 | 12.5 | 11.2 | 17.7 | 17.7 | 17.7 | 200x10 |
| GET /admin/roles/{roleCode} | 10 | 24.5 | 19.1 | 11.8 | 17.4 | 16.0 | 24.5 | 24.5 | 24.5 | 200x10 |
| PUT /admin/roles/{roleCode}/permissions | 10 | 69.3 | 44.2 | 26.9 | 46.4 | 36.5 | 104 | 104 | 104 | 200x10 |

### Admin - Safety

| Operation | n | 1st | 2nd | min | avg | p50 | p95 | p99 | max | Status |
|---|---|---|---|---|---|---|---|---|---|---|
| GET /admin/safety/reports | 10 | 13.3 | 20.2 | 9.76 | 13.1 | 11.8 | 20.2 | 20.2 | 20.2 | 200x10 |
| GET /admin/safety/blocks | 10 | 11.7 | 16.8 | 9.14 | 11.5 | 10.7 | 16.8 | 16.8 | 16.8 | 200x10 |
| POST /admin/safety/blocks | 10 | 35.9 | 176 | 25.8 | 47.8 | 33.6 | 176 | 176 | 176 | 200x10 |
| DELETE /admin/safety/blocks/{blockId} | 10 | 27.2 | 72.5 | 20.9 | 31.5 | 25.8 | 72.5 | 72.5 | 72.5 | 204x10 |

### Admin - Service Areas

| Operation | n | 1st | 2nd | min | avg | p50 | p95 | p99 | max | Status |
|---|---|---|---|---|---|---|---|---|---|---|
| POST /admin/service-areas | 10 | 45.9 | 34.7 | 19.4 | 35.3 | 25.0 | 99.6 | 99.6 | 99.6 | 201x10 |
| GET /admin/service-areas | 10 | 19.5 | 15.2 | 8.97 | 15.7 | 11.3 | 48.3 | 48.3 | 48.3 | 200x10 |
| GET /admin/service-areas/{areaId} | 10 | 18.0 | 14.7 | 8.27 | 12.6 | 10.7 | 24.1 | 24.1 | 24.1 | 200x10 |
| PATCH /admin/service-areas/{areaId} | 10 | 49.1 | 51.5 | 22.5 | 40.6 | 34.8 | 73.8 | 73.8 | 73.8 | 200x10 |

### Admin - Service Categories

| Operation | n | 1st | 2nd | min | avg | p50 | p95 | p99 | max | Status |
|---|---|---|---|---|---|---|---|---|---|---|
| POST /admin/service-categories | 10 | 45.4 | 35.1 | 19.8 | 31.7 | 27.3 | 47.9 | 47.9 | 47.9 | 201x10 |
| GET /admin/service-categories | 10 | 28.9 | 23.2 | 11.5 | 19.1 | 17.6 | 28.9 | 28.9 | 28.9 | 200x10 |
| GET /admin/service-categories/{categoryId} | 10 | 19.2 | 22.5 | 9.47 | 15.6 | 13.4 | 24.2 | 24.2 | 24.2 | 200x10 |
| PATCH /admin/service-categories/{categoryId} | 10 | 49.7 | 59.9 | 22.4 | 42.4 | 31.5 | 96.1 | 96.1 | 96.1 | 200x10 |
| PUT /admin/service-categories/{categoryId}/engagements | 10 | 53.6 | 71.5 | 27.7 | 47.9 | 37.1 | 88.1 | 88.1 | 88.1 | 200x10 |
| PUT /admin/pricing-guidance | 10 | 42.6 | 60.6 | 25.4 | 39.8 | 34.4 | 62.7 | 62.7 | 62.7 | 200x10 |
| GET /admin/pricing-guidance | 10 | 20.1 | 19.6 | 11.1 | 16.0 | 14.3 | 22.5 | 22.5 | 22.5 | 200x10 |
| DELETE /admin/pricing-guidance/{id} | 10 | 68.4 | 38.4 | 23.7 | 41.5 | 27.1 | 122 | 122 | 122 | 204x10 |

### Admin - Support

| Operation | n | 1st | 2nd | min | avg | p50 | p95 | p99 | max | Status |
|---|---|---|---|---|---|---|---|---|---|---|
| POST /admin/support/categories | 10 | 34.1 | 30.9 | 22.3 | 28.7 | 27.5 | 36.0 | 36.0 | 36.0 | 201x10 |
| GET /admin/support/categories | 10 | 14.5 | 13.4 | 9.54 | 12.0 | 11.2 | 14.6 | 14.6 | 14.6 | 200x10 |
| PATCH /admin/support/categories/{categoryId} | 10 | 37.6 | 35.6 | 21.8 | 30.5 | 28.7 | 37.6 | 37.6 | 37.6 | 200x10 |
| GET /admin/support/tickets | 10 | 14.4 | 19.7 | 12.0 | 19.4 | 14.4 | 36.9 | 36.9 | 36.9 | 200x10 |
| GET /admin/support/tickets/{ticketId} | 10 | 15.1 | 21.7 | 11.1 | 17.7 | 15.1 | 27.5 | 27.5 | 27.5 | 200x10 |
| POST /admin/support/tickets/{ticketId}/assign | 10 | 62.9 | 83.9 | 44.7 | 64.7 | 56.2 | 113 | 113 | 113 | 200x10 |
| POST /admin/support/tickets/{ticketId}/priority | 10 | 57.5 | 59.7 | 32.1 | 44.7 | 41.9 | 59.7 | 59.7 | 59.7 | 200x10 |
| POST /admin/support/tickets/{ticketId}/escalate | 10 | 58.6 | 108 | 34.5 | 50.9 | 44.2 | 108 | 108 | 108 | 200x10 |
| POST /admin/support/tickets/{ticketId}/messages | 10 | 39.9 | 49.2 | 28.5 | 36.8 | 35.6 | 49.2 | 49.2 | 49.2 | 201x10 |
| GET /admin/support/tickets/{ticketId}/messages | 10 | 17.0 | 22.7 | 12.7 | 15.5 | 14.4 | 22.7 | 22.7 | 22.7 | 200x10 |
| POST /admin/support/tickets/{ticketId}/close | 10 | 48.3 | 78.4 | 38.2 | 46.8 | 42.2 | 78.4 | 78.4 | 78.4 | 200x10 |

### Admin - System

| Operation | n | 1st | 2nd | min | avg | p50 | p95 | p99 | max | Status |
|---|---|---|---|---|---|---|---|---|---|---|
| GET /admin/system/readiness | 10 | 48.1 | 81.9 | 12.0 | 36.8 | 35.0 | 81.9 | 81.9 | 81.9 | 200x10 |

### Admin - Users

| Operation | n | 1st | 2nd | min | avg | p50 | p95 | p99 | max | Status |
|---|---|---|---|---|---|---|---|---|---|---|
| POST /admin/users | 10 | 583 | 498 | 400 | 491 | 438 | 724 | 724 | 724 | 201x10 |
| GET /admin/users | 10 | 32.4 | 16.5 | 13.4 | 17.7 | 14.8 | 32.4 | 32.4 | 32.4 | 200x10 |
| GET /admin/users/{userId} | 10 | 18.9 | 10.6 | 8.16 | 11.1 | 10.1 | 18.9 | 18.9 | 18.9 | 200x10 |
| PUT /admin/users/{userId}/role | 10 | 78.2 | 48.1 | 33.2 | 45.7 | 39.3 | 78.2 | 78.2 | 78.2 | 200x10 |
| POST /admin/users/{userId}/password-reset | 10 | 467 | 543 | 388 | 473 | 435 | 618 | 618 | 618 | 200x10 |
| PATCH /admin/users/{userId}/status | 10 | 58.6 | 42.6 | 23.6 | 37.9 | 31.4 | 61.3 | 61.3 | 61.3 | 200x10 |

### Admin - Verification

| Operation | n | 1st | 2nd | min | avg | p50 | p95 | p99 | max | Status |
|---|---|---|---|---|---|---|---|---|---|---|
| GET /admin/verification/requirements | 10 | 17.1 | 15.9 | 8.67 | 12.1 | 11.3 | 17.1 | 17.1 | 17.1 | 200x10 |
| PUT /admin/verification/requirements | 10 | 44.1 | 32.7 | 21.9 | 29.5 | 27.3 | 44.1 | 44.1 | 44.1 | 200x10 |
| GET /admin/verification/queue | 10 | 38.7 | 29.8 | 23.2 | 34.0 | 28.5 | 69.8 | 69.8 | 69.8 | 200x10 |
| GET /admin/workers/{workerId}/verification | 10 | 31.8 | 25.8 | 18.9 | 26.1 | 24.5 | 39.5 | 39.5 | 39.5 | 200x10 |
| POST /admin/verification/checks/{checkId}/start-review | 20 | 52.6 | 61.2 | 34.8 | 48.1 | 49.0 | 62.4 | 62.6 | 62.6 | 200x20 |
| POST /admin/verification/checks/{checkId}/approve | 10 | 59.0 | 52.4 | 39.9 | 58.5 | 57.3 | 92.3 | 92.3 | 92.3 | 200x10 |
| GET /admin/verification/documents/{documentId}/link | 10 | 29.7 | 41.6 | 21.7 | 32.7 | 29.7 | 46.1 | 46.1 | 46.1 | 200x10 |
| POST /admin/verification/checks/{checkId}/reject | 10 | 80.7 | 54.4 | 37.8 | 53.2 | 50.3 | 80.7 | 80.7 | 80.7 | 200x10 |
| POST /admin/verification/checks/{checkId}/recheck | 10 | 50.3 | 75.3 | 36.8 | 51.6 | 41.4 | 75.3 | 75.3 | 75.3 | 200x10 |

### Admin - Worker Availability

| Operation | n | 1st | 2nd | min | avg | p50 | p95 | p99 | max | Status |
|---|---|---|---|---|---|---|---|---|---|---|
| GET /admin/workers/{workerId}/availability | 10 | 23.7 | 15.4 | 14.9 | 19.8 | 17.4 | 27.0 | 27.0 | 27.0 | 200x10 |
| PATCH /admin/workers/{workerId}/availability | 10 | 68.1 | 49.7 | 47.2 | 57.7 | 51.8 | 73.0 | 73.0 | 73.0 | 200x10 |

### Admin - Workers

| Operation | n | 1st | 2nd | min | avg | p50 | p95 | p99 | max | Status |
|---|---|---|---|---|---|---|---|---|---|---|
| GET /admin/workers | 10 | 24.5 | 27.6 | 19.3 | 27.9 | 22.4 | 62.6 | 62.6 | 62.6 | 200x10 |
| POST /admin/workers | 10 | 55.5 | 72.3 | 45.2 | 73.7 | 55.8 | 219 | 219 | 219 | 201x10 |
| GET /admin/workers/{workerId} | 10 | 27.8 | 38.5 | 24.4 | 37.8 | 29.7 | 73.4 | 73.4 | 73.4 | 200x10 |
| PATCH /admin/workers/{workerId} | 10 | 61.8 | 66.3 | 45.1 | 58.5 | 55.5 | 82.4 | 82.4 | 82.4 | 200x10 |
| PUT /admin/workers/{workerId}/categories | 10 | 136 | 55.1 | 40.8 | 69.8 | 63.7 | 136 | 136 | 136 | 200x10 |
| GET /admin/workers/{workerId}/references | 10 | 42.4 | 26.6 | 23.2 | 31.0 | 27.8 | 42.4 | 42.4 | 42.4 | 200x10 |

### Admin account

| Operation | n | 1st | 2nd | min | avg | p50 | p95 | p99 | max | Status |
|---|---|---|---|---|---|---|---|---|---|---|
| POST /admin/account/password | 10 | 874 | 1498 | 746 | 988 | 874 | 1498 | 1498 | 1498 | 200x10 |

### App

| Operation | n | 1st | 2nd | min | avg | p50 | p95 | p99 | max | Status |
|---|---|---|---|---|---|---|---|---|---|---|
| GET /app-config | 10 | 15.9 | 8.51 | 4.48 | 7.09 | 5.55 | 15.9 | 15.9 | 15.9 | 200x10 |
| GET /reference-data | 10 | 16.7 | 9.22 | 4.83 | 8.39 | 6.93 | 16.7 | 16.7 | 16.7 | 200x10 |

### Auth

| Operation | n | 1st | 2nd | min | avg | p50 | p95 | p99 | max | Status |
|---|---|---|---|---|---|---|---|---|---|---|
| POST /auth/admin/login | 10 | 577 | 393 | 372 | 490 | 395 | 771 | 771 | 771 | 200x10 |
| POST /auth/otp/request | 40 | 18.5 | 14.0 | 8.89 | 14.6 | 11.8 | 25.8 | 73.7 | 73.7 | 200x40 |
| POST /auth/otp/verify | 40 | 40.8 | 41.9 | 22.5 | 35.0 | 31.8 | 48.5 | 68.8 | 68.8 | 200x40 |
| POST /auth/token/refresh | 10 | 13.2 | 11.9 | 8.60 | 17.6 | 10.2 | 83.9 | 83.9 | 83.9 | 200x10 |
| GET /auth/sessions | 20 | 12.0 | 7.97 | 6.28 | 10.7 | 8.39 | 20.6 | 35.8 | 35.8 | 200x20 |
| PUT /auth/device-token | 10 | 26.4 | 18.7 | 14.3 | 23.4 | 17.3 | 75.1 | 75.1 | 75.1 | 204x10 |
| DELETE /auth/device-token | 10 | 10.2 | 9.27 | 7.41 | 10.5 | 8.67 | 26.3 | 26.3 | 26.3 | 204x10 |
| DELETE /auth/sessions/{sessionId} | 10 | 11.7 | 15.1 | 8.76 | 12.9 | 9.96 | 31.5 | 31.5 | 31.5 | 404x10 |
| POST /auth/logout | 10 | 20.5 | 25.5 | 14.0 | 23.5 | 15.3 | 67.3 | 67.3 | 67.3 | 204x10 |

### Bookings

| Operation | n | 1st | 2nd | min | avg | p50 | p95 | p99 | max | Status |
|---|---|---|---|---|---|---|---|---|---|---|
| POST /bookings | 20 | 35.3 | 110 | 20.7 | 56.6 | 43.9 | 110 | 129 | 129 | 201x10 422x10 (!) |
| POST /workers/me/bookings/{bookingId}/{action} | 20 | 102 | 68.5 | 42.0 | 69.8 | 62.4 | 107 | 112 | 112 | 200x20 |
| PUT /workers/me/bookings/{bookingId}/slot-proposal | 10 | 113 | 29.3 | 19.4 | 35.3 | 22.4 | 113 | 113 | 113 | 409x10 |
| POST /bookings/{bookingId}/slot-proposal/{answer} | 10 | 15.6 | 17.2 | 10.0 | 13.4 | 12.6 | 17.2 | 17.2 | 17.2 | 409x10 |
| POST /bookings/{bookingId}/{action} | 10 | 63.6 | 94.6 | 36.3 | 59.1 | 54.9 | 94.6 | 94.6 | 94.6 | 200x10 |

### Customer

| Operation | n | 1st | 2nd | min | avg | p50 | p95 | p99 | max | Status |
|---|---|---|---|---|---|---|---|---|---|---|
| GET /customers/me/home | 10 | 156 | 79.0 | 60.1 | 102 | 67.8 | 262 | 262 | 262 | 200x10 |

### Customers

| Operation | n | 1st | 2nd | min | avg | p50 | p95 | p99 | max | Status |
|---|---|---|---|---|---|---|---|---|---|---|
| POST /customers/me | 10 | 26.3 | 22.7 | 15.1 | 20.6 | 16.6 | 30.1 | 30.1 | 30.1 | 201x10 |
| GET /customers/me | 10 | 10.7 | 10.4 | 6.97 | 9.35 | 9.29 | 11.8 | 11.8 | 11.8 | 200x10 |
| PATCH /customers/me | 10 | 35.8 | 27.6 | 21.3 | 26.9 | 23.4 | 35.9 | 35.9 | 35.9 | 200x10 |
| GET /customers/me/onboarding | 10 | 17.1 | 13.7 | 8.86 | 12.6 | 11.8 | 17.1 | 17.1 | 17.1 | 200x10 |
| POST /customers/me/addresses | 20 | 71.6 | 44.0 | 28.2 | 42.9 | 36.2 | 71.6 | 76.3 | 76.3 | 201x20 |
| GET /customers/me/addresses | 10 | 11.1 | 11.6 | 9.25 | 12.3 | 11.1 | 22.8 | 22.8 | 22.8 | 200x10 |
| GET /customers/me/addresses/{addressId} | 10 | 11.9 | 10.8 | 8.17 | 11.0 | 10.4 | 15.3 | 15.3 | 15.3 | 200x10 |
| PATCH /customers/me/addresses/{addressId} | 10 | 27.6 | 24.2 | 18.8 | 26.0 | 22.3 | 49.7 | 49.7 | 49.7 | 200x10 |
| PUT /customers/me/addresses/{addressId}/default | 10 | 19.9 | 28.1 | 14.6 | 20.4 | 19.9 | 28.8 | 28.8 | 28.8 | 200x10 |
| DELETE /customers/me/addresses/{addressId} | 10 | 36.6 | 31.3 | 18.0 | 49.9 | 25.8 | 257 | 257 | 257 | 204x10 |

### Interviews and trials

| Operation | n | 1st | 2nd | min | avg | p50 | p95 | p99 | max | Status |
|---|---|---|---|---|---|---|---|---|---|---|
| POST /interviews | 30 | 65.9 | 51.1 | 26.0 | 39.5 | 34.2 | 61.6 | 65.9 | 65.9 | 201x30 |
| POST /interviews/{interviewId}/cancel | 10 | 42.5 | 24.7 | 15.9 | 20.9 | 17.1 | 42.5 | 42.5 | 42.5 | 409x10 |

### Legal

| Operation | n | 1st | 2nd | min | avg | p50 | p95 | p99 | max | Status |
|---|---|---|---|---|---|---|---|---|---|---|
| GET /legal/current | 10 | 3.96 | 2.97 | 1.81 | 2.53 | 2.35 | 3.96 | 3.96 | 3.96 | 200x10 |
| GET /legal/status | 10 | 11.6 | 10.2 | 7.47 | 9.53 | 8.46 | 12.2 | 12.2 | 12.2 | 200x10 |
| POST /legal/accept | 10 | 7.33 | 8.84 | 4.88 | 6.97 | 6.92 | 9.31 | 9.31 | 9.31 | 409x10 |

### Notifications

| Operation | n | 1st | 2nd | min | avg | p50 | p95 | p99 | max | Status |
|---|---|---|---|---|---|---|---|---|---|---|
| GET /notifications | 10 | 20.2 | 32.6 | 10.1 | 15.8 | 13.4 | 32.6 | 32.6 | 32.6 | 200x10 |
| GET /notifications/unread-count | 10 | 8.35 | 17.0 | 5.80 | 8.41 | 6.98 | 17.0 | 17.0 | 17.0 | 200x10 |
| POST /notifications/{notificationId}/read | 4 | 13.3 | 23.8 | 9.92 | 14.5 | 10.8 | 23.8 | 23.8 | 23.8 | 204x4 |
| POST /notifications/{notificationId}/unread | 4 | 13.3 | 25.4 | 9.02 | 14.6 | 10.8 | 25.4 | 25.4 | 25.4 | 204x4 |
| POST /notifications/read-all | 10 | 11.8 | 20.3 | 6.05 | 9.70 | 8.01 | 20.3 | 20.3 | 20.3 | 200x10 |

### Pricing

| Operation | n | 1st | 2nd | min | avg | p50 | p95 | p99 | max | Status |
|---|---|---|---|---|---|---|---|---|---|---|
| GET /pricing/guidance | 10 | 16.4 | 12.0 | 7.77 | 13.0 | 12.0 | 19.6 | 19.6 | 19.6 | 404x10 |

### Replacements

| Operation | n | 1st | 2nd | min | avg | p50 | p95 | p99 | max | Status |
|---|---|---|---|---|---|---|---|---|---|---|
| POST /replacement-requests | 40 | 70.8 | 53.6 | 37.8 | 75.1 | 52.1 | 124 | 590 | 590 | 201x40 |
| GET /replacement-requests | 10 | 12.9 | 34.6 | 8.14 | 13.7 | 11.0 | 34.6 | 34.6 | 34.6 | 200x10 |
| GET /replacement-requests/{requestId} | 10 | 16.7 | 21.7 | 9.75 | 16.7 | 13.3 | 42.2 | 42.2 | 42.2 | 200x10 |
| POST /replacement-requests/{requestId}/cancel | 10 | 48.4 | 75.0 | 37.7 | 53.9 | 48.4 | 81.1 | 81.1 | 81.1 | 200x10 |
| GET /replacement-requests/{requestId}/alternatives | 10 | 58.6 | 188 | 58.6 | 93.9 | 71.6 | 188 | 188 | 188 | 200x10 |
| POST /replacement-requests/{requestId}/select | 10 | 116 | 336 | 81.2 | 147 | 116 | 336 | 336 | 336 | 200x10 |

### Safety

| Operation | n | 1st | 2nd | min | avg | p50 | p95 | p99 | max | Status |
|---|---|---|---|---|---|---|---|---|---|---|
| POST /safety/blocks | 10 | 28.6 | 41.2 | 18.6 | 24.7 | 21.1 | 41.2 | 41.2 | 41.2 | 200x10 |
| GET /safety/blocks | 10 | 13.6 | 26.4 | 9.62 | 13.6 | 11.9 | 26.4 | 26.4 | 26.4 | 200x10 |
| DELETE /safety/blocks/{blockId} | 10 | 16.2 | 31.6 | 12.5 | 17.2 | 15.4 | 31.6 | 31.6 | 31.6 | 204x10 |
| POST /safety/reports | 10 | 7.52 | 9.62 | 5.25 | 7.08 | 7.20 | 9.62 | 9.62 | 9.62 | 400x10 |

### Search

| Operation | n | 1st | 2nd | min | avg | p50 | p95 | p99 | max | Status |
|---|---|---|---|---|---|---|---|---|---|---|
| GET /search/workers | 10 | 34.7 | 27.9 | 27.9 | 38.4 | 33.6 | 74.1 | 74.1 | 74.1 | 200x10 |
| GET /search/workers/{workerId} | 10 | 12.4 | 8.36 | 8.10 | 10.7 | 9.75 | 14.1 | 14.1 | 14.1 | 404x10 (!) |
| GET /search/workers/{workerId}/slots | 10 | 11.9 | 9.72 | 9.21 | 11.2 | 11.0 | 14.0 | 14.0 | 14.0 | 404x10 (!) |
| GET /search/workers/{workerId}/ratings | 10 | 11.5 | 7.95 | 7.95 | 10.1 | 9.87 | 12.5 | 12.5 | 12.5 | 404x10 (!) |

### Service Areas

| Operation | n | 1st | 2nd | min | avg | p50 | p95 | p99 | max | Status |
|---|---|---|---|---|---|---|---|---|---|---|
| GET /service-areas | 10 | 13.0 | 9.20 | 6.78 | 9.05 | 7.86 | 13.0 | 13.0 | 13.0 | 200x10 |
| GET /service-areas/{areaId} | 10 | 9.58 | 7.65 | 6.02 | 8.36 | 7.99 | 11.8 | 11.8 | 11.8 | 200x10 |
| GET /locations/service-area | 10 | 16.5 | 13.6 | 9.89 | 13.9 | 13.6 | 19.8 | 19.8 | 19.8 | 200x10 |

### Service Categories

| Operation | n | 1st | 2nd | min | avg | p50 | p95 | p99 | max | Status |
|---|---|---|---|---|---|---|---|---|---|---|
| GET /service-categories | 10 | 17.1 | 11.9 | 9.20 | 12.7 | 11.5 | 17.3 | 17.3 | 17.3 | 200x10 |
| GET /service-categories/{categoryId} | 10 | 12.7 | 8.81 | 7.58 | 10.3 | 9.67 | 12.9 | 12.9 | 12.9 | 200x10 |

### Shortlist

| Operation | n | 1st | 2nd | min | avg | p50 | p95 | p99 | max | Status |
|---|---|---|---|---|---|---|---|---|---|---|
| PUT /shortlist/{workerId} | 10 | 11.9 | 9.64 | 8.54 | 10.7 | 9.64 | 17.4 | 17.4 | 17.4 | 404x10 (!) |
| GET /shortlist | 10 | 10.7 | 9.66 | 8.03 | 9.87 | 9.38 | 14.8 | 14.8 | 14.8 | 200x10 |
| DELETE /shortlist/{workerId} | 10 | 8.91 | 6.97 | 6.02 | 8.14 | 6.97 | 15.2 | 15.2 | 15.2 | 204x10 |

### Support

| Operation | n | 1st | 2nd | min | avg | p50 | p95 | p99 | max | Status |
|---|---|---|---|---|---|---|---|---|---|---|
| POST /support/tickets | 20 | 43.4 | 30.4 | 21.4 | 31.7 | 30.4 | 43.4 | 45.4 | 45.4 | 201x20 |
| GET /support/categories | 10 | 8.31 | 12.2 | 6.42 | 8.69 | 7.32 | 12.3 | 12.3 | 12.3 | 200x10 |
| GET /support/tickets | 10 | 13.3 | 14.3 | 8.87 | 12.2 | 11.4 | 18.7 | 18.7 | 18.7 | 200x10 |
| GET /support/tickets/{ticketId} | 10 | 13.8 | 19.0 | 9.59 | 13.9 | 13.8 | 19.0 | 19.0 | 19.0 | 200x10 |
| POST /support/tickets/{ticketId}/messages | 10 | 29.6 | 46.4 | 19.2 | 27.4 | 24.2 | 46.4 | 46.4 | 46.4 | 201x10 |
| GET /support/tickets/{ticketId}/messages | 10 | 14.0 | 16.8 | 11.1 | 15.6 | 13.9 | 25.0 | 25.0 | 25.0 | 200x10 |

### Users

| Operation | n | 1st | 2nd | min | avg | p50 | p95 | p99 | max | Status |
|---|---|---|---|---|---|---|---|---|---|---|
| GET /users/me | 10 | 26.2 | 17.3 | 10.9 | 17.9 | 16.0 | 29.6 | 29.6 | 29.6 | 200x10 |

### Verification

| Operation | n | 1st | 2nd | min | avg | p50 | p95 | p99 | max | Status |
|---|---|---|---|---|---|---|---|---|---|---|
| GET /workers/me/verification | 10 | 22.6 | 15.3 | 14.4 | 20.3 | 15.7 | 38.0 | 38.0 | 38.0 | 200x10 |
| POST /workers/me/verification/checks/{checkType}/documents | 10 | 51.8 | 35.9 | 29.2 | 46.2 | 35.9 | 86.5 | 86.5 | 86.5 | 201x10 |
| POST /workers/me/verification/documents/{documentId}/confirm | 10 | 50.7 | 41.7 | 32.7 | 46.2 | 41.7 | 64.1 | 64.1 | 64.1 | 200x10 |
| POST /workers/me/verification/checks/{checkType}/submit | 10 | 58.4 | 60.2 | 45.1 | 64.2 | 57.6 | 122 | 122 | 122 | 200x10 |

### Worker Availability

| Operation | n | 1st | 2nd | min | avg | p50 | p95 | p99 | max | Status |
|---|---|---|---|---|---|---|---|---|---|---|
| PATCH /workers/me/availability | 10 | 73.8 | 65.9 | 42.4 | 62.7 | 55.7 | 141 | 141 | 141 | 200x10 |
| GET /workers/me/availability | 10 | 23.9 | 15.0 | 12.4 | 23.2 | 15.0 | 82.4 | 82.4 | 82.4 | 200x10 |

### Worker interviews and trials

| Operation | n | 1st | 2nd | min | avg | p50 | p95 | p99 | max | Status |
|---|---|---|---|---|---|---|---|---|---|---|
| POST /workers/me/interviews/{interviewId}/propose | 20 | 49.2 | 43.1 | 27.5 | 39.0 | 35.1 | 53.0 | 56.5 | 56.5 | 200x20 |
| POST /workers/me/interviews/{interviewId}/decline | 10 | 56.2 | 52.3 | 30.2 | 41.1 | 34.5 | 63.4 | 63.4 | 63.4 | 200x10 |
| POST /workers/me/interviews/{interviewId}/accept | 10 | 66.8 | 99.0 | 42.7 | 59.1 | 46.2 | 99.0 | 99.0 | 99.0 | 200x10 |
| POST /workers/me/interviews/{interviewId}/cancel | 10 | 51.4 | 80.7 | 33.2 | 48.4 | 42.0 | 80.7 | 80.7 | 80.7 | 200x10 |

### Worker onboarding

| Operation | n | 1st | 2nd | min | avg | p50 | p95 | p99 | max | Status |
|---|---|---|---|---|---|---|---|---|---|---|
| GET /workers/me/onboarding | 10 | 27.1 | 21.7 | 18.5 | 23.2 | 21.1 | 32.1 | 32.1 | 32.1 | 200x10 |

### Worker photo

| Operation | n | 1st | 2nd | min | avg | p50 | p95 | p99 | max | Status |
|---|---|---|---|---|---|---|---|---|---|---|
| POST /workers/me/photo | 10 | 38.2 | 26.4 | 22.1 | 42.9 | 27.1 | 154 | 154 | 154 | 201x10 |
| POST /workers/me/photo/{photoId}/confirm | 10 | 74.5 | 51.6 | 48.1 | 119 | 60.4 | 537 | 537 | 537 | 200x10 |
| GET /workers/me/photo | 10 | 14.8 | 14.6 | 9.98 | 16.0 | 14.6 | 24.7 | 24.7 | 24.7 | 200x10 |

### Workers

| Operation | n | 1st | 2nd | min | avg | p50 | p95 | p99 | max | Status |
|---|---|---|---|---|---|---|---|---|---|---|
| POST /workers/me | 10 | 45.1 | 29.5 | 23.8 | 33.8 | 30.3 | 45.7 | 45.7 | 45.7 | 201x10 |
| PATCH /workers/me | 10 | 79.9 | 67.5 | 38.5 | 63.6 | 58.6 | 90.5 | 90.5 | 90.5 | 200x10 |
| PUT /workers/me/categories | 10 | 67.4 | 51.1 | 35.5 | 68.6 | 45.3 | 231 | 231 | 231 | 200x10 |
| PUT /workers/me/references | 10 | 54.7 | 38.4 | 27.3 | 42.9 | 35.5 | 82.8 | 82.8 | 82.8 | 200x10 |
| GET /workers/me/references | 10 | 17.5 | 15.9 | 11.0 | 15.7 | 14.1 | 25.8 | 25.8 | 25.8 | 200x10 |
| POST /workers/me/submit | 10 | 54.2 | 51.5 | 35.4 | 55.1 | 51.0 | 79.7 | 79.7 | 79.7 | 200x10 |
| GET /workers/me | 10 | 15.6 | 15.4 | 12.6 | 16.7 | 15.6 | 23.3 | 23.3 | 23.3 | 200x10 |

### health

| Operation | n | 1st | 2nd | min | avg | p50 | p95 | p99 | max | Status |
|---|---|---|---|---|---|---|---|---|---|---|
| GET /health/live | 10 | 51.0 | 2.67 | 1.68 | 7.41 | 2.29 | 51.0 | 51.0 | 51.0 | 200x10 |
| GET /health/ready | 10 | 27.3 | 4.66 | 3.48 | 6.88 | 4.38 | 27.3 | 27.3 | 27.3 | 200x10 |

## Not exercised (98)

* GET /users/me/notification-preferences
* PUT /users/me/notification-preferences
* POST /admin/deletion-requests/{requestId}/reject
* PUT /workers/me/criminal-declaration
* POST /admin/workers/{workerId}/blacklist
* POST /admin/workers/{workerId}/blacklist/lift
* POST /admin/workers/{workerId}/emergency-contact/reveal
* PUT /admin/service-categories/{categoryId}/image
* DELETE /admin/service-categories/{categoryId}/image
* POST /customers/me/photo
* GET /customers/me/photo
* POST /customers/me/photo/{photoId}/confirm
* POST /workers/me/attendance/bookings/{bookingId}
* GET /workers/me/attendance/bookings/{bookingId}
* POST /workers/me/attendance/bookings/{bookingId}/check-in
* POST /workers/me/attendance/bookings/{bookingId}/check-out
* GET /workers/me/attendance/bookings/{bookingId}/summary
* GET /attendance/bookings/{bookingId}
* GET /attendance/bookings/{bookingId}/summary
* POST /attendance/bookings/{bookingId}/exceptions
* GET /admin/attendance/bookings/{bookingId}
* POST /admin/attendance/bookings/{bookingId}
* GET /admin/attendance/bookings/{bookingId}/summary
* PATCH /admin/attendance/{attendanceId}
* GET /bookings
* POST /bookings/rebook
* GET /bookings/{bookingId}
* GET /bookings/{bookingId}/replacement-chain
* GET /workers/me/bookings
* GET /workers/me/bookings/{bookingId}
* GET /workers/me/opportunities
* GET /admin/bookings
* GET /admin/bookings/{bookingId}
* GET /admin/bookings/{bookingId}/replacement-chain
* GET /bookings/{bookingId}/interviews
* GET /interviews
* GET /interviews/{interviewId}
* POST /interviews/{interviewId}/reschedule
* POST /interviews/{interviewId}/accept-proposal
* POST /interviews/{interviewId}/reject-proposal
* POST /interviews/{interviewId}/complete
* GET /workers/me/interviews
* GET /workers/me/interviews/{interviewId}
* GET /admin/interviews
* GET /admin/bookings/{bookingId}/interviews
* GET /admin/interviews/{interviewId}
* POST /admin/outbox-events/{eventId}/retry
* GET /customers/me/booking-history
* GET /customers/me/booking-history/summary
* GET /fees/booking
* GET /fees/payable
* POST /fee-payments
* POST /payments
* GET /payments
* POST /payments/{paymentId}/verify
* GET /payments/{paymentId}/receipt
* GET /payments/{paymentId}/receipt/pdf
* GET /payments/{paymentId}
* GET /admin/payments
* GET /admin/payments-export
* GET /admin/payments/{paymentId}
* POST /admin/payments/{paymentId}/reconcile
* POST /admin/payments/{paymentId}/refund
* POST /admin/payment-exceptions/{exceptionId}/resolve
* POST /admin/fees
* GET /admin/fees/{code}
* PATCH /admin/fees/{code}
* DELETE /admin/fees/{code}
* GET /admin/app-settings
* PUT /admin/app-settings/{key}
* DELETE /admin/app-settings/{key}
* GET /admin/rating-tags
* POST /admin/rating-tags
* PATCH /admin/rating-tags/{code}
* POST /admin/verification/checks/{checkId}/release-review
* POST /admin/verification/checks/{checkId}/reassign-review
* POST /admin/verification/checks/{checkId}/notes
* PUT /admin/verification/checks/{checkId}/document-details
* POST /admin/workers/{workerId}/verification/sign-off
* POST /admin/workers/{workerId}/activate
* GET /workers/me/earnings
* POST /admin/wage-payments
* GET /admin/wage-payments
* POST /admin/wage-payments/{id}/correct
* POST /admin/wage-payments/{id}/void
* GET /admin/retention/preview
* POST /ratings
* GET /ratings
* GET /ratings/bookings/{bookingId}/eligibility
* GET /ratings/bookings/{bookingId}
* GET /ratings/{ratingId}
* GET /workers/me/ratings
* GET /workers/me/ratings/summary
* GET /admin/ratings
* GET /admin/ratings/workers/{workerId}/summary
* GET /admin/ratings/{ratingId}
* POST /admin/ratings/{ratingId}/hide
* POST /admin/ratings/{ratingId}/unhide

Steps skipped because a prerequisite was missing in at least one iteration: booking lifecycle; outbox retry; notification steps.

