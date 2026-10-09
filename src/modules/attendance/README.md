# Attendance

Status-based attendance per booking and date. V1 has **no GPS, geofence or facial attendance** (FR-ATT-003) and no payroll.

## Requirements covered

FR-ATT-001..003, FR-ON-001, FRD FM-09.

## Model

`attendance_records` (one row per booking and date: PRESENT, ABSENT or EXCEPTION with a note; recorder and kind), `attendance_events` (append-only first entry and every
correction with actor and reason). A unique index on (booking, date) and a CHECK that an exception carries a note.

## APIs (`/api/v1`)

| Who      | Path                                                         | Purpose                                                       |
| -------- | ------------------------------------------------------------ | ------------------------------------------------------------- |
| WORKER   | `POST /workers/me/attendance/bookings/{id}`                  | Record **today** for my active booking                        |
| WORKER   | `GET /workers/me/attendance/bookings/{id}`                   | My history for that booking                                   |
| CUSTOMER | `GET /attendance/bookings/{id}`                              | The same records the worker sees                              |
| CUSTOMER | `POST /attendance/bookings/{id}/exceptions`                  | Raise an exception for a day nobody recorded                  |
| ADMIN    | `GET /admin/attendance/bookings/{id}` (`attendance.view`)    | View with the full change history                             |
| ADMIN    | `POST /admin/attendance/bookings/{id}` (`attendance.manage`) | Record for a date on behalf of the worker                     |
| ADMIN    | `PATCH /admin/attendance/{id}` (`attendance.manage`)         | Correct an entry (reason required; old value kept in history) |

## Rules

- Recording needs an ACTIVE booking (409 `BOOKING_NOT_ACTIVE`); admins can still correct entries afterwards. Dates run from the booking start date to today (India).
- A worker records only their own booking and only today; repeating the same status is a no-op, a different status for a recorded day is 409 (staff correct it).
  Parallel duplicates leave one record and one history entry.
- Open: configurable status list (Q-53), how far into the past a worker may record, disputes (support tickets, module not built).
