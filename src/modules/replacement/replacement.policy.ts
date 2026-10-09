import { Injectable } from '@nestjs/common';

export const REPLACEMENT_POLICY = Symbol('REPLACEMENT_POLICY');

export interface ReplacementCandidateBooking {
  id: string;
  status: string;
  customerUserId: string;
  workerId: string | null;
  startDate: string | null;
}

export interface ReplacementVerdict {
  eligible: boolean;
  /** Shown to the customer when not eligible. */
  reason?: string;
}

/**
 * The single place where "may this booking be replaced?" is decided. The specification says eligibility is reviewed by
 * Support/Admin (FR-REP-003) but defines no rule - no time window, no limit on the number of replacements, no plan
 * (Q-09, Q-54) - so nothing is invented here. When the client defines a rule, replace the provider of REPLACEMENT_POLICY.
 */
export interface ReplacementPolicy {
  evaluate(booking: ReplacementCandidateBooking): Promise<ReplacementVerdict>;
}

/** Default: only what the booking state model already requires (a replacement starts from an ACTIVE booking). */
@Injectable()
export class ActiveBookingReplacementPolicy implements ReplacementPolicy {
  evaluate(booking: ReplacementCandidateBooking): Promise<ReplacementVerdict> {
    return Promise.resolve(
      booking.status === 'ACTIVE'
        ? { eligible: true }
        : { eligible: false, reason: 'Only a booking whose service is active can be replaced' },
    );
  }
}
