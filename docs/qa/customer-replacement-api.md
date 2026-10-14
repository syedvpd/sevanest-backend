# Customer replacement requests: requests 37-44 (2026-10-14)

Base `/api/v1/replacement-requests`, customer token. Tests: `test/integration/replacement.api.int-spec.ts` (23/23; the "customer workflow" block covers this page). Test accounts: the specs create a synthetic customer, an ACTIVE booking and eligible workers on a `_test`/`_ci` database; nothing is seeded on staging or Supabase.

| # | Ask | Result |
|---|---|---|
| 37 | Alternatives | **Fixed.** `GET /replacement-requests/{id}/alternatives?page&limit` returns customer-safe worker cards (no name, no user id; same shape as search) for an APPROVED request of the caller. Same eligibility as the staff candidate list, never the worker being replaced. Not APPROVED: 409 `INVALID_TRANSITION`; not yours: 404 `REPLACEMENT_NOT_FOUND`. Select still re-checks. |
| 38 | Reasons / notes | **Fixed (Q-107 decided).** `POST /replacement-requests` takes `reasonCode` (WORK_QUALITY, BEHAVIOUR, ATTENDANCE, MISMATCH, WORKER_UNAVAILABLE, OTHER); codes and labels are in `GET /reference-data` `replacementReasons`. `reason` is now optional free-text detail (defaults to the label); it is required when `reasonCode` is OTHER or omitted (older clients keep working and get OTHER). `notes` optional, max 2000. Views return `reasonCode`. |
| 39 | `neededFrom` | **Deferred from V1 (Q-108 decided).** Not accepted or stored; no migration for it. |
| 40 | Booking link | **Fixed.** `GET /replacement-requests?bookingId=` (own requests only). `replacementRequestId` is not added to `BookingView`. |
| 41 | Timeline / ETA | **Timeline fixed; no ETA for V1 (Q-109 decided, waits for an Operations SLA).** `GET /replacement-requests/{id}` has `timeline: [{status, at, actor: CUSTOMER|STAFF|SYSTEM, remarks}]`, oldest first, from the audit trail. On the APPROVED / REJECTED entry `remarks` is the customer-facing decision message. |
| 42 | Status rules | **Confirmed; staff remarks now internal (Q-110 decided).** APPROVED allows alternatives and select. REJECTED is final for that request (409 `INVALID_TRANSITION`); the customer may open a new one. Customer views return only `decisionMessage`; `decisionRemarks` is internal and appears only in `/admin/replacement-requests`. Staff set both in `approve` / `reject` (`remarks` internal, `message` customer-facing, both optional except `remarks` on reject). Old rows keep their remarks as internal. Both are audited. |
| 43 | After selection | **Documented, as built.** Select creates a NEW booking (same requirement, chosen worker) in `MATCHED` with `replacesBookingId`; the old booking becomes `REPLACED`; request `COMPLETED` with `replacementBookingId`. The new booking then follows the normal lifecycle (worker accept, interview/trial, confirm worker, booking fee payment). No payment or price is copied from the old booking (test asserts 0 payments). Whether a replacement should skip interview/fee or keep the old price is **blocked pending client approval** (Q-111, see below); nothing was invented. |
| 44 | Error codes | **Confirmed and tested.** Duplicate open request: 409 `REPLACEMENT_ALREADY_OPEN`. Ineligible worker: 422 `WORKER_NOT_ELIGIBLE`. Worker busy for those hours: 409 `WORKER_UNAVAILABLE`. Same worker: 422 `SAME_WORKER`. Cancel / select / approve when no longer open: 409 `INVALID_TRANSITION` (repeating cancel on a CANCELLED request is a harmless 200). Booking not yours: 404 `BOOKING_NOT_FOUND`; not eligible: 422 `REPLACEMENT_NOT_ELIGIBLE`. |

## Migration

`20261028090000_replacement_reason_decision_message`: enum `ReplacementReason`, `replacement_requests.reason_code` (default OTHER), `decision_message` (1..1000). Additive; checked on a fresh database (no drift).

## Q-111 blocked: pending client approval

Proposed policy, NOT implemented: waive a second platform fee for an eligible replacement; keep the original agreed price when service terms are unchanged; require customer agreement for price or scope changes; allow another interview/trial only when needed. Until approved, a replacement booking behaves as in row 43 (normal lifecycle including interview/trial and booking fee). The app must not promise a waived fee or skipped interview.

Contract changes for the app: create takes `reasonCode`; customer views drop `decisionRemarks` and add `decisionMessage`; reference data adds `replacementReasons`. Q-107 to Q-111 still need entries in `OPEN_QUESTIONS.md` / `DECISION_INDEX.md` (not edited here: those files carry another session's uncommitted changes).
