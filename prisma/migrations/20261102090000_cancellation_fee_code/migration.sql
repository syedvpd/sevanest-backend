-- DEC-04: cancellation fee code exists with amount 0 (no fee in V1); an administrator can change it later via PUT /admin/payments/fees/CANCELLATION_FEE.
-- Additive and idempotent; reverse with a follow-up migration deleting the row if no booking has used it.
INSERT INTO "fee_configs" ("id", "code", "amount_minor", "currency", "is_active", "created_at", "updated_at")
VALUES (gen_random_uuid(), 'CANCELLATION_FEE', 0, 'INR', true, now(), now())
ON CONFLICT ("code") DO NOTHING;
