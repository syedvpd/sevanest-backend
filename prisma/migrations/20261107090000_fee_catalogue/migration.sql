-- DEC-11: fee catalogue kinds and one open payment per (booking, fee). Additive: existing rows default to BOOKING; the booking-fee guarantee (one open payment per booking) is unchanged because it is now per (booking, fee_code).
-- CreateEnum
CREATE TYPE "FeeKind" AS ENUM ('BOOKING', 'PLACEMENT', 'VERIFICATION', 'REPLACEMENT_PLAN', 'SUBSCRIPTION', 'CANCELLATION');

-- AlterTable
ALTER TABLE "fee_configs" ADD COLUMN     "kind" "FeeKind" NOT NULL DEFAULT 'BOOKING';


UPDATE "fee_configs" SET "kind" = 'CANCELLATION' WHERE "code" = 'CANCELLATION_FEE';
UPDATE "fee_configs" SET "kind" = 'PLACEMENT' WHERE "code" LIKE 'PLACEMENT%';
UPDATE "fee_configs" SET "kind" = 'VERIFICATION' WHERE "code" LIKE 'VERIFICATION%';
UPDATE "fee_configs" SET "kind" = 'REPLACEMENT_PLAN' WHERE "code" LIKE 'REPLACEMENT%';
UPDATE "fee_configs" SET "kind" = 'SUBSCRIPTION' WHERE "code" LIKE 'SUBSCRIPTION%';

DROP INDEX "payments_one_active_per_booking_key";
CREATE UNIQUE INDEX "payments_one_active_per_booking_fee_key" ON "payments" ("booking_id", "fee_code")
  WHERE "status" IN ('CREATED', 'PENDING', 'SUCCEEDED', 'REFUND_PENDING', 'REFUND_FAILED');
