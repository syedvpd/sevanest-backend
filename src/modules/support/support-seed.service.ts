import { Injectable, Logger } from '@nestjs/common';
import { SupportRepository } from './support.repository';

/**
 * Initial support categories defined for client customer and worker applications (BUG-CUST-017).
 * Reference data used only by the seed mechanism; admin renames, disable/enable choices are never overwritten.
 */
export const INITIAL_SUPPORT_CATEGORIES: ReadonlyArray<{
  code: string;
  name: string;
}> = [
  { code: 'SAFETY_ISSUE', name: 'Report a Safety Issue' },
  { code: 'BOOKING_ISSUE', name: 'Booking issue' },
  { code: 'PAYMENT_ISSUE', name: 'Payment issue' },
  { code: 'WORKER_CONDUCT', name: 'Worker conduct' },
  { code: 'APP_PROBLEM', name: 'App problem' },
  { code: 'OTHER', name: 'Other' },
];

@Injectable()
export class SupportSeedService {
  private readonly logger = new Logger(SupportSeedService.name);

  constructor(private readonly repository: SupportRepository) {}

  /**
   * Creates any initial support category that does not exist yet.
   * Existing rows are untouched, preserving administrator renames, enable/disable choices.
   * Idempotent. Returns how many categories were created.
   */
  async ensureInitialCategories(): Promise<number> {
    let created = 0;
    for (const category of INITIAL_SUPPORT_CATEGORIES) {
      if (await this.repository.findCategoryByCode(category.code)) {
        continue;
      }
      try {
        await this.repository.createCategory(category);
        created++;
      } catch (error) {
        this.logger.warn(
          `Initial support category ${category.code} skipped: ${(error as Error).message}`,
        );
      }
    }
    return created;
  }
}
