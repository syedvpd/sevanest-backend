-- Optional map centre + radius per service area (admin-managed) so coordinates can be resolved to an area. Additive.
ALTER TABLE "service_areas"
  ADD COLUMN "center_latitude" DOUBLE PRECISION,
  ADD COLUMN "center_longitude" DOUBLE PRECISION,
  ADD COLUMN "radius_meters" INTEGER;

ALTER TABLE "service_areas" ADD CONSTRAINT "service_areas_geo_chk" CHECK (
  ("center_latitude" IS NULL AND "center_longitude" IS NULL AND "radius_meters" IS NULL)
  OR ("center_latitude" BETWEEN -90 AND 90 AND "center_longitude" BETWEEN -180 AND 180 AND "radius_meters" BETWEEN 100 AND 100000)
);
