
-- CreateEnum
CREATE TYPE "BookingStatus" AS ENUM ('NEW_REQUEST', 'MATCHED', 'INTERVIEW_TRIAL_SCHEDULED', 'INTERVIEW_TRIAL_COMPLETED', 'PENDING_PAYMENT', 'CONFIRMED', 'ACTIVE', 'REPLACEMENT_REQUESTED', 'REPLACED', 'COMPLETED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "ScheduleType" AS ENUM ('INTERVIEW', 'TRIAL');

-- CreateEnum
CREATE TYPE "PaymentStatus" AS ENUM ('CREATED', 'PENDING', 'SUCCEEDED', 'FAILED', 'REFUND_PENDING', 'REFUNDED', 'REFUND_FAILED');

-- CreateEnum
CREATE TYPE "NotificationChannel" AS ENUM ('PUSH', 'SMS', 'WHATSAPP');

-- CreateEnum
CREATE TYPE "NotificationStatus" AS ENUM ('QUEUED', 'SENT', 'FAILED', 'SKIPPED');

-- CreateEnum
CREATE TYPE "AttendanceStatus" AS ENUM ('PRESENT', 'ABSENT', 'EXCEPTION');

-- CreateEnum
CREATE TYPE "ActorKind" AS ENUM ('WORKER', 'CUSTOMER', 'ADMIN');

-- CreateEnum
CREATE TYPE "ReplacementStatus" AS ENUM ('REQUESTED', 'APPROVED', 'REJECTED', 'CANCELLED', 'COMPLETED');

-- CreateTable
CREATE TABLE "bookings" (
    "id" UUID NOT NULL,
    "customer_user_id" UUID NOT NULL,
    "worker_id" UUID,
    "category_id" UUID NOT NULL,
    "area_id" UUID NOT NULL,
    "engagement" "EngagementPreference" NOT NULL,
    "from_minute" SMALLINT NOT NULL,
    "to_minute" SMALLINT NOT NULL,
    "status" "BookingStatus" NOT NULL DEFAULT 'NEW_REQUEST',
    "schedule_type" "ScheduleType",
    "scheduled_at" TIMESTAMPTZ(6),
    "outcome_note" TEXT,
    "start_date" DATE,
    "cancel_reason" TEXT,
    "cancelled_at" TIMESTAMPTZ(6),
    "cancelled_by_user_id" UUID,
    "replaces_booking_id" UUID,
    "idempotency_key" TEXT,
    "request_hash" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "bookings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "booking_events" (
    "id" UUID NOT NULL,
    "booking_id" UUID NOT NULL,
    "from_status" "BookingStatus",
    "to_status" "BookingStatus" NOT NULL,
    "actor_user_id" UUID,
    "actor_kind" TEXT NOT NULL,
    "note" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "booking_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "fee_configs" (
    "id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "amount_minor" INTEGER NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'INR',
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "fee_configs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payments" (
    "id" UUID NOT NULL,
    "booking_id" UUID NOT NULL,
    "customer_user_id" UUID NOT NULL,
    "fee_code" TEXT NOT NULL,
    "amount_minor" INTEGER NOT NULL,
    "currency" TEXT NOT NULL,
    "status" "PaymentStatus" NOT NULL DEFAULT 'CREATED',
    "provider_order_id" TEXT,
    "provider_payment_id" TEXT,
    "checkout_payload" JSONB,
    "receipt_number" TEXT,
    "paid_at" TIMESTAMPTZ(6),
    "failure_reason" TEXT,
    "refund_reason" TEXT,
    "refund_provider_id" TEXT,
    "refunded_at" TIMESTAMPTZ(6),
    "refunded_by_user_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "payments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payment_events" (
    "id" UUID NOT NULL,
    "provider_event_id" TEXT NOT NULL,
    "payment_id" UUID,
    "outcome" TEXT NOT NULL,
    "applied" BOOLEAN NOT NULL,
    "note" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "payment_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "outbox_events" (
    "id" UUID NOT NULL,
    "topic" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processed_at" TIMESTAMPTZ(6),

    CONSTRAINT "outbox_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "notification_templates" (
    "id" UUID NOT NULL,
    "event_code" TEXT NOT NULL,
    "channel" "NotificationChannel" NOT NULL,
    "language" TEXT NOT NULL DEFAULT 'en',
    "title" TEXT,
    "body" TEXT NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "notification_templates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "notifications" (
    "id" UUID NOT NULL,
    "outbox_event_id" UUID NOT NULL,
    "recipient_user_id" UUID NOT NULL,
    "event_code" TEXT NOT NULL,
    "channel" "NotificationChannel" NOT NULL,
    "template_id" UUID,
    "params" JSONB NOT NULL,
    "status" "NotificationStatus" NOT NULL DEFAULT 'QUEUED',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "last_error" TEXT,
    "provider_message_id" TEXT,
    "sent_at" TIMESTAMPTZ(6),
    "dedupe_key" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "notifications_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "attendance_records" (
    "id" UUID NOT NULL,
    "booking_id" UUID NOT NULL,
    "worker_id" UUID NOT NULL,
    "date" DATE NOT NULL,
    "status" "AttendanceStatus" NOT NULL,
    "note" TEXT,
    "recorded_by_user_id" UUID NOT NULL,
    "recorded_by_kind" "ActorKind" NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "attendance_records_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "attendance_events" (
    "id" UUID NOT NULL,
    "record_id" UUID NOT NULL,
    "from_status" "AttendanceStatus",
    "to_status" "AttendanceStatus" NOT NULL,
    "note" TEXT,
    "reason" TEXT,
    "actor_user_id" UUID NOT NULL,
    "actor_kind" "ActorKind" NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "attendance_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "replacement_requests" (
    "id" UUID NOT NULL,
    "booking_id" UUID NOT NULL,
    "requested_by_user_id" UUID NOT NULL,
    "reason" TEXT NOT NULL,
    "notes" TEXT,
    "status" "ReplacementStatus" NOT NULL DEFAULT 'REQUESTED',
    "decided_by_user_id" UUID,
    "decided_at" TIMESTAMPTZ(6),
    "decision_remarks" TEXT,
    "replacement_booking_id" UUID,
    "completed_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "replacement_requests_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "bookings_replaces_booking_id_key" ON "bookings"("replaces_booking_id");

-- CreateIndex
CREATE INDEX "bookings_customer_user_id_created_at_idx" ON "bookings"("customer_user_id", "created_at");

-- CreateIndex
CREATE INDEX "bookings_worker_id_status_idx" ON "bookings"("worker_id", "status");

-- CreateIndex
CREATE INDEX "bookings_status_created_at_idx" ON "bookings"("status", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "bookings_customer_user_id_idempotency_key_key" ON "bookings"("customer_user_id", "idempotency_key");

-- CreateIndex
CREATE INDEX "booking_events_booking_id_created_at_idx" ON "booking_events"("booking_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "fee_configs_code_key" ON "fee_configs"("code");

-- CreateIndex
CREATE UNIQUE INDEX "payments_provider_order_id_key" ON "payments"("provider_order_id");

-- CreateIndex
CREATE UNIQUE INDEX "payments_provider_payment_id_key" ON "payments"("provider_payment_id");

-- CreateIndex
CREATE UNIQUE INDEX "payments_receipt_number_key" ON "payments"("receipt_number");

-- CreateIndex
CREATE INDEX "payments_customer_user_id_created_at_idx" ON "payments"("customer_user_id", "created_at");

-- CreateIndex
CREATE INDEX "payments_booking_id_idx" ON "payments"("booking_id");

-- CreateIndex
CREATE INDEX "payments_status_created_at_idx" ON "payments"("status", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "payment_events_provider_event_id_key" ON "payment_events"("provider_event_id");

-- CreateIndex
CREATE UNIQUE INDEX "notification_templates_event_code_channel_language_key" ON "notification_templates"("event_code", "channel", "language");

-- CreateIndex
CREATE UNIQUE INDEX "notifications_dedupe_key_key" ON "notifications"("dedupe_key");

-- CreateIndex
CREATE INDEX "notifications_status_created_at_idx" ON "notifications"("status", "created_at");

-- CreateIndex
CREATE INDEX "notifications_recipient_user_id_created_at_idx" ON "notifications"("recipient_user_id", "created_at");

-- CreateIndex
CREATE INDEX "attendance_records_worker_id_date_idx" ON "attendance_records"("worker_id", "date");

-- CreateIndex
CREATE UNIQUE INDEX "attendance_records_booking_id_date_key" ON "attendance_records"("booking_id", "date");

-- CreateIndex
CREATE INDEX "attendance_events_record_id_created_at_idx" ON "attendance_events"("record_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "replacement_requests_replacement_booking_id_key" ON "replacement_requests"("replacement_booking_id");

-- CreateIndex
CREATE INDEX "replacement_requests_booking_id_idx" ON "replacement_requests"("booking_id");

-- CreateIndex
CREATE INDEX "replacement_requests_requested_by_user_id_created_at_idx" ON "replacement_requests"("requested_by_user_id", "created_at");

-- CreateIndex
CREATE INDEX "replacement_requests_status_created_at_idx" ON "replacement_requests"("status", "created_at");

-- AddForeignKey
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_customer_user_id_fkey" FOREIGN KEY ("customer_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_cancelled_by_user_id_fkey" FOREIGN KEY ("cancelled_by_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_worker_id_fkey" FOREIGN KEY ("worker_id") REFERENCES "worker_profiles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_category_id_fkey" FOREIGN KEY ("category_id") REFERENCES "service_categories"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_area_id_fkey" FOREIGN KEY ("area_id") REFERENCES "service_areas"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_replaces_booking_id_fkey" FOREIGN KEY ("replaces_booking_id") REFERENCES "bookings"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "booking_events" ADD CONSTRAINT "booking_events_booking_id_fkey" FOREIGN KEY ("booking_id") REFERENCES "bookings"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "booking_events" ADD CONSTRAINT "booking_events_actor_user_id_fkey" FOREIGN KEY ("actor_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payments" ADD CONSTRAINT "payments_booking_id_fkey" FOREIGN KEY ("booking_id") REFERENCES "bookings"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payments" ADD CONSTRAINT "payments_customer_user_id_fkey" FOREIGN KEY ("customer_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payments" ADD CONSTRAINT "payments_refunded_by_user_id_fkey" FOREIGN KEY ("refunded_by_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment_events" ADD CONSTRAINT "payment_events_payment_id_fkey" FOREIGN KEY ("payment_id") REFERENCES "payments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_outbox_event_id_fkey" FOREIGN KEY ("outbox_event_id") REFERENCES "outbox_events"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_recipient_user_id_fkey" FOREIGN KEY ("recipient_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_template_id_fkey" FOREIGN KEY ("template_id") REFERENCES "notification_templates"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "attendance_records" ADD CONSTRAINT "attendance_records_booking_id_fkey" FOREIGN KEY ("booking_id") REFERENCES "bookings"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "attendance_records" ADD CONSTRAINT "attendance_records_worker_id_fkey" FOREIGN KEY ("worker_id") REFERENCES "worker_profiles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "attendance_records" ADD CONSTRAINT "attendance_records_recorded_by_user_id_fkey" FOREIGN KEY ("recorded_by_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "attendance_events" ADD CONSTRAINT "attendance_events_record_id_fkey" FOREIGN KEY ("record_id") REFERENCES "attendance_records"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "attendance_events" ADD CONSTRAINT "attendance_events_actor_user_id_fkey" FOREIGN KEY ("actor_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "replacement_requests" ADD CONSTRAINT "replacement_requests_booking_id_fkey" FOREIGN KEY ("booking_id") REFERENCES "bookings"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "replacement_requests" ADD CONSTRAINT "replacement_requests_replacement_booking_id_fkey" FOREIGN KEY ("replacement_booking_id") REFERENCES "bookings"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "replacement_requests" ADD CONSTRAINT "replacement_requests_requested_by_user_id_fkey" FOREIGN KEY ("requested_by_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "replacement_requests" ADD CONSTRAINT "replacement_requests_decided_by_user_id_fkey" FOREIGN KEY ("decided_by_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- Hand-written invariants (Prisma cannot express these).

-- Bookings: timings inside one day; the state implies which facts must exist.
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_time_chk" CHECK ("from_minute" >= 0 AND "to_minute" <= 1440 AND "from_minute" < "to_minute");
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_worker_chk" CHECK (
  ("status" IN ('NEW_REQUEST', 'CANCELLED') OR "worker_id" IS NOT NULL)
  AND ("status" <> 'NEW_REQUEST' OR "worker_id" IS NULL)
);
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_schedule_chk" CHECK (
  "status" NOT IN ('INTERVIEW_TRIAL_SCHEDULED', 'INTERVIEW_TRIAL_COMPLETED')
  OR ("scheduled_at" IS NOT NULL AND "schedule_type" IS NOT NULL)
);
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_start_date_chk" CHECK (
  "status" NOT IN ('PENDING_PAYMENT', 'CONFIRMED', 'ACTIVE', 'REPLACEMENT_REQUESTED', 'REPLACED', 'COMPLETED')
  OR "start_date" IS NOT NULL
);
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_cancel_chk" CHECK (
  "status" <> 'CANCELLED'
  OR ("cancel_reason" IS NOT NULL AND length(btrim("cancel_reason")) > 0 AND "cancelled_at" IS NOT NULL)
);
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_no_self_replace_chk" CHECK ("replaces_booking_id" IS NULL OR "replaces_booking_id" <> "id");
-- One live booking per customer, worker and category (duplicate-request protection).
CREATE UNIQUE INDEX "bookings_one_live_per_worker_key" ON "bookings" ("customer_user_id", "worker_id", "category_id")
  WHERE "worker_id" IS NOT NULL AND "status" NOT IN ('CANCELLED', 'COMPLETED', 'REPLACED');
CREATE INDEX "bookings_worker_schedule_idx" ON "bookings" ("worker_id", "scheduled_at") WHERE "worker_id" IS NOT NULL;

-- Booking history is append-only.
CREATE FUNCTION "append_only_reject_mutation"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% is append-only: % is not permitted', TG_TABLE_NAME, TG_OP USING ERRCODE = 'restrict_violation';
END;
$$;
CREATE TRIGGER "booking_events_no_update_delete" BEFORE UPDATE OR DELETE ON "booking_events"
FOR EACH ROW EXECUTE FUNCTION "append_only_reject_mutation"();
CREATE TRIGGER "attendance_events_no_update_delete" BEFORE UPDATE OR DELETE ON "attendance_events"
FOR EACH ROW EXECUTE FUNCTION "append_only_reject_mutation"();

-- Payments: positive amount, a success carries time and receipt, and one money-holding payment per booking.
ALTER TABLE "fee_configs" ADD CONSTRAINT "fee_configs_amount_chk" CHECK ("amount_minor" > 0);
ALTER TABLE "fee_configs" ADD CONSTRAINT "fee_configs_code_chk" CHECK ("code" ~ '^[A-Z][A-Z0-9_]{1,49}$');
ALTER TABLE "payments" ADD CONSTRAINT "payments_amount_chk" CHECK ("amount_minor" > 0);
ALTER TABLE "payments" ADD CONSTRAINT "payments_paid_chk" CHECK (
  "status" NOT IN ('SUCCEEDED', 'REFUND_PENDING', 'REFUNDED', 'REFUND_FAILED')
  OR ("paid_at" IS NOT NULL AND "receipt_number" IS NOT NULL AND "provider_payment_id" IS NOT NULL)
);
ALTER TABLE "payments" ADD CONSTRAINT "payments_refund_chk" CHECK (
  "status" <> 'REFUNDED' OR ("refunded_at" IS NOT NULL AND "refund_reason" IS NOT NULL)
);
CREATE UNIQUE INDEX "payments_one_active_per_booking_key" ON "payments" ("booking_id")
  WHERE "status" IN ('CREATED', 'PENDING', 'SUCCEEDED', 'REFUND_PENDING', 'REFUND_FAILED');

-- Notifications: the outbox is scanned for unprocessed rows only; one template per (event, channel, language).
CREATE INDEX "outbox_events_pending_idx" ON "outbox_events" ("created_at", "id") WHERE "processed_at" IS NULL;
CREATE INDEX "notifications_queued_idx" ON "notifications" ("created_at", "id") WHERE "status" = 'QUEUED';
ALTER TABLE "notification_templates" ADD CONSTRAINT "notification_templates_event_chk" CHECK ("event_code" ~ '^[A-Z][A-Z0-9_]{1,59}$');
ALTER TABLE "notification_templates" ADD CONSTRAINT "notification_templates_body_chk" CHECK (length(btrim("body")) > 0);

-- Attendance: an exception explains itself.
ALTER TABLE "attendance_records" ADD CONSTRAINT "attendance_records_exception_chk" CHECK (
  "status" <> 'EXCEPTION' OR ("note" IS NOT NULL AND length(btrim("note")) > 0)
);

-- Replacement: one open request per booking; a decision names its decider; completion names the new booking.
CREATE UNIQUE INDEX "replacement_requests_one_open_key" ON "replacement_requests" ("booking_id") WHERE "status" IN ('REQUESTED', 'APPROVED');
ALTER TABLE "replacement_requests" ADD CONSTRAINT "replacement_requests_decision_chk" CHECK (
  "status" NOT IN ('APPROVED', 'REJECTED') OR ("decided_by_user_id" IS NOT NULL AND "decided_at" IS NOT NULL)
);
ALTER TABLE "replacement_requests" ADD CONSTRAINT "replacement_requests_completed_chk" CHECK (
  ("status" = 'COMPLETED') = ("replacement_booking_id" IS NOT NULL AND "completed_at" IS NOT NULL)
);
ALTER TABLE "replacement_requests" ADD CONSTRAINT "replacement_requests_rejected_remarks_chk" CHECK (
  "status" <> 'REJECTED' OR ("decision_remarks" IS NOT NULL AND length(btrim("decision_remarks")) > 0)
);
