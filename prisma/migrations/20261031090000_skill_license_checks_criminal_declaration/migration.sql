-- Skill certificate / licence checks and the worker's criminal self-declaration (worker-app audit, decision D-87). Additive only.
ALTER TYPE "VerificationCheckType" ADD VALUE 'SKILL_CERTIFICATE';
ALTER TYPE "VerificationCheckType" ADD VALUE 'LICENSE';

ALTER TABLE "worker_profiles"
    ADD COLUMN "criminal_record_declared" BOOLEAN,
    ADD COLUMN "criminal_record_details" TEXT,
    ADD COLUMN "criminal_declared_at" TIMESTAMPTZ(6),
    ADD CONSTRAINT "worker_profiles_criminal_declaration_consistent" CHECK (
        ("criminal_record_declared" IS NULL AND "criminal_record_details" IS NULL AND "criminal_declared_at" IS NULL)
        OR ("criminal_record_declared" IS NOT NULL AND "criminal_declared_at" IS NOT NULL
            AND ("criminal_record_declared" OR "criminal_record_details" IS NULL))
    );
