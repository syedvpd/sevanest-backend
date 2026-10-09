import { HttpStatus, Injectable } from '@nestjs/common';
import { DomainException } from '../../common/errors/domain.exception';
import { ErrorCode } from '../../common/errors/error-codes';
import { Page, skipFor } from '../../common/pagination/pagination';
import { toMinutes, toText } from '../availability/domain/time-windows';
import { ServiceAreasService } from '../availability/service-areas.service';
import { ServiceCategoriesService } from '../service-categories/service-categories.service';
import { SearchWorkersQuery, WorkerCard } from './dto/search.dto';
import { SearchRepository } from './search.repository';
import type {
  Engagement,
  EligibleOrder,
  EligibleWorker,
  EligibleWorkerCriteria,
} from './search.types';

/** A requirement as received from a caller, before names are resolved to ids. */
export interface RequirementInput {
  category: string;
  areaId: string;
  engagement?: Engagement;
  availableFrom?: string;
  availableTo?: string;
  language?: string;
  minExperienceMonths?: number;
  excludeWorkerId?: string;
}

/**
 * Worker discovery (SRS 3.3 FR-SD-005, 3.4 FR-WD-005): "filter workers by category, location and availability", paginated.
 * Eligible = active worker account, submitted profile, fully verified (Verification's definition), offering the category
 * in the enabled area. Read-only. No scoring or recommendation: ordering is a stable sort on a stated attribute (Q-46).
 */
@Injectable()
export class SearchService {
  constructor(
    private readonly repository: SearchRepository,
    private readonly categories: ServiceCategoriesService,
    private readonly areas: ServiceAreasService,
  ) {}

  async searchForCustomer(query: SearchWorkersQuery): Promise<Page<WorkerCard>> {
    const criteria = await this.resolve(query);
    const { items, total } = await this.repository.findEligible(
      criteria,
      query.sort,
      skipFor(query),
      query.limit,
    );
    return {
      data: items.map(toCard),
      meta: { page: query.page, limit: query.limit, total },
    };
  }

  /**
   * Contract for Matching (and later Booking): the eligible workers for a requirement with the fields a staff-side caller
   * needs. Customer-facing callers must map through `toCard` so private fields never leave.
   */
  async findEligible(
    input: RequirementInput,
    order: EligibleOrder,
    page: { skip: number; limit: number },
  ): Promise<{ items: EligibleWorker[]; total: number }> {
    return this.repository.findEligible(await this.resolve(input), order, page.skip, page.limit);
  }

  /**
   * Contract for Booking: is this worker eligible (active, submitted, fully verified, offering the category in the area with
   * the engagement and a window covering the timings)? Ids are already resolved and validated by the caller.
   */
  isEligible(criteria: EligibleWorkerCriteria & { workerId: string }): Promise<boolean> {
    return this.repository.isEligible(criteria);
  }

  private async resolve(input: RequirementInput): Promise<EligibleWorkerCriteria> {
    const hasFrom = input.availableFrom !== undefined;
    const hasTo = input.availableTo !== undefined;
    if (hasFrom !== hasTo) {
      throw this.invalid('availableFrom', 'availableFrom and availableTo must be given together');
    }
    let window: EligibleWorkerCriteria['window'];
    if (hasFrom && hasTo) {
      const fromMinute = toMinutes(input.availableFrom!);
      const toMinute = toMinutes(input.availableTo!);
      if (fromMinute >= toMinute) {
        throw this.invalid('availableFrom', 'availableFrom must be earlier than availableTo');
      }
      window = { fromMinute, toMinute };
    }
    const [category, area] = await Promise.all([
      this.categories.requireEnabledByCode(input.category),
      this.areas.requireEnabled(input.areaId),
    ]);
    return {
      categoryId: category.id,
      areaId: area.id,
      engagement: input.engagement,
      window,
      language: input.language,
      minExperienceMonths: input.minExperienceMonths,
      excludeWorkerId: input.excludeWorkerId,
    };
  }

  private invalid(field: string, message: string): DomainException {
    return new DomainException(
      ErrorCode.VALIDATION_FAILED,
      'Request validation failed',
      HttpStatus.BAD_REQUEST,
      [{ field, messages: [message] }],
    );
  }
}

/** The customer-safe projection: explicit allow-list, so a new field on the worker can never leak by accident. */
export function toCard(worker: EligibleWorker): WorkerCard {
  return {
    workerId: worker.id,
    experienceMonths: worker.experienceMonths,
    categories: worker.categories,
    languages: worker.languages,
    serviceAreas: worker.serviceAreas,
    engagementPreference: worker.engagementPreference,
    availability: worker.availability.map((w) => ({
      start: toText(w.startMinute),
      end: toText(w.endMinute),
    })),
    verification: 'VERIFIED',
  };
}
