# Retention Module

## 1. Executive Summary

The Retention module orchestrates automated data lifecycle management, compliance pruning, and personal data anonymization across the SevaNest platform. Designed to meet privacy regulations (DPDP / GDPR) and optimize database storage, the module runs background tasks that purge expired notifications, prune processed transactional outbox events, scrub rejected KYC verification documents, and execute permanent data sanitization for accounts past their cooling-off deletion period.

---

## 2. Core Features & Capabilities

* **Automated Data Pruning:** Periodically scans and purges transient operational data exceeding configured retention thresholds, including read notifications and historical transactional outbox logs.
* **Rejected KYC File Scrubbing:** Permanently removes identity documents and proof files associated with rejected verification attempts after statutory retention limits expire.
* **Account Anonymization Pipeline:** Automatically anonymizes personal data (names, phone numbers, addresses, device identifiers) for users whose deletion requests have completed the cooling-off period without revocation.
* **Dry-Run Audit Previews:** Provides Super Admins with an on-demand preview API to dry-run retention tasks and inspect candidate records before any destructive deletions occur.
* **Transactional Execution Safety:** Executes batch purges in strictly bounded transaction windows to prevent database lock contention and preserve low-latency API operations.

---

## 3. End-to-End Data Retention & Anonymization Lifecycle

```
[ BullMQ Retention Worker ]           [ Database Tables ]       [ Cloud Storage ]
            |                                  |                        |
            | 1. Scan Candidate Records        |                        |
            |    (Past Retention Thresholds)   |                        |
            |--------------------------------->|                        |
            |                                  |                        |
            | 2. Purge Expired Notifications   |                        |
            |    & Processed Outbox Events     |                        |
            |--------------------------------->|                        |
            |                                  |                        |
            | 3. Find Expired Rejected KYC     |                        |
            |--------------------------------->|                        |
            | 4. Delete Physical Doc Binaries  |                        |
            |---------------------------------------------------------->|
            |                                  |                        |
            | 5. Process Approved Deletions    |                        |
            |    (Past Cooling-Off Window)     |                        |
            |--------------------------------->|                        |
            | 6. Anonymize PII Fields          |                        |
            |    (Names, Phone, Address, IP)   |                        |
            |--------------------------------->|                        |
            | 7. Emit Audit Log Entry          |                        |
            |    (Task Summary & Counts)       |                        |
```

---

## 4. API Endpoints & Contracts

* **`GET /api/v1/admin/retention/preview`**  
  * **Role:** Super Admin (`ADMIN` with `audit.view`)  
  * **Summary:** Execute a non-destructive dry-run to preview data eligible for retention purging and account anonymization.  
  * **Response:**  
    ```json
    {
      "dryRun": true,
      "notificationsEligible": 120,
      "outboxEventsEligible": 4500,
      "rejectedKycFilesEligible": 8,
      "accountDeletionsEligible": 2,
      "executedAt": "2026-10-28T12:00:00.000Z"
    }
    ```

---

## 5. Inter-Module Dependencies & System Design

```
+--------------------------------------------------------------+
|                       Retention Module                       |
+--------------------------------------------------------------+
         |                                           |
         v                                           v
+-----------------------+                   +------------------+
| Core Database Tables  |                   | Object Storage   |
| PII Anonymization &   |                   | Direct Document  |
| Transaction Outbox    |                   | Deletion Hooks   |
+-----------------------+                   +------------------+
```

* **Storage and Compute Decoupling:** Retention workers run as decoupled background jobs managed by Redis and BullMQ queues, ensuring continuous operational cleanup without degrading user-facing API performance.
* **Audit-Preserving Anonymization:** Rather than deleting relational rows which would break financial ledger history, user records are anonymized (sanitizing phone numbers and personal names while preserving immutable financial totals).
