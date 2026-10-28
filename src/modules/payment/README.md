# Payments & Financial Settlement Module

## 1. Executive Summary

The **Payment Module** manages financial transactions, platform fee collections, and refund workflows across SevaNest. It interfaces with external payment gateways (e.g., Razorpay) to process household booking fees, enforce cryptographically verified webhook settlement, and deliver digital payment receipts.

Engineered around **Zero-Discrepancy Invariants** and **Cryptographic Verification**:
1. **Authoritative Webhook Settlement:** Client-side "payment success" reports are treated as tentative hints; a payment is confirmed strictly when the backend validates the gateway's HMAC SHA-256 webhook signature against the raw body buffer.
2. **Idempotent Transaction Events:** Every payment gateway notification is recorded in an append-only `payment_events` table with deduplication keys, preventing double-credits.
3. **Automated Booking Confirmation:** Successful payment processing atomically confirms the associated booking and triggers customer receipt generation in one database transaction.

---

## 2. Core Features & Capabilities

* **Payment Gateway Abstraction:** Seamless adapter architecture supporting major gateways (Razorpay, Cashfree, PayU) with unified error handling.
* **Cryptographic Webhook Verification:** Real-time processing of signed webhook events with replay-attack protection and raw body signature validation.
* **Platform Fee Administration:** Dynamic configuration of booking fees per category and engagement model without code modifications.
* **Automated Receipt Generation:** Instant digital receipts available as structured JSON payloads and downloadable PDF documents.
* **Full & Partial Refunds:** Administrative refund processing with mandatory reason tracking and gateway synchronization.
* **Scheduled Reconciliation:** Diagnostic tools to query gateway settlement statuses and resolve stranded payment sessions.

---

## 3. End-to-End Payment Workflow

The following diagram illustrates how customer payments are initiated, verified, and settled:

```
Customer Mobile App (Flutter)
           │
           ▼
[POST /api/v1/payments { bookingId }]
           │
           ▼
┌────────────────────────────────────────────────────────┐
│ 1. Order Creation & Amount Calculation                 │
│    - Verifies booking is in PENDING_PAYMENT status     │
│    - Fetches authoritative fee from fee configuration  │
│    - Creates gateway order & returns payment session   │
└──────────────────────────┬─────────────────────────────┘
                           │
                           ▼
Customer completes checkout on Payment Gateway SDK (Razorpay)
                           │
                           ▼
Payment Gateway Webhook
           │
           ▼
[POST /api/v1/webhooks/payments] (Raw HTTP Body + HMAC Header)
           │
           ▼
┌────────────────────────────────────────────────────────┐
│ 2. Cryptographic Validation & Atomic Settlement        │
│    - Validates HMAC SHA-256 signature                  │
│    - Deduplicates webhook event in payment_events      │
│    - Updates payment status to SUCCEEDED               │
│    - Invokes BookingService.applyPaymentSucceeded      │
│    - Atomically moves booking to CONFIRMED             │
└──────────────────────────┬─────────────────────────────┘
                           │
                           ▼
┌────────────────────────────────────────────────────────┐
│ 3. Client Handoff & Receipt Delivery                   │
│    - Queues payment confirmation push notification     │
│    - Issues downloadable digital PDF payment receipt   │
└────────────────────────────────────────────────────────┘
```

---

## 4. API Endpoints & Contracts

### 1. `POST /api/v1/payments`
Initializes a payment order for a booking in `PENDING_PAYMENT` state.
* **Payload:** `{ bookingId: "booking_uuid" }`
* **Response:** `{ paymentId, amount, currency: "INR", gatewayOrderId, keyId }`

---

### 2. `POST /api/v1/payments/:id/verify`
Allows the customer mobile client to report completed checkout for immediate server-side gateway verification.

---

### 3. `GET /api/v1/payments` & `GET /api/v1/payments/:id`
Retrieves customer payment histories, settlement states, and refund details.

---

### 4. `GET /api/v1/payments/:id/receipt/pdf`
Generates and downloads a digital PDF payment receipt.

---

### 5. `POST /api/v1/webhooks/payments`
Public webhook endpoint for incoming payment gateway callbacks (authenticated via HMAC signature).

---

### 6. `POST /api/v1/admin/payments/:id/refund`
Processes an authorized customer refund through the payment gateway.
* **Authorization:** Administrative JWT (`payment.refund` permission).
* **Payload:** `{ reason: "Customer requested cancellation within trial window" }`

---

## 5. Inter-Module Dependencies & System Design

The Payment module coordinates closely with Bookings and Notifications:

```
┌─────────────────────────┐
│     Booking Module      │◄──┐  Invokes applyPaymentSucceeded
│   (PENDING_PAYMENT)     │   │  upon verified webhook
└─────────────────────────┘   │
                              │
┌─────────────────────────┐   │  Dispatches Receipts
│     Payment Module      ├───┼────────────────────────► [ Notifications Module ]
│  (Settlement & Refunds) │   │                          (SMS & Push Alerts)
└─────────────────────────┘   │
                              │
┌─────────────────────────┐   │
│ Payment Gateway (SaaS)  │───┘
│ (Razorpay / Webhooks)   │
└─────────────────────────┘
```

* **Booking Orchestration:** Payment success automatically unlocks the booking schedule and transitions the engagement to `CONFIRMED`.
* **Receipt Delivery:** Successful transactions trigger the Notifications module to dispatch confirmation SMS messages and PDF download links to the customer.

