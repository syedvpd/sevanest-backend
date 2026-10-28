# System Module

## 1. Executive Summary

The System module serves as the platform's diagnostic pre-flight verification and operational health monitor. Designed for DevOps engineers, Super Administrators, and automated deployment pipelines, it inspects every operational prerequisite required for live marketplace transactions—including service area availability, platform fee configuration, mandatory identity verification rules, messaging provider credentials, notification template seeds, and background worker loop liveness.

---

## 2. Core Features & Capabilities

* **Holistic Operational Readiness:** Aggregates checks across database configuration, cloud providers, and background workers into an actionable readiness status (`READY` vs `BLOCKED`).
* **Critical Launch Blockers Identification:** Categorizes failures into non-negotiable blockers (such as absent platform fees, unseeded SMS templates, or dead background queues) that prevent real-world marketplace operations.
* **Background Worker Heartbeat Tracking:** Monitors background queue loops and consumers across Redis and BullMQ, verifying that workers have emitted heartbeats within the preceding 3-minute window.
* **Zero-Secret Diagnostic Surface:** Provides thorough operational visibility while strictly redacting sensitive provider tokens, passwords, and cryptographic secrets from diagnostic payloads.
* **Super-Admin Protection:** Secures diagnostic inspection behind elevated role-management permissions (`role.manage`), preventing reconnaissance by unauthorized accounts.

---

## 3. End-to-End System Readiness Diagnostic Workflow

```
[ DevOps / Super Admin ]         [ System Module ]         [ Infrastructure & Workers ]
           |                             |                              |
           | 1. GET /admin/system/       |                              |
           |    readiness                |                              |
           |---------------------------->| 2. Check Enabled Areas       |
           |                             |----------------------------->|
           |                             |<-----------------------------|
           |                             |                              |
           |                             | 3. Check Platform Fee & Rules|
           |                             |----------------------------->|
           |                             |<-----------------------------|
           |                             |                              |
           |                             | 4. Verify Messaging Providers|
           |                             |    & Seeded Templates        |
           |                             |----------------------------->|
           |                             |<-----------------------------|
           |                             |                              |
           |                             | 5. Poll Worker Heartbeats    |
           |                             |    (Last 3-Minute Window)    |
           |                             |----------------------------->|
           |                             |<-----------------------------|
           |                             |                              |
           |                             | 6. Compute Global Status     |
           |                             |    (READY vs BLOCKED)        |
           | 7. Return Readiness Report  |                              |
           |<----------------------------|                              |
```

---

## 4. API Endpoints & Contracts

* **`GET /api/v1/admin/system/readiness`**  
  * **Role:** Super Admin (`ADMIN` with `role.manage`)  
  * **Summary:** Audit all operational prerequisites required for platform launch.  
  * **Response:**  
    ```json
    {
      "status": "READY",
      "checkedAt": "2026-10-28T12:00:00.000Z",
      "checks": {
        "areasEnabled": true,
        "platformFeeConfigured": true,
        "verificationRulesActive": true,
        "messagingProvidersConfigured": true,
        "templatesSeeded": true
      },
      "blockers": [],
      "workers": [
        { "name": "outbox-publisher", "lastHeartbeat": "2026-10-28T11:59:45.000Z", "alive": true },
        { "name": "retention-worker", "lastHeartbeat": "2026-10-28T11:58:30.000Z", "alive": true }
      ]
    }
    ```

---

## 5. Inter-Module Dependencies & System Design

```
+--------------------------------------------------------------+
|                        System Module                         |
+--------------------------------------------------------------+
         |                                           |
         v                                           v
+-----------------------+                   +------------------+
| Database Config       |                   | Background Queue |
| Areas, Fee Rules,     |                   | Redis / BullMQ   |
| Templates & Policies  |                   | Worker Heartbeat |
+-----------------------+                   +------------------+
```

* **Comprehensive Pre-Flight Verification:** Prevents premature deployment rollouts by validating that operational data requirements are satisfied before opening access to end customers.
* **Decoupled Queue Health Auditing:** Evaluates worker health through non-intrusive timestamp comparisons against recent worker heartbeats, avoiding queue disruption during diagnostic checks.
