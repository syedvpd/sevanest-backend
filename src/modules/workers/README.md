# Workers & Professional Profile Module

## 1. Executive Summary

The **Workers Module** manages domestic worker registrations, professional skill profiles, spoken languages, and employment preferences across SevaNest. It empowers domestic helpers (maids, cooks, drivers, babysitters, elderly caregivers) to build comprehensive work portfolios and submit their credentials for background verification.

Engineered around **Assisted Onboarding** and **Progressive Enrollment**:
1. **Multi-Step Onboarding Wizard:** Workers can complete onboarding across multiple short steps (personal details, categories, experience, language fluency), with drafts saved automatically at every stage.
2. **Readiness Audit & Submission Gating:** Prevents premature submissions by dynamically auditing required profile fields (`missingForSubmission`) before permitting submission for staff verification.
3. **Staff-Assisted Profile Completion:** Authorized operations agents can assist non-tech-savvy workers with profile creation and updates while maintaining complete audit accountability.

---

## 2. Core Features & Capabilities

* **Step-by-Step Onboarding:** Draft-friendly profile creation enabling incremental updates across address details, emergency contacts, and previous employer references.
* **Skill & Category Selection:** Multi-role mapping allowing workers to offer multiple household services (e.g., both "Cook" and "Housekeeper").
* **Language & Experience Profiling:** Captures spoken language proficiencies and cumulative months of domestic experience.
* **Assisted Operations Workflow:** Administrative endpoints allowing operations teams to support workers with phone or in-person registrations.
* **Submission Lifecycle Gating:** Transitions worker onboarding from `DRAFT` to `SUBMITTED`, handing off the completed profile to the Verification review queue.

---

## 3. End-to-End Worker Registration Workflow

The following diagram illustrates the worker onboarding and submission journey:

```
Worker Mobile App (Flutter)
           │
           ▼
[POST /api/v1/workers/me { name: "Sunita Devi" }]
           │
           ▼
┌────────────────────────────────────────────────────────┐
│ 1. Initial Profile Creation (DRAFT)                    │
│    - Binds profile to authenticated WORKER account     │
│    - Initializes missing fields checklist              │
└──────────────────────────┬─────────────────────────────┘
                           │
                           ▼
[PATCH /api/v1/workers/me { address, emergencyContact, experienceMonths, languages }]
[PUT /api/v1/workers/me/categories { categoryIds }]
                           │
                           ▼
┌────────────────────────────────────────────────────────┐
│ 2. Progressive Draft Saving                            │
│    - Validates contact and language formats            │
│    - Validates category references are active          │
│    - Saves progress atomically                         │
└──────────────────────────┬─────────────────────────────┘
                           │
                           ▼
[POST /api/v1/workers/me/submit]
                           │
                           ▼
┌────────────────────────────────────────────────────────┐
│ 3. Completeness Audit & Hand-off                       │
│    - Checks mandatory fields (address, skills, shifts) │
│    - If incomplete: Returns 422 PROFILE_INCOMPLETE     │
│    - If valid: Marks status SUBMITTED                  │
│    - Emits event alerting Verification review queue    │
└────────────────────────────────────────────────────────┘
```

---

## 4. API Endpoints & Contracts

### 1. `POST /api/v1/workers/me` & `GET /api/v1/workers/me`
Creates the initial worker profile draft and returns the current profile state along with any `missingForSubmission` fields.

---

### 2. `PATCH /api/v1/workers/me`
Progressively updates profile sections (address, emergency contact, experience months, languages, salary expectations).

---

### 3. `PUT /api/v1/workers/me/categories`
Selects the household service categories offered by the worker.
* **Payload:** `{ categoryIds: ["cat_cook_uuid", "cat_maid_uuid"] }`

---

### 4. `POST /api/v1/workers/me/submit`
Validates profile completeness and formally submits the dossier for operations review.

---

### 5. `GET /api/v1/admin/workers` & `GET /api/v1/admin/workers/:workerId`
Allows authorized operations staff to view worker applications with filtering by onboarding status and service category.

---

### 6. `PATCH /api/v1/admin/workers/:workerId`
Enables operations staff to provide assisted profile completion for registered workers.

---

## 5. Inter-Module Dependencies & System Design

The Workers module coordinates with catalog, availability, and verification services:

```
┌─────────────────────────┐
│ Service Categories      │──┐
│ (Role Master Catalogue) │  │
└─────────────────────────┘  │
┌─────────────────────────┐  │
│   Availability Module   │──┼──► [ Workers Module ] ──► [ Verification Module ]
│ (Shifts & Service Areas)│  │    (Profile Lifecycle)    (KYC Review Dossier)
└─────────────────────────┘  │
┌─────────────────────────┐  │
│       Auth Module       │──┘
│ (Worker Authentication) │
└─────────────────────────┘
```

* **Availability Dependency:** For a profile to be submitted, the worker must define both their profile skills and their service availability windows.
* **Verification Hand-Off:** Upon successful submission, the profile is locked into the Verification pipeline for document upload and administrative KYC audit.

