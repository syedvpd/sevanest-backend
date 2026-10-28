# Dynamic Platform Configuration Module

## 1. Executive Summary

The **Platform Configuration Module** manages dynamic application settings, feature toggles, app store version enforcement, and customer rating taxonomy across SevaNest. It allows platform administrators to update operational parameters and client-facing policies in real time without rebuilding or redeploying code.

Engineered around **Zero-Downtime Governance** and **Instant Client Synchronization**:
1. **Runtime App Settings:** Critical mobile parameters (minimum supported Flutter app version, maintenance mode flag, support phone/email, and legal policy URLs) are served dynamically at startup.
2. **Dynamic Review Taxonomy:** Rating tags (e.g., "Punctual", "Thorough", "Polite") are maintained dynamically in the database, ensuring mobile review forms remain flexible and localized.
3. **Audit-Tracked Administration:** Every modification to runtime configuration keys is strictly audited with previous and updated values.

---

## 2. Core Features & Capabilities

* **Mobile App Bootstrap Endpoint (`/app-config`):** Single high-speed startup endpoint providing mobile clients with version requirements, store download URLs, and emergency maintenance status.
* **Maintenance Mode Toggle:** Allows operations staff to place mobile apps in graceful maintenance mode during scheduled system upgrades.
* **Customer Review Tag Catalogue:** Dynamic management of positive and negative review tags used during post-service ratings.
* **Support Contact & Legal Policy Synchronization:** Real-time updates to official support helpline numbers and cancellation policy URLs.
* **Fallback Resilience:** Hierarchical configuration resolution—falls back safely to deployment environment defaults if database settings are unconfigured.

---

## 3. End-to-End Configuration Workflow

The following diagram illustrates how platform configuration is managed and delivered to mobile clients:

```
Platform Operations Portal
           │
           ▼
[PUT /api/v1/admin/app-settings/customer.minVersion { value: "1.4.0" }]
[POST /api/v1/admin/rating-tags { code: "PUNCTUAL", label: "Punctual", type: "POSITIVE" }]
           │
           ▼
┌────────────────────────────────────────────────────────┐
│ 1. Configuration Validation & Persistence              │
│    - Verifies setting key exists and format is valid   │
│    - Persists setting row in database                  │
│    - Records audit log entry with before/after state   │
└──────────────────────────┬─────────────────────────────┘
                           │
                           ▼
Mobile Application Launch (Customer & Worker Apps)
           │
           ▼
[GET /api/v1/app-config]
[GET /api/v1/reference-data]
           │
           ▼
┌────────────────────────────────────────────────────────┐
│ 2. Real-Time Settings Consumption                      │
│    - App verifies installed version >= minVersion      │
│    - Populates dynamic tags in review submission UI    │
└────────────────────────────────────────────────────────┘
```

---

## 4. API Endpoints & Contracts

### 1. `GET /api/v1/app-config`
Public mobile startup endpoint delivering app version rules, store links, maintenance flags, and support contact details.
* **Response:**
  ```json
  {
    "customer": { "minVersion": "1.2.0", "storeUrl": "https://play.google.com/..." },
    "worker": { "minVersion": "1.1.0", "storeUrl": "https://play.google.com/..." },
    "maintenance": false,
    "support": { "phone": "+914012345678", "email": "support@sevanest.com" }
  }
  ```

---

### 2. `GET /api/v1/reference-data`
Returns active rating tags and review taxonomies for customer feedback forms.

---

### 3. `GET /api/v1/admin/app-settings` & `PUT /api/v1/admin/app-settings/:key`
Administrative management of platform configuration keys.
* **Authorization:** Administrative JWT (`config.manage` permission).

---

### 4. `GET /api/v1/admin/rating-tags` & `POST ...` & `PATCH .../:code`
Allows operations teams to introduce new review tags or retire obsolete tags without deleting historical records.

---

## 5. Inter-Module Dependencies & System Design

The Platform Configuration module acts as the runtime metadata provider:

```
┌─────────────────────────┐
│     Mobile Clients      │◄──┐  Reads app-config on launch
│  (Flutter Applications) │   │
└─────────────────────────┘   │
                              │
┌─────────────────────────┐   │  Supplies active rating tags
│  Platform Configuration ├───┼────────────────────────► [ Ratings Module ]
│   (Runtime Settings)    │   │                          (Review Validations)
└─────────────────────────┘   │
                              │
┌─────────────────────────┐   │
│  Operations Admin Web   │───┘
│ (config.manage Portal)  │
└─────────────────────────┘
```

* **Client Gatekeeping:** Enables the mobile apps to enforce forced updates or display maintenance notices upon launch.
* **Ratings Integration:** When customers submit reviews, the Ratings module validates that chosen tags exist and are currently active.

