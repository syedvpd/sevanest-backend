-- Additive only: covering indexes for foreign keys that are joined or filtered by reports, payments and notifications.
-- Safe to deploy online with brief locks on small tables; rollback = DROP INDEX for the five names below (no data change).

-- CreateIndex
CREATE INDEX "bookings_area_id_idx" ON "bookings"("area_id");

-- CreateIndex
CREATE INDEX "bookings_category_id_idx" ON "bookings"("category_id");

-- CreateIndex
CREATE INDEX "payment_events_payment_id_idx" ON "payment_events"("payment_id");

-- CreateIndex
CREATE INDEX "notifications_outbox_event_id_idx" ON "notifications"("outbox_event_id");

-- CreateIndex
CREATE INDEX "notifications_template_id_idx" ON "notifications"("template_id");
