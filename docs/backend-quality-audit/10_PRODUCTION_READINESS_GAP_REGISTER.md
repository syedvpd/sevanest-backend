# 10 — Production readiness gap register

Status per area uses: VERIFIED, VERIFIED WITH LIMITATIONS, NOT VERIFIED, FAILED, BLOCKED. The overall result is in `11_FINAL_VERIFICATION_REPORT.md`.

## Readiness by area

| Area | Status | Basis |
|---|---|---|
| Functional | VERIFIED WITH LIMITATIONS | Core flows (auth, onboarding, verification, search, booking state machine of 297 combinations, payment, attendance, replacement, rating, support) are covered by 71 integration suites that pass on an isolated database (see 11). No live gateway/SMS/S3. PRD behaviours were not re-derived from the PRD document in this audit; business rules were taken as implemented and tested. |
| API | VERIFIED | Validation, envelope, status codes and authorization are strong and tested; OpenAPI now documents success and error responses on every operation and a test enforces it. |
| Data | VERIFIED WITH LIMITATIONS | 59 tables, 199 indexes, no duplicate or redundant index, no multi-column FK without a covering index, 17 single-column audit FKs unindexed (low value, see 04). Constraints and exclusion indexes enforced in DB. Backups/restore and migration rehearsal on staging data NOT VERIFIED (operator task; scripts `scripts/db/backup.sh`, `restore.sh` exist). |
| Performance | VERIFIED WITH LIMITATIONS | Local, sequential, synthetic baseline in 05; the readiness-probe starvation (F-012) is fixed. Not production hardware, not network, not concurrent load. Hosted p95/p99 NOT VERIFIED (Render runs need authorization). |
| Reliability | VERIFIED WITH LIMITATIONS | DB and Redis outage proven end to end after fixes (06). Queue/provider failure by tests only. |
| Security | VERIFIED WITH LIMITATIONS | No critical/high finding (07). Production configuration, real provider keys and dependency scan NOT VERIFIED. |
| Operational | NOT VERIFIED | Logging, Sentry, alerting, rollback and backup drills could not be observed from the repository alone. |

## Engineering gaps

| ID | Gap | Sev | Owner action |
|---|---|---|---|
| F-005 | ~~No cap on saved addresses~~ fixed: 422 `ADDRESS_LIMIT_REACHED` at 20 active addresses | closed | Owner may change the number (D-A). |
| F-001 | `safety.listMine` unbounded and one lookup per row | P3 | Batch lookup, add limit. |
| F-002 | `findMany` without `take` on `listAllAddresses`, support `events()` | P3 | Defensive limit. |
| F-006 | `scripts/load/seed.sql` predates activation gate; old search timings in `docs/qa/PERFORMANCE_REVIEW.md` not comparable | P3 | Add `activated_at`, `verification_signed_off_at`; re-run; refresh the doc. |
| F-008..F-010 | ~~OpenAPI: no error responses; 19 untyped 2xx; wrong decorator~~ fixed and enforced by a contract test | closed | App teams regenerate their API types from the new `docs/openapi.json`. |
| G-01 | Integration suites commit rows and share Redis: they need a fresh database and their own Redis index. A shared dirty database makes six suites fail (verification queue page limit, template FK, Redis jobs from other sessions) | P3 test hygiene | Scope lookups to the test's own worker; clean up templates; give the suite a dedicated Redis db number in CI docs. |
| G-02 | `foundation.int-spec.ts` depends on a `.env` file (imports `dotenv/config` only) | P3 test hygiene | Import the shared test environment like the other specs. |
| G-03 | 17 unindexed audit/actor foreign keys (for example `bookings.cancelled_by_user_id`) | info | Only matters if users are ever hard-deleted; add indexes only then. |
| G-04 | Planning time of the search statement (~40 ms) equals its execution time | info | Optional: fewer EXISTS branches or prepared statement; measure first. |
| G-05 | Dependency audit not run | P3 | Add `npm audit --omit=dev` to CI. |
| G-07 | General rate limiting with `THROTTLE_STORAGE=redis` fails open when Redis is down (proven, 06) | P3 | Decision D-B. |
| G-08 | Any admin with `verification.document.view` can open any worker's KYC document; each view is audited | P3 | Decision D-C. |
| G-06 | A simple authenticated read costs 3 to 6 statements (measured: `GET /customers/me` 3, `GET /users/me` 6, search 4); most of the fixed part is the session, user and permission lookups | P3 optimization | Measure at load; consider a short per-request/per-token cache only with a safe invalidation strategy (suspension must apply at once, a tested requirement). Not implemented: it would risk stale authorization. |

## Operational and external gaps

| ID | Gap | Needs |
|---|---|---|
| O-01 | Real S3/Supabase bucket test: private bucket policy, signed PUT/GET, size check against `HeadObject`, public bucket `pub/` keys | operator with staging bucket |
| O-02 | Razorpay test-mode end-to-end with real signatures and refunds; webhook URL registered | Razorpay account/keys |
| O-03 | SMS provider (the app refuses to let anyone log in with an OTP while `SMS_PROVIDER=disabled` in production and warns at boot; the real provider, sender registration and cost decision are not made in the repo) | provider decision |
| O-04 | FCM push credentials and device flow | Firebase project |
| O-05 | Google Maps key and quota; geocode cost per address create | Google account |
| O-06 | `JWT_KEYS` (ES256) not set means no key rotation; boot warns | operator sets key set |
| O-07 | Production `ALLOW_TEST_OTP` must be off; malware scanner enabled; Sentry DSN present | config check via `/admin/system/readiness` |
| O-08 | Worker process must run (`npm run start:worker` or `EMBEDDED_WORKERS`): Render needs a worker service; without it notifications, payment recovery, claim release and retention do not run | deployment check (also in memory note) |
| O-09 | Alerting on the failed-job set, payment exceptions, worker heartbeats | monitoring setup |
| O-10 | Backup, restore drill and migration rollback plan | operator |
| O-11 | Hosted performance run (cold start, network, TLS) | authorization to hit Render |
| O-12 | Load test with concurrent users (`scripts/load`) on production-like hardware | environment |

## Business decisions waiting

| ID | Decision |
|---|---|
| D-A | Confirm or change the saved-address cap (set to 20 as an engineering default, F-005). |
| D-B | Fail open or closed for the general rate limiter when Redis is down (G-07). |
| D-C | Should viewing a KYC document require holding the review claim (G-08)? |
| D-D | Reject unknown JSON fields (`forbidNonWhitelisted`) or keep stripping silently? Changing it breaks lenient clients. |
