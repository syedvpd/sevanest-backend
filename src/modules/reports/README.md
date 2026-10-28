# Reports & Operations Dashboard Module

## 1. Executive Summary

The **Reports & Operations Dashboard Module** provides business intelligence, operational metrics, and executive dashboards for SevaNest management and platform staff. It delivers granular visibility into household acquisition trends, worker supply, booking conversion funnels, payment settlements, and customer retention.

Engineered around **Database Safety** and **Zero Analytical Contention**:
1. **Read-Only by Construction:** All reporting queries execute inside explicit PostgreSQL `READ ONLY` transactions, guaranteeing that reporting calculations can never accidentally mutate production data.
2. **Fixed Aggregate Queries:** Employs optimized SQL aggregate statements with index-backed range filters, preventing slow full-table scans.
3. **Role-Scoped Dashboard Metrics:** Each section of the executive dashboard is secured by granular permissions—staff members see only the metrics they are explicitly authorized to view.

---

## 2. Core Features & Capabilities

* **Executive Operations Dashboard:** Real-time summary cards displaying active bookings, pending verification queues, daily gross collections, and open complaints.
* **Customer Acquisition & Retention Metrics:** Tracks new household signups, first-to-repeat booking conversion rates, and geographic growth across urban zones.
* **Workforce Supply & Utilization:** Evaluates worker registration volume, verification turnaround times, and workforce capacity utilization.
* **Booking Conversion Funnel:** Analyzes engagement lifecycles (`NEW_REQUEST` $\rightarrow$ `MATCHED` $\rightarrow$ `INTERVIEW` $\rightarrow$ `CONFIRMED`), identifying drop-off bottlenecks.
* **Financial & Revenue Audits:** Reports on gross fee collections, refund volumes, and payment gateway settlement reconciliation.

---

## 3. End-to-End Reporting Workflow

The following diagram illustrates how operational reports are compiled:

```
Platform Operations Portal
           │
           ▼
[GET /api/v1/admin/reports/booking-funnel?from=2026-10-01&to=2026-10-31&interval=week]
           │
           ▼
┌────────────────────────────────────────────────────────┐
│ 1. Permission & Parameter Validation                   │
│    - Verifies caller holds report.view permission      │
│    - Validates date range (at most 366 days)           │
│    - Validates aggregation interval (day, week, month) │
└──────────────────────────┬─────────────────────────────┘
                           │
                           ▼
┌────────────────────────────────────────────────────────┐
│ 2. Read-Only Transaction Execution                     │
│    - Opens BEGIN TRANSACTION READ ONLY in PostgreSQL   │
│    - Executes indexed aggregate query with time bounds │
│    - Commits transaction cleanly without writes        │
└──────────────────────────┬─────────────────────────────┘
                           │
                           ▼
┌────────────────────────────────────────────────────────┐
│ 3. Formatted Delivery & Metric Context                 │
│    - Attaches metric definition and explanatory notes  │
│    - Returns structured time-series data               │
└────────────────────────────────────────────────────────┘
```

---

## 4. API Endpoints & Contracts

### 1. `GET /api/v1/admin/dashboard`
Consolidated operational dashboard providing real-time metric cards tailored to the caller's specific administrative role.

---

### 2. `GET /api/v1/admin/reports/new-customers` & `.../worker-registrations`
Time-series growth metrics for customer onboarding and worker recruitment.
* **Query:** `from=YYYY-MM-DD&to=YYYY-MM-DD&interval=day|week|month`

---

### 3. `GET /api/v1/admin/reports/booking-funnel`
Funnel stage conversion rates from initial customer request to verified booking confirmation.

---

### 4. `GET /api/v1/admin/reports/payment-collections`
Financial settlement reports summarizing gross platform fees collected and refunded.

---

### 5. `GET /api/v1/admin/reports/demand-by-category` & `.../demand-by-area`
Identifies high-demand service categories and geographic zones to guide local workforce recruitment.

---

## 5. Inter-Module Dependencies & System Design

The Reports module functions as a non-invasive analytical layer:

```
┌─────────────────────────┐
│     Booking Module      │──┐
│  (Booking Conversions)  │  │
└─────────────────────────┘  │
┌─────────────────────────┐  │
│     Payment Module      │──┼──► [ Reports Module ] ──► [ Admin Dashboard UI ]
│  (Financial Aggregate)  │  │    (Read-Only Analytics)   (Visual Charts & KPIs)
└─────────────────────────┘  │
┌─────────────────────────┐  │
│   Verification Module   │──┘
│   (KYC Queue Velocity)  │
└─────────────────────────┘
```

* **Read-Only Independence:** The Reports module executes parameterized queries across domain tables without coupling to service domain logic, avoiding API bottlenecks.
* **Permission Mapping:** Access to specific report data mirrors the underlying functional permissions (e.g., viewing payment reports requires `payment.view`).

