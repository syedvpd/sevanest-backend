# Payment - test results

**Result: PASS** - 23/23 tests passed, 0 failed (1 suite). Run date: 2026-10-08.

Environment: Node 24.21, PostgreSQL 17 and Redis 7 (Docker), dedicated test database `sevanest_test` (real database and Redis for integration tests), in-memory SMS and storage adapters. OTP/lockout limits in the tests are test values, not approved business values.

## Suites

| Kind | File | Passed | Failed |
|---|---|---|---|
| integration | `payment.api.int-spec.ts` | 23 | 0 |

## Other verification

- Run against the fake gateway adapter (HMAC-signed like real gateways). Covered: fee configuration and its audit, amount taken only from configuration, resume and parallel start, gateway outage (503), verification of a client report, forged signatures, webhook authenticity (unsigned, wrong, tampered), duplicate and parallel webhooks, amount mismatch, unknown order, out-of-order outcomes, late success, success after cancellation, reconciliation, refunds (full, failed, retried), ownership, permissions, database invariants.

## Results by group

| Group | Passed | Failed |
|---|---|---|
| payment.api › fees | 2 | 0 |
| payment.api › starting a payment | 4 | 0 |
| payment.api › client-reported result (verified by the server) | 4 | 0 |
| payment.api › gateway webhook | 7 | 0 |
| payment.api › reconciliation and refunds (admin) | 4 | 0 |
| payment.api › the adapter boundary and the database | 2 | 0 |

## Every test and its result

### `payment.api.int-spec.ts`

- PASS - fees › are set by authorised staff only, validated, and audited with before and after
- PASS - fees › must be configured before anyone can pay (422 FEE_NOT_CONFIGURED) - nothing is hard-coded
- PASS - starting a payment › takes the amount from the fee configuration, never from the client, and shows only checkout data
- PASS - starting a payment › only for the owner and only while the booking waits for payment
- PASS - starting a payment › resumes the open payment instead of creating another, even when called in parallel
- PASS - starting a payment › survives a gateway outage: 503, the payment is kept, and the next call opens the order
- PASS - client-reported result (verified by the server) › confirms the booking, issues a receipt and queues the notification only after the gateway verifies
- PASS - client-reported result (verified by the server) › rejects a forged signature and a report the gateway does not know, changing nothing
- PASS - client-reported result (verified by the server) › lets only the owner report on a payment
- PASS - client-reported result (verified by the server) › records a failure, leaves the booking unchanged, and lets the customer retry with a new payment
- PASS - gateway webhook › does not trust an unsigned, wrongly signed or tampered notification
- PASS - gateway webhook › applies an authentic success once: payment, booking, receipt and notification
- PASS - gateway webhook › acknowledges a duplicate delivery without applying it again, even when many arrive at once
- PASS - gateway webhook › refuses an amount that is not the one we asked for
- PASS - gateway webhook › acknowledges an unknown order and a malformed (but signed) body without side effects
- PASS - gateway webhook › never moves a finished payment backwards, and accepts a late success on a failed one
- PASS - gateway webhook › keeps the money and flags it when the booking was cancelled before the success arrived
- PASS - reconciliation and refunds (admin) › reconciles a delayed success by asking the gateway, and needs something to ask about
- PASS - reconciliation and refunds (admin) › refunds a succeeded payment in full, audited, safe to repeat, visible to the customer
- PASS - reconciliation and refunds (admin) › records a failed refund and allows it to be retried; a pending payment cannot be refunded
- PASS - reconciliation and refunds (admin) › lists and filters payments for staff only
- PASS - the adapter boundary and the database › keeps provider failures out of the response body and refuses a second open payment per booking
- PASS - the adapter boundary and the database › does not accept the webhook through any user session

## Not covered

- A real gateway (none selected, Q-08) and its webhook format; who may refund (Q-17); partial refunds; scheduled reconciliation job.
