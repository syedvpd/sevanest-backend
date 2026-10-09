-- Workers, Service Categories and Availability. Additive only: new enums/tables, no existing table is altered, no data touched.

-- CreateEnum
CREATE TYPE "WorkerOnboardingStatus" AS ENUM ('DRAFT', 'SUBMITTED');

-- CreateEnum
CREATE TYPE "EngagementPreference" AS ENUM ('FULL_TIME', 'PART_TIME', 'LIVE_IN');

-- CreateTable
CREATE TABLE "service_categories" (
    "id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "is_enabled" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "service_categories_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "service_areas" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "city" TEXT NOT NULL,
    "is_enabled" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "service_areas_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "worker_profiles" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "onboarding_status" "WorkerOnboardingStatus" NOT NULL DEFAULT 'DRAFT',
    "submitted_at" TIMESTAMPTZ(6),
    "experience_months" INTEGER,
    "expected_salary" DECIMAL(12,2),
    "address_line" TEXT,
    "address_area" TEXT,
    "address_city" TEXT,
    "address_pincode" TEXT,
    "emergency_contact_name" TEXT,
    "emergency_contact_mobile" TEXT,
    "previous_employer_name" TEXT,
    "previous_employer_mobile" TEXT,
    "profile_photo_ref" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "worker_profiles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "worker_skills" (
    "worker_id" UUID NOT NULL,
    "category_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "worker_skills_pkey" PRIMARY KEY ("worker_id","category_id")
);

-- CreateTable
CREATE TABLE "worker_languages" (
    "worker_id" UUID NOT NULL,
    "language_code" TEXT NOT NULL,

    CONSTRAINT "worker_languages_pkey" PRIMARY KEY ("worker_id","language_code")
);

-- CreateTable
CREATE TABLE "worker_work_preferences" (
    "worker_id" UUID NOT NULL,
    "engagement_preference" "EngagementPreference" NOT NULL,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "worker_work_preferences_pkey" PRIMARY KEY ("worker_id")
);

-- CreateTable
CREATE TABLE "worker_preferred_areas" (
    "worker_id" UUID NOT NULL,
    "area_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "worker_preferred_areas_pkey" PRIMARY KEY ("worker_id","area_id")
);

-- CreateTable
CREATE TABLE "worker_time_windows" (
    "id" UUID NOT NULL,
    "worker_id" UUID NOT NULL,
    "start_minute" SMALLINT NOT NULL,
    "end_minute" SMALLINT NOT NULL,

    CONSTRAINT "worker_time_windows_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "service_categories_code_key" ON "service_categories"("code");

-- CreateIndex
CREATE UNIQUE INDEX "worker_profiles_user_id_key" ON "worker_profiles"("user_id");

-- CreateIndex
CREATE INDEX "worker_profiles_onboarding_status_created_at_idx" ON "worker_profiles"("onboarding_status", "created_at");

-- CreateIndex
CREATE INDEX "worker_skills_category_id_idx" ON "worker_skills"("category_id");

-- CreateIndex
CREATE INDEX "worker_preferred_areas_area_id_idx" ON "worker_preferred_areas"("area_id");

-- AddForeignKey
ALTER TABLE "worker_profiles" ADD CONSTRAINT "worker_profiles_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "worker_skills" ADD CONSTRAINT "worker_skills_worker_id_fkey" FOREIGN KEY ("worker_id") REFERENCES "worker_profiles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "worker_skills" ADD CONSTRAINT "worker_skills_category_id_fkey" FOREIGN KEY ("category_id") REFERENCES "service_categories"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "worker_languages" ADD CONSTRAINT "worker_languages_worker_id_fkey" FOREIGN KEY ("worker_id") REFERENCES "worker_profiles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "worker_work_preferences" ADD CONSTRAINT "worker_work_preferences_worker_id_fkey" FOREIGN KEY ("worker_id") REFERENCES "worker_profiles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "worker_preferred_areas" ADD CONSTRAINT "worker_preferred_areas_worker_id_fkey" FOREIGN KEY ("worker_id") REFERENCES "worker_profiles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "worker_preferred_areas" ADD CONSTRAINT "worker_preferred_areas_area_id_fkey" FOREIGN KEY ("area_id") REFERENCES "service_areas"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "worker_time_windows" ADD CONSTRAINT "worker_time_windows_worker_id_fkey" FOREIGN KEY ("worker_id") REFERENCES "worker_profiles"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- Invariants Prisma cannot express (hand-written; keep when regenerating).

-- GiST support for "equal uuid AND overlapping range" in a single exclusion constraint (trusted extension).
CREATE EXTENSION IF NOT EXISTS btree_gist;

-- Service categories: stable machine code; names unique ignoring case.
ALTER TABLE "service_categories" ADD CONSTRAINT "service_categories_code_chk" CHECK ("code" ~ '^[A-Z][A-Z0-9_]{1,49}$');
CREATE UNIQUE INDEX "service_categories_name_ci_key" ON "service_categories" (lower("name"));

-- Service areas: unique within the city, ignoring case (FRD FM-16).
CREATE UNIQUE INDEX "service_areas_city_name_ci_key" ON "service_areas" (lower("city"), lower("name"));

-- Worker profile: grouped fields are all-or-none; values are in range; SUBMITTED has a submission time.
ALTER TABLE "worker_profiles" ADD CONSTRAINT "worker_profiles_address_group_chk" CHECK (
  ("address_line" IS NULL) = ("address_area" IS NULL)
  AND ("address_line" IS NULL) = ("address_city" IS NULL)
  AND ("address_line" IS NULL) = ("address_pincode" IS NULL)
);
ALTER TABLE "worker_profiles" ADD CONSTRAINT "worker_profiles_emergency_group_chk" CHECK (
  ("emergency_contact_name" IS NULL) = ("emergency_contact_mobile" IS NULL)
);
ALTER TABLE "worker_profiles" ADD CONSTRAINT "worker_profiles_previous_employer_group_chk" CHECK (
  ("previous_employer_name" IS NULL) = ("previous_employer_mobile" IS NULL)
);
ALTER TABLE "worker_profiles" ADD CONSTRAINT "worker_profiles_experience_chk" CHECK ("experience_months" IS NULL OR "experience_months" >= 0);
ALTER TABLE "worker_profiles" ADD CONSTRAINT "worker_profiles_salary_chk" CHECK ("expected_salary" IS NULL OR "expected_salary" > 0);
ALTER TABLE "worker_profiles" ADD CONSTRAINT "worker_profiles_submitted_chk" CHECK (
  ("onboarding_status" = 'SUBMITTED') = ("submitted_at" IS NOT NULL)
);

ALTER TABLE "worker_languages" ADD CONSTRAINT "worker_languages_code_chk" CHECK ("language_code" ~ '^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$');

-- Time windows: minutes after local midnight, [start, end) within one day, never overlapping for one worker.
ALTER TABLE "worker_time_windows" ADD CONSTRAINT "worker_time_windows_range_chk" CHECK (
  "start_minute" >= 0 AND "end_minute" <= 1440 AND "start_minute" < "end_minute"
);
ALTER TABLE "worker_time_windows" ADD CONSTRAINT "worker_time_windows_no_overlap"
  EXCLUDE USING gist ("worker_id" WITH =, int4range("start_minute"::int, "end_minute"::int) WITH &&);
