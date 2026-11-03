# 07 — Security and authorization audit

## Status

**VERIFIED WITH LIMITATIONS.** No critical or high finding. Controls are enforced in code and pinned by dedicated suites; the limits are what could not be exercised without real infrastructure or accounts.

## Authorization model (verified from the live route dump, 305 routes)

| Class | Count | Rule |
|---|---|---|
| Public | 10 | `app-config`, `reference-data`, `legal/current`, four `auth` routes, payment webhook, two health probes. `security.api` asserts this exact list. |
| Authenticated, no further gate | 20 | self-service or shared reads (sessions, legal acceptance, deletion request, notifications inbox, service areas and categories, own profile/preferences). The list is reviewed in `security.api`; ownership is in the service. |
| User-type gated (CUSTOMER / WORKER / ADMIN) | 275 | `UserTypeGuard`; wrong type answers 403 (audited) |
| Admin permission gated | 160+ | every `/admin` route needs a permission or role except `GET /admin/dashboard` (sections filtered per permission by design) and `POST /admin/account/password` (self-service, re-verifies the current password). |

Test evidence (`security.api`): anonymous 401 on every protected route; forged token 401; wrong user type 403; admin with no permission 403; admin with some but not the needed permission 403; suspended admin with an older token 403; the refusal is audited without ids, query or body; permission codes used on routes all exist in the catalog.

## Checked areas

| Area | Verdict | Evidence |
|---|---|---|
| OTP: keyed hash with TTL in Redis, single use, attempt limit with lockout, parallel guesses cannot exceed the limit, per-mobile and per-IP send limits, resend cooldown, suspended and wrong-app accounts answered like unknown numbers (no enumeration) | PASS | `auth.api`, `qa.adversarial` |
| Test OTP backdoor (`ALLOW_TEST_OTP`) | Refused when `NODE_ENV=production`; ignored while the flag is off; keeps every normal protection. A ConfigWarning prints when on. | env validation; `test.otp`, `worker.app.blockers` |
| Tokens: tampered, unsigned, re-algorithmed, expired, refresh used as access, revoked session, replay of a rotated refresh token (theft revokes the session and audits) | PASS | `qa.adversarial`, `auth.api` |
| JWT signing | HS256 shared secret unless `JWT_KEYS` (ES256 key set) is set. The app warns at boot when `JWT_KEYS` is unset. No rotation without it. | `ConfigWarning` seen in every test run; `docs/JWT_ROTATION.md` |
| Admin login: same answer for unknown email and wrong password, constant-time dummy hash, per-account and per-IP lockout, atomic failure counting, suspended revealed only after the correct password | PASS | `auth.api`, `qa.adversarial` |
| IDOR / BOLA: another customer's or worker's booking, address, document, rating, session, payment, shortlist answers 404 for every operation | PASS | `qa.access`, `customers.api`, `verification.api`, `payment.api` |
| Privilege escalation: admin cannot grant themselves permissions, edit the Super Admin role, change their own status; Verification Executive cannot sign off or activate | PASS | `qa.adversarial`, `users.api`, `verification.decisions` |
| Mass assignment: server-controlled fields ignored on every mutating route; never echoed | PASS | `qa.adversarial`, per-module suites |
| Injection: SQL in filters/search treated as data (all raw SQL uses tagged `Prisma.sql` parameters); hostile text stored literally | PASS (tests) | `qa.adversarial`; code read of `search.repository.ts` |
| KYC private storage: random keys with no personal data, signed short-lived links, hash re-checked before each link, every view audited before the link is returned, KYC never in public bucket, never in other responses | PASS | Batch 4; `kyc.integrity`, `qa.access` |
| Payment integrity: amount from server fee config never from client; signed webhook verified in constant time; unknown, unsigned, wrongly signed, tampered, wrong-amount, duplicate and out-of-order notifications handled; success needs gateway evidence | PASS | `payment.api`, `payments.recovery`; `razorpay-payment.provider.ts` uses `timingSafeEqual` |
| CSV export: formula-looking text neutralised (`= + - @ tab CR`); numbers stay numbers (fixed F-007); exports capped at 5000 rows; export audited | PASS | `csv.ts`, `csv.spec.ts` |
| Error leakage: no stack, SQL, path, secret, connection text; `no-store`; request id only | PASS | `security.api`; outage run (503 bodies contain only code, message, requestId) |
| Headers: Helmet, `x-powered-by` removed, HSTS, no CORS grant to unlisted origin | PASS | `qa.adversarial`, `security.api` |
| Audit log: append-only at the database level (UPDATE/DELETE rejected, TRUNCATE trigger), no secrets, security events written even if Redis is down | PASS | `foundation.int-spec` (see run status in 11), `ops.hardening` |
| Account deletion / retention | present (`legal`, `retention`, erasers); retention job coverage tested in `retention.int-spec` | existing suite |

## Findings (security-relevant)

| ID | Sev | Class | Summary |
|---|---|---|---|
| F-011/F-004 | P2 | fixed | Dependency outages produced 500 and Sentry noise. Not a confidentiality issue. |
| G-07 | P3 | design decision | General rate limiting (`THROTTLE_STORAGE=redis`) fails open when Redis is down. OTP-specific limits fail closed (503). |
| F-005 | P3 | design weakness | No cap on saved addresses per customer: bounded by 120 req/min throttle only. |
| G-08 | P3 | business decision | Any admin with `verification.document.view` can open any worker's KYC document without holding the review claim. Every view is audited. |

No finding allows authentication bypass, cross-tenant read, privilege escalation or payment tampering.

## Not verified (needs access this audit did not have or must not use)

- Real Razorpay test-mode signatures, real SMS provider behaviour, real Supabase/S3 bucket policy and signed-URL enforcement, real FCM.
- Whether production has `ALLOW_TEST_OTP` off, `JWT_KEYS` set, malware scanning on, Sentry configured, and secrets rotated. Config validation refuses some unsafe production combinations (readiness endpoint reports them) but production values were not read.
- Dependency vulnerability scan (`npm audit`) was not run: it contacts an external registry and was outside the no-dependency-change rule's spirit; recommended as a CI step.
- Penetration-style fuzzing beyond the existing adversarial suite (for example authenticated multi-step business-logic abuse across the booking and payment chain under real gateways).
