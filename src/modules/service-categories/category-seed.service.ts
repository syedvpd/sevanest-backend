import { Injectable, Logger } from '@nestjs/common';
import { AuditService } from '../../common/audit/audit.service';
import { isUniqueViolation } from '../../common/errors/prisma-errors';
import type { Engagement } from '../../common/validation/engagements';
import { ServiceCategoriesRepository } from './service-categories.repository';

/**
 * The initial categories defined by the project documents (PRD section 4, FRD 1.6). They are reference DATA: this list is
 * used only by the seed and is never consulted by application logic. Names and descriptions follow the documents.
 */
export const INITIAL_CATEGORIES: ReadonlyArray<{
  code: string;
  name: string;
  description: string;
}> = [
  {
    code: 'HOUSE_MAID',
    name: 'House Maid',
    description: 'Cleaning, utensils, basic household support',
  },
  {
    code: 'DRIVER',
    name: 'Driver',
    description: 'Personal/family driver, temporary driver',
  },
  {
    code: 'COOK',
    name: 'Cook',
    description: 'Breakfast/lunch/dinner preparation',
  },
  {
    code: 'BABYSITTER',
    name: 'Babysitter',
    description: 'Child supervision and basic care',
  },
  {
    code: 'ELDERLY_CARE_HELPER',
    name: 'Elderly Care Helper',
    description: 'Non-clinical assistance and companionship',
  },
  {
    code: 'CLEANING_HELPER',
    name: 'Cleaning Helper',
    description: 'Deep/basic cleaning assistance',
  },
];

/**
 * Engagement types per category from the PRD section 4 table. OPT-IN seed data (never applied by default, never to a category that
 * already has any engagement row), because a category with no rows is unrestricted and switching that on changes what existing
 * environments accept. The PRD's "Monthly" (Driver, Cook) is NOT offered: the platform has no MONTHLY engagement value and the client has
 * not said whether it means a new type or FULL_TIME/PART_TIME billed monthly (Q-93). Values agreed with the customer-app team 2026-10-27.
 */
export const RECOMMENDED_ENGAGEMENTS: Readonly<Record<string, readonly Engagement[]>> = {
  HOUSE_MAID: ['PART_TIME', 'FULL_TIME', 'LIVE_IN'],
  DRIVER: ['HOURLY', 'DAILY'],
  COOK: ['PART_TIME'],
  BABYSITTER: ['HOURLY', 'FULL_TIME'],
  ELDERLY_CARE_HELPER: ['SHIFT', 'FULL_TIME'],
  CLEANING_HELPER: ['ONE_TIME', 'HOURLY'],
};

export interface EngagementSeedReport {
  applied: Array<{ code: string; engagements: string[] }>;
  skippedAlreadyConfigured: string[];
  skippedMissing: string[];
}

@Injectable()
export class CategorySeedService {
  private readonly logger = new Logger(CategorySeedService.name);

  constructor(
    private readonly repository: ServiceCategoriesRepository,
    private readonly audit: AuditService,
  ) {}

  /**
   * Creates any initial category that does not exist yet. Existing rows are NEVER modified, so an admin's renames,
   * descriptions and enable/disable choices survive every re-seed. Returns how many were created.
   */
  async ensureInitialCategories(): Promise<number> {
    let created = 0;
    for (const category of INITIAL_CATEGORIES) {
      if (await this.repository.findByCode(category.code)) {
        continue;
      }
      try {
        await this.repository.create(category);
        created++;
      } catch (error) {
        if (!isUniqueViolation(error)) {
          throw error;
        }
        // The name is already used by another category (an admin renamed things): leave it to the admin.
        this.logger.warn(`Initial category ${category.code} skipped: its name is already in use`);
      }
    }
    return created;
  }

  /**
   * Gives each of the six initial categories its PRD engagement types, but only where the category exists and has NO engagement rows
   * yet (an administrator's choice, including an explicit list, is never overwritten). `dryRun` reports without writing.
   * Safe to repeat: a second run finds every category configured and changes nothing.
   */
  async ensureRecommendedEngagements(dryRun = false): Promise<EngagementSeedReport> {
    const report: EngagementSeedReport = {
      applied: [],
      skippedAlreadyConfigured: [],
      skippedMissing: [],
    };
    for (const [code, engagements] of Object.entries(RECOMMENDED_ENGAGEMENTS)) {
      const category = await this.repository.findByCode(code);
      if (!category) {
        report.skippedMissing.push(code);
        continue;
      }
      if ((await this.repository.engagementsOf([category.id])).has(category.id)) {
        report.skippedAlreadyConfigured.push(code);
        continue;
      }
      const planned = { code, engagements: [...engagements].sort() };
      if (dryRun) {
        report.applied.push(planned);
        continue;
      }
      const wrote = await this.repository.transaction(async (tx) => {
        await this.repository.lockById(category.id, tx);
        // Re-check under the row lock: a concurrent admin edit wins.
        if ((await this.repository.engagementsOf([category.id], tx)).has(category.id)) return false;
        await this.repository.replaceEngagements(category.id, [...engagements].sort(), tx);
        await this.audit.record(
          {
            action: 'service_category.engagements_seeded',
            entityType: 'service_category',
            entityId: category.id,
            actorId: null,
            metadata: { code, to: [...engagements].sort() },
          },
          tx,
        );
        return true;
      });
      if (wrote) report.applied.push(planned);
      else report.skippedAlreadyConfigured.push(code);
    }
    return report;
  }
}
