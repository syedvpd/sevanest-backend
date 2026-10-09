-- CreateEnum
CREATE TYPE "RatingStatus" AS ENUM ('VISIBLE', 'HIDDEN');

-- CreateEnum
CREATE TYPE "TicketStatus" AS ENUM ('OPEN', 'IN_PROGRESS', 'ESCALATED', 'CLOSED');

-- CreateEnum
CREATE TYPE "TicketPriority" AS ENUM ('LOW', 'MEDIUM', 'HIGH');

-- CreateTable
CREATE TABLE "ratings" (
    "id" UUID NOT NULL,
    "booking_id" UUID NOT NULL,
    "customer_user_id" UUID NOT NULL,
    "worker_id" UUID NOT NULL,
    "score" SMALLINT NOT NULL,
    "review_text" TEXT,
    "status" "RatingStatus" NOT NULL DEFAULT 'VISIBLE',
    "moderated_by_user_id" UUID,
    "moderated_at" TIMESTAMPTZ(6),
    "moderation_reason" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "ratings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "worker_rating_summaries" (
    "worker_id" UUID NOT NULL,
    "rating_count" INTEGER NOT NULL DEFAULT 0,
    "rating_sum" INTEGER NOT NULL DEFAULT 0,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "worker_rating_summaries_pkey" PRIMARY KEY ("worker_id")
);

-- CreateTable
CREATE TABLE "support_categories" (
    "id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "is_enabled" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "support_categories_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "support_tickets" (
    "id" UUID NOT NULL,
    "creator_user_id" UUID NOT NULL,
    "creator_kind" "ActorKind" NOT NULL,
    "booking_id" UUID,
    "category_id" UUID NOT NULL,
    "description" TEXT NOT NULL,
    "priority" "TicketPriority",
    "status" "TicketStatus" NOT NULL DEFAULT 'OPEN',
    "assigned_to_user_id" UUID,
    "assigned_at" TIMESTAMPTZ(6),
    "escalated_at" TIMESTAMPTZ(6),
    "resolution" TEXT,
    "closed_at" TIMESTAMPTZ(6),
    "closed_by_user_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "support_tickets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "support_ticket_events" (
    "id" UUID NOT NULL,
    "ticket_id" UUID NOT NULL,
    "type" TEXT NOT NULL,
    "from_status" "TicketStatus",
    "to_status" "TicketStatus",
    "actor_user_id" UUID NOT NULL,
    "internal_note" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "support_ticket_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ratings_booking_id_key" ON "ratings"("booking_id");

-- CreateIndex
CREATE INDEX "ratings_worker_id_status_created_at_idx" ON "ratings"("worker_id", "status", "created_at");

-- CreateIndex
CREATE INDEX "ratings_customer_user_id_created_at_idx" ON "ratings"("customer_user_id", "created_at");

-- CreateIndex
CREATE INDEX "ratings_status_created_at_idx" ON "ratings"("status", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "support_categories_code_key" ON "support_categories"("code");

-- CreateIndex
CREATE INDEX "support_tickets_creator_user_id_created_at_idx" ON "support_tickets"("creator_user_id", "created_at");

-- CreateIndex
CREATE INDEX "support_tickets_status_created_at_idx" ON "support_tickets"("status", "created_at");

-- CreateIndex
CREATE INDEX "support_tickets_assigned_to_user_id_status_idx" ON "support_tickets"("assigned_to_user_id", "status");

-- CreateIndex
CREATE INDEX "support_tickets_booking_id_idx" ON "support_tickets"("booking_id");

-- CreateIndex
CREATE INDEX "support_tickets_category_id_created_at_idx" ON "support_tickets"("category_id", "created_at");

-- CreateIndex
CREATE INDEX "support_ticket_events_ticket_id_created_at_idx" ON "support_ticket_events"("ticket_id", "created_at");

-- AddForeignKey
ALTER TABLE "ratings" ADD CONSTRAINT "ratings_booking_id_fkey" FOREIGN KEY ("booking_id") REFERENCES "bookings"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ratings" ADD CONSTRAINT "ratings_customer_user_id_fkey" FOREIGN KEY ("customer_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ratings" ADD CONSTRAINT "ratings_worker_id_fkey" FOREIGN KEY ("worker_id") REFERENCES "worker_profiles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ratings" ADD CONSTRAINT "ratings_moderated_by_user_id_fkey" FOREIGN KEY ("moderated_by_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "worker_rating_summaries" ADD CONSTRAINT "worker_rating_summaries_worker_id_fkey" FOREIGN KEY ("worker_id") REFERENCES "worker_profiles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "support_tickets" ADD CONSTRAINT "support_tickets_creator_user_id_fkey" FOREIGN KEY ("creator_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "support_tickets" ADD CONSTRAINT "support_tickets_assigned_to_user_id_fkey" FOREIGN KEY ("assigned_to_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "support_tickets" ADD CONSTRAINT "support_tickets_closed_by_user_id_fkey" FOREIGN KEY ("closed_by_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "support_tickets" ADD CONSTRAINT "support_tickets_booking_id_fkey" FOREIGN KEY ("booking_id") REFERENCES "bookings"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "support_tickets" ADD CONSTRAINT "support_tickets_category_id_fkey" FOREIGN KEY ("category_id") REFERENCES "support_categories"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "support_ticket_events" ADD CONSTRAINT "support_ticket_events_ticket_id_fkey" FOREIGN KEY ("ticket_id") REFERENCES "support_tickets"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "support_ticket_events" ADD CONSTRAINT "support_ticket_events_actor_user_id_fkey" FOREIGN KEY ("actor_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- Integrity rules that Prisma cannot express.
ALTER TABLE "ratings" ADD CONSTRAINT "ratings_score_positive" CHECK ("score" >= 1);
ALTER TABLE "ratings" ADD CONSTRAINT "ratings_review_not_blank" CHECK ("review_text" IS NULL OR length(btrim("review_text")) > 0);
ALTER TABLE "ratings" ADD CONSTRAINT "ratings_moderation_consistent" CHECK (
  ("status" = 'VISIBLE') OR ("moderated_by_user_id" IS NOT NULL AND "moderated_at" IS NOT NULL AND "moderation_reason" IS NOT NULL)
);
ALTER TABLE "worker_rating_summaries" ADD CONSTRAINT "worker_rating_summaries_non_negative" CHECK ("rating_count" >= 0 AND "rating_sum" >= 0);

ALTER TABLE "support_tickets" ADD CONSTRAINT "support_tickets_creator_kind" CHECK ("creator_kind" IN ('CUSTOMER', 'WORKER'));
ALTER TABLE "support_tickets" ADD CONSTRAINT "support_tickets_description_not_blank" CHECK (length(btrim("description")) > 0);
-- A ticket is CLOSED if and only if a resolution and a close time are recorded ("Resolution: yes on close").
ALTER TABLE "support_tickets" ADD CONSTRAINT "support_tickets_closed_consistent" CHECK (
  ("status" = 'CLOSED' AND "resolution" IS NOT NULL AND length(btrim("resolution")) > 0 AND "closed_at" IS NOT NULL AND "closed_by_user_id" IS NOT NULL)
  OR ("status" <> 'CLOSED' AND "resolution" IS NULL AND "closed_at" IS NULL AND "closed_by_user_id" IS NULL)
);
ALTER TABLE "support_tickets" ADD CONSTRAINT "support_tickets_assignee_consistent" CHECK (
  ("assigned_to_user_id" IS NULL) = ("assigned_at" IS NULL)
);

-- Ticket history is append-only (function created by the Booking migration).
CREATE TRIGGER "support_ticket_events_no_update_delete" BEFORE UPDATE OR DELETE ON "support_ticket_events"
FOR EACH ROW EXECUTE FUNCTION "append_only_reject_mutation"();
