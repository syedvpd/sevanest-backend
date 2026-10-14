# Customer attendance and exception tests: results (2026-10-14)

Run on disposable local PostgreSQL databases (never a hosted one), real HTTP API, test-issued tokens.

| Suite | Tests | Result |
|---|---|---|
| `test/integration/customer.active-service.int-spec.ts` | 13 | pass |
| `test/integration/customer.history-rating.int-spec.ts` | 17 | pass |
| `test/integration/contract.openapi.int-spec.ts` (real bodies vs the published OpenAPI, incl. the new endpoints and the worker attendance routes) | 2 | pass |
| `src/common/rating/rating-eligibility.spec.ts` (every booking status) | 11 | pass |
| Targeted integration run after the final change (modules.workforce, qa.inventory, customer.*, contract, ratings, attendance, home, qa.journeys, security, booking, gap.closing, support, payment) | 230 | 229 pass, 1 fail: the module-boundary test reports `replacement` importing `search` and `meta` importing `replacement`, which is another session's uncommitted replacement work in the same working tree, not this change |
| Unit tests (whole project) | 295 | pass |
| E2E tests | 27 | pass |
| Prisma validate, migrations on an empty database, drift check | 23 migrations | valid, applied, no drift |
| Format, lint, typecheck | - | clean |

The complete integration suite (879 tests) ran once before the architecture fixes below: 875 passed; the 4 failures were real findings that were then fixed
(Booking must not import worker-photo/ratings or read the `ratings`/`payments` tables; `GET /bookings/history` and `POST /bookings/{id}/rebook` were
shadowable by `:bookingId` routes). Fixes: history moved to `GET /customers/me/booking-history[/summary]` through a new History composition module
(Booking + Payment), rebook became the literal route `POST /bookings/rebook` with `bookingId` in the body, the rating rule moved to `src/common/rating`,
Ratings registers its "already rated" lookup with Booking through `BookingLifecycleHooks`, and photo links come through Search. The affected suites were
re-run; the full 879 were not repeated.
Not run: Docker production-mode start of this change (image build started but its result was not awaited), Flutter UI.

## Customer exception rules (FRD FM-09, D-83): evidence

| Case | Expected | Test |
|---|---|---|
| Valid missing day | 201, EXCEPTION by CUSTOMER, history row (actorKind CUSTOMER), audit record, visible to the worker and staff, counted as `exception` not `present` | `customer.active-service` 3.1 |
| Staff review | correction with a reason keeps both entries in the history | 3.1 |
| Existing entry for the date | 409 `ATTENDANCE_ALREADY_RECORDED` | 3.2 |
| Future date, date before the start | 422 `DATE_NOT_ALLOWED` | 3.2 |
| Missing, empty, blank, 501-character note; missing or unreal date | 400, nothing stored | 3.2 |
| COMPLETED, CANCELLED, not yet active booking | 409 `BOOKING_NOT_ACTIVE` | 3.3 |
| Another customer, anonymous, admin | 404, 401, 403 | section 1 |
| Five identical concurrent submissions | one row, the same id returned | 3.4 |
| Four different notes for one day at once | exactly one winner, the rest 409, one row | 3.4 |
| Worker records PRESENT while the customer reports the same day | one entry exists | 3.5 |
| A `status` sent by the customer | ignored: the entry is EXCEPTION | section 2 |
