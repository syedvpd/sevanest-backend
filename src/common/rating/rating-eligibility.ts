/**
 * The one rule for "may this booking be rated?" (D-79), shared by the rating service (enforcement) and the booking views (the `rate`
 * action), so the app can never be shown a button the server will refuse. Pure: no database, no framework.
 *
 *  - COMPLETED with a worker: rateable (FRD FM-10: ratings are tied to completed/eligible engagements).
 *  - REPLACED ("ended early" in the design): NOT rateable until the client decides (Q-102); `allowEndedEarly` (RATING_ALLOW_ENDED_EARLY)
 *    switches it on, and then only if the service actually started.
 *  - everything else: not rateable. One rating per booking.
 */
export const RATING_ELIGIBILITY_CODES = [
  'ELIGIBLE',
  'ALREADY_RATED',
  'NOT_COMPLETED',
  'ENDED_EARLY_NOT_RATEABLE',
  'NO_WORKER',
] as const;
export type RatingEligibilityCode = (typeof RATING_ELIGIBILITY_CODES)[number];

export interface RatingEligibility {
  eligible: boolean;
  code: RatingEligibilityCode;
  /** Plain-language reason for the app to show; null when eligible. */
  reason: string | null;
}

export function evaluateRatingEligibility(
  booking: { status: string; workerId: string | null; startDate: string | null },
  state: { alreadyRated: boolean; allowEndedEarly: boolean },
): RatingEligibility {
  const no = (code: RatingEligibilityCode, reason: string): RatingEligibility => ({
    eligible: false,
    code,
    reason,
  });
  if (booking.workerId === null) return no('NO_WORKER', 'This booking has no worker to rate');
  if (state.alreadyRated) return no('ALREADY_RATED', 'This booking has already been rated');
  if (booking.status === 'COMPLETED') return { eligible: true, code: 'ELIGIBLE', reason: null };
  if (booking.status === 'REPLACED') {
    if (state.allowEndedEarly && booking.startDate !== null) {
      return { eligible: true, code: 'ELIGIBLE', reason: null };
    }
    return no('ENDED_EARLY_NOT_RATEABLE', 'A booking that ended early cannot be rated');
  }
  return no('NOT_COMPLETED', 'Only a completed booking can be rated');
}
