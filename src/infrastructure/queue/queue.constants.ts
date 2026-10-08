import type { DefaultJobOptions } from 'bullmq';

/**
 * Platform-wide retry defaults. Source: BEA p8 recommends ~5 attempts, ~2 s doubling backoff with jitter, then a failed
 * (dead-letter) set that is kept for inspection and replay. The exact numbers are tunable engineering defaults, not
 * business rules. Individual queues may override them when they are introduced with their module.
 */
export const DEFAULT_JOB_OPTIONS: DefaultJobOptions = {
  attempts: 5,
  backoff: { type: 'exponential', delay: 2000, jitter: 0.5 },
  removeOnComplete: { age: 24 * 3600, count: 1000 },
  // Failed jobs are retained (dead-letter set) so they can be alerted on and replayed; handlers must be idempotent.
  removeOnFail: false,
};
