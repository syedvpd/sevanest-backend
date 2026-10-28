# Availability & Service Area Management Module

## 1. Executive Summary

The **Availability Module** manages operational service areas, worker engagement preferences, and daily shift availability across SevaNest. It ensures that customer search queries and automated booking algorithms only consider workers who are genuinely available to work during requested hours within designated geographic territories.

Engineered around **Geographic Precision** and **Mathematical Invariant Guarantees**:
1. **Overlap Prevention via Database GiST Constraints:** Enforces strict non-overlapping time windows per worker directly in PostgreSQL (`btree_gist`), guaranteeing zero duplicate shifts even under concurrent updates.
2. **Dynamic Service Areas:** Master catalogue of platform-enabled urban zones (e.g., HITEC City, Kondapur, Madhapur, Gachibowli) with instant operational toggles.
3. **Engagement Models:** Captures worker employment preferences across `FULL_TIME`, `PART_TIME`, and `LIVE_IN` contracts.

---

## 2. Core Features & Capabilities

* **Service Area Master Catalogue:** Administrative management of operational coverage zones and geographic launch areas.
* **Granular Time Windows:** Definition of daily shift hours (e.g., `08:00 - 12:00`, `14:00 - 18:00`) calculated in 24-hour minute offsets.
* **Engagement Preferences:** Worker specification of preferred contract styles (`FULL_TIME`, `PART_TIME`, `LIVE_IN`).
* **Territory Mapping:** Multi-area preferences allowing workers to select all neighboring localities where they are willing to travel.
* **Transactional Advisory Locking:** Worker-level advisory locks prevent race conditions during schedule adjustments.

---

## 3. End-to-End Availability Workflow

The following diagram illustrates how service areas and worker availability are configured:

```
Platform Operations Portal
           │
           ▼
[POST /api/v1/admin/service-areas { name: "HITEC City", city: "Hyderabad" }]
           │
           ▼
┌────────────────────────────────────────────────────────┐
│ 1. Service Area Activation                             │
│    - Verifies name uniqueness within city              │
│    - Sets is_enabled to true                           │
└────────────────────────────────────────────────────────┘

Worker Mobile App
           │
           ▼
[PATCH /api/v1/workers/me/availability]
{ engagementPreference: "PART_TIME", areaIds: [...], timeWindows: [{ start: "08:00", end: "12:00" }] }
           │
           ▼
┌────────────────────────────────────────────────────────┐
│ 2. Schedule Validation & Atomic Persistence            │
│    - Verifies all selected areas are enabled           │
│    - Validates shift boundaries (start < end)          │
│    - Verifies zero overlapping windows                 │
│    - Commits preferences and shifts in one transaction │
└────────────────────────────────────────────────────────┘
```

---

## 4. API Endpoints & Contracts

### 1. `GET /api/v1/service-areas`
Retrieves all enabled service areas within a city for customer location selection.
* **Query:** `city=Hyderabad`

---

### 2. `POST /api/v1/admin/service-areas` & `PATCH /api/v1/admin/service-areas/:areaId`
Enables operations staff to introduce new service territories or temporarily disable zones.

---

### 3. `GET /api/v1/workers/me/availability`
Fetches the authenticated worker's current preferences, active areas, and time windows.

---

### 4. `PATCH /api/v1/workers/me/availability`
Updates working engagement preference, serviceable areas, and daily shift windows.
* **Payload:** `{ engagementPreference: "PART_TIME", areaIds: ["area_1_uuid"], timeWindows: [{ start: "09:00", end: "13:00" }] }`

---

### 5. `GET /api/v1/admin/workers/:workerId/availability` & `PATCH ...`
Allows customer support and operations staff to inspect and provide assisted schedule modifications.

---

## 5. Inter-Module Dependencies & System Design

The Availability module provides schedule filters to discovery and onboarding services:

```
┌─────────────────────────┐
│     Workers Module      │──┐
│ (Submission Checklist)  │  │
└─────────────────────────┘  │
┌─────────────────────────┐  │
│      Search Module      │──┼──► [ Availability Module ] ◄──► [ PostgreSQL GiST ]
│ (Shift & Area Filters)  │  │    (Schedules & Coverage)       (Zero Overlaps)
└─────────────────────────┘  │
┌─────────────────────────┐  │
│     Matching Module     │──┘
│ (Candidate Eligibility) │
└─────────────────────────┘
```

* **Search & Matching Integration:** Search queries filter candidates by intersecting requested time ranges with `worker_time_windows` and service areas.
* **Submission Enabler:** Worker profile completion requires at least one preferred area, time window, and engagement preference.

