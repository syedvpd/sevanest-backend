# Backend performance test results

Generated 2026-10-14T10:54:15.409Z. **Performance, not load**: one client, strictly sequential, 15 iterations of a sweep over every readable operation.

## How it was measured

* Target: https://sevanest-backend.onrender.com (read-only), measured from the machine below over the network, so the numbers INCLUDE network latency and TLS. Only public API calls were used; ids come from the target's own data. The first request of the run is GET /health/live, so a sleeping free-tier service shows its cold start as that operation's 1st hit.
* Machine: 11th Gen Intel(R) Core(TM) i7-1185G7 @ 3.00GHz, 8 logical CPUs, 16 GB RAM, Node v24.21.0, win32.
* Each iteration calls every read (GET) operation it can fill in, in the role the route belongs to. The same operation is therefore hit once per iteration.
* **1st hit** = iteration 1 (first call after the process started: cold caches, query plans, JIT). **2nd hit** = iteration 2. p50/p95/p99, min, avg, max use all 15 samples (nearest-rank; with 15 samples p95 and p99 equal the slowest sample).
* Times are end-to-end milliseconds for the HTTP call including reading the whole body.

## Summary

| | value |
|---|---|
| Operations in the API | 267 |
| Operations exercised | 134 (50.2 %) |
| Requests timed | 1972 |
| Overall p50 / p95 / p99 (all requests) | 110 / 204 / 522 ms |
| Warm requests only (iteration 3 onwards) p50 / p95 / p99 | 110 / 201 / 518 ms |
| 1st-hit median across operations | 112 ms |
| 2nd-hit median across operations | 109 ms |
| Operations with p95 above 100 ms | 133 |
| Operations with p95 above 250 ms | 38 |
| Operations whose status was not the expected one | 5 |

### Reading the numbers

* **Network baseline**: GET /health/live (no database work) has a p50 of 81.1 ms from this machine, so about that much of every call is network, TLS and routing. A typical read costs 28.8 ms more than that.
* **Cold start**: the first request of the run answered in 390 ms, so the service was awake; run again after about 15 minutes idle to measure a cold start.
* **Spikes**: 12 operations have a slowest call more than 5 times their median (and above 400 ms): GET /admin/permissions, GET /legal/status, GET /admin/service-categories, GET /customers/me/home, GET /bookings, GET /interviews/{interviewId}, GET /admin/safety/blocks, GET /admin/verification/queue. Single slow calls spread over unrelated endpoints point at shared infrastructure (a throttled free-tier CPU, the database pooler, a noisy network) rather than at one query.
* **Password hashing**: POST /auth/admin/login (n=1) is slow by design and slower on a small CPU.
* **Not 2xx** (5): GET /admin/service-categories/{categoryId} 404x15; GET /search/workers/{workerId}/slots 200x14 500x1; GET /payments/{paymentId}/receipt 409x15; GET /payments/{paymentId}/receipt/pdf 409x15; GET /ratings/bookings/{bookingId} 404x15. Statuses such as 404 or 409 for a missing rating or an unpaid receipt are correct empty-state answers; a 500 is not and needs the server log for its request id.

### Slowest 15 operations by p95 (ms)

| Operation | 1st | 2nd | p50 | p95 | max |
|---|---|---|---|---|---|
| POST /auth/admin/login | 2939 | NaN | 2939 | 2939 | 2939 |
| GET /admin/dashboard | 164 | 124 | 143 | 1135 | 1135 |
| GET /admin/permissions | 123 | 102 | 105 | 1094 | 1094 |
| GET /bookings | 118 | 94.3 | 103 | 951 | 951 |
| GET /interviews/{interviewId} | 109 | 108 | 101 | 929 | 929 |
| GET /admin/service-categories | 120 | 108 | 113 | 871 | 871 |
| GET /admin/reports/demand-by-area | 115 | 123 | 120 | 863 | 863 |
| GET /admin/verification/queue | 116 | 842 | 112 | 842 | 842 |
| GET /admin/ratings/{ratingId} | 114 | 163 | 112 | 816 | 816 |
| GET /legal/status | 97.5 | 111 | 98.9 | 808 | 808 |
| GET /admin/reports/new-customers | 121 | 131 | 123 | 802 | 802 |
| GET /admin/safety/blocks | 104 | 100 | 110 | 758 | 758 |
| GET /search/workers/{workerId}/slots | 316 | 241 | 198 | 690 | 690 |
| GET /customers/me/home | 111 | 103 | 111 | 596 | 596 |
| GET /admin/deletion-requests | 535 | 220 | 232 | 535 | 535 |

### Largest cold-start penalty (1st hit minus p50, ms)

| Operation | 1st | 2nd | p50 | p95 | max |
|---|---|---|---|---|---|
| GET /health/live | 390 | 80.1 | 81.1 | 390 | 390 |
| GET /admin/deletion-requests | 535 | 220 | 232 | 535 | 535 |
| POST /auth/otp/verify | 341 | 131 | 131 | 341 | 341 |
| GET /admin/alerts/summary | 326 | 126 | 143 | 326 | 326 |
| GET /search/workers/{workerId}/slots | 316 | 241 | 198 | 690 | 690 |
| GET /admin/support/tickets/{ticketId} | 216 | 111 | 118 | 216 | 216 |
| GET /admin/safety/reports | 198 | 105 | 109 | 198 | 198 |
| GET /admin/reports/demand-by-category | 196 | 132 | 120 | 196 | 196 |
| GET /admin/alerts | 211 | 133 | 138 | 257 | 257 |
| GET /admin/payments/{paymentId} | 340 | 236 | 268 | 408 | 408 |

## Every operation, by module

Columns are milliseconds. "Status" lists the HTTP statuses seen and how often (e.g. 200x15).

### Account

| Operation | n | 1st | 2nd | min | avg | p50 | p95 | p99 | max | Status |
|---|---|---|---|---|---|---|---|---|---|---|
| GET /me/deletion-request | 15 | 106 | 96.1 | 85.6 | 99.5 | 96.1 | 151 | 151 | 151 | 200x15 |

### Admin - Account deletion

| Operation | n | 1st | 2nd | min | avg | p50 | p95 | p99 | max | Status |
|---|---|---|---|---|---|---|---|---|---|---|
| GET /admin/deletion-requests | 15 | 535 | 220 | 182 | 254 | 232 | 535 | 535 | 535 | 200x15 |

### Admin - Alerts

| Operation | n | 1st | 2nd | min | avg | p50 | p95 | p99 | max | Status |
|---|---|---|---|---|---|---|---|---|---|---|
| GET /admin/alerts | 15 | 211 | 133 | 123 | 158 | 138 | 257 | 257 | 257 | 200x15 |
| GET /admin/alerts/summary | 15 | 326 | 126 | 121 | 170 | 143 | 326 | 326 | 326 | 200x15 |

### Admin - Attendance

| Operation | n | 1st | 2nd | min | avg | p50 | p95 | p99 | max | Status |
|---|---|---|---|---|---|---|---|---|---|---|
| GET /admin/attendance/bookings/{bookingId} | 15 | 111 | 113 | 96.8 | 113 | 113 | 129 | 129 | 129 | 200x15 |
| GET /admin/attendance/bookings/{bookingId}/summary | 15 | 120 | 112 | 99.5 | 113 | 113 | 127 | 127 | 127 | 200x15 |

### Admin - Audit

| Operation | n | 1st | 2nd | min | avg | p50 | p95 | p99 | max | Status |
|---|---|---|---|---|---|---|---|---|---|---|
| GET /admin/audit-logs | 15 | 144 | 105 | 102 | 116 | 112 | 144 | 144 | 144 | 200x15 |

### Admin - Bookings

| Operation | n | 1st | 2nd | min | avg | p50 | p95 | p99 | max | Status |
|---|---|---|---|---|---|---|---|---|---|---|
| GET /admin/bookings | 15 | 115 | 102 | 100 | 121 | 116 | 178 | 178 | 178 | 200x15 |
| GET /admin/bookings/{bookingId} | 15 | 116 | 113 | 106 | 126 | 116 | 187 | 187 | 187 | 200x15 |
| GET /admin/bookings/{bookingId}/replacement-chain | 15 | 123 | 119 | 109 | 128 | 119 | 187 | 187 | 187 | 200x15 |

### Admin - Customers

| Operation | n | 1st | 2nd | min | avg | p50 | p95 | p99 | max | Status |
|---|---|---|---|---|---|---|---|---|---|---|
| GET /admin/customers | 15 | 120 | 113 | 103 | 114 | 111 | 144 | 144 | 144 | 200x15 |
| GET /admin/customers/{customerId} | 15 | 120 | 112 | 102 | 116 | 113 | 139 | 139 | 139 | 200x15 |
| GET /admin/customers/{customerId}/notes | 15 | 155 | 110 | 100 | 119 | 113 | 160 | 160 | 160 | 200x15 |

### Admin - Dashboard

| Operation | n | 1st | 2nd | min | avg | p50 | p95 | p99 | max | Status |
|---|---|---|---|---|---|---|---|---|---|---|
| GET /admin/dashboard | 15 | 164 | 124 | 103 | 272 | 143 | 1135 | 1135 | 1135 | 200x15 |

### Admin - Interviews and trials

| Operation | n | 1st | 2nd | min | avg | p50 | p95 | p99 | max | Status |
|---|---|---|---|---|---|---|---|---|---|---|
| GET /admin/interviews | 15 | 106 | 113 | 97.0 | 116 | 111 | 160 | 160 | 160 | 200x15 |
| GET /admin/bookings/{bookingId}/interviews | 15 | 133 | 113 | 98.0 | 118 | 115 | 169 | 169 | 169 | 200x15 |
| GET /admin/interviews/{interviewId} | 15 | 126 | 154 | 110 | 129 | 126 | 176 | 176 | 176 | 200x15 |

### Admin - Notifications

| Operation | n | 1st | 2nd | min | avg | p50 | p95 | p99 | max | Status |
|---|---|---|---|---|---|---|---|---|---|---|
| GET /admin/notification-events | 15 | 107 | 117 | 93.5 | 106 | 106 | 129 | 129 | 129 | 200x15 |
| GET /admin/notification-templates | 15 | 118 | 109 | 97.5 | 110 | 109 | 126 | 126 | 126 | 200x15 |
| GET /admin/notification-templates/{templateId} | 15 | 111 | 115 | 102 | 140 | 111 | 522 | 522 | 522 | 200x15 |
| GET /admin/notifications | 15 | 101 | 108 | 96.0 | 124 | 113 | 307 | 307 | 307 | 200x15 |
| GET /admin/notifications/health | 15 | 103 | 101 | 98.0 | 112 | 108 | 156 | 156 | 156 | 200x15 |

### Admin - Payments

| Operation | n | 1st | 2nd | min | avg | p50 | p95 | p99 | max | Status |
|---|---|---|---|---|---|---|---|---|---|---|
| GET /admin/payments | 15 | 116 | 208 | 104 | 121 | 116 | 208 | 208 | 208 | 200x15 |
| GET /admin/payments-export | 15 | 137 | 127 | 110 | 136 | 134 | 183 | 183 | 183 | 200x15 |
| GET /admin/payments/{paymentId} | 15 | 340 | 236 | 184 | 282 | 268 | 408 | 408 | 408 | 200x15 |
| GET /admin/payment-exceptions | 15 | 108 | 107 | 93.6 | 124 | 108 | 341 | 341 | 341 | 200x15 |
| GET /admin/payment-recovery/summary | 15 | 121 | 115 | 107 | 123 | 117 | 203 | 203 | 203 | 200x15 |
| GET /admin/fees | 15 | 99.2 | 101 | 99.2 | 110 | 110 | 132 | 132 | 132 | 200x15 |

### Admin - Ratings

| Operation | n | 1st | 2nd | min | avg | p50 | p95 | p99 | max | Status |
|---|---|---|---|---|---|---|---|---|---|---|
| GET /admin/ratings | 15 | 112 | 96.7 | 96.6 | 109 | 106 | 128 | 128 | 128 | 200x15 |
| GET /admin/ratings/workers/{workerId}/summary | 15 | 110 | 107 | 93.3 | 122 | 113 | 246 | 246 | 246 | 200x15 |
| GET /admin/ratings/{ratingId} | 15 | 114 | 163 | 93.7 | 162 | 112 | 816 | 816 | 816 | 200x15 |

### Admin - Replacements

| Operation | n | 1st | 2nd | min | avg | p50 | p95 | p99 | max | Status |
|---|---|---|---|---|---|---|---|---|---|---|
| GET /admin/replacement-requests | 15 | 120 | 105 | 99.4 | 120 | 116 | 161 | 161 | 161 | 200x15 |
| GET /admin/replacement-requests/{requestId} | 15 | 115 | 110 | 94.3 | 126 | 111 | 316 | 316 | 316 | 200x15 |
| GET /admin/replacement-requests/{requestId}/candidates | 15 | 172 | 162 | 156 | 211 | 201 | 362 | 362 | 362 | 200x15 |

### Admin - Reports

| Operation | n | 1st | 2nd | min | avg | p50 | p95 | p99 | max | Status |
|---|---|---|---|---|---|---|---|---|---|---|
| GET /admin/reports | 15 | 100 | 102 | 92.5 | 103 | 101 | 116 | 116 | 116 | 200x15 |
| GET /admin/reports/new-customers | 15 | 121 | 131 | 107 | 169 | 123 | 802 | 802 | 802 | 200x15 |
| GET /admin/reports/worker-registrations | 15 | 114 | 120 | 102 | 115 | 116 | 130 | 130 | 130 | 200x15 |
| GET /admin/reports/booking-funnel | 15 | 120 | 159 | 102 | 121 | 120 | 159 | 159 | 159 | 200x15 |
| GET /admin/reports/demand-by-category | 15 | 196 | 132 | 103 | 125 | 120 | 196 | 196 | 196 | 200x15 |
| GET /admin/reports/demand-by-area | 15 | 115 | 123 | 103 | 169 | 120 | 863 | 863 | 863 | 200x15 |
| GET /admin/reports/worker-utilization | 15 | 114 | 112 | 105 | 121 | 116 | 154 | 154 | 154 | 200x15 |
| GET /admin/reports/interview-conversion | 15 | 127 | 123 | 101 | 119 | 118 | 139 | 139 | 139 | 200x15 |
| GET /admin/reports/cancellation-rate | 15 | 117 | 114 | 100 | 118 | 116 | 145 | 145 | 145 | 200x15 |
| GET /admin/reports/replacement-rate | 15 | 122 | 108 | 108 | 126 | 119 | 184 | 184 | 184 | 200x15 |
| GET /admin/reports/payment-collections | 15 | 119 | 112 | 104 | 125 | 118 | 218 | 218 | 218 | 200x15 |
| GET /admin/reports/support-tickets | 15 | 121 | 156 | 111 | 151 | 141 | 313 | 313 | 313 | 200x15 |
| GET /admin/reports/top-rated-workers | 15 | 124 | 119 | 108 | 121 | 124 | 132 | 132 | 132 | 200x15 |
| GET /admin/reports/repeat-customers | 15 | 107 | 122 | 107 | 121 | 122 | 153 | 153 | 153 | 200x15 |

### Admin - Roles

| Operation | n | 1st | 2nd | min | avg | p50 | p95 | p99 | max | Status |
|---|---|---|---|---|---|---|---|---|---|---|
| GET /admin/roles | 15 | 114 | 110 | 106 | 123 | 120 | 162 | 162 | 162 | 200x15 |
| GET /admin/permissions | 15 | 123 | 102 | 99.3 | 181 | 105 | 1094 | 1094 | 1094 | 200x15 |
| GET /admin/roles/{roleCode} | 15 | 122 | 116 | 98.5 | 124 | 121 | 162 | 162 | 162 | 200x15 |

### Admin - Safety

| Operation | n | 1st | 2nd | min | avg | p50 | p95 | p99 | max | Status |
|---|---|---|---|---|---|---|---|---|---|---|
| GET /admin/safety/reports | 15 | 198 | 105 | 99.3 | 115 | 109 | 198 | 198 | 198 | 200x15 |
| GET /admin/safety/blocks | 15 | 104 | 100 | 98.1 | 156 | 110 | 758 | 758 | 758 | 200x15 |

### Admin - Service Areas

| Operation | n | 1st | 2nd | min | avg | p50 | p95 | p99 | max | Status |
|---|---|---|---|---|---|---|---|---|---|---|
| GET /admin/service-areas | 15 | 101 | 119 | 96.4 | 111 | 107 | 129 | 129 | 129 | 200x15 |
| GET /admin/service-areas/{areaId} | 15 | 102 | 116 | 94.3 | 116 | 111 | 186 | 186 | 186 | 200x15 |

### Admin - Service Categories

| Operation | n | 1st | 2nd | min | avg | p50 | p95 | p99 | max | Status |
|---|---|---|---|---|---|---|---|---|---|---|
| GET /admin/service-categories | 15 | 120 | 108 | 98.3 | 166 | 113 | 871 | 871 | 871 | 200x15 |
| GET /admin/service-categories/{categoryId} | 15 | 110 | 112 | 103 | 110 | 107 | 126 | 126 | 126 | 404x15 (!) |
| GET /admin/pricing-guidance | 15 | 111 | 110 | 103 | 112 | 111 | 120 | 120 | 120 | 200x15 |

### Admin - Support

| Operation | n | 1st | 2nd | min | avg | p50 | p95 | p99 | max | Status |
|---|---|---|---|---|---|---|---|---|---|---|
| GET /admin/support/tickets | 15 | 128 | 112 | 104 | 136 | 112 | 296 | 296 | 296 | 200x15 |
| GET /admin/support/tickets/{ticketId} | 15 | 216 | 111 | 101 | 126 | 118 | 216 | 216 | 216 | 200x15 |
| GET /admin/support/tickets/{ticketId}/messages | 15 | 115 | 125 | 102 | 119 | 119 | 132 | 132 | 132 | 200x15 |
| GET /admin/support/categories | 15 | 110 | 178 | 95.8 | 111 | 106 | 178 | 178 | 178 | 200x15 |

### Admin - System

| Operation | n | 1st | 2nd | min | avg | p50 | p95 | p99 | max | Status |
|---|---|---|---|---|---|---|---|---|---|---|
| GET /admin/system/readiness | 15 | 122 | 116 | 103 | 147 | 121 | 325 | 325 | 325 | 200x15 |

### Admin - Users

| Operation | n | 1st | 2nd | min | avg | p50 | p95 | p99 | max | Status |
|---|---|---|---|---|---|---|---|---|---|---|
| GET /admin/users | 15 | 126 | 127 | 109 | 124 | 118 | 182 | 182 | 182 | 200x15 |
| GET /admin/users/{userId} | 15 | 111 | 97.7 | 97.7 | 111 | 112 | 120 | 120 | 120 | 200x15 |

### Admin - Verification

| Operation | n | 1st | 2nd | min | avg | p50 | p95 | p99 | max | Status |
|---|---|---|---|---|---|---|---|---|---|---|
| GET /admin/verification/queue | 15 | 116 | 842 | 105 | 250 | 112 | 842 | 842 | 842 | 200x15 |
| GET /admin/verification/requirements | 15 | 115 | 321 | 91.2 | 156 | 115 | 518 | 518 | 518 | 200x15 |
| GET /admin/workers/{workerId}/verification | 15 | 127 | 181 | 114 | 138 | 127 | 217 | 217 | 217 | 200x15 |

### Admin - Worker Availability

| Operation | n | 1st | 2nd | min | avg | p50 | p95 | p99 | max | Status |
|---|---|---|---|---|---|---|---|---|---|---|
| GET /admin/workers/{workerId}/availability | 15 | 117 | 119 | 110 | 131 | 119 | 244 | 244 | 244 | 200x15 |

### Admin - Workers

| Operation | n | 1st | 2nd | min | avg | p50 | p95 | p99 | max | Status |
|---|---|---|---|---|---|---|---|---|---|---|
| GET /admin/workers | 15 | 119 | 129 | 105 | 126 | 119 | 186 | 186 | 186 | 200x15 |
| GET /admin/workers/{workerId} | 15 | 136 | 126 | 125 | 163 | 144 | 369 | 369 | 369 | 200x15 |
| GET /admin/workers/{workerId}/references | 15 | 168 | 156 | 115 | 136 | 132 | 168 | 168 | 168 | 200x15 |

### App

| Operation | n | 1st | 2nd | min | avg | p50 | p95 | p99 | max | Status |
|---|---|---|---|---|---|---|---|---|---|---|
| GET /app-config | 15 | 80.6 | 122 | 73.5 | 90.8 | 83.5 | 173 | 173 | 173 | 200x15 |
| GET /reference-data | 15 | 86.6 | 94.4 | 75.4 | 83.2 | 80.8 | 95.0 | 95.0 | 95.0 | 200x15 |

### Attendance

| Operation | n | 1st | 2nd | min | avg | p50 | p95 | p99 | max | Status |
|---|---|---|---|---|---|---|---|---|---|---|
| GET /attendance/bookings/{bookingId} | 15 | 111 | 103 | 91.0 | 106 | 103 | 141 | 141 | 141 | 200x15 |
| GET /attendance/bookings/{bookingId}/summary | 15 | 114 | 121 | 87.5 | 110 | 106 | 175 | 175 | 175 | 200x15 |

### Auth

| Operation | n | 1st | 2nd | min | avg | p50 | p95 | p99 | max | Status |
|---|---|---|---|---|---|---|---|---|---|---|
| POST /auth/otp/request | 2 | 104 | 288 | 104 | 196 | 104 | 288 | 288 | 288 | 200x2 |
| POST /auth/otp/verify | 2 | 341 | 131 | 131 | 236 | 131 | 341 | 341 | 341 | 200x2 |
| POST /auth/admin/login | 1 | 2939 | NaN | 2939 | 2939 | 2939 | 2939 | 2939 | 2939 | 200x1 |
| GET /auth/sessions | 15 | 90.4 | 98.9 | 84.0 | 98.9 | 98.4 | 121 | 121 | 121 | 200x15 |
| POST /auth/token/refresh | 15 | 87.6 | 102 | 87.6 | 120 | 102 | 242 | 242 | 242 | 200x15 |

### Bookings

| Operation | n | 1st | 2nd | min | avg | p50 | p95 | p99 | max | Status |
|---|---|---|---|---|---|---|---|---|---|---|
| GET /bookings | 15 | 118 | 94.3 | 91.6 | 171 | 103 | 951 | 951 | 951 | 200x15 |
| GET /bookings/{bookingId} | 15 | 108 | 112 | 104 | 126 | 108 | 315 | 315 | 315 | 200x15 |
| GET /bookings/{bookingId}/replacement-chain | 15 | 101 | 109 | 89.3 | 140 | 110 | 523 | 523 | 523 | 200x15 |
| GET /workers/me/bookings | 15 | 107 | 105 | 91.4 | 113 | 105 | 198 | 198 | 198 | 200x15 |

### Customer

| Operation | n | 1st | 2nd | min | avg | p50 | p95 | p99 | max | Status |
|---|---|---|---|---|---|---|---|---|---|---|
| GET /customers/me/home | 15 | 111 | 103 | 88.0 | 163 | 111 | 596 | 596 | 596 | 200x15 |
| GET /customers/me/booking-history | 15 | 91.1 | 90.3 | 85.8 | 98.6 | 98.3 | 115 | 115 | 115 | 200x15 |
| GET /customers/me/booking-history/summary | 15 | 91.7 | 106 | 85.5 | 99.9 | 98.1 | 126 | 126 | 126 | 200x15 |

### Customers

| Operation | n | 1st | 2nd | min | avg | p50 | p95 | p99 | max | Status |
|---|---|---|---|---|---|---|---|---|---|---|
| GET /customers/me | 15 | 128 | 114 | 81.2 | 97.7 | 92.9 | 128 | 128 | 128 | 200x15 |
| GET /customers/me/onboarding | 15 | 96.0 | 104 | 86.0 | 105 | 100 | 192 | 192 | 192 | 200x15 |
| GET /customers/me/addresses | 15 | 103 | 98.3 | 85.9 | 117 | 106 | 277 | 277 | 277 | 200x15 |
| GET /customers/me/addresses/{addressId} | 15 | 105 | 92.3 | 89.7 | 107 | 104 | 196 | 196 | 196 | 200x15 |

### Interviews and trials

| Operation | n | 1st | 2nd | min | avg | p50 | p95 | p99 | max | Status |
|---|---|---|---|---|---|---|---|---|---|---|
| GET /bookings/{bookingId}/interviews | 15 | 114 | 108 | 90.6 | 106 | 104 | 129 | 129 | 129 | 200x15 |
| GET /interviews | 15 | 89.5 | 102 | 89.5 | 98.2 | 97.0 | 117 | 117 | 117 | 200x15 |
| GET /interviews/{interviewId} | 15 | 109 | 108 | 91.3 | 156 | 101 | 929 | 929 | 929 | 200x15 |

### Legal

| Operation | n | 1st | 2nd | min | avg | p50 | p95 | p99 | max | Status |
|---|---|---|---|---|---|---|---|---|---|---|
| GET /legal/current | 15 | 79.4 | 85.5 | 78.0 | 87.9 | 88.3 | 104 | 104 | 104 | 200x15 |
| GET /legal/status | 15 | 97.5 | 111 | 87.1 | 149 | 98.9 | 808 | 808 | 808 | 200x15 |

### Notifications

| Operation | n | 1st | 2nd | min | avg | p50 | p95 | p99 | max | Status |
|---|---|---|---|---|---|---|---|---|---|---|
| GET /notifications | 15 | 92.5 | 104 | 90.3 | 102 | 98.3 | 145 | 145 | 145 | 200x15 |
| GET /notifications/unread-count | 15 | 100 | 95.8 | 83.6 | 98.7 | 95.8 | 127 | 127 | 127 | 200x15 |

### Payments

| Operation | n | 1st | 2nd | min | avg | p50 | p95 | p99 | max | Status |
|---|---|---|---|---|---|---|---|---|---|---|
| GET /payments | 15 | 96.9 | 89.8 | 83.6 | 93.4 | 93.7 | 107 | 107 | 107 | 200x15 |
| GET /payments/{paymentId}/receipt | 15 | 104 | 92.9 | 86.0 | 103 | 100 | 169 | 169 | 169 | 409x15 (!) |
| GET /payments/{paymentId}/receipt/pdf | 15 | 101 | 88.2 | 88.2 | 98.1 | 99.3 | 104 | 104 | 104 | 409x15 (!) |
| GET /payments/{paymentId} | 15 | 99.1 | 89.0 | 88.6 | 97.1 | 93.8 | 115 | 115 | 115 | 200x15 |

### Pricing

| Operation | n | 1st | 2nd | min | avg | p50 | p95 | p99 | max | Status |
|---|---|---|---|---|---|---|---|---|---|---|
| GET /pricing/guidance | 15 | 92.2 | 101 | 92.2 | 102 | 101 | 121 | 121 | 121 | 404x15 |

### Ratings

| Operation | n | 1st | 2nd | min | avg | p50 | p95 | p99 | max | Status |
|---|---|---|---|---|---|---|---|---|---|---|
| GET /ratings | 15 | 112 | 87.6 | 83.0 | 95.9 | 92.0 | 115 | 115 | 115 | 200x15 |
| GET /ratings/bookings/{bookingId}/eligibility | 15 | 114 | 108 | 89.6 | 104 | 102 | 119 | 119 | 119 | 200x15 |
| GET /ratings/bookings/{bookingId} | 15 | 97.5 | 95.3 | 86.2 | 97.6 | 96.3 | 107 | 107 | 107 | 404x15 (!) |
| GET /workers/me/ratings | 15 | 111 | 99.6 | 89.8 | 106 | 103 | 147 | 147 | 147 | 200x15 |
| GET /workers/me/ratings/summary | 15 | 105 | 101 | 89.9 | 105 | 102 | 123 | 123 | 123 | 200x15 |

### Replacements

| Operation | n | 1st | 2nd | min | avg | p50 | p95 | p99 | max | Status |
|---|---|---|---|---|---|---|---|---|---|---|
| GET /replacement-requests | 15 | 97.7 | 93.4 | 83.8 | 97.4 | 96.4 | 129 | 129 | 129 | 200x15 |

### Safety

| Operation | n | 1st | 2nd | min | avg | p50 | p95 | p99 | max | Status |
|---|---|---|---|---|---|---|---|---|---|---|
| GET /safety/blocks | 15 | 85.3 | 90.6 | 85.3 | 99.6 | 94.8 | 156 | 156 | 156 | 200x15 |

### Search

| Operation | n | 1st | 2nd | min | avg | p50 | p95 | p99 | max | Status |
|---|---|---|---|---|---|---|---|---|---|---|
| GET /search/workers | 15 | 111 | 136 | 100 | 112 | 109 | 136 | 136 | 136 | 200x15 |
| GET /search/workers/{workerId}/ratings | 15 | 135 | 105 | 95.8 | 118 | 113 | 165 | 165 | 165 | 200x15 |
| GET /search/workers/{workerId}/slots | 15 | 316 | 241 | 132 | 244 | 198 | 690 | 690 | 690 | 200x14 500x1 (!) |
| GET /search/workers/{workerId} | 15 | 106 | 105 | 92.4 | 120 | 105 | 261 | 261 | 261 | 200x15 |

### Service Areas

| Operation | n | 1st | 2nd | min | avg | p50 | p95 | p99 | max | Status |
|---|---|---|---|---|---|---|---|---|---|---|
| GET /service-areas | 15 | 88.9 | 92.9 | 85.6 | 104 | 95.6 | 228 | 228 | 228 | 200x15 |
| GET /service-areas/{areaId} | 15 | 91.3 | 95.9 | 83.4 | 94.7 | 94.8 | 116 | 116 | 116 | 200x15 |
| GET /locations/service-area | 15 | 91.6 | 96.0 | 84.3 | 101 | 94.1 | 199 | 199 | 199 | 400x15 |

### Service Categories

| Operation | n | 1st | 2nd | min | avg | p50 | p95 | p99 | max | Status |
|---|---|---|---|---|---|---|---|---|---|---|
| GET /service-categories | 15 | 96.4 | 101 | 90.5 | 98.9 | 97.5 | 124 | 124 | 124 | 200x15 |
| GET /service-categories/{categoryId} | 15 | 94.8 | 100 | 90.7 | 106 | 100 | 166 | 166 | 166 | 200x15 |

### Shortlist

| Operation | n | 1st | 2nd | min | avg | p50 | p95 | p99 | max | Status |
|---|---|---|---|---|---|---|---|---|---|---|
| GET /shortlist | 15 | 102 | 117 | 83.5 | 95.6 | 94.3 | 117 | 117 | 117 | 200x15 |

### Support

| Operation | n | 1st | 2nd | min | avg | p50 | p95 | p99 | max | Status |
|---|---|---|---|---|---|---|---|---|---|---|
| GET /support/categories | 15 | 101 | 95.1 | 91.7 | 101 | 98.1 | 123 | 123 | 123 | 200x15 |
| GET /support/tickets | 15 | 99.3 | 100 | 91.3 | 98.6 | 99.2 | 102 | 102 | 102 | 200x15 |

### Users

| Operation | n | 1st | 2nd | min | avg | p50 | p95 | p99 | max | Status |
|---|---|---|---|---|---|---|---|---|---|---|
| GET /users/me | 15 | 96.9 | 104 | 94.5 | 113 | 104 | 200 | 200 | 200 | 200x15 |

### Verification

| Operation | n | 1st | 2nd | min | avg | p50 | p95 | p99 | max | Status |
|---|---|---|---|---|---|---|---|---|---|---|
| GET /workers/me/verification | 15 | 112 | 121 | 98.2 | 143 | 112 | 497 | 497 | 497 | 200x15 |

### Worker Availability

| Operation | n | 1st | 2nd | min | avg | p50 | p95 | p99 | max | Status |
|---|---|---|---|---|---|---|---|---|---|---|
| GET /workers/me/availability | 15 | 104 | 107 | 96.0 | 120 | 104 | 318 | 318 | 318 | 200x15 |

### Worker bookings

| Operation | n | 1st | 2nd | min | avg | p50 | p95 | p99 | max | Status |
|---|---|---|---|---|---|---|---|---|---|---|
| GET /workers/me/opportunities | 15 | 104 | 100 | 97.1 | 105 | 104 | 128 | 128 | 128 | 200x15 |

### Worker interviews and trials

| Operation | n | 1st | 2nd | min | avg | p50 | p95 | p99 | max | Status |
|---|---|---|---|---|---|---|---|---|---|---|
| GET /workers/me/interviews | 15 | 103 | 104 | 96.5 | 106 | 103 | 130 | 130 | 130 | 200x15 |

### Worker onboarding

| Operation | n | 1st | 2nd | min | avg | p50 | p95 | p99 | max | Status |
|---|---|---|---|---|---|---|---|---|---|---|
| GET /workers/me/onboarding | 15 | 121 | 115 | 95.0 | 119 | 108 | 191 | 191 | 191 | 200x15 |

### Worker photo

| Operation | n | 1st | 2nd | min | avg | p50 | p95 | p99 | max | Status |
|---|---|---|---|---|---|---|---|---|---|---|
| GET /workers/me/photo | 15 | 126 | 103 | 95.0 | 109 | 104 | 165 | 165 | 165 | 404x15 |

### Workers

| Operation | n | 1st | 2nd | min | avg | p50 | p95 | p99 | max | Status |
|---|---|---|---|---|---|---|---|---|---|---|
| GET /workers/me | 15 | 108 | 103 | 94.7 | 118 | 106 | 302 | 302 | 302 | 200x15 |
| GET /workers/me/references | 15 | 113 | 103 | 90.7 | 113 | 105 | 221 | 221 | 221 | 200x15 |

### health

| Operation | n | 1st | 2nd | min | avg | p50 | p95 | p99 | max | Status |
|---|---|---|---|---|---|---|---|---|---|---|
| GET /health/live | 16 | 390 | 80.1 | 74.8 | 104 | 81.1 | 390 | 390 | 390 | 200x16 |
| GET /health/ready | 16 | 96.6 | 90.4 | 81.2 | 88.9 | 85.8 | 110 | 110 | 110 | 200x16 |

## Not exercised (133)

* POST /admin/users
* PUT /admin/users/{userId}/role
* POST /admin/users/{userId}/password-reset
* PATCH /admin/users/{userId}/status
* PUT /admin/roles/{roleCode}/permissions
* POST /admin/alerts/{alertId}/acknowledge
* POST /admin/alerts/{alertId}/resolve
* POST /legal/accept
* POST /me/deletion-request
* DELETE /me/deletion-request
* POST /auth/logout
* DELETE /auth/sessions/{sessionId}
* PUT /auth/device-token
* DELETE /auth/device-token
* POST /admin/account/password
* POST /workers/me/photo
* POST /workers/me/photo/{photoId}/confirm
* POST /workers/me
* PATCH /workers/me
* PUT /workers/me/categories
* PUT /workers/me/references
* POST /workers/me/submit
* POST /admin/workers
* PATCH /admin/workers/{workerId}
* PUT /admin/workers/{workerId}/categories
* POST /admin/service-categories
* PATCH /admin/service-categories/{categoryId}
* PUT /admin/service-categories/{categoryId}/engagements
* PUT /admin/pricing-guidance
* DELETE /admin/pricing-guidance/{id}
* PUT /shortlist/{workerId}
* DELETE /shortlist/{workerId}
* POST /admin/service-areas
* PATCH /admin/service-areas/{areaId}
* PATCH /workers/me/availability
* PATCH /admin/workers/{workerId}/availability
* POST /bookings
* POST /bookings/rebook
* POST /bookings/{bookingId}/slot-proposal/{answer}
* POST /bookings/{bookingId}/{action}
* GET /workers/me/bookings/{bookingId}
* PUT /workers/me/bookings/{bookingId}/slot-proposal
* POST /workers/me/bookings/{bookingId}/{action}
* POST /admin/bookings
* POST /admin/bookings/{bookingId}/slot-proposal/{answer}
* POST /admin/bookings/{bookingId}/{action}
* POST /interviews
* POST /interviews/{interviewId}/reschedule
* POST /interviews/{interviewId}/accept-proposal
* POST /interviews/{interviewId}/reject-proposal
* POST /interviews/{interviewId}/cancel
* POST /interviews/{interviewId}/complete
* GET /workers/me/interviews/{interviewId}
* POST /workers/me/interviews/{interviewId}/accept
* POST /workers/me/interviews/{interviewId}/decline
* POST /workers/me/interviews/{interviewId}/propose
* POST /workers/me/interviews/{interviewId}/cancel
* POST /admin/interviews
* POST /admin/interviews/{interviewId}/confirm
* POST /admin/interviews/{interviewId}/reschedule
* POST /admin/interviews/{interviewId}/accept-proposal
* POST /admin/interviews/{interviewId}/reject-proposal
* POST /admin/interviews/{interviewId}/cancel
* POST /admin/interviews/{interviewId}/complete
* POST /customers/me
* PATCH /customers/me
* POST /customers/me/addresses
* PATCH /customers/me/addresses/{addressId}
* DELETE /customers/me/addresses/{addressId}
* PUT /customers/me/addresses/{addressId}/default
* PATCH /admin/customers/{customerId}/verification-status
* POST /admin/customers/{customerId}/notes
* POST /admin/notification-templates
* PATCH /admin/notification-templates/{templateId}
* POST /admin/notifications/{notificationId}/retry
* POST /admin/outbox-events/{eventId}/retry
* POST /notifications/read-all
* POST /notifications/{notificationId}/unread
* POST /notifications/{notificationId}/read
* POST /payments
* POST /payments/{paymentId}/verify
* POST /admin/payments/{paymentId}/reconcile
* POST /admin/payments/{paymentId}/refund
* POST /admin/payment-exceptions/{exceptionId}/resolve
* PUT /admin/fees/booking-fee
* PUT /admin/fees/{code}
* POST /safety/blocks
* DELETE /safety/blocks/{blockId}
* POST /safety/reports
* POST /admin/safety/blocks
* DELETE /admin/safety/blocks/{blockId}
* POST /workers/me/verification/checks/{checkType}/documents
* POST /workers/me/verification/documents/{documentId}/confirm
* POST /workers/me/verification/checks/{checkType}/submit
* PUT /admin/verification/requirements
* POST /admin/verification/checks/{checkId}/start-review
* POST /admin/verification/checks/{checkId}/approve
* POST /admin/verification/checks/{checkId}/reject
* POST /admin/verification/checks/{checkId}/recheck
* GET /admin/verification/documents/{documentId}/link
* POST /admin/matching/candidates
* POST /workers/me/attendance/bookings/{bookingId}
* GET /workers/me/attendance/bookings/{bookingId}
* POST /workers/me/attendance/bookings/{bookingId}/check-in
* POST /workers/me/attendance/bookings/{bookingId}/check-out
* GET /workers/me/attendance/bookings/{bookingId}/summary
* POST /attendance/bookings/{bookingId}/exceptions
* POST /admin/attendance/bookings/{bookingId}
* PATCH /admin/attendance/{attendanceId}
* POST /replacement-requests
* GET /replacement-requests/{requestId}
* GET /replacement-requests/{requestId}/alternatives
* POST /replacement-requests/{requestId}/cancel
* POST /replacement-requests/{requestId}/select
* POST /admin/replacement-requests/{requestId}/approve
* POST /admin/replacement-requests/{requestId}/reject
* POST /admin/replacement-requests/{requestId}/select
* POST /ratings
* GET /ratings/{ratingId}
* POST /admin/ratings/{ratingId}/hide
* POST /admin/ratings/{ratingId}/unhide
* POST /support/tickets
* GET /support/tickets/{ticketId}
* POST /support/tickets/{ticketId}/messages
* GET /support/tickets/{ticketId}/messages
* POST /admin/support/tickets/{ticketId}/assign
* POST /admin/support/tickets/{ticketId}/priority
* POST /admin/support/tickets/{ticketId}/escalate
* POST /admin/support/tickets/{ticketId}/close
* POST /admin/support/tickets/{ticketId}/messages
* POST /admin/support/categories
* PATCH /admin/support/categories/{categoryId}
* GET /admin/reports/export/{report}

Steps skipped because a prerequisite was missing in at least one iteration: GET /workers/me/bookings/{bookingId} (no id to use yet); GET /workers/me/interviews/{interviewId} (no id to use yet); GET /admin/verification/documents/{documentId}/link (no id to use yet); GET /workers/me/attendance/bookings/{bookingId} (no id to use yet); GET /workers/me/attendance/bookings/{bookingId}/summary (no id to use yet); GET /replacement-requests/{requestId} (no id to use yet); GET /replacement-requests/{requestId}/alternatives (no id to use yet); GET /ratings/{ratingId} (no id to use yet); GET /support/tickets/{ticketId} (no id to use yet); GET /support/tickets/{ticketId}/messages (no id to use yet).

