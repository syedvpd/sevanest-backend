# Multi-Channel Notifications & Dispatch Module

## 1. Executive Summary

The **Notifications Module** provides real-time multi-channel communication across SevaNest, delivering transactional push notifications (via Firebase Cloud Messaging), SMS alerts, and WhatsApp messages to customers and domestic workers.

Engineered around **Reliable Asynchronous Delivery** and **Transactional Outbox Architecture**:
1. **Zero Message Loss (Outbox Pattern):** Domain events (e.g., `BOOKING_CONFIRMED`, `PAYMENT_SUCCEEDED`) are saved into an `outbox_events` table in the exact same database transaction as the business operation, eliminating dual-write failure risks.
2. **Decoupled Worker Processing:** Notification rendering and external gateway delivery execute asynchronously in the background BullMQ worker process, protecting API response times.
3. **Resilient Retry & Exponential Backoff:** Transient telecommunication or push gateway outages are automatically retried with exponential backoff (up to 5 attempts) before dead-lettering.

---

## 2. Core Features & Capabilities

* **Multi-Channel Dispatch:** Unified orchestration across Mobile Push (FCM), SMS (MSG91 / Twilio), and WhatsApp Business messaging.
* **Dynamic Template Engine:** Administrators can configure notification templates, variable placeholders, and channel activations without redeploying code.
* **Transactional Outbox Delivery:** Guarantees that notifications are dispatched if and only if the underlying business transaction successfully commits.
* **Idempotent Queue Consumer:** Deduplication keys (`eventId:recipientId:channel`) prevent accidental duplicate messages from reaching users.
* **Delivery Status Audit:** Full visibility into delivery states (`QUEUED`, `SENT`, `FAILED`, `SKIPPED`) with failure diagnostics for operational support.

---

## 3. End-to-End Notification Workflow

The following diagram illustrates how asynchronous notifications are queued and dispatched:

```
API Process (Business Event Committed)
           │
           ▼
[Prisma DB Transaction: Business Record + outbox_events Record]
           │
           ▼
Background Worker Process (BullMQ Dispatcher)
           │
           ▼
┌────────────────────────────────────────────────────────┐
│ 1. Event Polling & Template Resolution                 │
│    - Claims outbox events via FOR UPDATE SKIP LOCKED   │
│    - Matches active templates for the event type       │
│    - Inserts notifications rows in QUEUED state        │
└──────────────────────────┬─────────────────────────────┘
                           │
                           ▼
┌────────────────────────────────────────────────────────┐
│ 2. BullMQ Job Enqueueing & Concurrency Lock            │
│    - Enqueues job to BullMQ notifications queue        │
│    - Locks notification row to avoid race conditions   │
└──────────────────────────┬─────────────────────────────┘
                           │
                           ▼
┌────────────────────────────────────────────────────────┐
│ 3. Provider Adapter Delivery & Status Update           │
│    - Dispatches to FCM, Twilio SMS, or WhatsApp        │
│    - On Success: Marks status SENT                     │
│    - On Transient Failure: Retries with backoff        │
└────────────────────────────────────────────────────────┘
```

---

## 4. API Endpoints & Contracts

### 1. `GET /api/v1/admin/notification-events`
Lists all supported system event types available for template creation.

---

### 2. `GET /api/v1/admin/notification-templates` & `POST ...`
Lists and creates notification templates mapped to specific channels and languages.
* **Payload:** `{ eventType: "BOOKING_CONFIRMED", channel: "PUSH", title: "Booking Confirmed", body: "Your helper is scheduled for {{startDate}}." }`

---

### 3. `PATCH /api/v1/admin/notification-templates/:id`
Enables, disables, or updates the copy of an existing message template.

---

### 4. `GET /api/v1/admin/notifications`
Audit directory of historical notification deliveries with filters for status (`SENT`, `FAILED`, `SKIPPED`) and recipient.

---

## 5. Inter-Module Dependencies & System Design

The Notifications module functions as the asynchronous communication engine for the entire backend:

```
┌─────────────────────────┐
│     Booking Module      │──┐
│  (Booking Event Outbox) │  │
└─────────────────────────┘  │
┌─────────────────────────┐  │
│     Payment Module      │──┼──► [ Notifications Module ] ──► [ Push / SMS SaaS ]
│  (Payment Event Outbox) │  │    (Outbox & BullMQ Queue)      (FCM, Twilio, MSG91)
└─────────────────────────┘  │
┌─────────────────────────┐  │
│   Verification Module   │──┘
│  (Approval Notifications)
└─────────────────────────┘
```

* **Outbox Decoupling:** Business modules never communicate with telecom gateways directly; they simply insert an event into the transactional outbox table.
* **Worker Execution:** The notification dispatch loop runs in the background worker process, keeping the public REST API fast and responsive.

