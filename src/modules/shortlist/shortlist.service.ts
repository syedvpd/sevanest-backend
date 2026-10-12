import { HttpStatus, Injectable } from '@nestjs/common';
import { DomainException } from '../../common/errors/domain.exception';
import { Page, skipFor } from '../../common/pagination/pagination';
import { SearchService } from '../search/search.service';
import { ShortlistItemView, ShortlistQuery } from './dto/shortlist.dto';
import { ShortlistRepository } from './shortlist.repository';

export const ShortlistErrorCode = {
  WORKER_NOT_FOUND: 'WORKER_NOT_FOUND',
  SHORTLIST_FULL: 'SHORTLIST_FULL',
} as const;

/** Technical abuse guard, NOT a business rule (the specs give no limit, Q-72): entries one customer may hold. */
export const MAX_SHORTLIST_ENTRIES = 100;

/**
 * Customer shortlist / favourites (FR-WD-005, FRD FM-03 step 6). Owned by the signed-in customer: the customer id always
 * comes from the token, never from the request. Only workers currently visible to customers can be added; adding twice is
 * harmless; a worker who later stops being visible stays listed as unavailable and can be removed.
 */
@Injectable()
export class ShortlistService {
  constructor(
    private readonly repository: ShortlistRepository,
    private readonly search: SearchService,
  ) {}

  async add(customerUserId: string, workerId: string): Promise<void> {
    const visible = await this.search.getVisibleCards([workerId], customerUserId);
    if (!visible.has(workerId)) {
      throw new DomainException(
        ShortlistErrorCode.WORKER_NOT_FOUND,
        'Worker not found',
        HttpStatus.NOT_FOUND,
      );
    }
    await this.repository.transaction(async (tx) => {
      await this.repository.lockCustomer(customerUserId, tx);
      if (await this.repository.has(customerUserId, workerId, tx)) return;
      if ((await this.repository.count(customerUserId, tx)) >= MAX_SHORTLIST_ENTRIES) {
        throw new DomainException(
          ShortlistErrorCode.SHORTLIST_FULL,
          'The shortlist is full; remove a worker first',
          HttpStatus.UNPROCESSABLE_ENTITY,
        );
      }
      await this.repository.add(customerUserId, workerId, tx);
    });
  }

  /** Idempotent: removing an entry that is not there succeeds. Another customer's entries are unreachable by construction. */
  async remove(customerUserId: string, workerId: string): Promise<void> {
    await this.repository.remove(customerUserId, workerId);
  }

  async list(customerUserId: string, query: ShortlistQuery): Promise<Page<ShortlistItemView>> {
    const { items, total } = await this.repository.list(
      customerUserId,
      skipFor(query),
      query.limit,
    );
    const cards = await this.search.getVisibleCards(
      items.map((i) => i.workerId),
      customerUserId,
    );
    return {
      data: items.map((item) => {
        const worker = cards.get(item.workerId) ?? null;
        return {
          workerId: item.workerId,
          addedAt: item.createdAt,
          available: worker !== null,
          worker,
        };
      }),
      meta: { page: query.page, limit: query.limit, total },
    };
  }
}
