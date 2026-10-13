-- Additive: optional label, second address line and state on a saved address (customer app request).
-- Rollback: drop the three columns (nothing else depends on them).
ALTER TABLE "customer_addresses"
  ADD COLUMN "label" TEXT,
  ADD COLUMN "line2" TEXT,
  ADD COLUMN "state" TEXT;
