# Reports and operations dashboard

Read-only operational reporting (PRD section 14) and the admin dashboard (FRD FM-14 step 1).

## Requirements covered

FR-RPT-001..012 with the PROPOSED definitions of FRD section 7 (Q-61), FR-ADM dashboard.

## APIs (`/api/v1/admin`, all GET)

`reports` (catalog with every definition) · `reports/new-customers` · `worker-registrations` · `booking-funnel` · `demand-by-category` · `demand-by-area` (paged) · `worker-utilization` (snapshot) · `interview-conversion` · `cancellation-rate` · `replacement-rate` · `payment-collections` · `support-tickets` · `top-rated-workers` (paged, all-time) · `repeat-customers` (paged). Permission `report.view`.
`dashboard` is open to any admin account; each section appears only for a caller holding the permission that already guards the same data (bookings `booking.view`, workers `worker.view`, pending KYC `verification.review`, complaints `support.view`, replacements `replacement.view`, collections `payment.view`).

Parameters: `from`, `to` (YYYY-MM-DD, India calendar, inclusive, at most 366 days apart), `interval=day|week|month` (weeks start Monday). Every response carries `definition` and `notes`, so a number is never separated from what it means.

## How it stays safe and cheap

- **Read-only by construction**: every query runs in a transaction that PostgreSQL has set `READ ONLY`, so even a mistake cannot write; the module has no table, no write route, and an automated test forbids any writing statement.
- One transaction and a constant number of aggregate statements per report (no per-row queries); range filters are half-open on indexed timestamp columns; every ordering has an id tie-break.
- Like Search, it reads other modules' tables with parameterised SELECTs on purpose (correct aggregates and paging must happen in the database) and embeds Verification's own SQL definition of "verified".
- Nothing is estimated. A rate over zero is `null`, not 0%. A metric the data cannot answer is stated in `notes` (utilization cannot be reproduced for a past date; ratings are not dated so top-rated is all-time; partial refunds do not exist).

## Open

Q-61 (all definitions are proposed; reporting periods; minimum ratings for "top-rated"; whether cancelled requests count as repeat; CSV/export, which FR-PAY-008 mentions for payments but no format is specified).
