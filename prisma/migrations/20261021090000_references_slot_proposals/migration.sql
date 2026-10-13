-- AlterTable
ALTER TABLE "bookings" ADD COLUMN     "proposed_slot_at" TIMESTAMPTZ(6),
ADD COLUMN     "proposed_slot_note" TEXT;

-- CreateTable
CREATE TABLE "worker_references" (
    "id" UUID NOT NULL,
    "worker_id" UUID NOT NULL,
    "position" SMALLINT NOT NULL,
    "name" TEXT NOT NULL,
    "mobile" TEXT NOT NULL,
    "relationship" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "worker_references_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "worker_references_worker_id_position_idx" ON "worker_references"("worker_id", "position");

-- CreateIndex
CREATE UNIQUE INDEX "worker_references_worker_id_mobile_key" ON "worker_references"("worker_id", "mobile");

-- AddForeignKey
ALTER TABLE "worker_references" ADD CONSTRAINT "worker_references_worker_id_fkey" FOREIGN KEY ("worker_id") REFERENCES "worker_profiles"("id") ON DELETE CASCADE ON UPDATE CASCADE;
