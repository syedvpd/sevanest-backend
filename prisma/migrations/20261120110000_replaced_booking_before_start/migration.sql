-- Only the approved completed-interview Find Another Worker transition may close a booking before service start.
ALTER TABLE "bookings"
    ADD COLUMN "replacement_before_start" BOOLEAN NOT NULL DEFAULT FALSE;

ALTER TABLE "bookings"
    DROP CONSTRAINT "bookings_start_date_chk";

ALTER TABLE "bookings"
    ADD CONSTRAINT "bookings_start_date_chk" CHECK (
        "status" NOT IN ('PENDING_PAYMENT', 'CONFIRMED', 'ACTIVE', 'REPLACEMENT_REQUESTED', 'REPLACED', 'COMPLETED')
        OR "start_date" IS NOT NULL
        OR ("status" = 'REPLACED' AND "replacement_before_start")
    );

ALTER TABLE "bookings"
    ADD CONSTRAINT "bookings_replacement_before_start_chk" CHECK (
        NOT "replacement_before_start" OR "status" = 'REPLACED'
    );
