# Customer Active Service: API traceability (2026-10-14)

Requirements reported by the customer-app developer for the Active Service screen, traced to the specs, the implementation and the tests.
Baseline: the OpenAPI of 2026-10-13. Every response shape below is also checked against the published OpenAPI by
`test/integration/contract.openapi.int-spec.ts`.

## 1. Attendance for customers

| | |
|---|---|
| Initial finding | "Does `GET /attendance/bookings/{id}` and `/summary` accept a customer token?" and a request for test data. |
| Found | **Already implemented** (`CustomerAttendanceController`, `@RequireUserType('CUSTOMER')`): the list, the monthly summary and `POST .../exceptions`, each scoped to the caller's own booking (404 for anything else, 403 for admins and workers, 401 anonymous). |
| Done | Nothing to change in behaviour. Added a repeatable fixture and tests: a customer with an ACTIVE booking holding five entries (PRESENT, PRESENT, LATE, ABSENT, LEAVE), a COMPLETED booking, and another customer's booking for IDOR. |
| Contract | `GET /attendance/bookings/{id}` (page, newest date first), `GET /attendance/bookings/{id}/summary?month=YYYY-MM`. |
| Tests | `customer.active-service.int-spec.ts` section 1 (4 tests). |
| Test data for the app team | The fixture is created by the test itself on a disposable local database. A hosted staging customer was not seeded (no live data is touched); `scripts/seed-demo.ts` builds the same shape locally. |

## 2. Attendance fields: Late, Leave, check-in/out, scheduled window

| | |
|---|---|
| Initial finding | The API knew PRESENT/ABSENT/EXCEPTION and a note only. |
| Spec check | FRD FM-09: status "present, absent, exception (configurable)"; SRS FR-ATT-003: V1 is status-based, GPS/face are Phase 2. Late, Leave and times are not defined, so they are an additive extension awaiting sign-off (**Q-101**, D-76, D-77). |
| Implemented | Statuses `LATE` (worked day) and `LEAVE` (not a worked day); `checkInAt`/`checkOutAt` on every attendance row; worker endpoints `POST /workers/me/attendance/bookings/{id}/check-in` and `/check-out`; `late`, `leave` and `scheduledWindow {from,to}` (and, for the customer, `worker`) on the summary. |
| Rules | The worker records LATE/LEAVE for today; staff for any day from the start date; a customer can only raise EXCEPTION. Times are the **server clock** at the call, never a client value, never inferred from a status; check-out needs a check-in; repeats change nothing; two simultaneous first check-ins make one row. A staff correction to a non-worked status clears the times (audit keeps them). The window is the booking's own `availableFrom/availableTo`, never a default. |
| Database | Migration `20261027090000_attendance_states_history`: enum values `LATE`, `LEAVE`; `attendance_records.check_in_at`, `check_out_at` (CHECK: a check-out needs an earlier-or-equal check-in). Additive; existing rows have NULL times. |
| Tests | `customer.active-service.int-spec.ts` section 2 (4 tests); `attendance.api.int-spec.ts` adjusted (LATE is now valid; an unknown status is still 400; the key list gained the two time fields). |
| Open | Q-101 client sign-off. |

## 7 (attendance part). Worker identity

`GET /attendance/bookings/{id}/summary` (customer) carries `worker {displayName, initials, photo}` (D-81). Verified for an active booking, absent before
the interview stage, absent for the worker's own and admin views. Photo links reuse the existing signed-URL strategy (card/large WebP, `cacheKey`).

## 8. Customer missing-day exceptions

| | |
|---|---|
| Initial finding | Asked whether the customer may raise an exception and to confirm the rules. |
| Found | **Already implemented**; the rules match FRD FM-09 ("Worker forgets to update: customer or admin can raise an exception") (D-83). |
| Rules (verified by tests) | Own booking, status ACTIVE (409 `BOOKING_NOT_ACTIVE` for COMPLETED, CANCELLED, CONFIRMED); date from the booking start date to today in India time (422 `DATE_NOT_ALLOWED` for future or earlier dates, 400 for unreal dates); no existing entry for that date (409 `ATTENDANCE_ALREADY_RECORDED`; an identical repeat returns the same entry); note required, 1 to 500 characters (400). |
| Integrity | Unique `(booking_id, date)`; a unique violation (a race) resolves to the winner's row. Stored as EXCEPTION by CUSTOMER with an append-only history row and an audit record; it is counted as `exception`, never as `present`; staff review/correct it with a reason. A `status` field sent by a customer is ignored (the entry is still an EXCEPTION). |
| Concurrency tests | Five identical submissions make one row; four different notes for one day leave one winner (others 409); a worker's PRESENT and a customer's exception for the same day leave exactly one entry. |
| Tests | `customer.active-service.int-spec.ts` section 3 (5 tests). Details: `customer-attendance-exception-test-results.md`. |
