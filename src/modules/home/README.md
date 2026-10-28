# Home Module

## 1. Executive Summary

The Home module serves as the primary aggregation and orchestration layer for the customer mobile application. Designed to deliver an instantaneous, single round-trip launch experience, it aggregates active bookings, upcoming interviews, unread notification tallies, and shortlist candidate previews into a unified payload. The module employs advanced HTTP conditional caching (`ETag` and `If-None-Match`) with signed URL TTL bucketing, minimizing network bandwidth and eliminating redundant database operations.

---

## 2. Core Features & Capabilities

* **Single-Round-Trip Dashboard:** Combines active bookings, upcoming interview schedules with assigned workers, unread notification counts, and top shortlisted workers into one coherent response.
* **Smart HTTP Caching with ETags:** Generates deterministic `ETag` validators based on underlying state hashes, enabling clients to receive lightweight `304 Not Modified` responses when data is unchanged.
* **Signed URL Lifespan Bucketing:** Excludes volatile presigned photo link timestamps from the ETag hash by utilizing stable photo cache keys and time-bucket rounding, preventing unnecessary cache invalidations.
* **Sub-Service Parallelism:** Fetches bookings, interviews, notifications, and shortlists concurrently using non-blocking asynchronous execution to achieve minimal API latency.
* **Privacy-Safe Data Delivery:** Scopes all queries strictly to the authenticated customer and sanitizes worker details to maintain customer privacy and trust standards.

---

## 3. End-to-End Home Aggregation Workflow

```
[ Customer App ]             [ Home Module ]          [ Underlying Sub-Services ]
       |                            |                              |
       | 1. GET /customers/me/home  |                              |
       |    [If-None-Match: "ETag"] |                              |
       |--------------------------->| 2. Parallel Data Fetch:      |
       |                            |    - Active Bookings         |
       |                            |    - Next Scheduled Interview|
       |                            |    - Unread Notifications    |
       |                            |    - Shortlist Preview       |
       |                            |----------------------------->|
       |                            |<-----------------------------|
       |                            |                              |
       |                            | 3. Compute Composite ETag    |
       |                            |    & Check If-None-Match     |
       |                            |                              |
       | (If State Unchanged)       |                              |
       | 4a. 304 Not Modified       |                              |
       |<---------------------------|                              |
       |                            |                              |
       | (If State Changed)         |                              |
       | 4b. 200 OK + Full Payload  |                              |
       |     + Updated ETag Header  |                              |
       |<---------------------------|                              |
```

---

## 4. API Endpoints & Contracts

* **`GET /api/v1/customers/me/home`**  
  * **Role:** Customer (`CUSTOMER`)  
  * **Summary:** Retrieve the complete customer home screen feed in a single API call with HTTP conditional cache headers.  
  * **Headers:** `If-None-Match` (optional, client cached ETag)  
  * **Response (200 OK):**  
    ```json
    {
      "activeBooking": { "id": "uuid", "status": "CONFIRMED", "worker": { ... } },
      "activeBookingsTotal": 1,
      "upcomingInterview": { "id": "uuid", "scheduledAt": "ISO", "worker": { ... } },
      "unreadNotifications": 3,
      "shortlistPreview": [ { "workerId": "uuid", "worker": { ... } } ],
      "shortlistTotal": 4
    }
    ```  
  * **Response (304 Not Modified):** Returned when state has not changed since the client's provided ETag.

---

## 5. Inter-Module Dependencies & System Design

```
                     +-----------------------+
                     |      Home Module      |
                     +-----------------------+
                       /     |          |    \
                      /      |          |     \
                     v       v          v      v
        +-----------+ +------------+ +-------+ +-----------+
        |  Booking  | | Interview  | | Short | | Notifica- |
        |  Service  | |  Service   | | list  | |  tions    |
        +-----------+ +------------+ +-------+ +-----------+
```

* **Aggregation Over Micro-Queries:** Consolidates multiple domain queries into one server-side execution context, drastically reducing mobile battery drain and cellular latency.
* **Strict Read-Only Orchestration:** Home performs zero state mutations; it solely queries indexed read projections, preserving high horizontal scalability.
