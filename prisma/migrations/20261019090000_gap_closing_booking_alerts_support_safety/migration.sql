-- CreateEnum
CREATE TYPE "AdminAlertSeverity" AS ENUM ('INFO', 'WARNING', 'CRITICAL');

-- CreateEnum
CREATE TYPE "AdminAlertStatus" AS ENUM ('OPEN', 'ACKNOWLEDGED', 'RESOLVED');

-- CreateEnum
CREATE TYPE "DeletionRequestStatus" AS ENUM ('REQUESTED', 'CANCELLED', 'COMPLETED');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "EngagementPreference" ADD VALUE 'DAILY';
ALTER TYPE "EngagementPreference" ADD VALUE 'HOURLY';
ALTER TYPE "EngagementPreference" ADD VALUE 'SHIFT';
ALTER TYPE "EngagementPreference" ADD VALUE 'ONE_TIME';

-- AlterEnum
ALTER TYPE "NotificationChannel" ADD VALUE 'IN_APP';

-- AlterTable
ALTER TABLE "bookings" ADD COLUMN     "address_id" UUID,
ADD COLUMN     "budget_max_minor" INTEGER,
ADD COLUMN     "budget_min_minor" INTEGER,
ADD COLUMN     "budget_period" TEXT,
ADD COLUMN     "requested_start_date" DATE,
ADD COLUMN     "requirement_note" TEXT,
ADD COLUMN     "respond_by" TIMESTAMPTZ(6),
ADD COLUMN     "worker_responded_at" TIMESTAMPTZ(6);

-- AlterTable
ALTER TABLE "notification_templates" ADD COLUMN     "dlt_template_id" TEXT;

-- AlterTable
ALTER TABLE "notifications" ADD COLUMN     "read_at" TIMESTAMPTZ(6);

-- AlterTable
ALTER TABLE "support_tickets" ADD COLUMN     "due_at" TIMESTAMPTZ(6),
ADD COLUMN     "sla_breached_at" TIMESTAMPTZ(6);

-- AlterTable
ALTER TABLE "worker_profiles" ADD COLUMN     "preferred_language" TEXT;

-- CreateTable
CREATE TABLE "support_messages" (
    "id" UUID NOT NULL,
    "ticket_id" UUID NOT NULL,
    "author_user_id" UUID NOT NULL,
    "author_kind" "ActorKind" NOT NULL,
    "body" TEXT NOT NULL,
    "is_internal" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "support_messages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "admin_alerts" (
    "id" UUID NOT NULL,
    "dedupe_key" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "severity" "AdminAlertSeverity" NOT NULL,
    "status" "AdminAlertStatus" NOT NULL DEFAULT 'OPEN',
    "required_permission" TEXT,
    "entity_type" TEXT,
    "entity_id" TEXT,
    "title" TEXT NOT NULL,
    "detail" JSONB,
    "occurrences" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_seen_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "acknowledged_at" TIMESTAMPTZ(6),
    "acknowledged_by" UUID,
    "resolved_at" TIMESTAMPTZ(6),
    "resolved_by" UUID,
    "resolution_note" TEXT,

    CONSTRAINT "admin_alerts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "user_blocks" (
    "id" UUID NOT NULL,
    "blocker_user_id" UUID NOT NULL,
    "blocked_user_id" UUID NOT NULL,
    "reason" TEXT,
    "created_by_admin" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "user_blocks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "safety_reports" (
    "id" UUID NOT NULL,
    "reporter_user_id" UUID NOT NULL,
    "target_user_id" UUID NOT NULL,
    "booking_id" UUID,
    "reason_code" TEXT NOT NULL,
    "note" TEXT,
    "ticket_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "safety_reports_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "legal_acceptances" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "document_type" TEXT NOT NULL,
    "version" TEXT NOT NULL,
    "accepted_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "legal_acceptances_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "deletion_requests" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "status" "DeletionRequestStatus" NOT NULL DEFAULT 'REQUESTED',
    "reason" TEXT,
    "requested_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "cancelled_at" TIMESTAMPTZ(6),
    "completed_at" TIMESTAMPTZ(6),

    CONSTRAINT "deletion_requests_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "support_messages_ticket_id_created_at_idx" ON "support_messages"("ticket_id", "created_at");

-- CreateIndex
CREATE INDEX "support_messages_author_user_id_idx" ON "support_messages"("author_user_id");

-- CreateIndex
CREATE UNIQUE INDEX "admin_alerts_dedupe_key_key" ON "admin_alerts"("dedupe_key");

-- CreateIndex
CREATE INDEX "admin_alerts_status_severity_created_at_idx" ON "admin_alerts"("status", "severity", "created_at");

-- CreateIndex
CREATE INDEX "admin_alerts_entity_type_entity_id_idx" ON "admin_alerts"("entity_type", "entity_id");

-- CreateIndex
CREATE INDEX "admin_alerts_acknowledged_by_idx" ON "admin_alerts"("acknowledged_by");

-- CreateIndex
CREATE INDEX "admin_alerts_resolved_by_idx" ON "admin_alerts"("resolved_by");

-- CreateIndex
CREATE INDEX "user_blocks_blocked_user_id_idx" ON "user_blocks"("blocked_user_id");

-- CreateIndex
CREATE UNIQUE INDEX "user_blocks_blocker_user_id_blocked_user_id_key" ON "user_blocks"("blocker_user_id", "blocked_user_id");

-- CreateIndex
CREATE INDEX "safety_reports_reporter_user_id_created_at_idx" ON "safety_reports"("reporter_user_id", "created_at");

-- CreateIndex
CREATE INDEX "safety_reports_target_user_id_created_at_idx" ON "safety_reports"("target_user_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "legal_acceptances_user_id_document_type_version_key" ON "legal_acceptances"("user_id", "document_type", "version");

-- CreateIndex
CREATE INDEX "deletion_requests_user_id_requested_at_idx" ON "deletion_requests"("user_id", "requested_at");

-- CreateIndex
CREATE INDEX "deletion_requests_status_requested_at_idx" ON "deletion_requests"("status", "requested_at");

-- CreateIndex
CREATE INDEX "bookings_address_id_idx" ON "bookings"("address_id");

-- CreateIndex
CREATE INDEX "notifications_recipient_user_id_channel_read_at_idx" ON "notifications"("recipient_user_id", "channel", "read_at");

-- CreateIndex
CREATE INDEX "support_tickets_due_at_idx" ON "support_tickets"("due_at");

-- AddForeignKey
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_address_id_fkey" FOREIGN KEY ("address_id") REFERENCES "customer_addresses"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "support_messages" ADD CONSTRAINT "support_messages_ticket_id_fkey" FOREIGN KEY ("ticket_id") REFERENCES "support_tickets"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "support_messages" ADD CONSTRAINT "support_messages_author_user_id_fkey" FOREIGN KEY ("author_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "admin_alerts" ADD CONSTRAINT "admin_alerts_acknowledged_by_fkey" FOREIGN KEY ("acknowledged_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "admin_alerts" ADD CONSTRAINT "admin_alerts_resolved_by_fkey" FOREIGN KEY ("resolved_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_blocks" ADD CONSTRAINT "user_blocks_blocker_user_id_fkey" FOREIGN KEY ("blocker_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_blocks" ADD CONSTRAINT "user_blocks_blocked_user_id_fkey" FOREIGN KEY ("blocked_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "safety_reports" ADD CONSTRAINT "safety_reports_reporter_user_id_fkey" FOREIGN KEY ("reporter_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "safety_reports" ADD CONSTRAINT "safety_reports_target_user_id_fkey" FOREIGN KEY ("target_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "legal_acceptances" ADD CONSTRAINT "legal_acceptances_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "deletion_requests" ADD CONSTRAINT "deletion_requests_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- Data integrity for the new columns and tables.
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_budget_chk" CHECK (
  ("budget_min_minor" IS NULL OR "budget_min_minor" >= 0)
  AND ("budget_max_minor" IS NULL OR "budget_max_minor" >= 0)
  AND ("budget_min_minor" IS NULL OR "budget_max_minor" IS NULL OR "budget_min_minor" <= "budget_max_minor")
  AND ("budget_period" IS NULL OR "budget_period" IN ('HOUR', 'DAY', 'MONTH', 'ONE_TIME'))
);
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_note_chk" CHECK ("requirement_note" IS NULL OR char_length("requirement_note") <= 500);
ALTER TABLE "user_blocks" ADD CONSTRAINT "user_blocks_not_self_chk" CHECK ("blocker_user_id" <> "blocked_user_id");
ALTER TABLE "safety_reports" ADD CONSTRAINT "safety_reports_not_self_chk" CHECK ("reporter_user_id" <> "target_user_id");
ALTER TABLE "support_messages" ADD CONSTRAINT "support_messages_body_chk" CHECK (char_length(btrim("body")) > 0);
ALTER TABLE "admin_alerts" ADD CONSTRAINT "admin_alerts_resolved_chk" CHECK ("status" <> 'RESOLVED' OR "resolved_at" IS NOT NULL);
CREATE INDEX "admin_alerts_open_idx" ON "admin_alerts" ("severity", "created_at") WHERE "status" <> 'RESOLVED';
-- Job queries: opportunities waiting for a worker, unpaid bookings, tickets with a target.
CREATE INDEX "bookings_respond_by_idx" ON "bookings" ("respond_by") WHERE "status" = 'MATCHED' AND "worker_responded_at" IS NULL;
CREATE INDEX "support_tickets_open_due_idx" ON "support_tickets" ("due_at") WHERE "status" <> 'CLOSED' AND "sla_breached_at" IS NULL AND "due_at" IS NOT NULL;
-- Support messages are history: no edits or deletes.
CREATE OR REPLACE FUNCTION support_messages_immutable() RETURNS trigger AS $$
BEGIN RAISE EXCEPTION 'support_messages is append-only'; END; $$ LANGUAGE plpgsql;
CREATE TRIGGER support_messages_no_change BEFORE UPDATE OR DELETE ON "support_messages"
  FOR EACH ROW EXECUTE FUNCTION support_messages_immutable();
