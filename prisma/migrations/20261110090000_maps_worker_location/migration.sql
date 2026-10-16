-- DEC-18: approximate worker address location (about 1 km) for distance ordering. Additive and nullable; reverse by dropping the columns.
-- AlterTable
ALTER TABLE "worker_profiles" ADD COLUMN     "address_latitude" DOUBLE PRECISION,
ADD COLUMN     "address_longitude" DOUBLE PRECISION;


ALTER TABLE "worker_profiles" ADD CONSTRAINT "worker_profiles_address_location_chk" CHECK (("address_latitude" IS NULL) = ("address_longitude" IS NULL) AND ("address_latitude" IS NULL OR ("address_latitude" BETWEEN -90 AND 90 AND "address_longitude" BETWEEN -180 AND 180)));
