-- Attendance: two more statuses (D-76) and server-stamped check-in / check-out times (D-77); customer history indexes (D-78).
-- Additive only: existing rows keep their status and get NULL times.
ALTER TYPE "AttendanceStatus" ADD VALUE IF NOT EXISTS 'LATE';
ALTER TYPE "AttendanceStatus" ADD VALUE IF NOT EXISTS 'LEAVE';

ALTER TABLE "attendance_records" ADD COLUMN "check_in_at" TIMESTAMPTZ(6);
ALTER TABLE "attendance_records" ADD COLUMN "check_out_at" TIMESTAMPTZ(6);
ALTER TABLE "attendance_records" ADD CONSTRAINT "attendance_records_times_chk" CHECK (
  "check_out_at" IS NULL OR ("check_in_at" IS NOT NULL AND "check_out_at" >= "check_in_at")
);

CREATE INDEX "bookings_customer_user_id_status_idx" ON "bookings"("customer_user_id", "status");
