# Search

Read-only worker discovery for customers: "filter workers by category, location and availability", paginated (FR-SD-005, FR-WD-005).

## Requirements covered

SRS 3.3 FR-SD-002..005, 3.4 FR-WD-001/002/005/007, FRD FM-03 (category, engagement, location in an enabled area, preferred timings).

## Behaviour

`GET /api/v1/search/workers` (CUSTOMER only). Query: `category` (code) and `areaId` required; optional `engagement`
(FULL_TIME | PART_TIME | LIVE_IN), `availableFrom` + `availableTo` (`HH:mm`, together), `language`, `minExperienceMonths`,
`sort` (EXPERIENCE_DESC default | EXPERIENCE_ASC), `page`, `limit` (max 100).

A worker is eligible only when the account is ACTIVE, the profile is SUBMITTED, they offer the category, list the area as a preferred
area, and are **fully verified** by Verification's definition. A window filter matches when ONE availability window covers the whole
requested range. Disabled or unknown category/area answer 422. Order is a stable sort on a stated attribute (the id breaks ties);
it is not a relevance ranking.

The response is a **worker card** (explicit allow-list): workerId, experienceMonths, categories, languages, serviceAreas,
engagementPreference, availability, `verification: VERIFIED`. No name, contact, address, salary, emergency contact, document or
account id. Photo and rating summary are not available yet.

## Design

Search is a deliberate read-only query module (D-26): one parameterised SQL statement over the tables owned by Workers, Availability,
Service Categories and Verification (correct paging and totals need filter and order inside the database), plus four batched
look-ups for the page: a constant 6 statements per request, no per-row queries. It writes nothing; a test enforces this. The
definition of "verified" is Verification's SQL fragment, not a copy. Indexes: `worker_profiles_search_order_idx` (partial, experience
order), `worker_profiles_search_submitted_idx` (partial, matching order), plus the existing skill, area and verification indexes.

Contract for Matching: `SearchService.findEligible(requirement, order, page)`.
