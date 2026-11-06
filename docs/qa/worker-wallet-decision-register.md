# Worker Wallet / Banking / Earnings / Registration — Decision Register

**Date:** 2026-11-05 · **Branch:** `main` · **Purpose:** the business decisions that must be approved before the
wallet, banking, withdrawal, payout, analytics and DOB/gender tracks can be implemented.

**Status of every track:** **BLOCKED — no implementation code, migration, or API change has been written for
Tracks A–G.** The only change made in this round is the authorized test-fixture repair in
`test/support/bookings.ts` (see the final report). The audit in
`docs/qa/worker-wallet-registration-gap-audit.md` remains the baseline.

Why this file: `AGENTS.md` §2.4 and the implementation task §4 both forbid inventing a business rule to fill a gap.
Each row below is a question the source code cannot answer. Approve an option (or supply a different one) and the
named work can start.

| # | Decision | Why it blocks | Recommended option (proposal only) | Alternatives / impact |
|---|---|---|---|---|
| D-1 | **Worker earnings source** — which real events create a worker earning? | Nothing in the backend credits a worker. `worker_payment_references` records *off-platform* payments staff observed and must not be treated as wallet credits. | **No automatic platform earnings in V1** (consistent with D-102 "zero escrow/payout"). Keep the reference ledger as information only; wallet stays empty. | If platform earnings are required: credit on `bookings.status = COMPLETED` only, never on matched/scheduled/started. Impact: ledger schema + backfill policy for historical bookings (would need a business date). |
| D-2 | **Pending earnings** — when does an earning become *pending*? | No pending/escrow state exists on any money row. | Enter `PENDING` when D-1's credit event fires, with a configurable hold. | Hold length (0 days / 7 days / until customer confirmation) changes the status machine and the worker-visible "pending" figure. |
| D-3 | **Release policy** — what makes pending earnings withdrawable? | No release/settlement code exists. | Release automatically when the hold elapses (D-2), unless an admin places a dispute hold. | Manual admin release costs operations; automatic release needs a scheduler (outbox/queue already available). |
| D-4 | **Escrow** — does SevaNest actually hold worker funds? | D-102 records "zero escrow/payout in V1"; `Q-73` is still open. | **No escrow in V1.** Do not expose "available balance" until a funded ledger and payout rail exist. | Holding funds requires a licensed payment flow, reconciliation, refunds and regulatory review — a much larger project than an endpoint. |
| D-5 | **Withdrawal limits** — minimum, maximum, frequency. | No limits exist anywhere in code or docs. | ₹100 minimum, balance as the effective maximum, **one pending withdrawal at a time**, per-request idempotency key. | Any number is policy; confirm before it is coded. A "frequency" rule (e.g. 1/day) needs a defined timezone (India). |
| D-6 | **Payout responsibility** — manual operations or automated provider? | No payout processing exists. | **Manual admin processing first**, behind a provider abstraction; no money moves until a rail is approved. | Automated payouts need a provider, callback authentication, dedupe and failed-payout restoration. |
| D-7 | **Bank verification** — approved provider and policy. | No bank model or provider abstraction exists. | Abstract `BankVerificationProvider`; until configured, accounts are `UNVERIFIED`/`PENDING` and **cannot** be used for payouts. Penny-drop/KYC vendor to be named. | Saving an unverified account is a policy choice; deletion while a payout references an account needs a retention rule. |
| D-8 | **Platform incentives** — rules and data source. | Nothing in the backend represents an incentive; the request's "Platform Incentive" category has no source. | **Omit incentives in V1** (no invented category or amount). | Adding incentives later needs a source table and a credit rule; it must not be faked in analytics. |
| D-9 | **DOB** — mandatory or optional; minimum age. | No field, no rule, no spec text in the repo. | **Optional** in V1 (does not block existing drafts/submissions); no age gate until legal/policy confirms. | Mandatory + 18+ changes `missingForSubmission`, `STEP_OF_MISSING`, admin UI and the submission error. Adding it later is an additive migration either way. |
| D-10 | **Gender** — approved values and optionality. | No enum, no accepted values anywhere. | Optional enum `MALE, FEMALE, OTHER, PREFER_NOT_TO_SAY` (the values in the request), stored as a Prisma enum. | If values may change later, use `TEXT` + application validation instead of a DB enum (no migration to add a value). |
| D-11 | **"Completed shift"** — the analytics definition. | Both `attendance_records` and `bookings.status` exist; the business has not chosen. | Count **attendance days with status `PRESENT` or `LATE`** inside the period; a booking is not a shift and an opportunity is never one. | Booking-completed counting is simpler but cannot produce category-wise shift counts tied to actual work days. |
| D-12 | **Admin visibility of DOB/gender** + retention. | No rule exists for these personal fields. | Visible to ADMIN only (inherits `AdminWorkerDetail`), never to customers/search; covered by the existing retention module. | Verification staff may need them; erasure rules must be stated before storage. |

## What each approval unblocks

| After approval of | Work that can start |
|---|---|
| D-9, D-10 (and D-12) | Track G: additive migration (`date_of_birth DATE`, `gender`), DTOs, `scalarUpdate`/`toProfileView`, conditional `missingForSubmission`, tests. Small, no financial risk. |
| D-11 (D-8 to omit incentives) | Track C/D reporting on **existing** rows: analytics + richer earnings history. No ledger. |
| D-7 | Track B: bank-account model, CRUD, masking, ownership, verification abstraction (status stays PENDING/UNVERIFIED without a provider). |
| D-1…D-6, D-8 | Track A/E/F: ledger, balance, withdrawals, payouts. This is the financial subsystem and must not ship in pieces that expose a withdrawable amount without a funded ledger. |

## Constraints that apply once implementation starts

- Integer minor units only; no floating-point money.
- Immutable ledger rows; corrections are compensating entries (the existing wage-reference pattern).
- Balance changes inside one transaction with row locking (`SELECT … FOR UPDATE`); idempotency keys on writes.
- Provider callbacks authenticated (HMAC + constant-time compare) and deduplicated by provider event id.
- No fake payout success, no simulated verified bank account, no placeholder balances.
- Migrations additive only; do not touch production/staging or run destructive commands.
- Every endpoint: WORKER-scoped ownership, standard error envelope, OpenAPI documentation and contract test.
