import { Injectable } from '@nestjs/common';
import { AppConfigService } from '../../config/app-config.service';
import { evaluateRatingEligibility } from '../../common/rating/rating-eligibility';

export const RATING_POLICY = Symbol('RATING_POLICY');

export interface RatableBooking {
  id: string;
  status: string;
  customerUserId: string;
  workerId: string | null;
  startDate: string | null;
  alreadyRated: boolean;
}

export interface RatingVerdict {
  eligible: boolean;
  /** Shown to the customer when not eligible. */
  reason?: string;
}

/**
 * The single place where "may this engagement be rated?" is decided. The specification says ratings are tied to "completed or
 * otherwise eligible" engagements and that eligibility rules are still to be defined (FRD FM-10, section 9; Q-58), so only the
 * documented part is implemented: a COMPLETED booking that has a worker. When the client defines "otherwise eligible" (for
 * example a REPLACED booking after some period), replace the provider of RATING_POLICY.
 */
export interface RatingPolicy {
  evaluate(booking: RatableBooking): Promise<RatingVerdict>;
}

@Injectable()
export class CompletedBookingRatingPolicy implements RatingPolicy {
  constructor(private readonly config: AppConfigService) {}

  evaluate(booking: RatableBooking): Promise<RatingVerdict> {
    const verdict = evaluateRatingEligibility(booking, {
      alreadyRated: booking.alreadyRated,
      allowEndedEarly: this.config.ratingAllowEndedEarly,
    });
    return Promise.resolve(
      verdict.eligible
        ? { eligible: true }
        : { eligible: false, reason: verdict.reason ?? undefined },
    );
  }
}
