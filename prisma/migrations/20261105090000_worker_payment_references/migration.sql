-- CreateEnum
CREATE TYPE "WagePaymentMethod" AS ENUM ('CASH', 'BANK_TRANSFER', 'UPI', 'CHEQUE', 'OTHER');

-- CreateTable
CREATE TABLE "worker_payment_references" (
    "id" UUID NOT NULL,
    "booking_id" UUID NOT NULL,
    "worker_id" UUID NOT NULL,
    "amount_minor" INTEGER NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'INR',
    "period_label" TEXT NOT NULL,
    "method" "WagePaymentMethod" NOT NULL,
    "reference_text" TEXT NOT NULL,
    "corrects_id" UUID,
    "is_void" BOOLEAN NOT NULL DEFAULT false,
    "recorded_by_user_id" UUID NOT NULL,
    "recorded_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "worker_payment_references_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "worker_payment_references_corrects_id_key" ON "worker_payment_references"("corrects_id");

-- CreateIndex
CREATE INDEX "worker_payment_references_worker_id_recorded_at_idx" ON "worker_payment_references"("worker_id", "recorded_at");

-- CreateIndex
CREATE INDEX "worker_payment_references_booking_id_idx" ON "worker_payment_references"("booking_id");

-- AddForeignKey
ALTER TABLE "worker_payment_references" ADD CONSTRAINT "worker_payment_references_booking_id_fkey" FOREIGN KEY ("booking_id") REFERENCES "bookings"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "worker_payment_references" ADD CONSTRAINT "worker_payment_references_worker_id_fkey" FOREIGN KEY ("worker_id") REFERENCES "worker_profiles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "worker_payment_references" ADD CONSTRAINT "worker_payment_references_recorded_by_user_id_fkey" FOREIGN KEY ("recorded_by_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "worker_payment_references" ADD CONSTRAINT "worker_payment_references_corrects_id_fkey" FOREIGN KEY ("corrects_id") REFERENCES "worker_payment_references"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- Amounts are positive; a void keeps the amount of the row it cancels.
ALTER TABLE "worker_payment_references" ADD CONSTRAINT "worker_payment_references_amount_chk" CHECK ("amount_minor" > 0);
ALTER TABLE "worker_payment_references" ADD CONSTRAINT "worker_payment_references_void_corrects_chk" CHECK (NOT "is_void" OR "corrects_id" IS NOT NULL);

-- DEC-05: append-only. A mistake is fixed by a new row that corrects or voids the old one (existing function from the booking migration).
CREATE TRIGGER "worker_payment_references_no_update_delete" BEFORE UPDATE OR DELETE ON "worker_payment_references"
FOR EACH ROW EXECUTE FUNCTION "append_only_reject_mutation"();
