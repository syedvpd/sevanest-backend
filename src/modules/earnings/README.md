# Earnings Module

## 1. Executive Summary

The Earnings module manages the wage payment tracking and financial reference ledger for domestic service workers. While customer platform fees and subscription transactions are handled digitally through the Payment module, worker service wages are frequently settled directly off-platform between customers and workers. The Earnings module provides an audited, append-only administrative ledger where operational staff log, correct, and reconcile verified wage disbursements, giving workers complete transparency into their cumulative historical compensation.

---

## 2. Core Features & Capabilities

* **Worker Earnings Transparency:** Provides workers with an intuitive, mobile-friendly breakdown of recorded wage disbursements, payment dates, associated bookings, and cumulative earnings.
* **Append-Only Administrative Ledger:** Enforces immutable audit logging for all wage records logged by operations staff, preventing silent modifications or arbitrary data overrides.
* **Audited Corrections & Voids:** When adjustments are required, the original record remains preserved in historical audit trails while new correction or cancellation entries adjust active balance totals.
* **Booking State Verification:** Restricts wage logging exclusively to active or completed bookings with verified assigned workers, ensuring accounting integrity.
* **Staff RBAC & Audit Enforcement:** Restricts wage entry, revision, and voiding capabilities to authorized finance and operations administrators with comprehensive change attribution.

---

## 3. End-to-End Wage Tracking Workflow

```
[ Operations Staff ]         [ Earnings Module ]          [ Worker App ]
         |                            |                         |
         | 1. Record Wage Payment     |                         |
         |    (bookingId, amount, ref)|                         |
         |--------------------------->|                         |
         |                            | 2. Verify Booking & Worker
         |                            | 3. Append Immutable Entry
         | 4. 201 Created             |                         |
         |<---------------------------|                         |
         |                            |                         |
         |                            | 5. GET /workers/me/earnings
         |                            |<------------------------|
         |                            | 6. Aggregate Net Active |
         |                            |    Disbursements        |
         |                            | 7. Return Wage History  |
         |                            |    & Total Sum          |
         |                            |------------------------>|
         |                            |                         |
         | 8. Correct Entry (Post-audit)                        |
         |--------------------------->|                         |
         |                            | 9. Mark Prior Inactive  |
         |                            |    Append New Row       |
         | 10. Corrected Entry OK     |                         |
         |<---------------------------|                         |
```

---

## 4. API Endpoints & Contracts

* **`GET /api/v1/workers/me/earnings`**  
  * **Role:** Worker (`WORKER`)  
  * **Summary:** View paginated personal wage payments recorded by staff, along with total cumulative earnings.  
  * **Query Parameters:** `page`, `limit`  
  * **Response:** `{ data: [{ id: string, bookingId: string, amountMinor: number, currency: string, paidOn: string }], totals: { totalEarnedMinor: number, currency: string }, meta: PageMeta }`

* **`POST /api/v1/admin/wage-payments`**  
  * **Role:** Staff / Admin (`ADMIN` with `payment.manage`)  
  * **Summary:** Record an off-platform wage disbursement for a started booking (idempotent, audited).  
  * **Payload:** `{ bookingId: string, amountMinor: number, paidOn: string, paymentMethod: string, reference?: string, note?: string }`  
  * **Response:** Admin wage payment view object.

* **`POST /api/v1/admin/wage-payments/:id/correct`**  
  * **Role:** Staff / Admin (`ADMIN` with `payment.manage`)  
  * **Summary:** Correct an existing wage payment entry; preserves historical row and introduces a replacement entry.  
  * **Payload:** `{ amountMinor: number, paidOn: string, paymentMethod: string, reference?: string, reason: string }`

* **`POST /api/v1/admin/wage-payments/:id/void`**  
  * **Role:** Staff / Admin (`ADMIN` with `payment.manage`)  
  * **Summary:** Void an erroneous wage entry with an audited justification.  
  * **Payload:** `{ reason: string }`

* **`GET /api/v1/admin/wage-payments`**  
  * **Role:** Staff / Admin (`ADMIN` with `payment.view`)  
  * **Summary:** Query all wage records with worker, booking, date, and status filters.

---

## 5. Inter-Module Dependencies & System Design

```
+--------------------------------------------------------------+
|                       Earnings Module                        |
+--------------------------------------------------------------+
         |                                           |
         v                                           v
+-----------------------+                   +------------------+
| Booking & Workers     |                   | Security & RBAC  |
| Validates Active Job  |                   | Audited Staff    |
| & Worker Assignment   |                   | Permissions Check|
+-----------------------+                   +------------------+
```

* **Financial Ledger Integrity:** Designed as an append-only transaction ledger that decouples informational wage tracking from automated credit card / UPI gateway billing.
* **State Coherence with Booking Lifecycle:** Prevents orphaned wage transactions by validating that wage disbursements only attach to genuine bookings that have reached service commencement.
