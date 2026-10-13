# Customer app: contract and negative-path test results (2026-10-13)

Disposable local Docker PostgreSQL 17 + Redis (database names ending `_ci`); no Supabase/Render data was touched. Providers: fake SMS/payment. Nothing committed, pushed or deployed.

## Suites written for this round
| Suite | Tests | Result (latest run) |
|---|---|---|
| `test/integration/appgaps2.int-spec.ts` | 21 | 21 passed |
| `test/integration/contract.openapi.int-spec.ts` | 1 (checks 20+ real customer-app responses against `/docs/openapi.json`: required keys present, no undocumented key, types, nullability, enums) | passed |
| `test/integration/appfeedback.int-spec.ts` (earlier, reviews/rating scale/address fields) | 10 | passed in the earlier full run |

`appgaps2` cases (exact titles):
* Pricing: "answers 404 PRICING_GUIDANCE_NOT_FOUND until an administrator sets a band"; "serves the category-wide band, and an area band wins over it"; "replaces the band instead of duplicating it, and lists it for the administrator"; "rejects a band whose maximum is below the minimum, an unknown category and an unknown area" (400 / 422 / 404); "is closed to the wrong audience and to anonymous callers" (403 / 401); "removes a band; a second removal is 404".
* Area lookup: inside the circle; outside -> 404 `AREA_NOT_FOUND`; name fallback incl. city narrowing; partial / missing / out-of-range coordinates -> 400; disabled area not resolved and 401 anonymous; admin sets / clears the centre and a partial centre is refused (400).
* Slots: one-hour starts inside the windows with the 14-day horizon; hours of a held booking removed; a confirmed interview removed; past date, date beyond horizon, malformed date -> 400; unknown or not-visible worker -> 404 (identical); 401 anonymous; 403 wrong user type.
* Interviews list / Home: only my interviews (IDOR with a second customer), filters, 400 bad status, 401, 403 for a worker, `allowedActions` + `timeline`; empty Home; full Home (booking, confirmed interview, unread count, shortlist); no leakage to another customer, 403 worker, 401 anonymous.

Existing suites that already cover the rest of the interview workflow (state transitions, concurrent requests, IDOR, idempotency replay, stale/cancelled): `interview.int-spec.ts` (18). Shortlist, addresses, search, ratings, OTP and refresh behaviour: `shortlist`/`customers`/`search`/`ratings`/`auth` suites.

## Other gates (this session)
| Gate | Result |
|---|---|
| `tsc --noEmit`, `npm run lint`, prettier | clean |
| unit (`npm test`) | 29 suites, 270 tests passed |
| `prisma migrate deploy` on fresh DBs + `migrate diff` vs schema | applied; "No difference detected" |
| Existing tests updated for intended contract changes (not weakened): search statement count 8 -> 7 (page and total in one statement; empty result 2 -> 1), service-area DTO key list, route inventory | adjusted |
| Full integration run on a fresh DB | see the section appended below once finished |
| Docker image build / production-mode start | NOT_VERIFIED in this round |
| Flutter app / live staging / real providers | NOT_VERIFIED (not available) |

## Defects the contract test found and fixed
* 146 nullable fields were published as `type: object` (for example address `label`, category `description`, worker `experienceMonths`); they now publish their real type.
* `GET /app-config` and `GET /reference-data` had no response schema; added.
* Home / shortlist nested schemas were checked through `allOf`.
