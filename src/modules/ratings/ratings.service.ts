import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import { AuditService } from '../../common/audit/audit.service';
import { DomainException } from '../../common/errors/domain.exception';
import { isUniqueViolation } from '../../common/errors/prisma-errors';
import { Page, skipFor } from '../../common/pagination/pagination';
import { AppConfigService } from '../../config/app-config.service';
import { BookingService } from '../booking/booking.service';
import {
  AdminRatingListQuery,
  AdminRatingView,
  CreateRatingDto,
  RatingListQuery,
  RatingSummaryView,
  RatingView,
  WorkerRatingView,
} from './dto/ratings.dto';
import { RATING_POLICY, type RatingPolicy } from './ratings.policy';
import { RatingRecord, RatingsRepository } from './ratings.repository';

export const RatingErrorCode = {
  RATING_NOT_FOUND: 'RATING_NOT_FOUND',
  RATING_NOT_ELIGIBLE: 'RATING_NOT_ELIGIBLE',
  RATING_ALREADY_EXISTS: 'RATING_ALREADY_EXISTS',
  RATING_SCORE_OUT_OF_SCALE: 'RATING_SCORE_OUT_OF_SCALE',
} as const;

export interface ModerationActor {
  userId: string;
  roles: string[];
}

export interface WorkerRatingSummary {
  workerId: string;
  count: number;
  average: number | null;
}

/**
 * Ratings and reviews (SRS 3.16, FRD FM-10). A customer rates the worker of ONE of their own completed bookings, once. The
 * worker is taken from the booking, never from the request. Eligibility is a policy boundary (Q-58). The documented rules
 * carry no edit or delete for the customer (Q-60), so a rating is final except for administrator moderation, which hides or
 * restores it (audited) and keeps the worker's running totals correct in the same transaction.
 */
@Injectable()
export class RatingsService {
  constructor(
    private readonly repository: RatingsRepository,
    private readonly bookings: BookingService,
    private readonly audit: AuditService,
    private readonly config: AppConfigService,
    @Inject(RATING_POLICY) private readonly policy: RatingPolicy,
  ) {}

  // --- customer -------------------------------------------------------------------------------------------------

  async create(customerUserId: string, dto: CreateRatingDto): Promise<RatingView> {
    const booking = await this.bookings.getSummary(dto.bookingId).catch(() => null);
    // A booking that is not the caller's looks exactly like a booking that does not exist.
    if (!booking || booking.customerUserId !== customerUserId) throw this.bookingNotFound();
    const scaleMax = this.config.ratingScaleMax;
    if (dto.score > scaleMax) {
      throw new DomainException(
        RatingErrorCode.RATING_SCORE_OUT_OF_SCALE,
        `The score must be between 1 and ${scaleMax}`,
        HttpStatus.BAD_REQUEST,
        [{ field: 'score', messages: [`score must not be greater than ${scaleMax}`] }],
      );
    }
    const verdict = await this.policy.evaluate(booking);
    if (!verdict.eligible || booking.workerId === null) {
      throw new DomainException(
        RatingErrorCode.RATING_NOT_ELIGIBLE,
        verdict.reason ?? 'This booking cannot be rated',
        HttpStatus.UNPROCESSABLE_ENTITY,
      );
    }
    const workerId = booking.workerId;
    try {
      const created = await this.repository.transaction(async (tx) => {
        const rating = await this.repository.create(
          {
            bookingId: booking.id,
            customerUserId,
            workerId,
            score: dto.score,
            reviewText: dto.review ?? null,
          },
          tx,
        );
        await this.repository.adjustSummary(workerId, 1, dto.score, tx);
        await this.audit.record(
          {
            action: 'rating.create',
            entityType: 'rating',
            entityId: rating.id,
            actorId: customerUserId,
            // The review text is customer-written free text: it stays out of the audit log.
            metadata: { bookingId: booking.id, workerId, score: dto.score },
          },
          tx,
        );
        return rating;
      });
      return this.customerView(created);
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new DomainException(
          RatingErrorCode.RATING_ALREADY_EXISTS,
          'This booking has already been rated',
          HttpStatus.CONFLICT,
        );
      }
      throw error;
    }
  }

  async listMine(customerUserId: string, query: RatingListQuery): Promise<Page<RatingView>> {
    const { items, total } = await this.repository.list(
      { customerUserId },
      skipFor(query),
      query.limit,
    );
    return {
      data: items.map((r) => this.customerView(r)),
      meta: { page: query.page, limit: query.limit, total },
    };
  }

  async getMine(customerUserId: string, ratingId: string): Promise<RatingView> {
    const rating = await this.repository.findById(ratingId);
    if (!rating || rating.customerUserId !== customerUserId) throw this.notFound();
    return this.customerView(rating);
  }

  async getMineForBooking(customerUserId: string, bookingId: string): Promise<RatingView> {
    const rating = await this.repository.findByBooking(bookingId);
    if (!rating || rating.customerUserId !== customerUserId) throw this.notFound();
    return this.customerView(rating);
  }

  // --- worker ---------------------------------------------------------------------------------------------------

  async listReceived(workerId: string, query: RatingListQuery): Promise<Page<WorkerRatingView>> {
    const { items, total } = await this.repository.list(
      { workerId, status: 'VISIBLE' },
      skipFor(query),
      query.limit,
    );
    return {
      data: items.map((r) => ({
        id: r.id,
        score: r.score,
        review: r.reviewText,
        createdAt: r.createdAt,
      })),
      meta: { page: query.page, limit: query.limit, total },
    };
  }

  async summaryFor(workerId: string): Promise<RatingSummaryView> {
    const [summary] = await this.getSummaries([workerId]);
    return {
      count: summary.count,
      average: summary.average,
      scaleMax: this.config.ratingScaleMax,
    };
  }

  /**
   * Contract for other modules (profile cards, reports): the visible-rating totals for many workers in ONE query. A worker
   * with no ratings is returned with count 0 and a null average. Search and Matching deliberately do not use this (Q-46).
   */
  async getSummaries(workerIds: string[]): Promise<WorkerRatingSummary[]> {
    const rows = await this.repository.summaries(workerIds);
    const byWorker = new Map(rows.map((r) => [r.workerId, r]));
    return workerIds.map((workerId) => {
      const row = byWorker.get(workerId);
      const count = row?.ratingCount ?? 0;
      return {
        workerId,
        count,
        average: count === 0 ? null : Math.round((row!.ratingSum / count) * 100) / 100,
      };
    });
  }

  // --- admin ----------------------------------------------------------------------------------------------------

  async adminList(query: AdminRatingListQuery): Promise<Page<AdminRatingView>> {
    const { items, total } = await this.repository.list(
      { status: query.status, workerId: query.workerId, bookingId: query.bookingId },
      skipFor(query),
      query.limit,
    );
    return {
      data: items.map((r) => this.adminView(r)),
      meta: { page: query.page, limit: query.limit, total },
    };
  }

  async adminGet(ratingId: string): Promise<AdminRatingView> {
    const rating = await this.repository.findById(ratingId);
    if (!rating) throw this.notFound();
    return this.adminView(rating);
  }

  /** Hides a rating from the worker profile and the totals (FRD FM-10 "abusive content can be moderated by admin"). */
  hide(ratingId: string, reason: string, actor: ModerationActor): Promise<AdminRatingView> {
    return this.moderate(ratingId, 'HIDDEN', reason, actor);
  }

  unhide(ratingId: string, reason: string, actor: ModerationActor): Promise<AdminRatingView> {
    return this.moderate(ratingId, 'VISIBLE', reason, actor);
  }

  private async moderate(
    ratingId: string,
    target: 'HIDDEN' | 'VISIBLE',
    reason: string,
    actor: ModerationActor,
  ): Promise<AdminRatingView> {
    await this.repository.transaction(async (tx) => {
      const rating = await this.repository.lock(ratingId, tx);
      if (!rating) throw this.notFound();
      // Repeating the same moderation changes nothing (no second adjustment of the totals).
      if (rating.status === target) return;
      await this.repository.moderate(
        ratingId,
        {
          status: target,
          moderatedByUserId: actor.userId,
          moderatedAt: new Date(),
          moderationReason: reason,
        },
        tx,
      );
      const sign = target === 'HIDDEN' ? -1 : 1;
      await this.repository.adjustSummary(rating.workerId, sign, sign * rating.score, tx);
      await this.audit.record(
        {
          action: target === 'HIDDEN' ? 'rating.hide' : 'rating.unhide',
          entityType: 'rating',
          entityId: ratingId,
          actorId: actor.userId,
          actorRole: actor.roles.join(',') || null,
          metadata: { from: rating.status, to: target, workerId: rating.workerId, reason },
        },
        tx,
      );
    });
    return this.adminView((await this.repository.findById(ratingId))!);
  }

  // --- views ----------------------------------------------------------------------------------------------------

  private customerView(r: RatingRecord): RatingView {
    return {
      id: r.id,
      bookingId: r.bookingId,
      score: r.score,
      review: r.reviewText,
      status: r.status,
      createdAt: r.createdAt,
    };
  }

  private adminView(r: RatingRecord): AdminRatingView {
    return {
      id: r.id,
      bookingId: r.bookingId,
      workerId: r.workerId,
      customerUserId: r.customerUserId,
      score: r.score,
      review: r.reviewText,
      status: r.status,
      moderatedByUserId: r.moderatedByUserId,
      moderatedAt: r.moderatedAt,
      moderationReason: r.moderationReason,
      createdAt: r.createdAt,
    };
  }

  private notFound(): DomainException {
    return new DomainException(
      RatingErrorCode.RATING_NOT_FOUND,
      'Rating not found',
      HttpStatus.NOT_FOUND,
    );
  }

  private bookingNotFound(): DomainException {
    return new DomainException('BOOKING_NOT_FOUND', 'Booking not found', HttpStatus.NOT_FOUND);
  }
}
