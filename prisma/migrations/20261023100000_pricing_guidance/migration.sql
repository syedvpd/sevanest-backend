-- Admin-entered price guidance for the customer Budget step. Additive.
CREATE TABLE "pricing_guidance" (
  "id" UUID NOT NULL,
  "category_id" UUID NOT NULL,
  "area_id" UUID,
  "engagement" "EngagementPreference" NOT NULL,
  "min_minor" INTEGER NOT NULL,
  "max_minor" INTEGER NOT NULL,
  "period" TEXT NOT NULL,
  "basis" TEXT NOT NULL,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(6) NOT NULL,
  CONSTRAINT "pricing_guidance_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "pricing_guidance" ADD CONSTRAINT "pricing_guidance_category_id_fkey" FOREIGN KEY ("category_id") REFERENCES "service_categories"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "pricing_guidance" ADD CONSTRAINT "pricing_guidance_area_id_fkey" FOREIGN KEY ("area_id") REFERENCES "service_areas"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "pricing_guidance" ADD CONSTRAINT "pricing_guidance_band_chk" CHECK ("min_minor" > 0 AND "max_minor" >= "min_minor");
ALTER TABLE "pricing_guidance" ADD CONSTRAINT "pricing_guidance_period_chk" CHECK ("period" IN ('HOUR', 'DAY', 'MONTH', 'ONE_TIME'));

-- One category-wide row and one row per area for each category + engagement.
CREATE UNIQUE INDEX "pricing_guidance_category_engagement_key" ON "pricing_guidance" ("category_id", "engagement") WHERE "area_id" IS NULL;
CREATE UNIQUE INDEX "pricing_guidance_category_area_engagement_key" ON "pricing_guidance" ("category_id", "area_id", "engagement") WHERE "area_id" IS NOT NULL;
CREATE INDEX "pricing_guidance_area_id_idx" ON "pricing_guidance" ("area_id");
