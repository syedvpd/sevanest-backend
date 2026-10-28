# Search & Worker Discovery Module

## 1. Executive Summary

The **Search & Discovery Module** is the public-facing storefront of SevaNest. It empowers customers to find verified domestic workers (maids, cooks, drivers, babysitters, elderly care assistants) tailored precisely to their household needs, location, and schedule.

Because household employment involves inviting workers into personal homes, this module is engineered around a **Safety-First, Zero-Trust Principle**:
1. **100% Verified Only:** A worker *never* appears in search results unless their background, government identity, address, and criminal self-declarations have been thoroughly vetted and approved by operations staff.
2. **Privacy by Design:** Search results return privacy-sanitized "Worker Cards." Sensitive Personally Identifiable Information (PII)—such as real phone numbers, home addresses, government document IDs, and full legal names—is strictly redacted to protect worker safety.
3. **High-Performance Architecture:** Search is designed as a high-throughput, read-only query engine capable of sub-100ms response times across tens of thousands of workers without database bottlenecks.

---

## 2. Core Features & Capabilities

* **Multi-Dimensional Discovery:** Filter workers simultaneously by:
  * **Service Category** (e.g., Maid, Cook, Driver, Babysitter, Elderly Care).
  * **Hyper-Local Area** (e.g., HITEC City, Madhapur, Gachibowli, Kondapur).
  * **Engagement Model** (`FULL_TIME`, `PART_TIME`, `LIVE_IN`).
  * **Working Time Windows** (e.g., Available between `08:00` and `12:00`).
  * **Spoken Languages** (e.g., Telugu, Hindi, English).
  * **Minimum Experience** (e.g., 2+ years).
* **Public Worker Profile Cards:** Customer-safe view of a worker's skills, verified status, languages, rating score, and professional profile photo.
* **Real-Time Slot Availability (`/slots`):** Calculates available 1-hour interview and trial time slots over the next 14 days, dynamically subtracting conflicting bookings and confirmed interviews.
* **Customer Reviews & Moderated Feedback (`/ratings`):** Displays verified customer ratings and feedback, automatically filtering out hidden or abusive reviews.
* **Staff-Assisted Fallback (`canRequestAdminMatching`):** If no worker matches a customer's specific criteria, the API proactively flags `canRequestAdminMatching: true`, allowing the customer to request custom concierge matching from SevaNest support staff.

---

## 3. End-to-End Search Workflow

The following diagram illustrates how a customer search request flows through authentication, security filtering, and database execution:

```
Customer Mobile App (Flutter)
           │
           ▼
[GET /api/v1/search/workers?category=COOK&areaId=...]
           │
           ▼
┌────────────────────────────────────────────────────────┐
│ 1. Guard & Parameter Validation                        │
│    - Verifies Customer JWT authentication              │
│    - Validates category and area are active & enabled  │
│    - Strips malicious or unexpected query parameters   │
└──────────────────────────┬─────────────────────────────┘
                           │
                           ▼
┌────────────────────────────────────────────────────────┐
│ 2. Eligibility & Safety Enforcement Pipeline           │
│    - Account Status: ACTIVE (not suspended)            │
│    - Profile Status: SUBMITTED                         │
│    - Verification: FULLY_VERIFIED (Staff approved)     │
│    - Safety Filter: Excludes reported/blocked workers  │
│    - Location Filter: Worker covers the requested area │
│    - Window Filter: Availability covers time range     │
└──────────────────────────┬─────────────────────────────┘
                           │
                           ▼
┌────────────────────────────────────────────────────────┐
│ 3. Optimized Database Query Execution                  │
│    - Single SQL query with count(*) OVER ()            │
│    - Retrieves paginated list + total in 1 statement   │
│    - Batches categories, areas, ratings, and photos    │
│    - Guaranteed ZERO N+1 database queries              │
└──────────────────────────┬─────────────────────────────┘
                           │
                           ▼
┌────────────────────────────────────────────────────────┐
│ 4. Privacy Sanitization & Card Serialization           │
│    - Redacts phone, address, Aadhaar, salary, name     │
│    - Applies temporary signed URLs for photos          │
│    - Returns sanitized WorkerCard[] + metadata         │
└────────────────────────────────────────────────────────┘
```

---

## 4. API Endpoints & Contracts

### 1. `GET /api/v1/search/workers`
Discovers and filters workers based on search criteria.

* **Authorization:** Customer Bearer JWT (`CUSTOMER` role).
* **Required Query Parameters:**
  * `category` (string, e.g., `COOK`)
  * `areaId` (UUID)
* **Optional Query Parameters:**
  * `engagement` (`FULL_TIME` | `PART_TIME` | `LIVE_IN`)
  * `availableFrom` & `availableTo` (e.g., `09:00` and `13:00`, must be supplied together)
  * `language` (e.g., `HINDI`)
  * `minExperienceMonths` (integer, e.g., `24`)
  * `sort` (`EXPERIENCE_DESC` default | `EXPERIENCE_ASC`)
  * `page` (default: 1) & `limit` (default: 20, max: 100)

---

### 2. `GET /api/v1/search/workers/:workerId`
Fetches the detailed customer-safe profile card of an individual worker.
* Returns `404 WORKER_NOT_FOUND` if the worker does not exist OR if the worker is unverified/suspended (preventing enumeration attacks).

---

### 3. `GET /api/v1/search/workers/:workerId/slots`
Calculates bookable 1-hour interview/trial time slots for a specific worker.
* **Query:** `date=YYYY-MM-DD` (must be within the next 14 calendar days).
* Automatically reconciles the worker's working hours against existing bookings and pending interviews.

---

### 4. `GET /api/v1/search/workers/:workerId/ratings`
Lists historical customer reviews and feedback (paginated, newest first).
* Excludes reviews flagged or hidden by admin moderation.

---

## 5. Inter-Module Dependencies & System Design

The Search module sits at the intersection of several SevaNest domains:

```
┌─────────────────────────┐
│     Workers Module      │──┐
│ (Profile, Skills, Lang) │  │
└─────────────────────────┘  │
┌─────────────────────────┐  │
│   Availability Module   │──┼──► [ Search Module ] ──► Matching Module
│ (Schedules, Shifts)     │  │    (Read-Only Engine)    (Staff Recommendations)
└─────────────────────────┘  │
┌─────────────────────────┐  │
│   Verification Module   │──┤
│ (Approval Status, KYC)  │  │
└─────────────────────────┘  │
┌─────────────────────────┐  │
│     Ratings Module      │──┘
│ (Reviews, Star Average) │
└─────────────────────────┘
```
* **Data Integration:** The Search module aggregates verified information from Workers, Availability, Verification, and Ratings to provide unified discovery without mutating underlying data.
* **Matching Coordination:** When a customer requests assisted matching, the Matching service coordinates with Search to identify eligible, top-rated candidates.

