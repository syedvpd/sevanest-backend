# Service Categories

The admin-managed master of service categories (roles a worker can offer and a customer can request).

## Requirements covered

FRD FM-16 (categories added/edited by Super Admin, unique name, enabled/disabled, audit-logged), FR-ADM-005 / SRS 3.17
(configuration without code changes), FM-03/FM-04 ("only categories enabled in admin masters"), PRD section 4 (the six
categories), NFR-OPS-005 (categories via masters).

## Domain and database

`service_categories`: `id`, immutable `code` (`UPPER_SNAKE_CASE`, unique), `name` (unique ignoring case), optional `description`,
`is_enabled`. Categories are never deleted: a worker association (`worker_skills`) restricts deletion, and disabling hides a
category from new selections while existing holders keep it.

The six categories in the project documents (House Maid, Driver, Cook, Babysitter, Elderly Care Helper, Cleaning Helper) are seeded
as DATA by `npm run seed` using the documents' names and descriptions. Re-seeding creates only missing rows and never overwrites
an admin's edits. Application logic never refers to a category by name or code.

## APIs (`/api/v1`)

| Method | Path                                     | Requires           | Purpose                                                   |
| ------ | ---------------------------------------- | ------------------ | --------------------------------------------------------- |
| GET    | `/service-categories`                    | any signed-in user | Enabled categories, paginated, stable order               |
| GET    | `/service-categories/{categoryId}`       | any signed-in user | One enabled category (404 if disabled)                    |
| GET    | `/admin/service-categories`              | `category.manage`  | All categories, filter `isEnabled`, paginated             |
| GET    | `/admin/service-categories/{categoryId}` | `category.manage`  | One including disabled                                    |
| POST   | `/admin/service-categories`              | `category.manage`  | `{ code, name, description? }` (409 `CATEGORY_DUPLICATE`) |
| PATCH  | `/admin/service-categories/{categoryId}` | `category.manage`  | `{ name?, description?, isEnabled? }`; code immutable     |

Public responses carry `id, code, name, description` only.

## Rules, concurrency, audit

- Code and name uniqueness (name ignoring case) are enforced by the database; the API maps violations to 409.
- Updates lock the row; re-sending identical values writes no audit record. Audit: `service_category.create`, `service_category.update`
  (before/after of changed fields; configuration data, not personal data).
- `assertAssignable(requested, held)` is the contract other modules use: every id must exist (400) and every NEW id must be enabled (422).

## Open decisions

Category-to-engagement-type mapping ("as allowed for the category") is not modelled: the vocabulary in the documents is inconsistent
(FR-SD-003 lists full-time/part-time/daily/hourly/live-in; the PRD table also uses Monthly, Shift, One-time). Display ordering,
localised names, and config-master ownership (Q-14) are undefined.
