# Service Categories & Master Catalogue Module

## 1. Executive Summary

The **Service Categories Module** maintains the authoritative master catalogue of domestic workforce roles available on the SevaNest platform (e.g., House Maid, Cook, Driver, Babysitter, Elderly Care Helper, Cleaning Helper). It defines the operational taxonomy and permitted engagement types across the marketplace.

Engineered around **Catalogue Integrity** and **Zero-Downtime Extensibility**:
1. **Dynamic Master Administration:** Operations administrators can introduce new domestic service categories, adjust descriptions, and toggle availability without redeploying code.
2. **Referential Stability:** Categories are soft-disabled rather than deleted, ensuring that historical bookings, ongoing monthly contracts, and worker certifications never break.
3. **Engagement Type Matrix:** Pairs each service category with authorized engagement models (e.g., `FULL_TIME`, `PART_TIME`, `LIVE_IN`).

---

## 2. Core Features & Capabilities

* **Authoritative Role Master:** Centralized taxonomy of household service categories with unique business codes (e.g., `COOK`, `MAID`, `DRIVER`).
* **Dynamic Category Management:** Administrative endpoints to create, update, and enable/disable categories on demand.
* **Engagement Model Governance:** Associates permitted contract structures (`FULL_TIME`, `PART_TIME`, `LIVE_IN`) with corresponding household roles.
* **Referential Protection:** Restricts hard deletions when active workers or booking contracts hold associations.
* **Customer-Facing Catalogue:** High-speed, public-facing cached API endpoint for mobile onboarding and search filters.

---

## 3. End-to-End Service Category Workflow

The following diagram illustrates how service categories are managed and consumed:

```
Platform Operations Portal
           │
           ▼
[POST /api/v1/admin/service-categories { code: "COOK", name: "Cook", description: "..." }]
           │
           ▼
┌────────────────────────────────────────────────────────┐
│ 1. Uniqueness Validation & Persistence                 │
│    - Verifies code and name uniqueness                 │
│    - Enables category for marketplace availability     │
│    - Emits audit log entry for configuration tracking  │
└──────────────────────────┬─────────────────────────────┘
                           │
                           ▼
Mobile Applications (Customer & Worker Apps)
           │
           ▼
[GET /api/v1/service-categories]
           │
           ▼
┌────────────────────────────────────────────────────────┐
│ 2. Filtered Catalogue Delivery                         │
│    - Returns active, enabled categories                │
│    - Feeds customer search filters and worker skills   │
└────────────────────────────────────────────────────────┘
```

---

## 4. API Endpoints & Contracts

### 1. `GET /api/v1/service-categories`
Returns all enabled service categories for customer discovery and worker profile creation.
* **Response:** `[{ id, code: "COOK", name: "Cook", description: "...", allowedEngagements: [...] }]`

---

### 2. `GET /api/v1/service-categories/:categoryId`
Retrieves detailed information for a specific active service category.

---

### 3. `GET /api/v1/admin/service-categories`
Lists all categories (both enabled and disabled) for administrative operations.

---

### 4. `POST /api/v1/admin/service-categories`
Registers a new service category on the platform.
* **Payload:** `{ code: "ELDERLY_CARE", name: "Elderly Care Helper", description: "Specialized senior care" }`

---

### 5. `PATCH /api/v1/admin/service-categories/:categoryId`
Updates category descriptions or toggles platform visibility (`isEnabled: true | false`).

---

## 5. Inter-Module Dependencies & System Design

The Service Categories module serves as the functional foundation for worker profiling and customer search:

```
┌─────────────────────────┐
│     Workers Module      │──┐
│ (Worker Skill Mapping)  │  │
└─────────────────────────┘  │
┌─────────────────────────┐  │
│      Search Module      │──┼──► [ Service Categories ]
│ (Category Search Filter)│  │    (Authoritative Master)
└─────────────────────────┘  │
┌─────────────────────────┐  │
│     Booking Module      │──┘
│ (Service Requirements)  │
└─────────────────────────┘
```

* **Skill Assignment:** The Workers module validates that any skill a worker registers references an active, enabled category.
* **Booking Validation:** Booking creation ensures the requested service matches an active platform category.

