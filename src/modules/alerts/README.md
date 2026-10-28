# Alerts Module

## 1. Executive Summary

The Alerts module provides an operational command center and real-time anomaly detection inbox for operations staff and administrators. As a real-time marketplace handling physical home services, financial payments, and verification compliance, SevaNest continuously detects operational friction—such as stuck bookings, SLA breaches, payment webhook failures, and unassigned requests. The Alerts module surfaces these events with standardized severity levels, enabling operations staff to acknowledge, triage, and resolve incidents with complete audit accountability.

---

## 2. Core Features & Capabilities

* **Real-Time Operational Inbox:** Centralizes critical business anomalies, stuck states, and service breaches across booking, payment, matching, and support workflows into a single dashboard.
* **Granular Severity Levels:** Classifies alerts into standardized tiers (`INFO`, `WARNING`, `CRITICAL`), facilitating fast prioritization during peak operating hours.
* **Audited Triage Lifecycle:** Implements a formalized acknowledgement and resolution flow where staff capture investigative notes, preventing duplicate interventions across team members.
* **Auto-Reopening Anomaly Guard:** If an issue is manually resolved but the root anomaly persists on subsequent system health scans, the alert automatically re-opens to prevent silent service degradation.
* **Role-Based Alert Filtering:** Enforces strict permission controls so staff only view and manage alerts pertinent to their specific operational responsibilities.

---

## 3. End-to-End Operational Alert Lifecycle

```
[ Domain Subsystems / Cron ]       [ Alerts Module ]         [ Operations Dashboard ]
             |                             |                            |
             | 1. Detect Anomaly           |                            |
             |    (e.g., Booking Stuck)    |                            |
             |---------------------------->|                            |
             |                             | 2. Deduplicate or Upsert   |
             |                             |    Assign Severity         |
             |                             |                            |
             |                             | 3. GET /admin/alerts       |
             |                             |<---------------------------|
             |                             | 4. Return Open Alerts      |
             |                             |--------------------------->|
             |                             |                            |
             |                             | 5. POST /:id/acknowledge   |
             |                             |<---------------------------|
             |                             | 6. Set IN_PROGRESS (Audit) |
             |                             | 7. Return Acknowledged     |
             |                             |--------------------------->|
             |                             |                            |
             |                             | 8. POST /:id/resolve       |
             |                             |    (with resolution note)  |
             |                             |<---------------------------|
             |                             | 9. Mark RESOLVED (Audit)   |
             |                             |--------------------------->|
```

---

## 4. API Endpoints & Contracts

* **`GET /api/v1/admin/alerts`**  
  * **Role:** Staff (`ADMIN` with `alert.view`)  
  * **Summary:** Fetch open operational alerts ordered newest first, with severity, status, and category filters.  
  * **Query Parameters:** `status` (`OPEN`, `ACKNOWLEDGED`, `RESOLVED`), `severity`, `type`, `page`, `limit`  
  * **Response:** `{ data: [AlertView], meta: PageMeta }`

* **`GET /api/v1/admin/alerts/summary`**  
  * **Role:** Staff (`ADMIN` with `alert.view`)  
  * **Summary:** Retrieve real-time counter of open alerts grouped by severity level for dashboard notification badges.  
  * **Response:** `{ open: number, bySeverity: { CRITICAL: number, WARNING: number, INFO: number } }`

* **`POST /api/v1/admin/alerts/:alertId/acknowledge`**  
  * **Role:** Staff (`ADMIN` with `alert.manage`)  
  * **Summary:** Acknowledge an alert to indicate active staff investigation (idempotent, audited).  
  * **Response:** Updated `AlertView`

* **`POST /api/v1/admin/alerts/:alertId/resolve`**  
  * **Role:** Staff (`ADMIN` with `alert.manage`)  
  * **Summary:** Close an alert with required resolution notes explaining corrective measures taken.  
  * **Payload:** `{ note: string }`  
  * **Response:** Updated `AlertView`

---

## 5. Inter-Module Dependencies & System Design

```
+--------------------------------------------------------------+
|                        Alerts Module                         |
+--------------------------------------------------------------+
         ^                                           |
         |                                           v
+-----------------------+                   +------------------+
| Domain Subsystems     |                   | Operations Teams |
| Booking, Payments,    |                   | RBAC-Controlled  |
| Verification & Workers|                   | Admin Workspaces |
+-----------------------+                   +------------------+
```

* **Non-Invasive Diagnostic Ingestion:** Alert creation is decoupled from core transactional paths via event listeners or scheduled scanner sweeps, ensuring database write operations on bookings and payments never fail due to alert logging.
* **Persistent Problem Detection:** Resolving an alert does not mutate domain entities; if a booking remains in an invalid state, continuous health checks will re-raise the alert until the underlying root cause is addressed.
