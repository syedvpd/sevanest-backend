import { Injectable } from '@nestjs/common';

export const RATING_POLICY = Symbol('RATING_POLICY');

export interface RatableBooking {
  id: string;
  status: string;
  customerUserId: string;
  workerId: string | null;
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
  evaluate(booking: RatableBooking): Promise<RatingVerdict> {
    if (booking.status !== 'COMPLETED' || booking.workerId === null) {
      return Promise.resolve({ eligible: false, reason: 'Only a completed booking can be rated' });
    }
    return Promise.resolve({ eligible: true });
  }
}
