# Phase 1 production readiness - recorded results (2026-10-12)

Run on Windows 11, Node 24.21, local Docker PostgreSQL 17 + Redis 7, fresh disposable databases. Nothing was run against the remote database or any real provider.

| Check | Command | Result |
|---|---|---|
| Format | `npm run format:check` | all files formatted |
| Lint | `npm run lint` | 0 problems |
| Typecheck | `npm run typecheck` | 0 errors |
| Prisma | `npx prisma validate` | valid |
| Migrations | `prisma migrate deploy` on an empty `sevanest_full_ci`; `migrate diff --exit-code` on a scratch DB | 12 applied, no drift |
| Unit | `npm test` | 248/248, 24 suites |
| E2E | `npm run test:e2e` | 27/27, 2 suites |
| Integration (fresh DB) | `TEST_DATABASE_URL=...sevanest_full_ci npm run test:integration` | 672/672, 36 suites |
| Baseline before changes (same DB state) | same command | 626/630; the 4 failures were tests that encoded the old, weaker behaviour (reconcile without a payment id, refund retry key, KYC size/slot rules) and were updated |
| Production image | `docker build --target runtime` | built |
| Container start | API + worker containers, production env | `/health/live` 200, `/health/ready` 200, worker started; start without `TRUST_PROXY_HOPS` refused |
| HTTP smoke | curl against the container | OTP request -> 503 `SMS_NOT_CONFIGURED`; admin login 200; `/admin/payment-recovery/summary`, `/admin/payment-exceptions`, `/admin/payments` 200; unsigned webhook 401 |
| Bootstrap CLI | `node dist/bootstrap-admin` on a throwaway DB | refused: missing confirmation, weak password, invalid email; two concurrent runs -> one account, one `admin.bootstrap`, one `admin.bootstrap_rejected`; repeat refused |

New suites: `payments.recovery.int-spec.ts` (25 tests), `kyc.integrity.int-spec.ts`, `razorpay-payment.provider.spec.ts`, `sms-providers.spec.ts`, `payment-recovery.constants.spec.ts`, `password-strength.spec.ts`, additions to `file-signature.spec.ts` and `env.validation.spec.ts`.

NOT covered: real Twilio/MSG91/Razorpay/S3 calls, Render, GitHub CI, load, separate-host replicas.
