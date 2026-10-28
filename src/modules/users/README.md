# Users & Role-Based Access Control Module

## 1. Executive Summary

The **Users Module** manages core account identities, administrative lifecycles, and platform-wide **Role-Based Access Control (RBAC)** across SevaNest. It is the central authority on who a user is, their operational state (`ACTIVE` or `SUSPENDED`), and what granular administrative permissions they hold.

Designed around **Least-Privilege Security** and **Account Governance**:
1. **Centralized Identity Record:** Decouples user credentials and account states from domain-specific profiles (Customers vs. Workers).
2. **Instant Administrative Control:** Account suspension takes effect immediately on the next inbound HTTP request, instantly revoking all active sessions.
3. **Privilege Escalation Protection:** Immutable hierarchy ensuring that administrative role and permission modifications are restricted and strictly audited.

---

## 2. Core Features & Capabilities

* **Unified Account Management:** Manages base user accounts, account statuses (`ACTIVE`, `SUSPENDED`), and associated login identifiers (mobile numbers and email addresses).
* **Role-Based Access Control (RBAC):** Configurable permissions assigned to administrative roles (`SUPER_ADMIN`, `OPERATIONS_ADMIN`, `VERIFICATION_EXECUTIVE`, `SUPPORT_EXECUTIVE`).
* **Immediate Account Suspension:** One-click suspension of malicious, fraudulent, or compromised accounts with immediate revocation of all active device sessions.
* **Granular Staff Permissions:** Enforces specific capability tokens (e.g., `worker.view`, `worker.verify`, `customer.manage`, `payment.reconcile`) on every admin endpoint.
* **Tamper-Evident Audit Trails:** Every user creation, status transition, and role/permission modification is permanently recorded in an append-only audit trail.

---

## 3. End-to-End Account & RBAC Workflow

The following diagram illustrates how user accounts and administrative roles are governed:

```
Platform Operations Portal
           │
           ▼
[POST /api/v1/admin/users { email, roleCode }]
           │
           ▼
┌────────────────────────────────────────────────────────┐
│ 1. Authorization & Role Validation                     │
│    - Verifies actor has admin.manage_users permission  │
│    - Prevents privilege escalation (non-Super Admins   │
│      cannot grant Super Admin roles)                   │
└──────────────────────────┬─────────────────────────────┘
                           │
                           ▼
┌────────────────────────────────────────────────────────┐
│ 2. Account Provisioning & Password Hashing             │
│    - Hashes password using salted scrypt algorithm     │
│    - Assigns designated operational role               │
│    - Commits user record and logs admin.create audit   │
└────────────────────────────────────────────────────────┘

Suspension Workflow:
[PATCH /api/v1/admin/users/:userId/status { status: "SUSPENDED" }]
           │
           ▼
┌────────────────────────────────────────────────────────┐
│ 3. Atomic Lock & Revocation                            │
│    - Updates account status to SUSPENDED               │
│    - Emits UserSuspendedEvent                          │
│    - Auth module instantly revokes all active sessions │
└────────────────────────────────────────────────────────┘
```

---

## 4. API Endpoints & Contracts

### 1. `GET /api/v1/users/me`
Retrieves the authenticated user's core identity profile, account status, and assigned permissions.
* **Authorization:** Any authenticated user.

---

### 2. `GET /api/v1/admin/users`
Lists platform user accounts with filtering by account type (`CUSTOMER`, `WORKER`, `ADMIN`) and status (`ACTIVE`, `SUSPENDED`).
* **Protection:** Sensitive mobile numbers are masked for routine staff viewing.

---

### 3. `POST /api/v1/admin/users`
Provisions a new administrative staff account with an initial operational role.
* **Payload:** `{ email: "staff@sevanest.com", password: "...", roleCode: "OPERATIONS_ADMIN" }`

---

### 4. `PATCH /api/v1/admin/users/:userId/status`
Suspends or reactivates an account.
* **Payload:** `{ status: "ACTIVE" | "SUSPENDED", reason?: "Investigation pending" }`
* **Rule:** Administrators cannot suspend their own accounts.

---

### 5. `PUT /api/v1/admin/users/:userId/role`
Updates an administrative user's assigned role.

---

### 6. `GET /api/v1/admin/roles` & `PUT /api/v1/admin/roles/:code/permissions`
Manages the platform permission matrix, allowing Super Admins to adjust granular capabilities across staff roles.

---

## 5. Inter-Module Dependencies & System Design

The Users module serves as the core identity provider for all operational domains:

```
┌─────────────────────────┐
│       Auth Module       │──┐
│ (Session Revocation)    │  │
└─────────────────────────┘  │
┌─────────────────────────┐  │
│    Customers Module     │──┼──► [ Users Module ] ◄──► [ Audit Service ]
│ (Profile Association)   │  │    (Identity & RBAC)    (Immutable History)
└─────────────────────────┘  │
┌─────────────────────────┐  │
│     Workers Module      │──┘
│ (Worker Association)    │
└─────────────────────────┘
```

* **Session Decoupling:** When an account is suspended, Users publishes a domain event that instructs Auth to terminate active sessions without circular module dependencies.
* **Profile Independence:** Domain profile data (addresses, skills, preferences) is decoupled into dedicated Customer and Worker modules, keeping the core identity lightweight and fast.

