-- DEC-17: e-mail notification channel and the per-user e-mail preference. Additive (enum value + defaulted column); reverse by dropping the column in a follow-up migration.
-- AlterEnum
ALTER TYPE "NotificationChannel" ADD VALUE 'EMAIL';

-- AlterTable
ALTER TABLE "users" ADD COLUMN     "email_notifications" BOOLEAN NOT NULL DEFAULT true;

