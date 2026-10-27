-- Adds the MONTHLY engagement type (PRD section 4: Driver and Cook "Monthly"). Additive: one new enum value, no row changes.
ALTER TYPE "EngagementPreference" ADD VALUE IF NOT EXISTS 'MONTHLY';
