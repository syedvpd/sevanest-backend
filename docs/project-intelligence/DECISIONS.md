# SevaNest approved decisions

The canonical chronological decision log is [`DECISION_INDEX.md`](DECISION_INDEX.md). Current replacement decisions added 2026-11-09:

- **D-109 — Refund approval:** one authorized Admin explicitly approves and initiates the full refund in one action. Request requires `approval: "APPROVE"`; approval and gateway outcome are audited. No second Admin is required.
- **D-110 — Find Another Worker reason and notes:** completed-interview requests require an enabled stable reason code; `OTHER` requires a reason description. Notes are optional, limited to 500 characters, persisted with requester/time, visible to customer and Admin, and excluded from the former-worker notification.
- **Q-143 closed by D-108:** pre-service replacement for `CONFIRMED` and `PENDING_PAYMENT` remains intentionally unsupported.
