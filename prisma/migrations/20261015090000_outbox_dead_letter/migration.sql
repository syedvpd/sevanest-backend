-- Additive: per-event failure tracking for the outbox, so one poison event can no longer block the events behind it.
-- Rollback: drop the index and the four columns (no business data is stored in them).
ALTER TABLE "outbox_events"
  ADD COLUMN "attempts" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "last_error" TEXT,
  ADD COLUMN "next_attempt_at" TIMESTAMPTZ(6),
  ADD COLUMN "failed_at" TIMESTAMPTZ(6);

-- CreateIndex
CREATE INDEX "outbox_events_processed_at_failed_at_idx" ON "outbox_events"("processed_at", "failed_at");
