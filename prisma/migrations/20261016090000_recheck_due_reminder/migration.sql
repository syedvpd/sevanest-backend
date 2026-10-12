-- Additive: remembers the due date a re-check reminder was sent for, so the scheduler is idempotent.
-- Rollback: drop the column (no application data depends on it besides the reminder loop).
ALTER TABLE "worker_verification_checks" ADD COLUMN "recheck_notified_for" DATE;
