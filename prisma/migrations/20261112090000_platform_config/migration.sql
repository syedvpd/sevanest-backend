-- Additive: two new tables, no existing table is touched. Reverse by dropping them (they hold only admin-entered configuration).
-- CreateTable
CREATE TABLE "app_settings" (
    "key" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "updated_by_user_id" UUID,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "app_settings_pkey" PRIMARY KEY ("key")
);

-- CreateTable
CREATE TABLE "rating_tags" (
    "code" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "sentiment" TEXT NOT NULL,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "rating_tags_pkey" PRIMARY KEY ("code"),
    CONSTRAINT "rating_tags_sentiment_check" CHECK ("sentiment" IN ('POSITIVE', 'NEGATIVE'))
);

-- Keeps the catalogue the apps already receive (customer-app request, D-88; wording awaits client confirmation, Q-121) as ordinary
-- rows. From now on staff edit, reorder or retire them through /admin/rating-tags; re-running never overwrites a staff change.
INSERT INTO "rating_tags" ("code", "label", "sentiment", "sort_order", "updated_at") VALUES
    ('PUNCTUAL', 'Punctual', 'POSITIVE', 10, CURRENT_TIMESTAMP),
    ('POLITE', 'Polite', 'POSITIVE', 20, CURRENT_TIMESTAMP),
    ('SKILLED', 'Skilled', 'POSITIVE', 30, CURRENT_TIMESTAMP),
    ('CLEAN_WORK', 'Clean work', 'POSITIVE', 40, CURRENT_TIMESTAMP),
    ('TRUSTWORTHY', 'Trustworthy', 'POSITIVE', 50, CURRENT_TIMESTAMP),
    ('LATE', 'Late', 'NEGATIVE', 60, CURRENT_TIMESTAMP),
    ('RUDE', 'Rude', 'NEGATIVE', 70, CURRENT_TIMESTAMP),
    ('POOR_QUALITY_WORK', 'Poor quality work', 'NEGATIVE', 80, CURRENT_TIMESTAMP),
    ('UNRELIABLE', 'Unreliable', 'NEGATIVE', 90, CURRENT_TIMESTAMP)
ON CONFLICT ("code") DO NOTHING;
