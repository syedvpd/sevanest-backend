# Shortlist Module

## 1. Executive Summary

The Shortlist module delivers worker bookmarking and candidate tracking capabilities for customers. As customers browse verified service professionals across various categories, the shortlist allows them to curate, compare, and preserve candidate profiles prior to booking or interview requests. The module provides real-time worker availability checks, idempotency across additions and removals, and tight integration with the customer home dashboard.

---

## 2. Core Features & Capabilities

* **Curated Worker Bookmarking:** Enables customers to save preferred worker profiles with a single action, creating an organized pool of potential domestic hires.
* **Real-Time Eligibility Reflection:** Dynamically decorates bookmarked worker items with customer-safe profile cards if the worker remains active and eligible; gracefully flags unavailable or deactivated candidates.
* **Bounded Collection Protection:** Imposes a guard limit (maximum 100 entries per customer) to prevent database degradation and enforce meaningful curation.
* **Idempotent Mutations:** Adding or deleting candidates is fully idempotent, ensuring network retries from mobile clients never cause duplicate records or errors.
* **Unified Dashboard Previews:** Supplies summarized shortlist counters and top-candidate snapshots directly to customer home feed aggregations.

---

## 3. End-to-End Shortlist Workflow

```
[ Customer App ]             [ Shortlist Module ]         [ Workers / Search ]
       |                              |                            |
       | 1. PUT /shortlist/:workerId  |                            |
       |----------------------------->| 2. Check Worker Visibility |
       |                              |--------------------------->|
       |                              |<---------------------------|
       |                              | 3. Persist Bookmark        |
       | 4. 204 No Content            |                            |
       |<-----------------------------|                            |
       |                                                           |
       | 5. GET /shortlist (Paginated)|                            |
       |----------------------------->| 6. Fetch Items & Status    |
       |                              |--------------------------->|
       |                              |<---------------------------|
       | 7. Return Shortlist with     |                            |
       |    Worker Cards & Status     |                            |
       |<-----------------------------|                            |
       |                                                           |
       | 8. DELETE /shortlist/:workerId                            |
       |----------------------------->| 9. Remove Bookmark         |
       | 10. 204 No Content           |                            |
       |<-----------------------------|                            |
```

---

## 4. API Endpoints & Contracts

* **`GET /api/v1/shortlist`**  
  * **Role:** Customer (`CUSTOMER`)  
  * **Summary:** Fetch paginated list of shortlisted workers ordered newest first.  
  * **Query Parameters:** `page`, `limit`  
  * **Response:** `{ data: [{ workerId: string, available: boolean, worker: WorkerDisplayView | null, createdAt: string }], meta: PageMeta }`

* **`PUT /api/v1/shortlist/:workerId`**  
  * **Role:** Customer (`CUSTOMER`)  
  * **Summary:** Add a worker to the customer's personal shortlist (idempotent; capped at 100 entries).  
  * **Response:** `204 No Content`

* **`DELETE /api/v1/shortlist/:workerId`**  
  * **Role:** Customer (`CUSTOMER`)  
  * **Summary:** Remove a worker from the customer's shortlist (idempotent).  
  * **Response:** `204 No Content`

---

## 5. Inter-Module Dependencies & System Design

```
+--------------------------------------------------------------+
|                       Shortlist Module                       |
+--------------------------------------------------------------+
         |                                           |
         v                                           v
+-----------------------+                   +------------------+
| Workers & Verification|                   | Home Aggregation |
| Real-time Eligibility |                   | Dashboard Feeds  |
| & Profile Details     |                   | & Preview Cards  |
+-----------------------+                   +------------------+
```

* **Live Status Evaluation:** Rather than freezing snapshot data, the shortlist dynamically verifies current worker visibility and active status on read, preventing customers from hiring suspended workers.
* **Cross-Module Feeds:** Supplies fast indexed reads to the customer home dashboard, optimizing mobile startup time via pre-aggregated previews.
