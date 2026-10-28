# Attendance & Daily Service Logging Module

## 1. Executive Summary

The **Attendance Module** tracks daily service fulfillment across active customer-worker household engagements in SevaNest. It provides transparency into worker presence (`PRESENT`, `ABSENT`, `EXCEPTION`), maintaining a verified, tamper-evident log of domestic service delivery.

Engineered around **Auditability** and **Mutual Transparency**:
1. **Active Engagement Gating:** Attendance can only be recorded for confirmed bookings in an `ACTIVE` lifecycle state.
2. **Same-Day Worker Stamping:** Workers record presence strictly on the current calendar day, preventing retroactive backfilling without administrative review.
3. **Dispute & Exception Tracking:** Customers and staff can record exception notes when discrepancies arise, preserving full historical correction records.

---

## 2. Core Features & Capabilities

* **Daily Presence Logging:** Captures worker service status (`PRESENT`, `ABSENT`, `EXCEPTION`) per booking and calendar date.
* **Mutual Visibility:** Synchronized attendance timeline visible to both the employing household and the domestic worker.
* **Customer Exception Filing:** Allows households to report absent days or service anomalies with mandatory notes.
* **Administrative Corrections:** Operations staff can correct attendance records with audit logging that preserves original values and amendment reasons.
* **Duplicate Prevention:** Unique constraint on `(booking_id, service_date)` guarantees exactly one record per day per engagement.

---

## 3. End-to-End Attendance Workflow

The following diagram illustrates how daily service attendance is logged:

```
Worker Mobile App (Flutter)
           │
           ▼
[POST /api/v1/workers/me/attendance/bookings/:id { status: "PRESENT" }]
           │
           ▼
┌────────────────────────────────────────────────────────┐
│ 1. Booking State & Date Validation                    │
│    - Verifies booking is ACTIVE and belongs to worker  │
│    - Verifies date is the current calendar day        │
└──────────────────────────┬─────────────────────────────┘
                           │
                           ▼
┌────────────────────────────────────────────────────────┐
│ 2. Atomic Entry & Event Audit                          │
│    - Inserts attendance_record for today               │
│    - Emits attendance_event with actor timestamp       │
└──────────────────────────┬─────────────────────────────┘
                           │
                           ▼
Customer Mobile App (Flutter)
           │
           ▼
[GET /api/v1/attendance/bookings/:id]
           │
           ▼
┌────────────────────────────────────────────────────────┐
│ 3. Synchronized Household Transparency                 │
│    - Customer inspects monthly attendance calendar     │
│    - Option to raise exception if discrepancy exists   │
└────────────────────────────────────────────────────────┘
```

---

## 4. API Endpoints & Contracts

### 1. `POST /api/v1/workers/me/attendance/bookings/:id`
Records the worker's presence status for the current day.
* **Payload:** `{ status: "PRESENT" | "ABSENT" | "EXCEPTION", note?: "Arrived late due to rain" }`

---

### 2. `GET /api/v1/workers/me/attendance/bookings/:id`
Retrieves historical attendance logs for a specific engagement from the worker's perspective.

---

### 3. `GET /api/v1/attendance/bookings/:id`
Provides the customer with the verified attendance history for their active booking.

---

### 4. `POST /api/v1/attendance/bookings/:id/exceptions`
Enables a customer to raise an attendance exception for an unrecorded or disputed date.
* **Payload:** `{ date: "2026-10-27", note: "Worker was unavailable on this day" }`

---

### 5. `PATCH /api/v1/admin/attendance/:id`
Enables operations staff to amend an attendance record upon dispute investigation.
* **Authorization:** Administrative JWT (`attendance.manage` permission).
* **Payload:** `{ status: "PRESENT", reason: "Customer confirmed worker arrived at rescheduled time" }`

---

## 5. Inter-Module Dependencies & System Design

The Attendance module connects active engagements with customer support and reporting:

```
┌─────────────────────────┐
│     Booking Module      │──┐
│   (ACTIVE Engagements)  │  │
└─────────────────────────┘  │
                             ▼
                 [ Attendance Module ] ──► [ Support Module ]
                 (Daily Service Logs)      (Dispute Resolution)
```

* **Booking Status Dependency:** The Attendance module queries the Booking module to verify that an engagement is in `ACTIVE` state before accepting presence entries.
* **Dispute Escalation:** Customer-flagged exceptions can automatically feed into the Support module when customer mediation is required.

