-- CreateEnum
CREATE TYPE "InterviewStatus" AS ENUM ('REQUESTED', 'CONFIRMED', 'RESCHEDULE_PROPOSED', 'DECLINED', 'CANCELLED', 'COMPLETED');

-- CreateTable
CREATE TABLE "interview_trials" (
    "id" UUID NOT NULL,
    "booking_id" UUID NOT NULL,
    "type" "ScheduleType" NOT NULL,
    "status" "InterviewStatus" NOT NULL DEFAULT 'REQUESTED',
    "requested_by_kind" TEXT NOT NULL,
    "requested_by_user_id" UUID,
    "preferred_at" TIMESTAMPTZ(6) NOT NULL,
    "scheduled_at" TIMESTAMPTZ(6),
    "proposed_at" TIMESTAMPTZ(6),
    "proposed_by_kind" TEXT,
    "note" TEXT,
    "decline_reason" TEXT,
    "cancel_reason" TEXT,
    "outcome_note" TEXT,
    "completed_at" TIMESTAMPTZ(6),
    "cancelled_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "interview_trials_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "interview_trials_booking_id_created_at_idx" ON "interview_trials"("booking_id", "created_at");

-- CreateIndex
CREATE INDEX "interview_trials_status_scheduled_at_idx" ON "interview_trials"("status", "scheduled_at");

-- AddForeignKey
ALTER TABLE "interview_trials" ADD CONSTRAINT "interview_trials_booking_id_fkey" FOREIGN KEY ("booking_id") REFERENCES "bookings"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- At most one open interview/trial per booking (a partial unique index cannot be expressed in the Prisma schema).
CREATE UNIQUE INDEX "interview_trials_one_open_per_booking" ON "interview_trials"("booking_id")
  WHERE "status" IN ('REQUESTED', 'CONFIRMED', 'RESCHEDULE_PROPOSED');

-- Bookings that were scheduled through the booking actions before this table existed get one session row each.
INSERT INTO "interview_trials" ("id", "booking_id", "type", "status", "requested_by_kind", "preferred_at", "scheduled_at", "outcome_note", "completed_at", "cancelled_at", "created_at", "updated_at")
SELECT gen_random_uuid(), b."id", b."schedule_type",
       CASE b."status"::text WHEN 'INTERVIEW_TRIAL_SCHEDULED' THEN 'CONFIRMED' WHEN 'CANCELLED' THEN 'CANCELLED' ELSE 'COMPLETED' END::"InterviewStatus",
       'SYSTEM', b."scheduled_at", b."scheduled_at", b."outcome_note",
       CASE WHEN b."status"::text NOT IN ('INTERVIEW_TRIAL_SCHEDULED', 'CANCELLED') THEN b."updated_at" END,
       CASE WHEN b."status"::text = 'CANCELLED' THEN b."cancelled_at" END,
       b."updated_at", b."updated_at"
FROM "bookings" b
WHERE b."schedule_type" IS NOT NULL AND b."scheduled_at" IS NOT NULL;
