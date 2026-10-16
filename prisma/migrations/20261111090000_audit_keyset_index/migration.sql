-- Keyset paging of the audit viewer. Index only; reverse by dropping it.
-- CreateIndex
CREATE INDEX "audit_logs_created_at_id_desc_idx" ON "audit_logs"("created_at" DESC, "id" DESC);

