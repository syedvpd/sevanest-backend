-- DEC-04: cancellation fee code exists with amount 0 (no fee in V1); an administrator can change it via PUT /admin/payments/fees/CANCELLATION_FEE.
-- Only this code may be 0 (a charged fee must stay positive). Additive; reverse with a follow-up migration restoring the old check once the row is removed.
ALTER TABLE "fee_configs" DROP CONSTRAINT "fee_configs_amount_chk";
ALTER TABLE "fee_configs" ADD CONSTRAINT "fee_configs_amount_chk"
  CHECK ("amount_minor" > 0 OR ("amount_minor" = 0 AND "code" = 'CANCELLATION_FEE'));

INSERT INTO "fee_configs" ("id", "code", "amount_minor", "currency", "is_active", "created_at", "updated_at")
VALUES (gen_random_uuid(), 'CANCELLATION_FEE', 0, 'INR', true, now(), now())
ON CONFLICT ("code") DO NOTHING;
