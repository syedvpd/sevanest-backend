-- D-91: optional public image per service category (additive).
ALTER TABLE "service_categories" ADD COLUMN "image_key" TEXT;
