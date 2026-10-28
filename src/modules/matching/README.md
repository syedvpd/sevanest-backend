# Matching & Concierge Recommendation Module

## 1. Executive Summary

The **Matching Module** powers staff-assisted worker allocation across SevaNest. When customers cannot find an immediate match in self-service search or prefer high-touch concierge assistance, operations staff use this module to identify qualified, verified domestic workers who satisfy the customer's exact household criteria.

Engineered around **Integrity Inheritance** and **Privacy Protection**:
1. **Safety Rule Inheritance:** Delegates candidate evaluation to the core Search eligibility rules, guaranteeing that suspended, unverified, or incomplete workers can never be suggested by staff.
2. **Staff Accountability:** Every matching execution records the input criteria and candidate count in immutable audit logs.
3. **Redacted Staff View:** Displays worker IDs, experience, and skills required for operational decision-making while redacting home addresses, personal phone numbers, and financial details.

---

## 2. Core Features & Capabilities

* **Staff-Assisted Matching:** Enables operations specialists to find candidate matches for customized customer requests.
* **Multi-Factor Criteria Evaluation:** Evaluates candidate pools across service category, geographic area, engagement preference, daily time windows, languages, and experience.
* **Deterministic Candidate Selection:** Stable candidate ordering (e.g., earliest submitted applications first) for fair worker opportunity distribution.
* **Zero Direct Mutation:** Read-only candidate query engine that does not alter booking states or lock schedules until formal booking confirmation occurs.

---

## 3. End-to-End Matching Workflow

The following diagram illustrates how staff-assisted matching is executed:

```
Platform Operations Portal
           │
           ▼
[POST /api/v1/admin/matching/candidates]
{ category: "COOK", areaId: "...", engagement: "PART_TIME", availableFrom: "08:00", availableTo: "12:00" }
           │
           ▼
┌────────────────────────────────────────────────────────┐
│ 1. Permission & Requirement Validation                 │
│    - Verifies staff permission matching.run            │
│    - Validates category, area, and time range formats  │
└──────────────────────────┬─────────────────────────────┘
                           │
                           ▼
┌────────────────────────────────────────────────────────┐
│ 2. Delegated Eligibility Execution                     │
│    - Enforces 100% verified status & active profile    │
│    - Filters workers covering area and time window     │
│    - Sorts eligible candidates fairly                  │
└──────────────────────────┬─────────────────────────────┘
                           │
                           ▼
┌────────────────────────────────────────────────────────┐
│ 3. Candidate Presentation & Audit                      │
│    - Logs matching.candidates run in audit trail       │
│    - Returns sanitized candidate list for staff action │
└────────────────────────────────────────────────────────┘
```

---

## 4. API Endpoints & Contracts

### 1. `POST /api/v1/admin/matching/candidates`
Searches for candidate workers who satisfy all constraints of a customer's service requirement.
* **Authorization:** Administrative JWT (`matching.run` permission).
* **Payload:**
  ```json
  {
    "category": "COOK",
    "areaId": "area_uuid",
    "engagement": "PART_TIME",
    "availableFrom": "08:00",
    "availableTo": "12:00",
    "language": "HINDI",
    "minExperienceMonths": 24,
    "page": 1,
    "limit": 20
  }
  ```
* **Response:** Paginated list of candidate cards with operational IDs for staff assignment.

---

## 5. Inter-Module Dependencies & System Design

The Matching module acts as an operational bridge between Search and Bookings:

```
┌─────────────────────────┐
│      Search Module      │
│  (Eligibility Pipeline) │
└────────────┬────────────┘
             │ Delegates Evaluation
             ▼
┌─────────────────────────┐      Assigned Candidate Hand-off     ┌─────────────────────────┐
│     Matching Module     │─────────────────────────────────────►│     Booking Module      │
│ (Concierge Allocator)   │                                      │ (Booking Confirmation)  │
└─────────────────────────┘                                      └─────────────────────────┘
```

* **Eligibility Delegation:** Delegates candidate filtering directly to Search, guaranteeing that safety rules are never duplicated or bypassed.
* **Booking Handoff:** Once staff identify a suitable candidate, they assign the candidate to the customer's open requirement in the Booking module.

