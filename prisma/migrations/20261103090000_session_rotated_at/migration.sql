-- DEC-14: when the refresh token was last rotated, so a replay within a short grace window from the same device is not treated as theft.
-- Additive and nullable; reverse with a follow-up migration dropping the column.
ALTER TABLE "sessions" ADD COLUMN "rotated_at" TIMESTAMPTZ(6);
