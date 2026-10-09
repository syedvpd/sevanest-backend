
-- CreateEnum
CREATE TYPE "VerificationCheckType" AS ENUM ('IDENTITY', 'ADDRESS', 'EMERGENCY_CONTACT', 'PREVIOUS_EMPLOYMENT', 'POLICE_VERIFICATION');

-- CreateEnum
CREATE TYPE "VerificationCheckStatus" AS ENUM ('NOT_SUBMITTED', 'SUBMITTED', 'IN_REVIEW', 'APPROVED', 'REJECTED');

-- CreateEnum
CREATE TYPE "VerificationDocumentStatus" AS ENUM ('PENDING_UPLOAD', 'UPLOADED');

-- CreateTable
CREATE TABLE "verification_requirements" (
    "check_type" "VerificationCheckType" NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "verification_requirements_pkey" PRIMARY KEY ("check_type")
);

-- CreateTable
CREATE TABLE "worker_verification_checks" (
    "id" UUID NOT NULL,
    "worker_id" UUID NOT NULL,
    "check_type" "VerificationCheckType" NOT NULL,
    "status" "VerificationCheckStatus" NOT NULL DEFAULT 'NOT_SUBMITTED',
    "submitted_at" TIMESTAMPTZ(6),
    "reviewed_at" TIMESTAMPTZ(6),
    "reviewer_user_id" UUID,
    "remarks" TEXT,
    "recheck_at" DATE,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "worker_verification_checks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "worker_verification_events" (
    "id" UUID NOT NULL,
    "check_id" UUID NOT NULL,
    "from_status" "VerificationCheckStatus",
    "to_status" "VerificationCheckStatus" NOT NULL,
    "actor_user_id" UUID NOT NULL,
    "remarks" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "worker_verification_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "verification_documents" (
    "id" UUID NOT NULL,
    "check_id" UUID NOT NULL,
    "object_key" TEXT NOT NULL,
    "content_type" TEXT NOT NULL,
    "size_bytes" INTEGER NOT NULL,
    "status" "VerificationDocumentStatus" NOT NULL DEFAULT 'PENDING_UPLOAD',
    "uploaded_at" TIMESTAMPTZ(6),
    "submitted_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "verification_documents_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "worker_verification_checks_status_submitted_at_idx" ON "worker_verification_checks"("status", "submitted_at");

-- CreateIndex
CREATE UNIQUE INDEX "worker_verification_checks_worker_id_check_type_key" ON "worker_verification_checks"("worker_id", "check_type");

-- CreateIndex
CREATE INDEX "worker_verification_events_check_id_created_at_idx" ON "worker_verification_events"("check_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "verification_documents_object_key_key" ON "verification_documents"("object_key");

-- CreateIndex
CREATE INDEX "verification_documents_check_id_created_at_idx" ON "verification_documents"("check_id", "created_at");

-- AddForeignKey
ALTER TABLE "worker_verification_checks" ADD CONSTRAINT "worker_verification_checks_worker_id_fkey" FOREIGN KEY ("worker_id") REFERENCES "worker_profiles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "worker_verification_checks" ADD CONSTRAINT "worker_verification_checks_reviewer_user_id_fkey" FOREIGN KEY ("reviewer_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "worker_verification_events" ADD CONSTRAINT "worker_verification_events_check_id_fkey" FOREIGN KEY ("check_id") REFERENCES "worker_verification_checks"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "worker_verification_events" ADD CONSTRAINT "worker_verification_events_actor_user_id_fkey" FOREIGN KEY ("actor_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "verification_documents" ADD CONSTRAINT "verification_documents_check_id_fkey" FOREIGN KEY ("check_id") REFERENCES "worker_verification_checks"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- Hand-written invariants (Prisma cannot express these).

-- A reviewed check names its reviewer and time; a rejection carries remarks; recheck_at only belongs to an approval;
-- anything past NOT_SUBMITTED has a submission time.
ALTER TABLE "worker_verification_checks" ADD CONSTRAINT "worker_verification_checks_reviewed_chk" CHECK (
  "status" NOT IN ('APPROVED', 'REJECTED') OR ("reviewed_at" IS NOT NULL AND "reviewer_user_id" IS NOT NULL)
);
ALTER TABLE "worker_verification_checks" ADD CONSTRAINT "worker_verification_checks_rejected_remarks_chk" CHECK (
  "status" <> 'REJECTED' OR ("remarks" IS NOT NULL AND length(btrim("remarks")) > 0)
);
ALTER TABLE "worker_verification_checks" ADD CONSTRAINT "worker_verification_checks_recheck_chk" CHECK (
  "recheck_at" IS NULL OR "status" = 'APPROVED'
);
ALTER TABLE "worker_verification_checks" ADD CONSTRAINT "worker_verification_checks_submitted_chk" CHECK (
  "status" = 'NOT_SUBMITTED' OR "submitted_at" IS NOT NULL
);

ALTER TABLE "verification_documents" ADD CONSTRAINT "verification_documents_size_chk" CHECK ("size_bytes" > 0);
ALTER TABLE "verification_documents" ADD CONSTRAINT "verification_documents_uploaded_chk" CHECK (
  ("status" = 'UPLOADED') = ("uploaded_at" IS NOT NULL)
);
ALTER TABLE "verification_documents" ADD CONSTRAINT "verification_documents_submitted_chk" CHECK (
  "submitted_at" IS NULL OR "status" = 'UPLOADED'
);

-- The verification history is append-only, like audit_logs: block UPDATE and DELETE at the database level.
CREATE FUNCTION "worker_verification_events_reject_mutation"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'worker_verification_events is append-only: % is not permitted', TG_OP USING ERRCODE = 'restrict_violation';
END;
$$;
CREATE TRIGGER "worker_verification_events_no_update_delete"
BEFORE UPDATE OR DELETE ON "worker_verification_events"
FOR EACH ROW EXECUTE FUNCTION "worker_verification_events_reject_mutation"();

-- Search (read-only module): serves "eligible workers, stable order" without sorting the whole table.
CREATE INDEX "worker_profiles_search_order_idx" ON "worker_profiles" ("experience_months" DESC NULLS LAST, "id")
  WHERE "onboarding_status" = 'SUBMITTED';
CREATE INDEX "worker_profiles_search_submitted_idx" ON "worker_profiles" ("submitted_at", "id")
  WHERE "onboarding_status" = 'SUBMITTED';
