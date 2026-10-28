# Legal Module

## 1. Executive Summary

The Legal module governs regulatory compliance, terms of service agreements, privacy consent tracking, and account deletion requests across the SevaNest platform. Built to comply with modern data privacy frameworks (DPDP / GDPR) and mobile app store mandates, it maintains versioned records of all user consents, safeguards against invalid deletions while active financial or service commitments exist, and provides audited administrative workflows for reviewing data erasure requests.

---

## 2. Core Features & Capabilities

* **Public Terms & Privacy Versioning:** Exposes current terms of service and privacy policy versions publicly so mobile and web applications can present agreements prior to authentication.
* **Append-Only Consent Tracking:** Maintains an immutable historical log of terms and privacy policy acceptances with timestamps and version tags, ensuring legal non-repudiation.
* **Self-Service Account Deletion:** Gives customers and workers an automated self-service path to request account and personal data deletion directly within the mobile application.
* **Deletion In-Flight Protection:** Automatically blocks account deletion requests if the user has ongoing active bookings, pending service disputes, or unfinalized payment/refund transactions.
* **Audited Deletion Governance:** Provides staff with a structured administrative interface to review open deletion requests, verify cooling-off periods, and log formal justifications if a deletion must be refused.

---

## 3. End-to-End Legal Consent & Account Deletion Workflow

```
[ User Mobile App ]          [ Legal Module ]           [ Compliance Staff / Ops ]
         |                          |                               |
         | 1. GET /legal/current    |                               |
         |    (Public Query)        |                               |
         |------------------------->|                               |
         | 2. Current Policy Info   |                               |
         |<-------------------------|                               |
         |                                                          |
         | 3. POST /legal/accept (v1.2)                             |
         |------------------------->| 4. Log Immutable Consent      |
         | 5. Acceptance Confirmed  |                               |
         |<-------------------------|                               |
         |                                                          |
         | 6. Request Deletion      |                               |
         |------------------------->| 7. Check Active Bookings &    |
         |                          |    Pending Transactions       |
         |                          |    (If clear, enter queue)    |
         | 8. Deletion Request Logged                               |
         |<-------------------------|                               |
         |                          |                               |
         |                          | 9. Review During Cooling-Off  |
         |                          |<------------------------------|
         |                          | 10. Forward to Retention for  |
         |                          |     Automated Anonymization   |
```

---

## 4. API Endpoints & Contracts

* **`GET /api/v1/legal/current`**  
  * **Role:** Public (No authentication required)  
  * **Summary:** Fetch active version identifiers and metadata for terms of service and privacy policies.  
  * **Response:** `{ termsVersion: string, privacyVersion: string, updatedAt: string }`

* **`GET /api/v1/legal/status`**  
  * **Role:** Authenticated User (`CUSTOMER`, `WORKER`, `ADMIN`)  
  * **Summary:** Check if the signed-in user has accepted the latest terms and privacy policy versions.  
  * **Response:** `{ termsAccepted: boolean, privacyAccepted: boolean, termsVersion: string, privacyVersion: string }`

* **`POST /api/v1/legal/accept`**  
  * **Role:** Authenticated User (`CUSTOMER`, `WORKER`)  
  * **Summary:** Record user acceptance of the current legal policies (append-only).  
  * **Payload:** `{ termsVersion?: string, privacyVersion?: string }`  
  * **Response:** Updated `LegalStatusView`

* **`POST /api/v1/me/deletion-request`**  
  * **Role:** Authenticated User (`CUSTOMER`, `WORKER`)  
  * **Summary:** Submit an account and personal data deletion request.  
  * **Payload:** `{ reason?: string }`  
  * **Response:** `{ id: string, status: "PENDING", requestedAt: string }`

* **`DELETE /api/v1/me/deletion-request`**  
  * **Role:** Authenticated User (`CUSTOMER`, `WORKER`)  
  * **Summary:** Withdraw an open account deletion request during the cooling-off period.  
  * **Response:** `204 No Content`

* **`GET /api/v1/admin/deletion-requests`**  
  * **Role:** Staff (`ADMIN` with `user_status.manage`)  
  * **Summary:** List and filter account deletion requests submitted across the platform.

* **`POST /api/v1/admin/deletion-requests/:requestId/reject`**  
  * **Role:** Staff (`ADMIN` with `user_status.manage`)  
  * **Summary:** Refuse a deletion request with an audited justification (e.g., active legal hold or pending liability).  
  * **Payload:** `{ reason: string }`

---

## 5. Inter-Module Dependencies & System Design

```
+--------------------------------------------------------------+
|                         Legal Module                         |
+--------------------------------------------------------------+
         |                                           |
         v                                           v
+-----------------------+                   +------------------+
| Booking & Payment     |                   | Retention Worker |
| Active Commitment     |                   | Scheduled Data   |
| Verification Checks   |                   | Anonymization    |
+-----------------------+                   +------------------+
```

* **Guard Rails for Active Obligations:** Deletion requests interact with Booking and Payment repositories to verify that no pending escrow funds, unpaid invoices, or unfulfilled service commitments exist before accepting a deletion.
* **Separation of Intent and Execution:** Legal records user intent and compliance consents; actual cryptographic data sanitization and anonymization are executed by the Retention subsystem after cooling-off expiry.
