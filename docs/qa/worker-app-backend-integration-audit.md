# Worker-app backend integration and persistence audit (2026-10-15)

Scope: the six request groups from the Worker App team. Method: inspect code and specs, implement what is decision-independent, test against a fresh local PostgreSQL (`sevanest_vc_ci`), record what only the client or an external provider can settle. Nothing was committed, pushed or deployed; no staging/production database was touched.

## Completed code changes

| Change | Where |
| --- | --- |
| Check types `SKILL_CERTIFICATE`, `LICENSE` (document-evidenced like identity/address/police) | `prisma/schema.prisma` enum, `verification.dto.ts` `CHECK_TYPES`, `verification.service.ts` `DOCUMENT_CHECKS` |
| Criminal self-declaration + consent + server-stamped time | `worker_profiles.criminal_record_declared / _details / criminal_declared_at` (DB CHECK keeps the three consistent); `PUT /workers/me/criminal-declaration`; `criminalDeclaration` on `GET /workers/me` and `GET /admin/workers/{id}` |
| Migration | `20261031090000_skill_license_checks_criminal_declaration` (additive; applies to an empty DB, `prisma migrate diff` = no difference) |
| Audit | `worker.criminal_declaration` (answer only, never the free text); admin detail read audit now lists the group `criminalDeclaration` |
| Decision / questions | D-87, Q-117..Q-120 |

Not changed on purpose: accepted file types and size, requirement set, search eligibility, OTP and push code (all verified below, no defect found).

## Traceability matrix

| # | Request | Status before | Defect / gap | Change | Tests (local, fresh DB) | Client decision | External | Verified where |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | Skill certificate / licence checks: upload, confirm, submit, queue, approve/reject, worker response | Pipeline existed for 3 document types | The two types did not exist | Enum values + document set | `verification.api` new test: upload, submit, queue filter `checkType=LICENSE`, start-review, reject with remarks, worker sees REJECTED + remarks, resubmit, approve, level VERIFIED; existing loop now also asserts 422 `CHECK_INCOMPLETE` for both types; check list returns 7 types | Whether they are mandatory, per category (Q-118) | none | local only |
| 2 | Criminal self-declaration | No field anywhere in schema or specs | Missing | Columns + endpoint + views | `workers.api`: null until made, saved, shown to worker and admin, replaced with a later server time, 400 without consent / without answer / details with a "no" | Meaning, wording, mandatory?, consequence of "yes", retention (Q-117) | none | local only |
| 3 | Verification requirements / onboarding | Rules exist (below) | Matrix not approved (Q-04, Q-45) | none (not invented) | existing `verification.api` (about 60 tests), `search.api` | Q-118 | none | local only |
| 4 | Upload and resubmission | Implemented | none found | none | existing lifecycle tests (confirm wrong size, signature mismatch, parallel submit, reject then resubmit keeps history, parallel decisions one wins) | Q-119 | real bucket (Q-69) | local (memory storage adapter) |
| 5a | SMS / OTP | Implemented | none found | none | `auth.api`, `test.otp`, unit specs for adapters | production SMS vendor/creds | Twilio or MSG91 credentials and a test number | NOT verified live |
| 5b | FCM | Implemented | none found | none | `notifications.api`, `module10.support-safety-notifications` (fake provider responses) | none | see below | NOT verified live |
| 5c | Opportunities, tickets, categories/areas, status sync | Verified earlier | none | none | see `worker-app-blockers-audit.md` (WAB-01..05); sync covered by the verification and search suites | none | none | local only |
| 6 | OpenAPI | Served at `/docs/openapi.json` when `SWAGGER_ENABLED` | no committed artifact existed | `docs/openapi.json` exported from local code | `contract.openapi` validates real bodies against the schema | none | none | local code, NOT compared with deployed |

## Verification rules as they exist (authoritative source in brackets)

1. Check types: IDENTITY, ADDRESS, EMERGENCY_CONTACT, PREVIOUS_EMPLOYMENT, POLICE_VERIFICATION [FRD FM-05, PROPOSED], SKILL_CERTIFICATE, LICENSE [worker-app request, D-87].
2. Document checks (IDENTITY, ADDRESS, POLICE_VERIFICATION, SKILL_CERTIFICATE, LICENSE) need at least one confirmed document; EMERGENCY_CONTACT / PREVIOUS_EMPLOYMENT need profile data (`verification.service.ts` `submitCheck`).
3. Verification can start only after the profile is submitted (422 `PROFILE_NOT_SUBMITTED`).
4. Required set = `verification_requirements`, admin-configured, empty by default; empty = nobody verified (fails closed) [D-72].
5. VERIFIED = every required check APPROVED and not past `recheckAt`; computed on read (`levelOf`), never stored, so there is no stale status. Search uses the same rule in SQL (`verifiedWorkerCondition`).
6. States: NOT_SUBMITTED -> SUBMITTED -> IN_REVIEW -> APPROVED | REJECTED; RECHECK_DUE derived. Worker may edit only NOT_SUBMITTED, REJECTED, RECHECK_DUE; other moves are 409 `INVALID_TRANSITION`; rows are locked so one parallel decision wins.
7. Rejection needs remarks; the worker sees them in `checks[].remarks`; the full history (from, to, actor, remarks, time) is append-only and visible to staff.
8. Approval of one document never verifies a worker unless the required set is complete.
9. Permissions: `verification.review` (queue, start review), `verification.decide` (approve/reject/recheck), `verification.document.view` (signed link, audited), `verification.configure` (requirements).

## Documents (as implemented)

- Types: env `VERIFICATION_DOCUMENT_CONTENT_TYPES`, a subset of `application/pdf`, `image/jpeg`, `image/png`; the file signature is checked against the declared type at confirmation. Size: env `VERIFICATION_DOCUMENT_MAX_BYTES` (413 above it).
- Several documents per check: yes, up to 10 open (technical guard). Upload link is a short-lived signed PUT (`SIGNED_URL_TTL_SECONDS`). Unconfirmed, wrong-sized or mismatching objects are deleted and cannot be submitted; abandoned uploads are swept. A resubmission clears the old decision, goes to SUBMITTED, and still needs staff review. Storage key never leaves the backend.
- Optional ClamAV scanning exists (D-62).

## OTP and push

- OTP: HMAC-stored, not returned or logged; codes `OTP_INVALID`, `OTP_EXPIRED`, `OTP_ATTEMPTS_EXCEEDED`, `OTP_LOCKED`, `OTP_RESEND_COOLDOWN`, `OTP_SEND_LIMIT`, `OTP_RATE_LIMITED`; provider failure answers `SMS_DELIVERY_FAILED` and `SMS_NOT_CONFIGURED` (503) instead of pretending delivery; fixed test code and accept-any demo flag are refused in production (D-70) and shown in readiness. Local `.env` has `SMS_PROVIDER=disabled`: **no SMS was sent in any test.** Owner action: set Twilio (`TWILIO_*`) or MSG91 (`MSG91_*`) secrets, then `npm run check:providers` and one real OTP to a safe number.
- FCM: `PUSH_PROVIDER=fcm` and `FCM_SERVICE_ACCOUNT_JSON` are present in the local `.env` (the user reports the same on Render; not inspected). Token registration `PUT/DELETE /auth/device-token` is bound to the authenticated session, dead tokens are pruned, failed sends are not marked delivered (SKIPPED/FAILED). Tests use faked provider responses only. **Real delivery needs one registered device token and a send; not done here.**

## Open client decisions

Q-117 (declaration meaning/consent), Q-118 (mandatory checks, per category, onboarding approver, rejected/expired mandatory check), Q-119 (document types/size/count/expiry), plus Q-04/Q-45 history. External: SMS credentials and test number (Q-120), one real FCM device test, real storage bucket.

## Test results

Local, fresh DB `sevanest_vc_ci`, 2026-10-15:

- `prisma validate` OK; `typecheck` OK; `format:check` OK; unit 319/319 (35 suites); migrations apply to an empty DB, `migrate diff` = no difference.
- `lint`: 0 errors in the files of this task. 2 errors remain in the user's uncommitted work (`src/common/rating/rating-tags.ts`, `test/integration/customer.devrequests.int-spec.ts`), not touched.
- Full integration run: 943 passed, 2 failed, 945 total (55 suites). Failure 1: `small.items` expected the old audit group list (my change; test updated). Failure 2: `module10` unread-count test hit its 30 s timeout (known transient, unrelated). Rerun of `small.items`, `module10.support`, `contract.openapi`: 41/41 passed. There was no second clean full run.
- Not run: e2e suite, load tests, any real SMS / FCM / bucket call.

## OpenAPI

`docs/openapi.json` was exported on 2026-10-15 from the local code (the `/docs/openapi.json` document, API version `1`) through the integration harness; there is no npm script for it. It matches local code only and was NOT compared with the deployed backend; compare it with `GET <render-url>/docs/openapi.json` (needs `SWAGGER_ENABLED` there) before telling the app team it matches.
