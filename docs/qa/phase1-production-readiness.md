# Phase 1 - core production readiness remediation (2026-10-12)

Scope: audit findings F-01..F-07 (plus F-09, F-15, F-20) of `SevaNest_Backend_Audit.md`. Existing modules were extended, not rewritten.
Nothing here was run against the remote Supabase database; all database work used disposable local PostgreSQL databases
(`*_ci`, `sevanest_boot`, `sevanest_mig`). No real SMS, payment, WhatsApp or storage provider was contacted.

## Status per workstream

| Workstream | Implemented | Tested locally | Tested against the real provider | Blocked |
|---|---|---|---|---|
| 1 SMS / OTP | Twilio and MSG91 adapters, WhatsApp via Twilio, config validation, timeouts, error classification | adapter specs with faked HTTP; OTP failure paths (existing suite) | **No** | External: vendor choice, credentials, India DLT sender/template (Q-76) |
| 2 First Super Admin | hidden-prompt / secret-file password, strength check, confirmation, one-time, locked | local CLI runs: missing confirm, weak, invalid email, no password, two concurrent runs, repeat | n/a | Operator must run it on the production service (README) |
| 3 Booking <-> payment | cancellation hook, late-payment exception, duplicate/mismatch exceptions, booking-first lock order | `payments.recovery` (cancel unpaid / open order / paid / refunding / races) | **No** | Business: refund/cancellation policy (Q-77) |
| 4 Recovery | gateway lookup by order, refund lookup, claimed sweeper, backoff+jitter, UNKNOWN_ORDER replay, summary endpoint | lost webhook, outage, exhaustion, duplicates, concurrent workers, claim lapse, refund adoption | **No** | Business: booking expiry (Q-78); external: Razorpay account (Q-79) |
| 5 KYC | whole-file validation, exact size, SHA-256 + ETag, delete rejected, review-time hash check, abandoned sweeper | `kyc.integrity` + updated `verification.api` + unit | **No** (in-memory storage) | Business/external: malware scanner (Q-81) |
| 6 Rate limiting | `TRUST_PROXY_HOPS` mandatory in production, Redis store default (existing), documented | env validation specs; existing Redis throttler specs | n/a | Operator: choose the hop count (Q-82) |

## Defects fixed (file evidence)
* F-01 `src/integrations/notifications/{twilio.provider,msg91-sms.provider}.ts`, `src/integrations/http/provider-http.ts`, `src/config/env.validation.ts`.
* F-02 `src/bootstrap-admin.ts`, `src/common/security/password-strength.ts` (one-time command already existed; password handling and strength added).
* F-03 `src/modules/payment/payment-recovery.service.ts` (cancellation hook), `payment.service.ts` (`applyOutcome`, booking-first lock order).
* F-04 `razorpay-payment.provider.ts` + `PaymentProvider.findPaymentsForOrder`, `PaymentService.reconcileNow`.
* F-06 (payment/KYC parts) `payment.worker.ts`, `verification.worker.ts`. **Not fixed: expiry of unpaid bookings (Q-78).**
* F-05 `file-signature.ts`, `verification.service.ts`, storage providers (`readObject`, `deleteObject`).
* F-07 `env.validation.ts` (mandatory in production), README, `.env.example`, `render.yaml`. F-15 was already addressed (`RedisThrottlerStorage`).
* F-09 refund polling and refund webhooks (`applyRefundLocked`, `reconcileRefund`, `applyRefundReport`). F-20 `replayUnknownOrderEvent`.

## Migration
`prisma/migrations/20261018090000_payment_recovery_kyc_integrity` (additive only): `payments.reconcile_*` columns, `payment_events` payload columns,
`payment_exceptions` table + two enums, `verification_documents` hash/etag/purge columns, partial indexes, two CHECK constraints, and a backfill that puts
existing PENDING-with-order and REFUND_PENDING payments into the recovery queue. Applies cleanly on an empty database and after the previous 11 migrations; no drift.

## Behaviour changes to know about
* `POST /admin/payments/{id}/reconcile` now succeeds for a payment with an open order and no known payment id (it asks the gateway by order); it answers 422 only when no checkout was started.
* A retry after a FAILED refund uses a new idempotency key (`refund-<id>-f<n>`); the same key would replay the failed refund at a real gateway.
* Document confirmation requires the uploaded size to equal the declared size and a complete file of the declared type; a rejected upload is deleted and its slot cannot be reused.
* Production start-up fails without `TRUST_PROXY_HOPS`.
* `bookings` cancel while payment pending: the payment becomes `FAILED` with reason `BOOKING_CANCELLED` (previously stayed `PENDING`).

## Still NOT done / not verified
* No real SMS, payment, refund, webhook or storage call has been made. Razorpay's response shapes and the MSG91 flow API were implemented from the vendors' documented
  APIs and verified only against faked responses.
* No booking-expiry job (undecided). No automatic refunds (undecided). No malware scan. No push provider.
* Notification templates for `PAYMENT_EXCEPTION_ALERT` / `PAYMENT_UNDER_REVIEW` are admin data and none is seeded; until one exists no message is sent (the admin list still shows the problem).
* GitHub Actions has not been run. Multi-replica behaviour was tested with several workers/instances in one process against one database/Redis, not on separate hosts.
