-- DEC-06: worker blacklist columns. Additive and nullable; reverse with a follow-up migration dropping them.
-- AlterTable
ALTER TABLE "worker_profiles" ADD COLUMN     "blacklist_reason" TEXT,
ADD COLUMN     "blacklisted_at" TIMESTAMPTZ(6),
ADD COLUMN     "blacklisted_by_user_id" UUID;

-- AddForeignKey
ALTER TABLE "worker_profiles" ADD CONSTRAINT "worker_profiles_blacklisted_by_user_id_fkey" FOREIGN KEY ("blacklisted_by_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

