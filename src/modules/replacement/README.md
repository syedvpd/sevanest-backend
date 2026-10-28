# Worker Replacement Management Module

## 1. Executive Summary

The **Replacement Module** manages customer requests for domestic worker substitutions during active monthly or long-term household engagements. If an assigned worker becomes unavailable or is incompatible with household needs, this module coordinates administrative review, candidate re-matching, and seamless booking transitions.

Engineered around **Continuous Household Service** and **Contract Continuity**:
1. **Seamless Contract Transition:** When a replacement is confirmed, the original booking is closed as `REPLACED` and linked directly to the newly created replacement booking in a single atomic transaction.
2. **Operations-Supervised Vetting:** Administrative approval ensures replacement requests are reviewed and suitable alternative candidates are identified before reassignment.
3. **Single Active Request Invariant:** Enforces database constraints allowing at most one active replacement request per booking at any time.

---

## 2. Core Features & Capabilities

* **Replacement Request Submission:** Customers can initiate replacement requests for ongoing bookings with structured reason codes.
* **Administrative Approval Workflow:** Operations specialists review requests (`/approve`, `/reject`) and coordinate with the customer.
* **Alternative Candidate Matching:** Automatically identifies candidate replacements who match the original booking's category and schedule while excluding the current worker.
* **Atomic Booking Swap:** Atomically transitions the original engagement to `REPLACED` while creating and confirming the substitute booking.
* **Request Withdrawal:** Allows customers to cancel open replacement requests if circumstances change, returning the booking to normal `ACTIVE` status.

---

## 3. End-to-End Replacement Workflow

The following diagram illustrates how worker replacement is managed:

```
Customer Mobile App (Flutter)
           │
           ▼
[POST /api/v1/replacement-requests { bookingId, reason: "Schedule mismatch" }]
           │
           ▼
┌────────────────────────────────────────────────────────┐
│ 1. Request Initiation & Booking State Lock             │
│    - Verifies booking is ACTIVE and owned by caller    │
│    - Transitions booking to REPLACEMENT_REQUESTED      │
│    - Alerts operations support desk                    │
└──────────────────────────┬─────────────────────────────┘
                           │
                           ▼
Platform Operations Portal
           │
           ▼
[POST /api/v1/admin/replacement-requests/:id/approve]
[GET /api/v1/admin/replacement-requests/:id/candidates] (Finds eligible workers)
           │
           ▼
Customer / Admin selects new worker
           │
           ▼
[POST /api/v1/replacement-requests/:id/select { workerId: "new_worker_uuid" }]
           │
           ▼
┌────────────────────────────────────────────────────────┐
│ 2. Atomic Transition & Reassignment                    │
│    - Closes previous booking as REPLACED               │
│    - Provisions new replacement booking                │
│    - Completes replacement request                     │
│    - All executed in a single atomic transaction       │
└────────────────────────────────────────────────────────┘
```

---

## 4. API Endpoints & Contracts

### 1. `POST /api/v1/replacement-requests`
Files a replacement request for an active booking.
* **Payload:** `{ bookingId: "booking_uuid", reason: "Worker relocation", notes?: "Need morning shift helper" }`

---

### 2. `GET /api/v1/replacement-requests` & `GET .../:id`
Retrieves the customer's open and historical replacement requests.

---

### 3. `POST /api/v1/admin/replacement-requests/:id/approve` & `POST .../reject`
Authorizes or declines a replacement filing.
* **Authorization:** Administrative JWT (`replacement.manage` permission).

---

### 4. `GET /api/v1/admin/replacement-requests/:id/candidates`
Searches for alternative verified workers matching the original booking requirements.

---

### 5. `POST /api/v1/replacement-requests/:id/select`
Selects the replacement worker, creates the successor booking, and completes the swap.
* **Payload:** `{ workerId: "new_worker_uuid" }`

---

### 6. `POST /api/v1/replacement-requests/:id/cancel`
Allows the customer to withdraw an open replacement request.

---

## 5. Inter-Module Dependencies & System Design

The Replacement module links active engagements with matching:

```
┌─────────────────────────┐
│     Booking Module      │◄──┐  Transitions original booking to REPLACED
│   (State Transitions)   │   │  and creates successor booking
└─────────────────────────┘   │
                              │
┌─────────────────────────┐   │  Queries replacement candidates
│   Replacement Module    ├───┴────────────────────────► [ Matching Module ]
│  (Substitution Engine)  │                              (Excludes Current Worker)
└─────────────────────────┘
```

* **Booking State Machine Hook:** Transitions the booking between `ACTIVE`, `REPLACEMENT_REQUESTED`, and `REPLACED`.
* **Matching Coordination:** Matching automatically filters out the previous worker so the customer is only presented with fresh alternatives.

