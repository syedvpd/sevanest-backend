# Triage of the external "forensic audit" (2026-10-14)

Each finding was checked against the code, the PRD/FRD and the decision index before anything changed. Verdicts:
**Fixed** (confirmed and changed), **Decision** (the user chose), **By design** (works as decided; no change), **Inaccurate** (the claim does not match the code).

| ID | Claim | Verdict | Evidence / action |
|---|---|---|---|
| CRIT-01 | Two customers can allocate the same worker | By design | D-63 (user-specified): matched and interview stages hold nothing; the first customer to confirm wins under a per-worker advisory lock (`BookingRepository.lockWorker`, `booking.service.ts` confirm path). Covered by `scheduling.int-spec.ts` (two customers confirm at once: one 200, one 409 `WORKER_UNAVAILABLE`). The partial unique index is per customer on purpose (no duplicate live booking of the same worker by the same customer). The project applies migrations only; `prisma db push` is never used |
| CRIT-02 | OTP request reveals suspended / wrong-app numbers | Decision (kept) | D-72: FRD FM-01 asks for a clear message; per-IP and per-number limits slow harvesting. Closes Q-34 |
| CRIT-03 | `ALLOW_TEST_OTP` only warns in production | Fixed | D-70: startup refuses `ALLOW_TEST_OTP=true` with `NODE_ENV=production` (`env.validation.ts`, unit test) |
| CRIT-04 | Suspended admin answers 403 only after a correct password | By design | Standard pattern: account state is shown only to someone who proved the password; every wrong password counts toward the lockout; a suspended account cannot log in |
| CRIT-05 | Session row read on every request | By design | Gives immediate revocation (suspension and logout take effect on the next request, tested). A cache would delay revocation by its TTL. Capacity: `docs/qa/capacity-assessment.md` |
| CRIT-06 | Worker photos not malware-scanned | Fixed | Photos now go through the same optional ClamAV scan as KYC documents (unavailable scanner -> 503 and retry, detection -> 422 `PHOTO_MALWARE_DETECTED`, audited); integration test in `remediation2.discovery.int-spec.ts` |
| OPS-01 | Non-Super admin roles start with no permissions | Fixed | D-71 least-privilege starting sets, applied by the seed only to an empty role; readiness warns about empty roles; tests for grants and denials in `users.api.int-spec.ts` |
| OPS-02 | No verification requirement seeded, search is empty | Inaccurate (plus visibility added) | Deliberate: which checks are required is a client decision (Q-04); nothing is invented. Readiness already reported it as a BLOCKER; the API now also logs readiness problems at startup (D-72) |
| OPS-03 | No booking fee seeded, payment answers 422 | Inaccurate (plus visibility added) | Same: the fee is a client value (Q-01); readiness BLOCKER `booking_fee`, now also in the startup log |
| OPS-04 | Events without an SMS template send no SMS | By design | Channels are chosen by the active templates an administrator sets; SMS wording must be DLT-registered by the client. Readiness lists events with no template at all |
| Sec. 5 | 15 customer-app gaps | Informational | Matches `docs/qa/customer-app-api-gaps.md` answers; shortlist bulk sync and instant "book and pay" are not in the PRD/FRD flow and were not built |
| Sec. 7 | No cross-customer concurrency test | Inaccurate | `scheduling.int-spec.ts` "first customer to confirm wins" runs both confirmations in parallel |

Also done in the same change (user request, D-69): profile photos are re-encoded on the server into two WebP renditions without camera metadata, and the original upload is deleted.
