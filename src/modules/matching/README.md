# Matching

Staff-side candidate selection for one customer requirement (FR-WD-006/007: "admin users match and assign workers manually").

## Behaviour

`POST /api/v1/admin/matching/candidates` (ADMIN with `matching.run`). Body: the whole requirement - `category`, `areaId`, `engagement`,
`availableFrom`, `availableTo` (all required) and optional `language`, `minExperienceMonths`, `page`, `limit`. Returns the
candidates that meet every criterion, `ordering: SUBMITTED_ASC` (earliest submitted profile first) and `ranked: false`.

Matching delegates to Search's eligibility, which already requires an ACTIVE account, a SUBMITTED profile and full verification, so
there is no code path around those rules (a test proves unverified, draft and suspended workers never appear and that no request field
changes that). Candidates show name and account id (so staff can act) but no contact, address, salary, emergency contact or document.

It does not score, rank, reserve, assign, notify or store anything; each run is audited (`matching.candidates`) with the requirement and
the result count, never with worker details. Booking, interview, trial, payment and notification belong to later modules.

Not matched on, because the specs define no rule: salary/budget (no salary period, Q-39), start date (no effective dates), customer
"daily/hourly" engagement (Q-38). No scoring is defined (Q-46).
