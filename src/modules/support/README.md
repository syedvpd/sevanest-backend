# Support & Complaints Management Module

## 1. Executive Summary

The **Support & Complaints Module** provides dispute resolution and customer service ticketing across the SevaNest marketplace. It enables both households and domestic workers to file support tickets regarding service issues, schedule anomalies, or booking inquiries, while equipping operations staff with triage and escalation tools.

Engineered around **Dispute Accountability** and **Resolution Integrity**:
1. **Immutable Audit History:** Every status transition, priority change, and staff assignment appends an immutable historical record protected by database triggers.
2. **Context-Aware Ticket Filing:** Tickets can be directly linked to active or historical bookings, giving support executives instant operational context.
3. **Structured Ticket Lifecycle:** Enforces formal closure requirements (`OPEN` $\rightarrow$ `IN_PROGRESS` $\rightarrow$ `ESCALATED` $\rightarrow$ `CLOSED`), requiring written resolution notes before a ticket can be completed.

---

## 2. Core Features & Capabilities

* **Multi-Category Ticket Filing:** User-friendly filing under configurable categories (e.g., "Attendance Dispute", "Payment Query", "Worker Feedback").
* **Staff Triage & Ownership:** Explicit assignment of tickets to active support executives with workload tracking.
* **Priority & Escalation Management:** Support supervisors can elevate urgent safety or service issues to `ESCALATED` status.
* **Transparent Timeline for Users:** Customers and workers can track ticket status changes in real time while internal administrative notes remain protected.
* **Resolution Documentation:** Mandatory resolution summary recorded upon ticket closure to preserve service accountability.

---

## 3. End-to-End Support Workflow

The following diagram illustrates how support tickets are created and resolved:

```
Customer / Worker Mobile App
           │
           ▼
[POST /api/v1/support/tickets { categoryId, description, bookingId? }]
           │
           ▼
┌────────────────────────────────────────────────────────┐
│ 1. Ticket Submission & Validation                      │
│    - Verifies category is active                       │
│    - If bookingId supplied, verifies caller is a party │
│    - Initializes ticket in OPEN status                 │
└──────────────────────────┬─────────────────────────────┘
                           │
                           ▼
Support Operations Portal
           │
           ▼
[POST /api/v1/admin/support/tickets/:id/assign { assigneeId }]
[POST /api/v1/admin/support/tickets/:id/priority { priority: "HIGH" }]
           │
           ▼
┌────────────────────────────────────────────────────────┐
│ 2. Triage & Investigation                              │
│    - Status transitions to IN_PROGRESS                 │
│    - Appends immutable history event                   │
│    - Emits TICKET_UPDATE notification to user          │
└──────────────────────────┬─────────────────────────────┘
                           │
                           ▼
[POST /api/v1/admin/support/tickets/:id/close { resolution: "Resolved" }]
           │
           ▼
┌────────────────────────────────────────────────────────┐
│ 3. Resolution & Final Closure                          │
│    - Validates resolution text is supplied             │
│    - Closes ticket (CLOSED is final)                   │
│    - Notifies customer/worker of final resolution      │
└────────────────────────────────────────────────────────┘
```

---

## 4. API Endpoints & Contracts

### 1. `GET /api/v1/support/categories`
Returns all enabled support complaint categories.

---

### 2. `POST /api/v1/support/tickets`
Submits a new support ticket.
* **Payload:** `{ categoryId: "cat_uuid", description: "Worker did not arrive today.", bookingId?: "booking_uuid" }`

---

### 3. `GET /api/v1/support/tickets` & `GET /api/v1/support/tickets/:id`
Retrieves tickets filed by the authenticated user along with resolution history.

---

### 4. `GET /api/v1/admin/support/tickets`
Administrative ticket queue with filters for status, priority, category, and assigned staff member.

---

### 5. `POST /api/v1/admin/support/tickets/:id/assign`
Assigns an open ticket to a designated support executive.
* **Authorization:** Administrative JWT (`support.manage` permission).

---

### 6. `POST /api/v1/admin/support/tickets/:id/close`
Resolves and closes a ticket.
* **Payload:** `{ resolution: "Replacement worker assigned and credit applied." }`

---

## 5. Inter-Module Dependencies & System Design

The Support module connects marketplace participants with operations staff:

```
┌─────────────────────────┐
│     Booking Module      │──┐
│ (Associated Engagements)│  │
└─────────────────────────┘  │
                             ▼
                    [ Support Module ] ──► [ Notifications Module ]
                  (Dispute Resolution)     (Ticket Status Alerts)
```

* **Booking Correlation:** Verifies that any referenced booking belongs to the caller, preventing unauthorized access to other users' service records.
* **Proactive Notification:** Every status transition dispatches automated push and in-app alerts through the Notifications module.

