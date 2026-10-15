import { HttpStatus, Injectable } from '@nestjs/common';
import { DomainException } from '../../common/errors/domain.exception';
import { ErrorCode } from '../../common/errors/error-codes';
import { AppConfigService } from '../../config/app-config.service';
import { Page, skipFor } from '../../common/pagination/pagination';
import { indiaToday, isRealDate } from '../../common/time/india';
import { toMinutes, toText } from '../availability/domain/time-windows';
import { ServiceAreasService } from '../availability/service-areas.service';
import { ServiceCategoriesService } from '../service-categories/service-categories.service';
import { WorkerPhotoService } from '../worker-photo/worker-photo.service';
import { PageQueryDto } from '../../common/pagination/pagination';
import {
  SearchWorkersQuery,
  SlotsQuery,
  WorkerCard,
  WorkerReviewView,
  WorkerSlotsView,
} from './dto/search.dto';
import { SearchRepository } from './search.repository';
import type {
  Engagement,
  EligibleOrder,
  EligibleWorker,
  EligibleWorkerCriteria,
} from './search.types';

export const INTERVIEW_SLOT_MINUTES = 60;
export const SLOT_HORIZON_DAYS = 14;

/** A requirement as received from a caller, before names are resolved to ids. */
export interface RequirementInput {
  category: string;
  areaId: string;
  engagement?: Engagement;
  availableFrom?: string;
  availableTo?: string;
  startDate?: string;
  language?: string;
  minExperienceMonths?: number;
  minRating?: number;
  /** Internal: the customer the search is for (block exclusion). Never taken from a client. */
  forCustomerUserId?: string;
  excludeWorkerId?: string;
  excludeBookingId?: string;
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
    private readonly photos: WorkerPhotoService,
    private readonly config: AppConfigService,
  ) {}

  /** Per-instance, short-lived, bounded cache of eligible-worker pages (see SEARCH_CACHE_TTL_SECONDS). */
  private readonly pageCache = new Map<
    string,
    { expires: number; value: { items: EligibleWorker[]; total: number } }
  >();

  async searchForCustomer(
    query: SearchWorkersQuery,
    customerUserId?: string,
  ): Promise<Page<WorkerCard>> {
    const resolved = await this.resolve(query);
    const { items, total } = await this.eligiblePage(
      resolved,
      query.sort,
      skipFor(query),
      query.limit,
      customerUserId,
    );
    return {
      data: await this.decorate(items),
      meta: { page: query.page, limit: query.limit, total },
    };
  }

  /**
   * The eligible page for a customer. With the cache enabled, customers who have no blocks share one cached page per distinct
   * search (block filtering is the only per-customer part of the query); anyone with a block always reads the database.
   */
  private async eligiblePage(
    resolved: EligibleWorkerCriteria,
    sort: EligibleOrder,
    skip: number,
    take: number,
    customerUserId: string | undefined,
  ): Promise<{ items: EligibleWorker[]; total: number }> {
    const ttl = this.config.searchCacheTtlSeconds * 1000;
    if (ttl > 0 && customerUserId && !(await this.repository.hasBlocks(customerUserId))) {
      const key = JSON.stringify([resolved, sort, skip, take, indiaToday()]);
      const hit = this.pageCache.get(key);
      if (hit && hit.expires > Date.now()) return hit.value;
      const value = await this.repository.findEligible(resolved, sort, skip, take);
      if (this.pageCache.size >= 500) {
        const oldest = this.pageCache.keys().next();
        if (!oldest.done) this.pageCache.delete(oldest.value);
      }
      this.pageCache.set(key, { expires: Date.now() + ttl, value });
      return value;
    }
    return this.repository.findEligible(
      { ...resolved, forCustomerUserId: customerUserId },
      sort,
      skip,
      take,
    );
  }

  /**
   * Contract for the customer-facing profile and shortlist (FR-WD-005, FRD FM-03 step 6): the cards of those given workers
   * that are visible to customers (active, submitted, fully verified), keyed by worker id. Unknown, ineligible, suspended and
   * expired-verification workers are absent, so a caller can never tell them apart.
   */
  async getVisibleCards(ids: string[], customerUserId?: string): Promise<Map<string, WorkerCard>> {
    const workers = await this.repository.findVisibleByIds(ids, customerUserId);
    const cards = await this.decorate(workers);
    return new Map(cards.map((c) => [c.workerId, c]));
  }

  /** Contract for Booking: short-lived photo links of these workers (the caller already decided they may be shown). */
  photoLinks(ids: string[]): ReturnType<WorkerPhotoService['linksFor']> {
    return this.photos.linksFor(ids);
  }

  /** Free interview/trial start times of a visible worker on one date (same 404 as the profile for anyone not visible). */
  async listSlots(
    workerId: string,
    query: SlotsQuery,
    customerUserId?: string,
  ): Promise<WorkerSlotsView> {
    const slotMinutes = INTERVIEW_SLOT_MINUTES;
    const today = indiaToday();
    const last = new Date(`${today}T00:00:00.000Z`);
    last.setUTCDate(last.getUTCDate() + SLOT_HORIZON_DAYS - 1);
    if (
      !isRealDate(query.date) ||
      query.date < today ||
      query.date > last.toISOString().slice(0, 10)
    ) {
      throw new DomainException(
        ErrorCode.VALIDATION_FAILED,
        'Request validation failed',
        HttpStatus.BAD_REQUEST,
        [
          {
            field: 'date',
            messages: [`date must be from ${today} to ${last.toISOString().slice(0, 10)}`],
          },
        ],
      );
    }
    const card = await this.getProfile(workerId, customerUserId);
    const nowIst = new Date(Date.now() + 330 * 60_000);
    const earliest =
      query.date === today ? nowIst.getUTCHours() * 60 + nowIst.getUTCMinutes() + 60 : 0;
    const starts: number[] = [];
    for (const window of card.availability) {
      for (
        let m = toMinutes(window.start);
        m + slotMinutes <= toMinutes(window.end);
        m += slotMinutes
      ) {
        if (m >= earliest && !starts.includes(m)) starts.push(m);
      }
    }
    starts.sort((a, b) => a - b);
    const taken = await this.repository.takenStarts(workerId, query.date, starts, slotMinutes);
    return {
      date: query.date,
      slotMinutes,
      horizonDays: SLOT_HORIZON_DAYS,
      slots: starts.filter((m) => !taken.has(m)).map(toText),
    };
  }

  async getProfile(workerId: string, customerUserId?: string): Promise<WorkerCard> {
    const card = (await this.getVisibleCards([workerId], customerUserId)).get(workerId);
    if (!card) {
      throw new DomainException('WORKER_NOT_FOUND', 'Worker not found', HttpStatus.NOT_FOUND);
    }
    return card;
  }

  /**
   * Reviews a customer may read about a visible worker (FR-WD-003): score, text, date and the reviewer's first name only.
   * Same visibility rule as the profile: an unknown or invisible worker answers 404 exactly like any other.
   */
  async listReviews(workerId: string, query: PageQueryDto): Promise<Page<WorkerReviewView>> {
    await this.getProfile(workerId);
    const { items, total } = await this.repository.listVisibleReviews(
      workerId,
      skipFor(query),
      query.limit,
    );
    return { data: items, meta: { page: query.page, limit: query.limit, total } };
  }

  /** Adds the rating aggregate and a short-lived photo link in two batched look-ups (no per-worker queries). */
  private async decorate(workers: EligibleWorker[]): Promise<WorkerCard[]> {
    const ids = workers.map((w) => w.id);
    const [ratings, photos] = await Promise.all([
      this.repository.ratingSummaries(ids),
      this.photos.linksFor(ids),
    ]);
    return workers.map((w) => {
      const rating = ratings.get(w.id);
      const photo = photos.get(w.id);
      return {
        ...toCard(w),
        rating: rating
          ? { average: Math.round((rating.sum / rating.count) * 100) / 100, count: rating.count }
          : null,
        photo: photo ?? null,
      };
    });
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
    if (input.startDate !== undefined && !isRealDate(input.startDate)) {
      throw this.invalid('startDate', 'startDate is not a real date');
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
    if (input.minRating !== undefined && input.minRating > this.config.ratingScaleMax) {
      // Ratings use the configured scale (reference-data ratingScaleMax): a minimum above it can never match.
      throw this.invalid(
        'minRating',
        `minRating must be at most ${this.config.ratingScaleMax} (the rating scale)`,
      );
    }
    const [category, area] = await Promise.all([
      this.categories.requireEnabledByCode(input.category),
      this.areas.requireEnabled(input.areaId),
    ]);
    if (input.engagement) {
      await this.categories.assertEngagementOffered(category.id, input.engagement);
    }
    return {
      categoryId: category.id,
      areaId: area.id,
      engagement: input.engagement,
      window,
      startDate: input.startDate,
      excludeBookingId: input.excludeBookingId,
      language: input.language,
      minExperienceMonths: input.minExperienceMonths,
      minRating: input.minRating,
      forCustomerUserId: input.forCustomerUserId,
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
export function toCard(worker: EligibleWorker): Omit<WorkerCard, 'rating' | 'photo'> {
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
