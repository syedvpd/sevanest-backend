# Booking & Engagement Lifecycle Module

## 1. Executive Summary

The **Booking Module** is the transactional core of SevaNest. It orchestrates the full lifecycle of a domestic service engagement—from initial customer requirement creation and candidate matching, through interview and trial scheduling, to payment confirmation, active engagement, and eventual completion.

Engineered around **Financial Invariants** and **Double-Booking Prevention**:
1. **Strict State Machine Architecture:** All status transitions (`NEW_REQUEST` $\rightarrow$ `MATCHED` $\rightarrow$ `INTERVIEW_SCHEDULED` $\rightarrow$ `CONFIRMED` $\rightarrow$ `ACTIVE` $\rightarrow$ `COMPLETED`) are strictly validated against permitted transition paths.
2. **Double-Booking Elimination:** Employs transactional locks and schedule overlap checks ensuring a worker cannot be confirmed for overlapping dates and hours across different households.
3. **Idempotency Guarantee:** Protects create and confirm actions with HTTP `Idempotency-Key` headers, eliminating duplicate bookings and double charges under poor mobile network conditions.

---

## 2. Core Features & Capabilities

* **End-to-End State Machine:** Governs every stage of customer-worker engagements with append-only status change timelines.
* **Interview & Trial Scheduling:** Coordinates pre-engagement interviews or trial work sessions between households and domestic helpers.
* **Anti-Double-Booking Protection:** Re-evaluates worker schedules at creation, matching, and final confirmation to prevent conflicting appointments.
* **Payment-Gated Confirmation:** A booking transitions to `CONFIRMED` only upon cryptographic verification of payment settlement from the Payment module.
* **Cancellation & Reason Tracking:** Structured cancellation workflows with mandatory reason codes and customer notifications.
* **Multi-Actor Access Controls:** Distinct, role-tailored views and actions for Customers, Workers, and Operations Administrators.

---

## 3. End-to-End Booking Lifecycle Workflow

The following state machine diagram illustrates the lifecycle of a booking:

```
[Customer creates request with workerId]
                  │
                  ▼
            ┌───────────┐
            │  MATCHED  │
            └─────┬─────┘
                  │
     Customer / Worker schedules interview
                  ▼
     ┌────────────────────────┐
     │  INTERVIEW_SCHEDULED   │
     └────────────┬───────────┘
                  │
         Interview completed
                  ▼
     ┌────────────────────────┐
     │  INTERVIEW_COMPLETED   │
     └────────────┬───────────┘
                  │
         Payment initialized
                  ▼
     ┌────────────────────────┐
     │    PENDING_PAYMENT     │
     └────────────┬───────────┘
                  │
       Payment Webhook Verified (Payment Module)
                  ▼
            ┌───────────┐
            │ CONFIRMED │  (Schedule locked)
            └─────┬─────┘
                  │
         Start date arrived
                  ▼
            ┌───────────┐
            │  ACTIVE   │  (Daily attendance active)
            └─────┬─────┘
                  │
         Engagement concludes
                  ▼
            ┌───────────┐
            │ COMPLETED │  (Review eligibility unlocked)
            └───────────┘
```

---

## 4. API Endpoints & Contracts

### 1. `POST /api/v1/bookings`
Creates a new booking requirement. Supplying a verified `workerId` creates the booking directly in `MATCHED` status.
* **Header:** `Idempotency-Key: <uuid>` (optional, prevents duplicate orders)
* **Payload:** `{ workerId?: "...", categoryId: "...", areaId: "...", addressId: "...", startDate: "2026-11-01", timeSlot: "..." }`

---

### 2. `GET /api/v1/bookings` & `GET /api/v1/bookings/:id`
Retrieves the customer's booking list and full status timeline (timestamps and status history).

---

### 3. `POST /api/v1/bookings/:id/:action`
Executes lifecycle transitions on a booking.
* **Customer Actions:** `schedule`, `interview-complete`, `confirm-worker`, `cancel`.
* **Worker Actions:** `schedule`, `decline`, `start`.
* **Admin Actions:** `match`, `reopen-matching`, `cancel`, `complete`.

---

### 4. `GET /api/v1/workers/me/bookings`
Provides workers with a requirement summary and schedule for engagements assigned to them.

---

### 5. `GET /api/v1/admin/bookings`
Comprehensive administrative operations dashboard with filters for status, date ranges, and areas.

---

## 5. Inter-Module Dependencies & System Design

The Booking module acts as the central orchestrator for marketplace operations:

```
┌─────────────────────────┐
│      Search Module      │──┐
│ (Worker Eligibility)    │  │
└─────────────────────────┘  │
┌─────────────────────────┐  │
│     Payment Module      │──┼──► [ Booking Module ] ──► [ Attendance Module ]
│  (Payment Settlement)   │  │    (Core State Machine)   (Active Service Logs)
└─────────────────────────┘  │
┌─────────────────────────┐  │
│  Notifications Module   │──┘
│  (State Alerts & Push)  │
└─────────────────────────┘
```

* **Payment Settlement Hook:** The booking state only moves from `PENDING_PAYMENT` to `CONFIRMED` when the Payment module processes a successful webhook and invokes the booking lifecycle hook.
* **Attendance Handoff:** Once a booking becomes `ACTIVE`, the Attendance module begins managing daily check-ins and check-outs.

