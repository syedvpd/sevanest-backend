# Payment

Payment of the booking/platform fee behind the `PaymentProvider` abstraction. **No gateway is selected (Q-08)**: only `disabled` (default) and the
test-only `fake` adapter (HMAC-signed like real gateways) exist; `PAYMENT_PROVIDER=fake` is refused in production.

## Requirements covered

FR-PAY-001..009 (gateway abstraction, receipts, transaction history, refund status, success/failure reflected on the booking, amount/reference/status/
refund recorded, audit), FRD FM-07.

## Model

`fee_configs` (admin-set; **empty until set, Q-01** - 422 `FEE_NOT_CONFIGURED`), `payments` (CREATED, PENDING, SUCCEEDED, FAILED, REFUND_PENDING,
REFUNDED, REFUND_FAILED - vocabulary conflict C-05), `payment_events` (one row per gateway notification). A partial unique index allows one
money-holding payment per booking; CHECK constraints tie SUCCEEDED to time, receipt and gateway id.

## APIs (`/api/v1`)

| Who      | Path                                                     | Purpose                                                                           |
| -------- | -------------------------------------------------------- | --------------------------------------------------------------------------------- |
| CUSTOMER | `POST /payments` `{bookingId}`                           | Start or resume payment of my PENDING_PAYMENT booking; amount from the fee config |
| CUSTOMER | `POST /payments/{id}/verify`                             | Report a finished checkout; the server verifies it with the gateway               |
| CUSTOMER | `GET /payments[/{id}]`                                   | Transaction history, receipt, refund status                                       |
| GATEWAY  | `POST /webhooks/payments`                                | Public route; authenticated only by the adapter's signature check on the raw body |
| ADMIN    | `GET /admin/payments[/{id}]` (`payment.view`)            | With gateway references                                                           |
| ADMIN    | `POST /admin/payments/{id}/reconcile` (`payment.manage`) | Ask the gateway and apply the outcome                                             |
| ADMIN    | `POST /admin/payments/{id}/refund` (`payment.refund`)    | Full refund, reason required, safe to repeat                                      |
| ADMIN    | `GET /admin/fees`, `PUT /admin/fees/booking-fee`         | Fee configuration, audited with before/after                                      |

## Rules

- State changes come only from the gateway (verified webhook, server-side verification of a client report, reconciliation) - never from client input.
- One place applies an outcome: serialised by the payment row lock; a notification is recorded once (duplicates acknowledged, ignored); the amount must
  equal the asked amount; finished states never go backwards, except a late success on a FAILED payment (UPI failed, card worked) unless a newer payment exists.
- Success confirms the booking through `BookingService.applyPaymentSucceeded` in the same transaction and queues the receipt notification; if the booking was
  cancelled meanwhile the money is kept, flagged in the audit log, and staff can refund.
- Provider detail never reaches a response; no card data is stored; customer views carry no gateway references.
- Open: who may refund (Q-17), cancellation fee/refund rules (Q-21), partial refunds, other fee types, vendor and its webhook format (Q-08), automatic
  reconciliation job.
