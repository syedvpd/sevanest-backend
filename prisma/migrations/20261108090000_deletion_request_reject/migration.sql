-- DEC-08: staff can reject an account deletion request (reason kept). Additive; reverse with a follow-up migration dropping the columns.
-- AlterEnum
ALTER TYPE "DeletionRequestStatus" ADD VALUE 'REJECTED';

-- AlterTable
ALTER TABLE "deletion_requests" ADD COLUMN     "rejected_at" TIMESTAMPTZ(6),
ADD COLUMN     "rejected_by_user_id" UUID,
ADD COLUMN     "rejected_reason" TEXT;

-- AddForeignKey
ALTER TABLE "deletion_requests" ADD CONSTRAINT "deletion_requests_rejected_by_user_id_fkey" FOREIGN KEY ("rejected_by_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

