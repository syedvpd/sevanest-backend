# Worker search screens: backend answers (2026-11-02)

Local verification only (disposable PostgreSQL). No schema change, nothing deployed.

| # | Request | Status | Answer |
|---|---|---|---|
| 1 | Sort values | PARTLY | `GET /search/workers?sort=` accepts `EXPERIENCE_DESC` (default, "Most experienced"), `EXPERIENCE_ASC`, `RATING_DESC` ("Highest rated"), `DISTANCE_ASC`; case-insensitive. **`BEST_MATCH` is not built**: no ranking formula is defined (Q-136). Until decided, use the default for "Best match". |
| 2 | `matchScore` | NOT BUILT | Needs a defined scoring rule (Q-136). Keep showing the average rating. |
| 3 | `verifiedOnly` | NOT NEEDED | Every worker returned is already fully verified (`verified` is always `true`). Remove the chip, or keep it as a no-op in the app. |
| 4 | Result count | DONE | `GET /search/workers/count` with the same query as the search (`page`, `limit`, `sort` ignored) returns `{ "total": 12 }`, equal to `meta.total` of the search. |
| 5 | Weekdays | NOT BUILT | Availability windows are daily; weekdays are not modelled. Needs a worker-app input and a migration (Q-136). |
| 6 | Monthly rate | NOT EXPOSED | Worker pay is private to customers (FR-WD-007) and has no period. Drop the row from the design unless the client decides otherwise (Q-136, Q-131). |
| 7 | Rating breakdown | DONE | `GET /search/workers/{id}/ratings` returns `summary: { average, count, distribution }` on every page. `distribution` has every score from `ratingScaleMax` down to 1, zeros included, e.g. `{ "5": 29, "4": 6, "3": 1, "2": 0, "1": 0 }`. Built from visible (not moderated) reviews, so `count` equals `meta.total`. `average` is null with no reviews. |
| 8 | Reviews paging | DONE (docs) | `?page=N&limit=M`, page starts at 1, newest first. Response `meta: { page, limit, total }`. Next page exists while `page * limit < meta.total`; the list ended when that is false or `data` is empty. |

Tests: `search.api` (count), `appfeedback` (summary), openapi contract and module-boundary suites pass; unit 402/402.
