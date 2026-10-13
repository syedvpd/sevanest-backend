# Customer app blockers: status (2026-10-13)

Statuses: FIXED_VERIFIED / PARTIALLY_FIXED / BLOCKED_BY_DECISION / BLOCKED_BY_EXTERNAL_DEPENDENCY / NOT_FIXED / NOT_VERIFIED. Evidence = automated test names in `customer-app-contract-test-results.md`.

| # | Request | Status | What exists |
|---|---|---|---|
| 1 | Worker reviews + `ratingScaleMax` | FIXED_VERIFIED | `GET /search/workers/{id}/ratings`; `GET /reference-data` |
| 2 | Typed success schemas | FIXED_VERIFIED | explicit response classes on all customer-app routes (incl. `app-config`, `reference-data`, `home`, `pricing`, `locations`, `slots`); 146 nullable fields now declare their type; real responses validated against the published OpenAPI |
| 3 | Test customer + data | PARTIALLY_FIXED | `scripts/seed-demo.ts` (local) and the contract test build the data through the real API; nothing static is committed; a seeded **staging** customer needs the owner to run it with `ALLOW_TEST_OTP` (BLOCKED_BY_EXTERNAL_DEPENDENCY for live) |
| 4 | Price guidance | PARTIALLY_FIXED | endpoint + admin entry built; **no approved price data exists**, so it answers 404 until an admin enters bands (BLOCKED_BY_DECISION: who owns the numbers) |
| 5 | Budget in search | BLOCKED_BY_DECISION | worker `expectedSalary` has no period (Q-39); budget stays a booking label |
| 6 | Start date / weekdays | PARTIALLY_FIXED | `startDate` + busy-hours matching built; weekdays not stored in availability, so not matched (needs a decision on per-weekday windows) |
| 7 | Home aggregate | FIXED_VERIFIED | `GET /customers/me/home` |
| 8 | Customer photo | BLOCKED_BY_DECISION | not in FR-CUS-001..006; confirm V1 scope before building |
| 9 | Interview/trial + slots | FIXED_VERIFIED (booking-centred contract) | see handoff; draft `date`/`slot`/`decision` shape not adopted |
| 10 | Address label/line2/state | FIXED_VERIFIED | migration `20261018090000` |
| 11 | Coordinates -> area | PARTIALLY_FIXED | admin-set centre+radius, nearest circle, name fallback; no polygons/geocoder (BLOCKED_BY_DECISION for a map provider) |
| P3 | Confirmations | FIXED_VERIFIED | answered in the handoff table; support contact needs owner config |

Migrations added this round: `20261023090000_service_area_geo` (3 nullable columns + check), `20261023100000_pricing_guidance` (new table, partial unique indexes). Both additive; `prisma migrate diff` against the schema reports no difference.
