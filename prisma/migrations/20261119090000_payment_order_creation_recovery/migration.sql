ALTER TABLE "payments"
ADD COLUMN "order_creation_started_at" TIMESTAMPTZ(6);

-- Existing open rows without a provider order may represent an ambiguous create from the old flow.
-- Mark them for lookup-only recovery so deployment cannot blindly create a second provider order.
UPDATE "payments"
SET "order_creation_started_at" = "created_at"
WHERE "provider_order_id" IS NULL
  AND "status" IN ('CREATED', 'PENDING');
