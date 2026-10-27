# Service categories: end-to-end audit (2026-10-27)

Local verification only (disposable PostgreSQL, in-memory storage). No migration, no data repair, nothing committed, pushed or run against staging or production.

## 1. Verdict

| Item | Status | Evidence |
|---|---|---|
| Six categories as database master data (not an enum, not hardcoded in the apps) | **DONE (already implemented)** | `service_categories` (`prisma/schema.prisma:297`), seeded by `CategorySeedService.ensureInitialCategories` (`category-seed.service.ts`) from `npm run seed`; created in every test app by `test/support/api-app.ts:63` |
| House Maid, Driver, Cook, Babysitter, Elderly Care Helper, Cleaning Helper: code, name, description | **DONE** x6 | `categories.six` "lists all six enabled categories": exact PRD names and descriptions, stable codes `HOUSE_MAID, DRIVER, COOK, BABYSITTER, ELDERLY_CARE_HELPER, CLEANING_HELPER` |
| Idempotent seed, never overwrites admin edits | **DONE** | `categories.six` "seeding twice"; `categories.api` "never overwrites an admin's edits" |
| Supported engagement types per category stored and enforced | **DONE (mechanism) / PARTIAL (values)** | table `category_engagements`, admin `PUT /admin/service-categories/{id}/engagements`, enforced in booking, search and matching (`ENGAGEMENT_NOT_OFFERED` 422). **The PRD values were not seeded** (see section 3) |
| Worker App: list categories, select several, validated, persisted, returned in profile | **DONE** | `GET /service-categories`, `PUT /workers/me/categories`, `GET /workers/me`; `categories.six` and `workers.api` (unknown 400, disabled 422, failed request changes nothing) |
| Selecting a category does not make a worker visible | **DONE** | `categories.six`: unverified worker -> 404 on `GET /search/workers/{id}` |
| Customer App: enabled categories + engagement types | **DONE** (field-name fix in section 3) | `GET /service-categories` |
| Search filter by category code, only matching verified workers, unknown code 422 | **DONE** | `categories.six` "filters search by category code" |
| Engagement filter only with values the category offers | **DONE** | `categories.six` "accepts only the engagement types a category offers" (422 `ENGAGEMENT_NOT_OFFERED`) |
| Cards and detail show the same category identifiers | **DONE** | `categories: [{code, name}]` on cards and detail (test) |
| Admin: list, create, edit, enable/disable, engagements; permission enforced | **DONE** | `category.manage`; `categories.api`, `categories.six` (customer and worker 403, anonymous 401) |

## 2. Data flow and root-cause check

Prisma `ServiceCategory` (unique `code`, `name`, `description`, `isEnabled`) -> `worker_skills` (worker to category) -> `ServiceCategoriesService` -> `GET /service-categories` and `GET /admin/service-categories` -> worker `PUT /workers/me/categories` and customer `GET /search/workers?category=<code>` (search uses the stable **code**; category `id` is for worker selection and admin routes). All six exist, codes match across the APIs, no enum or frontend-only list is involved.

Checked and found fine: duplicate associations (a worker holds a category once), disabled and unknown ids, visibility rules (active, submitted, fully verified) combined with the category filter, response shapes between card and detail.

## 3. The two gaps found, and what changed

1. **Engagement types were never populated.** PRD section 4 lists them, but `category_engagements` had no rows, so every category accepted every engagement (Q-93, D-64). Not seeded by default on purpose: switching restrictions on changes what existing environments accept, and existing tests book HOURLY maids.
   Added (`category-seed.service.ts`): `RECOMMENDED_ENGAGEMENTS` and `ensureRecommendedEngagements(dryRun)`, **opt-in** from `npm run seed` with `SEED_CATEGORY_ENGAGEMENTS=dry-run` (report only) or `=true` (apply). It writes only for categories that exist and have **no** engagement rows, re-checks under the row lock (an admin edit wins), audits `service_category.engagements_seeded`, and is idempotent.

   | Category | Engagements applied |
   |---|---|
   | House Maid | PART_TIME, FULL_TIME, LIVE_IN |
   | Driver | HOURLY, DAILY, FULL_TIME (PRD "Monthly") |
   | Cook | PART_TIME, FULL_TIME (PRD "Monthly") |
   | Babysitter | HOURLY, FULL_TIME |
   | Elderly Care Helper | SHIFT, FULL_TIME |
   | Cleaning Helper | ONE_TIME, HOURLY |

   **"Monthly" has no value in the platform vocabulary.** It is mapped to FULL_TIME as an interim reading; the client must confirm (Q-93, Q-38), or a MONTHLY value must be added (additive enum migration plus availability, search and scheduling handling).
2. **Name mismatch:** the category response exposed the allowed engagement types as `allowedEngagements`, while the admin write body uses `engagements`. Added `engagements` with the same value (additive; `allowedEngagements` stays).

Existing environments: no change happens unless someone runs the opt-in seed. Dry-run plan for staging or production: `SEED_CATEGORY_ENGAGEMENTS=dry-run npm run seed` against that environment's database by its owner, or read the table above and apply it with `PUT /admin/service-categories/{id}/engagements`. I did neither.

## 4. Example responses

`GET /api/v1/service-categories` (customer or worker token):

```json
{ "data": [
  { "id": "01a1...", "code": "DRIVER", "name": "Driver", "description": "Personal/family driver, temporary driver",
    "allowedEngagements": ["DAILY", "FULL_TIME", "HOURLY"], "engagements": ["DAILY", "FULL_TIME", "HOURLY"] }
], "meta": { "page": 1, "limit": 20, "total": 6 } }
```

`PUT /api/v1/workers/me/categories` with `{ "categoryIds": ["<COOK id>", "<HOUSE_MAID id>"] }`:

```json
{ "id": "w-1", "categories": [ { "code": "COOK", "name": "Cook" }, { "code": "HOUSE_MAID", "name": "House Maid" } ], "...": "worker profile" }
```

`GET /api/v1/search/workers?category=COOK&areaId=<area>` (card; same `categories` shape on `GET /search/workers/{id}`):

```json
{ "data": [ { "workerId": "w-1", "name": "Lakshmi D.", "categories": [ { "code": "COOK", "name": "Cook" } ],
              "engagementPreference": "PART_TIME", "verification": "VERIFIED", "verified": true, "...": "card" } ],
  "meta": { "page": 1, "limit": 20, "total": 1 } }
```

`GET /api/v1/workers/me` (profile): `"categories": [ { "code": "COOK", "name": "Cook" } ]`.
Errors: unknown search category `422 CATEGORY_NOT_AVAILABLE`; engagement not offered `422 ENGAGEMENT_NOT_OFFERED`; worker selecting an unknown id `400`, a disabled id `422`.

## 5. Tests

| Check | Result |
|---|---|
| `npm run typecheck`, `npm run lint` (0 errors), `npm run format:check`, `npx prisma validate` | pass (final run noted below) |
| Unit `category-seed.service.spec` | 7/7 (mapping valid, only unconfigured categories, admin choice kept, idempotent, dry run writes nothing, missing category skipped, concurrent admin edit wins) |
| Integration `categories.six` + `categories.api` | 34/34 |
| `contract.openapi`, `modules.workforce` | pass |
| `gap.closing` | 1 test failed on the reused local database (`notificationTemplate.deleteMany` foreign key); unrelated to categories and not re-run on a fresh database. CI is the first full run |

## 6. Remaining decisions and notes

* Q-93 / Q-38: confirm the engagement vocabulary and what "Monthly" means; until then the opt-in seed is not applied anywhere.
* Display order and localised category names are undefined (unchanged).
* Frontend: read `engagements` (or `allowedEngagements`); empty means "not restricted"; filter search by category **code**; use category **id** only when saving a worker's roles.
