# Safety Module

## 1. Executive Summary

The Safety module protects customers and service workers by managing mutual blocklists, safety incident reporting, and administrative intervention workflows. In an in-home service marketplace, personal safety and trust are paramount. The module ensures that when a block or report is initiated, the involved parties are instantly partitioned across search results, shortlist curation, automated matching algorithms, and replacement candidate pools. Staff are immediately alerted to review reports and take appropriate administrative action.

---

## 2. Core Features & Capabilities

* **Mutual Safety Blocking:** Customers can block workers, and workers can block customers they have interacted with. Blocked pairs are permanently isolated from each other across all discovery, booking, and matching operations.
* **Incident & Misconduct Reporting:** Enables users to submit structured safety reports with categorized reason codes (e.g., misconduct, harassment, fraud) and free-text notes for staff review.
* **Instant Co-Blocking:** Allows users submitting a report to simultaneously apply a mutual block in a single atomic operation (`alsoBlock: true`).
* **Staff-Enforced Administrative Blocks:** Operations staff can enforce system-level blocks that cannot be lifted by users, protecting the community from flagged or abusive accounts.
* **Relationship Validation:** Prevents arbitrary blocking or reporting by verifying that an authentic interaction or booking exists between the two parties before accepting a submission.

---

## 3. End-to-End Safety Incident & Blocking Workflow

```
[ User (Customer / Worker) ]        [ Safety Module ]        [ Staff / Admin Console ]
             |                             |                           |
             | 1. Submit Safety Report     |                           |
             |    + Optional Immediate     |                           |
             |      Block Request          |                           |
             |---------------------------->|                           |
             |                             | 2. Verify Valid History   |
             |                             | 3. Create Incident Report |
             |                             | 4. Partition Matching     |
             |                             |    & Discovery Indexes    |
             |                             | 5. Dispatch Alert to Ops  |
             |                             |-------------------------->|
             | 6. Return Report & Block OK |                           |
             |<----------------------------|                           |
             |                             |                           |
             |                             | 6. Investigate Incident   |
             |                             | 7. Apply Mandatory Admin  |
             |                             |    Block or Account Action|
             |                             |<--------------------------|
```

---

## 4. API Endpoints & Contracts

* **`POST /api/v1/safety/blocks`**  
  * **Role:** Customer or Worker (`CUSTOMER`, `WORKER`)  
  * **Summary:** Block an individual with whom the caller has had an active or historical relationship (idempotent).  
  * **Payload:** `{ workerId?: string, customerId?: string, bookingId?: string, reason?: string }`  
  * **Response:** `{ blockId: string, blockedUserId: string, createdAt: string }`

* **`GET /api/v1/safety/blocks`**  
  * **Role:** Customer or Worker (`CUSTOMER`, `WORKER`)  
  * **Summary:** Retrieve list of active safety blocks created by the authenticated user.  
  * **Response:** `BlockView[]`

* **`DELETE /api/v1/safety/blocks/:blockId`**  
  * **Role:** Customer or Worker (`CUSTOMER`, `WORKER`)  
  * **Summary:** Remove a user-initiated safety block (admin-applied blocks cannot be removed by users).  
  * **Response:** `204 No Content`

* **`POST /api/v1/safety/reports`**  
  * **Role:** Customer or Worker (`CUSTOMER`, `WORKER`)  
  * **Summary:** File a safety or misconduct incident report with optional concurrent blocking (idempotent).  
  * **Payload:** `{ workerId?: string, customerId?: string, bookingId?: string, reasonCode: string, note: string, alsoBlock?: boolean }`  
  * **Response:** `{ reportId: string, status: "SUBMITTED", createdAt: string }`

* **`GET /api/v1/admin/safety/reports`**  
  * **Role:** Staff (`ADMIN` with `support.view`)  
  * **Summary:** List and filter all filed safety reports for operational investigation.

* **`POST /api/v1/admin/safety/blocks`**  
  * **Role:** Staff (`ADMIN` with `support.manage`)  
  * **Summary:** Impose an immutable staff-level safety block between two users (audited).

---

## 5. Inter-Module Dependencies & System Design

```
+--------------------------------------------------------------+
|                        Safety Module                         |
+--------------------------------------------------------------+
         |                                           |
         v                                           v
+-----------------------+                   +------------------+
| Search & Matching     |                   | Alerts & Support |
| Hard Candidate Filter |                   | Operations Inbox |
| Exclusion List        |                   | Immediate Triage |
+-----------------------+                   +------------------+
```

* **Zero-Tolerance Discovery Isolation:** The Search and Matching engines query the active safety block table directly to filter out blocked candidates prior to any score ranking.
* **Cross-Cutting Operational Alerting:** Safety reports trigger immediate operational alerts in the staff incident inbox, ensuring swift escalation for serious violations.
