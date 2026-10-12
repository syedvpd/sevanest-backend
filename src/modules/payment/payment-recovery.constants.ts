/**
 * Recovery tuning. These are ENGINEERING defaults (how often to ask the gateway, how long to back off), not business rules:
 * they decide nothing about money. No booking-expiry period, cancellation fee or refund deadline is encoded here (all open,
 * Q-17/Q-21): a payment that never completes is simply checked a bounded number of times and then left alone.
 */
export const RECOVERY = {
  /** First authoritative check after a checkout order is created (gives the normal webhook time to arrive first). */
  firstCheckDelayMs: 5 * 60_000,
  baseDelayMs: 5 * 60_000,
  capDelayMs: 6 * 3_600_000,
  /** Checks of a PENDING payment or a pending refund before automatic checks stop and a person is alerted. */
  maxAttempts: 12,
  /** After a FAILED report (or a booking cancelled with an open order) only a short tail of checks is made. */
  failedTailAttempts: 4,
  tailFirstDelayMs: 2 * 60_000,
  /** How long a worker owns a claimed payment; a crashed worker's claim lapses after this. */
  claimSeconds: 300,
  batchSize: 25,
  /** An UNKNOWN_ORDER webhook still unmatched after this long is escalated to a person. */
  unknownOrderEscalateAfterMs: 30 * 60_000,
  unknownOrderBatch: 50,
  /** Backstop sweep size for cancelled bookings that still hold money. */
  cancelledSweepBatch: 50,
} as const;

/**
 * Bounded exponential backoff with jitter: base * 2^attempts, capped, then scaled into [50%, 100%] so a restart does not make every
 * payment retry in the same second. `random` is injectable for tests.
 */
export function nextCheckDelayMs(attempts: number, random: () => number = Math.random): number {
  const exponential = Math.min(
    RECOVERY.capDelayMs,
    RECOVERY.baseDelayMs * 2 ** Math.max(0, attempts),
  );
  return Math.floor(exponential * (0.5 + random() * 0.5));
}
