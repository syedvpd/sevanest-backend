-- Additive: worker profile photos (FR-WON-002) and customer shortlist (FR-WD-005). No existing table is altered.
-- Rollback: DROP TABLE customer_shortlist_items, worker_profile_photos; DROP TYPE "PhotoStatus" (only data created by these features is lost).

-- CreateEnum
CREATE TYPE "PhotoStatus" AS ENUM ('PENDING_UPLOAD', 'READY');

-- CreateTable
CREATE TABLE "worker_profile_photos" (
    "id" UUID NOT NULL,
    "worker_id" UUID NOT NULL,
    "object_key" TEXT NOT NULL,
    "content_type" TEXT NOT NULL,
    "size_bytes" INTEGER NOT NULL,
    "status" "PhotoStatus" NOT NULL DEFAULT 'PENDING_UPLOAD',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "confirmed_at" TIMESTAMPTZ(6),

    CONSTRAINT "worker_profile_photos_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "customer_shortlist_items" (
    "customer_user_id" UUID NOT NULL,
    "worker_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "customer_shortlist_items_pkey" PRIMARY KEY ("customer_user_id","worker_id")
);

-- CreateIndex
CREATE UNIQUE INDEX "worker_profile_photos_object_key_key" ON "worker_profile_photos"("object_key");

-- CreateIndex
CREATE INDEX "worker_profile_photos_worker_id_status_confirmed_at_idx" ON "worker_profile_photos"("worker_id", "status", "confirmed_at");

-- CreateIndex
CREATE INDEX "customer_shortlist_items_customer_user_id_created_at_idx" ON "customer_shortlist_items"("customer_user_id", "created_at");

-- CreateIndex
CREATE INDEX "customer_shortlist_items_worker_id_idx" ON "customer_shortlist_items"("worker_id");

-- AddForeignKey
ALTER TABLE "worker_profile_photos" ADD CONSTRAINT "worker_profile_photos_worker_id_fkey" FOREIGN KEY ("worker_id") REFERENCES "worker_profiles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "customer_shortlist_items" ADD CONSTRAINT "customer_shortlist_items_customer_user_id_fkey" FOREIGN KEY ("customer_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "customer_shortlist_items" ADD CONSTRAINT "customer_shortlist_items_worker_id_fkey" FOREIGN KEY ("worker_id") REFERENCES "worker_profiles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
