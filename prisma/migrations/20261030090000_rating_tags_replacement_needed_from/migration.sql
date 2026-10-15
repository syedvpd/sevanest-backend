-- Additive only: two new columns with safe defaults. Existing rows are untouched (tags = empty array, needed_from = NULL).
ALTER TABLE "ratings" ADD COLUMN "tags" TEXT[] DEFAULT ARRAY[]::TEXT[];
ALTER TABLE "replacement_requests" ADD COLUMN "needed_from" DATE;
