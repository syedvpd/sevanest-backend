# Favourites and Interviews: test report (2026-11-02)

Run locally on disposable PostgreSQL databases (`*_ci`, dropped afterwards), in-memory storage, no real SMS or payments. Nothing run against staging or production.

| Suite                                                                                                                 | Result           |
| --------------------------------------------------------------------------------------------------------------------- | ---------------- |
| Unit (`npm test`)                                                                                                     | 402 / 402 passed |
| Typecheck, lint                                                                                                       | clean            |
| Integration, 5 suites: `favourites-interviews`, `interview`, `contract.openapi`, `customer.home`, `modules.workforce` | 59 / 59 passed   |
| Earlier in the day (search screens): `search.api`, `appfeedback`, `contract.openapi`, `modules.workforce`             | 40 / 40 passed   |
| Full integration suite                                                                                                | **not run**      |

New spec `test/integration/favourites-interviews.int-spec.ts` covers: worker summary (name, initials, null photo, no surname or contact), `durationMinutes`, counts across pages, mixed states (confirmed, waiting, cancelled), `scope=upcoming` order (soonest agreed time first) and `scope=past`, invalid `scope` (400), empty list, customer isolation, timeline timestamps (set for done/failed, null for pending), shortlist `categoryCounts` (multi-category worker counted in both, other customer's entries not counted, whole-shortlist counts on any page), `category` filter with paging, empty category (total 0), invalid `category` (400), empty shortlist.

Not tested because not built: `monthlyRate`, `canRequestInterview` / `cannotRequestReason`, interview event history, equal-`scheduledAt` tie order (id is the tie-break in the query, not asserted), query counts (no N+1 assertion; batching is by construction: two statements for bookings and workers per page).
