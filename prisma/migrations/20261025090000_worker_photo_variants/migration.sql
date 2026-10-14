-- Server-made WebP renditions of a confirmed profile photo (D-69). Additive and nullable: photos confirmed before this
-- change keep serving their original object.
ALTER TABLE "worker_profile_photos" ADD COLUMN "card_object_key" TEXT;
ALTER TABLE "worker_profile_photos" ADD COLUMN "large_object_key" TEXT;
