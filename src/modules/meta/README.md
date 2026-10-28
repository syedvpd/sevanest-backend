# Meta Module

## 1. Executive Summary

The Meta module delivers centralized configuration, client version governance, and static reference vocabularies required during client application bootstrap. Prior to user authentication, mobile and web applications query the Meta module to enforce minimum build versions, detect active maintenance windows, obtain support contact details, and synchronize static system vocabularies (e.g., service engagement types, report reasons, rating scales, and status display labels). Responses are heavily cached with public HTTP headers to deliver sub-millisecond responses without incurring database load.

---

## 2. Core Features & Capabilities

* **Pre-Authentication App Bootstrap:** Provides all critical parameters necessary for mobile apps to determine operational eligibility before prompting users for sign-in or registration.
* **Forced Update & Version Enforcement:** Publishes minimum supported version boundaries (`minVersion`) and direct app store URLs (`storeUrl`) for both customer and worker applications, protecting against outdated and insecure clients.
* **Instant Maintenance Mode:** Surfaces global maintenance flags configured by administrators, allowing frontend applications to gracefully display maintenance notices during scheduled deployments.
* **Dynamic Legal & Policy Links:** Serves verified cancellation policies, refund terms, and current legal version identifiers configured by platform administrators.
* **Static Reference Vocabularies:** Exposes platform-wide enums and fixed choices—including service engagement types, budget billing frequencies, incident report reasons, support ticket priorities, and active rating tags.

---

## 3. End-to-End Client Bootstrap Workflow

```
[ Mobile App (Cold Boot) ]             [ CDN / Reverse Proxy ]         [ Meta Module ]
             |                                    |                           |
             | 1. GET /api/v1/app-config          |                           |
             |----------------------------------->|                           |
             |                                    | (If Cache Hit: Return)    |
             |                                    |---.                       |
             |                                    |<--'                       |
             |                                    | 2. Cache Miss: Query API  |
             |                                    |-------------------------->|
             |                                    | 3. Assemble Dynamic State |
             |                                    |<--------------------------|
             | 4. 200 OK + Cache-Control          |                           |
             |<-----------------------------------|                           |
             |                                                                |
             | 5. Verify Local Version >= minVersion                          |
             |    Check Maintenance Flag == false                             |
             |                                                                |
             | 6. GET /api/v1/reference-data                                  |
             |--------------------------------------------------------------->|
             | 7. Return Enums, Form Tags, & Scales                           |
             |<---------------------------------------------------------------|
```

---

## 4. API Endpoints & Contracts

* **`GET /api/v1/app-config`**  
  * **Role:** Public (No authentication required)  
  * **Cache:** `public, max-age=60`  
  * **Summary:** Application configuration, version gates, maintenance flag, and policy links.  
  * **Response:**  
    ```json
    {
      "customer": { "minVersion": "1.2.0", "storeUrl": "https://..." },
      "worker": { "minVersion": "1.1.0", "storeUrl": "https://..." },
      "maintenance": false,
      "support": { "phone": "+91...", "email": "help@sevanest.com" },
      "legal": { "termsVersion": "1.0", "privacyVersion": "1.0" },
      "policy": { "cancellationText": "...", "refundText": "..." },
      "languages": ["en", "hi"]
    }
    ```

* **`GET /api/v1/reference-data`**  
  * **Role:** Public (No authentication required)  
  * **Cache:** `public, max-age=300`  
  * **Summary:** Standardized form vocabularies: engagement types, budget frequencies, rating tags, and report reasons.  
  * **Response:**  
    ```json
    {
      "engagements": ["FULL_TIME", "PART_TIME", "LIVE_IN"],
      "budgetPeriods": ["HOURLY", "DAILY", "MONTH"],
      "reportReasons": ["MISCONDUCT", "SAFETY", "FRAUD"],
      "ticketPriorities": ["LOW", "MEDIUM", "HIGH", "URGENT"],
      "ratingScaleMax": 5,
      "ratingReviewMax": 300,
      "ratingTags": [{ "code": "PUNCTUAL", "label": "Punctual", "sentiment": "POSITIVE" }],
      "languages": ["en", "hi"],
      "statusLabels": { "booking": { ... }, "interview": { ... } }
    }
    ```

---

## 5. Inter-Module Dependencies & System Design

```
+--------------------------------------------------------------+
|                         Meta Module                          |
+--------------------------------------------------------------+
         |                                           |
         v                                           v
+-----------------------+                   +------------------+
| Platform Config       |                   | Legal Subsystem  |
| Database-Backed Admin |                   | Active Versions  |
| Overrides & Settings  |                   | & Policy Records |
+-----------------------+                   +------------------+
```

* **Database Overrides with Env Fallbacks:** Operational configuration values set by administrators in the Platform Config table take precedence over environment variables, allowing instant adjustments without redeployment.
* **Edge Caching Compliance:** All meta endpoints provide explicit HTTP `Cache-Control` and `ETag` headers, allowing edge CDNs and mobile HTTP clients to cache responses and eliminate server compute load.
