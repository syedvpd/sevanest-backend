-- Admin-managed labels and enablement for the fixed replacement reason codes.
CREATE TABLE "replacement_reason_settings" (
    "code" "ReplacementReason" NOT NULL,
    "label" VARCHAR(60) NOT NULL,
    "is_enabled" BOOLEAN NOT NULL DEFAULT true,
    "updated_by_user_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "replacement_reason_settings_pkey" PRIMARY KEY ("code")
);

INSERT INTO "replacement_reason_settings" ("code", "label") VALUES
    ('WORK_QUALITY', 'Quality of work'),
    ('BEHAVIOUR', 'Behaviour'),
    ('ATTENDANCE', 'Attendance or punctuality'),
    ('MISMATCH', 'Not the right match'),
    ('WORKER_UNAVAILABLE', 'Worker unavailable'),
    ('OTHER', 'Other');

CREATE INDEX "replacement_reason_settings_is_enabled_idx"
    ON "replacement_reason_settings" ("is_enabled");
