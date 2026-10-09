import { Injectable, Logger } from '@nestjs/common';
import { isUniqueViolation } from '../../common/errors/prisma-errors';
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

@Injectable()
export class CategorySeedService {
  private readonly logger = new Logger(CategorySeedService.name);

  constructor(private readonly repository: ServiceCategoriesRepository) {}

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
}
