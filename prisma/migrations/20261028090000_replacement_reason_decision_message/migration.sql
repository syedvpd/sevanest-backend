-- Q-107: fixed replacement reason codes. Q-110: customer-facing decision message, separate from internal staff remarks.
-- Additive: existing rows get reason_code OTHER and no decision message (old remarks stay internal).
CREATE TYPE "ReplacementReason" AS ENUM ('WORK_QUALITY', 'BEHAVIOUR', 'ATTENDANCE', 'MISMATCH', 'WORKER_UNAVAILABLE', 'OTHER');
ALTER TABLE "replacement_requests" ADD COLUMN "reason_code" "ReplacementReason" NOT NULL DEFAULT 'OTHER';
ALTER TABLE "replacement_requests" ADD COLUMN "decision_message" TEXT;
ALTER TABLE "replacement_requests" ADD CONSTRAINT "replacement_requests_decision_message_chk"
  CHECK ("decision_message" IS NULL OR char_length("decision_message") BETWEEN 1 AND 1000);
