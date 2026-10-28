# Worker Background Verification (KYC) Module

## 1. Executive Summary

The **Worker Verification Module** manages the trust, safety, and background vetting pipeline of the SevaNest marketplace. Because household helpers work inside personal family residences, this module enforces that no worker can be matched or discovered until their identity, address, police clearance, and emergency contacts are rigorously reviewed and approved by operations staff.

Engineered around **Zero-Trust Safety** and **Private Document Architecture**:
1. **Private Encrypted Storage:** Document images (Aadhaar, Voter ID, Police Verification Certificates) are stored in secure, private object storage and are never publicly accessible.
2. **Ephemeral Presigned URLs:** Reviewers and workers access files strictly via short-lived, permission-validated signed links (60-second expiry) that are individually audit-logged.
3. **Fail-Closed Verification Gate:** A worker appears in public search *only* when every mandatory check is approved and an authorized operations supervisor provides formal sign-off.

---

## 2. Core Features & Capabilities

* **Multi-Check Verification Dossier:** Orchestrates multiple distinct verification tracks: Government Identity, Residential Address, Police Clearance Status, Emergency Contact, and Previous Employment.
* **Direct Private Upload Pipeline:** Generates temporary upload links directly to object storage, validating file size, MIME types, and SHA-256 signatures upon confirmation.
* **Staff Claim & Review Queue:** Triage queues enabling verification executives to claim worker dossiers (`start-review`), record call notes, and document verification details.
* **Granular Rejection Codes:** Standardized rejection reasons (e.g., `BLURRY_IMAGE`, `NAME_MISMATCH`, `DOCUMENT_EXPIRED`), allowing workers to resubmit specific deficient documents without restarting the entire onboarding process.
* **Periodic Re-Check Audits:** Automatic calculation of background re-check expiration dates, causing expired workers to automatically drop out of search until re-verified.

---

## 3. End-to-End Worker Verification Workflow

The following diagram illustrates the verification review pipeline:

```
Worker Mobile App
           │
           ▼
[POST /api/v1/workers/me/verification/checks/:type/documents { contentType, sizeBytes }]
           │
           ▼
┌────────────────────────────────────────────────────────┐
│ 1. Presigned Upload Link Issuance                      │
│    - Verifies worker profile is SUBMITTED              │
│    - Returns short-lived S3 upload URL                 │
└──────────────────────────┬─────────────────────────────┘
                           │ Worker uploads document
                           ▼
[POST /api/v1/workers/me/verification/documents/:id/confirm]
[POST /api/v1/workers/me/verification/checks/:type/submit]
                           │
                           ▼
Operations Portal (Verification Queue)
           │
           ▼
┌────────────────────────────────────────────────────────┐
│ 2. Triage & Review Claim                               │
│    - Reviewer claims check via start-review            │
│    - Inspects document via ephemeral signed link       │
│    - Conducts reference & police record verification   │
└──────────────────────────┬─────────────────────────────┘
                           │
                           ▼
[POST /api/v1/admin/verification/checks/:id/approve]
           │
           ▼
┌────────────────────────────────────────────────────────┐
│ 3. Supervisor Sign-off & Platform Activation           │
│    - Verifies all required checks are APPROVED         │
│    - Supervisor grants formal verification sign-off    │
│    - Worker transitions to ACTIVE in Search & Matching │
└────────────────────────────────────────────────────────┘
```

---

## 4. API Endpoints & Contracts

### 1. `GET /api/v1/workers/me/verification`
Returns the worker's current verification dossier, required checks, and check-level approval statuses.

---

### 2. `POST /api/v1/workers/me/verification/checks/:type/documents`
Requests a private pre-signed URL for document upload.
* **Payload:** `{ contentType: "image/jpeg", sizeBytes: 2048576 }`
* **Response:** `{ uploadUrl, documentId, expiresInSeconds }`

---

### 3. `POST /api/v1/workers/me/verification/documents/:id/confirm`
Confirms the file has been successfully uploaded to private storage and validates file integrity.

---

### 4. `GET /api/v1/admin/verification/queue`
Administrative queue listing worker dossiers awaiting review, sorted by submission timestamp.

---

### 5. `POST /api/v1/admin/verification/checks/:id/start-review`
Claims a check for review, locking it to the assigned reviewer.

---

### 6. `POST /api/v1/admin/verification/checks/:id/approve` & `.../reject`
Records the formal verification decision.
* **Payload for Rejection:** `{ reasonCode: "BLURRY_IMAGE", remarks?: "Corners of the Aadhaar card are cut off" }`

---

### 7. `POST /api/v1/admin/workers/:workerId/verification/sign-off`
Supervisory approval given once all mandatory checks are satisfied.

---

### 8. `POST /api/v1/admin/workers/:workerId/activate`
Activates the verified worker, allowing them to appear in public search and concierge matching.

---

## 5. Inter-Module Dependencies & System Design

The Verification module is the trust guardian for the marketplace:

```
┌─────────────────────────┐
│     Workers Module      │──┐
│  (Profile Submission)   │  │
└─────────────────────────┘  │
                             ▼
                 [ Verification Module ] ──► [ Search & Matching Module ]
                 (KYC Gate & Approvals)      (Only Active & Verified Appear)
                             │
                             ▼
                 [ Secure Private Bucket ]
                 (Encrypted Document S3)
```

* **Search Gating:** The Search and Matching modules query the Verification module's active condition—workers without formal sign-off and active checks are 100% invisible.
* **Storage Provider:** Integrates with private S3/Blob storage to issue short-lived signed URLs, ensuring zero public web exposure of citizen documents.

