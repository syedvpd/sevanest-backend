-- CreateTable
CREATE TABLE "category_engagements" (
    "category_id" UUID NOT NULL,
    "engagement" "EngagementPreference" NOT NULL,

    CONSTRAINT "category_engagements_pkey" PRIMARY KEY ("category_id","engagement")
);

-- AddForeignKey
ALTER TABLE "category_engagements" ADD CONSTRAINT "category_engagements_category_id_fkey" FOREIGN KEY ("category_id") REFERENCES "service_categories"("id") ON DELETE CASCADE ON UPDATE CASCADE;
