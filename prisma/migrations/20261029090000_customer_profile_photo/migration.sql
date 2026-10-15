-- Customer's own profile photo (customer-app request 8). Additive: one new table, nothing existing is changed.
CREATE TABLE "customer_profile_photos" (
    "id" UUID NOT NULL,
    "customer_user_id" UUID NOT NULL,
    "object_key" TEXT NOT NULL,
    "content_type" TEXT NOT NULL,
    "size_bytes" INTEGER NOT NULL,
    "status" "PhotoStatus" NOT NULL DEFAULT 'PENDING_UPLOAD',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "confirmed_at" TIMESTAMPTZ(6),
    "card_object_key" TEXT,
    "large_object_key" TEXT,

    CONSTRAINT "customer_profile_photos_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "customer_profile_photos_object_key_key" ON "customer_profile_photos"("object_key");
CREATE INDEX "customer_profile_photos_customer_user_id_status_confirmed_a_idx" ON "customer_profile_photos"("customer_user_id", "status", "confirmed_at");
CREATE INDEX "customer_profile_photos_status_created_at_idx" ON "customer_profile_photos"("status", "created_at");

ALTER TABLE "customer_profile_photos" ADD CONSTRAINT "customer_profile_photos_customer_user_id_fkey" FOREIGN KEY ("customer_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
