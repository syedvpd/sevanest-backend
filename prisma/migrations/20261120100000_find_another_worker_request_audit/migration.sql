-- Persist the customer-selected reason and supporting notes for the completed-interview successor workflow.
CREATE TABLE "find_another_worker_requests" (
    "id" UUID NOT NULL,
    "original_booking_id" UUID NOT NULL,
    "successor_booking_id" UUID NOT NULL,
    "requested_by_user_id" UUID NOT NULL,
    "reason_code" "ReplacementReason" NOT NULL,
    "reason" VARCHAR(1000) NOT NULL,
    "notes" VARCHAR(500),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "find_another_worker_requests_pkey" PRIMARY KEY ("id")
);

-- No direct Supabase Data API access: this table is read/written through the authorized NestJS backend only.
ALTER TABLE "find_another_worker_requests" ENABLE ROW LEVEL SECURITY;

CREATE UNIQUE INDEX "find_another_worker_requests_original_booking_id_key"
    ON "find_another_worker_requests"("original_booking_id");
CREATE UNIQUE INDEX "find_another_worker_requests_successor_booking_id_key"
    ON "find_another_worker_requests"("successor_booking_id");
CREATE INDEX "find_another_worker_requests_requested_by_user_id_created_at_idx"
    ON "find_another_worker_requests"("requested_by_user_id", "created_at");

ALTER TABLE "find_another_worker_requests"
    ADD CONSTRAINT "find_another_worker_requests_original_booking_id_fkey"
    FOREIGN KEY ("original_booking_id") REFERENCES "bookings"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "find_another_worker_requests"
    ADD CONSTRAINT "find_another_worker_requests_successor_booking_id_fkey"
    FOREIGN KEY ("successor_booking_id") REFERENCES "bookings"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "find_another_worker_requests"
    ADD CONSTRAINT "find_another_worker_requests_requested_by_user_id_fkey"
    FOREIGN KEY ("requested_by_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
