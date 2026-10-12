-- CreateEnum
CREATE TYPE "PaymentExceptionKind" AS ENUM ('PAID_BOOKING_CANCELLED', 'LATE_PAYMENT_BOOKING_NOT_PENDING', 'AMOUNT_MISMATCH', 'CURRENCY_MISMATCH', 'DUPLICATE_PAYMENT', 'UNKNOWN_ORDER_EVENT', 'RECONCILIATION_EXHAUSTED', 'REFUND_STUCK', 'REFUND_NOT_REQUESTED');

-- CreateEnum
CREATE TYPE "PaymentExceptionStatus" AS ENUM ('OPEN', 'RESOLVED');

-- AlterTable
ALTER TABLE "payment_events" ADD COLUMN     "amount_minor" INTEGER,
ADD COLUMN     "currency" TEXT,
ADD COLUMN     "event_kind" TEXT,
ADD COLUMN     "provider_order_id" TEXT,
ADD COLUMN     "provider_payment_id" TEXT,
ADD COLUMN     "provider_refund_id" TEXT;

-- AlterTable
ALTER TABLE "payments" ADD COLUMN     "reconcile_attempts" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "reconcile_claimed_until" TIMESTAMPTZ(6),
ADD COLUMN     "reconcile_last_at" TIMESTAMPTZ(6),
ADD COLUMN     "reconcile_last_note" TEXT,
ADD COLUMN     "reconcile_next_at" TIMESTAMPTZ(6);

-- AlterTable
ALTER TABLE "verification_documents" ADD COLUMN     "content_sha256" TEXT,
ADD COLUMN     "purged_at" TIMESTAMPTZ(6),
ADD COLUMN     "rejection_code" TEXT,
ADD COLUMN     "storage_etag" TEXT;

-- CreateTable
CREATE TABLE "payment_exceptions" (
    "id" UUID NOT NULL,
    "dedupe_key" TEXT NOT NULL,
    "kind" "PaymentExceptionKind" NOT NULL,
    "status" "PaymentExceptionStatus" NOT NULL DEFAULT 'OPEN',
    "payment_id" UUID,
    "booking_id" UUID,
    "booking_status" TEXT,
    "payment_status" TEXT,
    "amount_minor" INTEGER,
    "currency" TEXT,
    "provider_order_id" TEXT,
    "provider_payment_id" TEXT,
    "required_action" TEXT NOT NULL,
    "details" JSONB,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolved_at" TIMESTAMPTZ(6),
    "resolved_by_user_id" UUID,
    "resolution_note" TEXT,

    CONSTRAINT "payment_exceptions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "payment_exceptions_dedupe_key_key" ON "payment_exceptions"("dedupe_key");

-- CreateIndex
CREATE INDEX "payment_exceptions_status_created_at_idx" ON "payment_exceptions"("status", "created_at");

-- CreateIndex
CREATE INDEX "payment_exceptions_payment_id_idx" ON "payment_exceptions"("payment_id");

-- CreateIndex
CREATE INDEX "payment_exceptions_resolved_by_user_id_idx" ON "payment_exceptions"("resolved_by_user_id");

-- AddForeignKey
ALTER TABLE "payment_exceptions" ADD CONSTRAINT "payment_exceptions_payment_id_fkey" FOREIGN KEY ("payment_id") REFERENCES "payments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment_exceptions" ADD CONSTRAINT "payment_exceptions_resolved_by_user_id_fkey" FOREIGN KEY ("resolved_by_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- Recovery queue: only rows waiting for an authoritative check are indexed.
CREATE INDEX "payments_reconcile_due_idx" ON "payments" ("reconcile_next_at") WHERE "reconcile_next_at" IS NOT NULL;
-- Replay of webhooks that raced ahead of their order.
CREATE INDEX "payment_events_unknown_order_idx" ON "payment_events" ("created_at") WHERE "note" = 'UNKNOWN_ORDER' AND "applied" = false;
-- Open money problems for the admin queue.
CREATE INDEX "payment_exceptions_open_idx" ON "payment_exceptions" ("created_at") WHERE "status" = 'OPEN';
ALTER TABLE "payment_exceptions" ADD CONSTRAINT "payment_exceptions_resolved_chk" CHECK (
  "status" <> 'RESOLVED' OR ("resolved_at" IS NOT NULL AND "resolved_by_user_id" IS NOT NULL AND "resolution_note" IS NOT NULL)
);
ALTER TABLE "payments" ADD CONSTRAINT "payments_reconcile_attempts_chk" CHECK ("reconcile_attempts" >= 0);

-- Existing in-flight rows join the recovery queue (idempotent; new rows are scheduled by the application).
UPDATE "payments" SET "reconcile_next_at" = now()
WHERE "reconcile_next_at" IS NULL AND "reconcile_attempts" = 0
  AND (("status" = 'PENDING' AND "provider_order_id" IS NOT NULL) OR "status" = 'REFUND_PENDING');
