# History Module

## 1. Executive Summary

The History module powers the customer booking history screen, delivering detailed service logs and aggregated spending analytics across all completed, ended, and cancelled engagements. Designed for high read performance, it allows customers to filter their service records by calendar year, service category, keyword search, and lifecycle status. It also computes real-time summary statistics, including total completed engagements, distinct domestic workers employed, and net expenditure.

---

## 2. Core Features & Capabilities

* **Consolidated Service Records:** Provides customers with a chronologically ordered view of past bookings, including worker information, service dates, category tags, and total amounts paid.
* **Multi-Dimensional Query Filtering:** Supports precise client filtering by Indian standard calendar years, service category codes, booking status variants, and free-text worker/category searches.
* **Real-Time Financial & Engagement Summaries:** Dynamically computes top-level metric cards: total services completed, number of unique workers engaged, and net amounts successfully billed.
* **Strict Customer Scoping:** Enforces tenant isolation at the service layer, guaranteeing customers only access their own authenticated engagement histories and payment figures.
* **Consistent Pagination Contracts:** Uses standardized offset-based pagination metadata to ensure smooth infinite-scrolling feeds on mobile devices.

---

## 3. End-to-End Service History Workflow

```
[ Customer App ]             [ History Module ]           [ Booking & Payments ]
       |                            |                              |
       | 1. GET /booking-history    |                              |
       |    (year, category, search)|                              |
       |--------------------------->| 2. Query Finished Bookings   |
       |                            |    Filter by Customer ID     |
       |                            |----------------------------->|
       |                            |<-----------------------------|
       |                            | 3. Join Payment Totals       |
       | 4. Paginated Service List  |                              |
       |<---------------------------|                              |
       |                                                           |
       | 5. GET /booking-history/summary                           |
       |--------------------------->| 6. Compute Aggregate Totals: |
       |                            |    - Total Services          |
       |                            |    - Distinct Workers        |
       |                            |    - Net Spent Minor         |
       | 7. Return Summary Metrics  |                              |
       |<---------------------------|                              |
```

---

## 4. API Endpoints & Contracts

* **`GET /api/v1/customers/me/booking-history`**  
  * **Role:** Customer (`CUSTOMER`)  
  * **Summary:** Retrieve paginated finished bookings (completed, ended early, cancelled), newest first.  
  * **Query Parameters:** `year` (YYYY), `category` (string), `search` (string), `status` (enum), `page`, `limit`  
  * **Response:** `{ data: [{ bookingId: string, category: string, workerName: string, servicePeriod: string, status: string, amountPaidMinor: number }], meta: PageMeta }`

* **`GET /api/v1/customers/me/booking-history/summary`**  
  * **Role:** Customer (`CUSTOMER`)  
  * **Summary:** Retrieve header summary metrics: total services, distinct workers engaged, and total net amount spent.  
  * **Query Parameters:** `year` (optional), `category` (optional)  
  * **Response:** `{ totalServices: number, distinctWorkers: number, totalSpentMinor: number, currency: string }`

---

## 5. Inter-Module Dependencies & System Design

```
+--------------------------------------------------------------+
|                        History Module                        |
+--------------------------------------------------------------+
         |                                           |
         v                                           v
+-----------------------+                   +------------------+
| Booking Subsystem     |                   | Payment Ledger   |
| Service Milestones &  |                   | Settled Charges  |
| Worker Association    |                   | & Net Receipts   |
+-----------------------+                   +------------------+
```

* **Read-Optimized Service Projection:** Aggregates finalized booking data and reconciled payment totals without locking transactional booking tables, ensuring high read responsiveness.
* **Accurate Spending Reconciliation:** Only accounts for settled charges (`SUCCEEDED`) while accounting for pending or finalized refunds, presenting authentic financial transparency to the customer.
