-- D-90 (client decisions Q-123..Q-129): application reference, final sign-off, activation, rejection codes, notes,
-- document details, claim activity. Additive; workers that are fully verified today are backfilled as signed off and
-- activated so search and matching behave exactly as before.

CREATE TYPE "VerificationRejectionCode" AS ENUM (
  'BLURRY_IMAGE', 'DOCUMENT_EXPIRED', 'NAME_MISMATCH', 'INCOMPLETE_DOCUMENT', 'INVALID_DOCUMENT_TYPE',
  'SUSPECTED_TAMPERING', 'UNVERIFIABLE_REFERENCE', 'CRIMINAL_RECORD_DISQUALIFIED', 'OTHER'
);
CREATE TYPE "VerificationNoteKind" AS ENUM ('CALL', 'REVIEW');

ALTER TABLE "worker_verification_checks"
  ADD COLUMN "last_activity_at" TIMESTAMPTZ(6),
  ADD COLUMN "rejection_code" "VerificationRejectionCode",
  ADD COLUMN "masked_document_number" TEXT,
  ADD COLUMN "document_expires_on" DATE;
ALTER TABLE "worker_verification_checks" ADD CONSTRAINT "worker_verification_checks_rejection_code_chk" CHECK (
  "rejection_code" IS NULL OR "status" = 'REJECTED'
);
CREATE INDEX "worker_verification_checks_reviewer_user_id_status_idx" ON "worker_verification_checks"("reviewer_user_id", "status");

CREATE TABLE "worker_verification_notes" (
  "id" UUID NOT NULL,
  "check_id" UUID NOT NULL,
  "kind" "VerificationNoteKind" NOT NULL,
  "body" TEXT NOT NULL,
  "author_user_id" UUID NOT NULL,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "worker_verification_notes_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "worker_verification_notes_body_chk" CHECK (length(btrim("body")) > 0)
);
CREATE INDEX "worker_verification_notes_check_id_created_at_idx" ON "worker_verification_notes"("check_id", "created_at");
ALTER TABLE "worker_verification_notes" ADD CONSTRAINT "worker_verification_notes_check_id_fkey" FOREIGN KEY ("check_id") REFERENCES "worker_verification_checks"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "worker_verification_notes" ADD CONSTRAINT "worker_verification_notes_author_user_id_fkey" FOREIGN KEY ("author_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "worker_profiles"
  ADD COLUMN "application_reference" TEXT,
  ADD COLUMN "verification_signed_off_at" TIMESTAMPTZ(6),
  ADD COLUMN "verification_signed_off_by_user_id" UUID,
  ADD COLUMN "activated_at" TIMESTAMPTZ(6),
  ADD COLUMN "activated_by_user_id" UUID;
CREATE UNIQUE INDEX "worker_profiles_application_reference_key" ON "worker_profiles"("application_reference");
ALTER TABLE "worker_profiles" ADD CONSTRAINT "worker_profiles_verification_signed_off_by_user_id_fkey" FOREIGN KEY ("verification_signed_off_by_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "worker_profiles" ADD CONSTRAINT "worker_profiles_activated_by_user_id_fkey" FOREIGN KEY ("activated_by_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
-- Activation needs the final sign-off first.
ALTER TABLE "worker_profiles" ADD CONSTRAINT "worker_profiles_activated_needs_signoff_chk" CHECK (
  "activated_at" IS NULL OR "verification_signed_off_at" IS NOT NULL
);

-- SEVA + 8 digits, stamped by the server at submission (never reused; gaps are fine).
CREATE SEQUENCE "worker_application_reference_seq" START 1;
UPDATE "worker_profiles" wp
SET "application_reference" = 'SEVA' || lpad(nextval('worker_application_reference_seq')::text, 8, '0')
FROM (SELECT id FROM "worker_profiles" WHERE "onboarding_status" = 'SUBMITTED' ORDER BY "submitted_at", id) o
WHERE wp.id = o.id;

-- Workers that are fully verified today keep working exactly as before: signed off and activated at migration time
-- (no actor recorded). New workers need the explicit sign-off and activation steps.
UPDATE "worker_profiles" wp
SET "verification_signed_off_at" = now(), "activated_at" = now()
WHERE wp."onboarding_status" = 'SUBMITTED'
  AND EXISTS (SELECT 1 FROM "verification_requirements")
  AND NOT EXISTS (
    SELECT 1 FROM "verification_requirements" vr
    WHERE NOT EXISTS (
      SELECT 1 FROM "worker_verification_checks" vc
      WHERE vc."worker_id" = wp.id AND vc."check_type" = vr."check_type" AND vc."status" = 'APPROVED'
        AND (vc."recheck_at" IS NULL OR vc."recheck_at" > (now() AT TIME ZONE 'Asia/Kolkata')::date)
    )
  );

-- New permissions (the seed upserts the same codes) and their starting holders among existing roles.
INSERT INTO "permissions" ("id", "code", "description") VALUES
  (gen_random_uuid(), 'verification.signoff', 'Give the final verification sign-off for a worker once all required checks are approved'),
  (gen_random_uuid(), 'verification.reassign', 'Release or reassign a verification check claimed by another reviewer'),
  (gen_random_uuid(), 'worker.activate', 'Activate a signed-off worker so they appear in search and matching')
ON CONFLICT ("code") DO NOTHING;
INSERT INTO "role_permissions" ("role_id", "permission_id")
SELECT r."id", p."id" FROM "roles" r CROSS JOIN "permissions" p
WHERE r."code" IN ('SUPER_ADMIN', 'OPERATIONS_ADMIN')
  AND p."code" IN ('verification.signoff', 'verification.reassign', 'worker.activate')
ON CONFLICT DO NOTHING;
