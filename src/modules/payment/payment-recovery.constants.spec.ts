import { nextCheckDelayMs, RECOVERY } from './payment-recovery.constants';

describe('nextCheckDelayMs (bounded exponential backoff with jitter)', () => {
  it('grows exponentially and never exceeds the cap', () => {
    const max = (attempts: number): number => nextCheckDelayMs(attempts, () => 1);
    expect(max(0)).toBe(RECOVERY.baseDelayMs);
    expect(max(1)).toBe(RECOVERY.baseDelayMs * 2);
    expect(max(2)).toBe(RECOVERY.baseDelayMs * 4);
    for (const attempts of [10, 20, 1000]) {
      expect(max(attempts)).toBe(RECOVERY.capDelayMs);
    }
  });

  it('applies jitter between 50% and 100% of the step so retries do not synchronise', () => {
    expect(nextCheckDelayMs(1, () => 0)).toBe(RECOVERY.baseDelayMs);
    expect(nextCheckDelayMs(1, () => 0.5)).toBe(Math.floor(RECOVERY.baseDelayMs * 2 * 0.75));
    const samples = new Set(Array.from({ length: 50 }, () => nextCheckDelayMs(3)));
    expect(samples.size).toBeGreaterThan(1);
    for (const sample of samples) {
      expect(sample).toBeGreaterThanOrEqual(RECOVERY.baseDelayMs * 8 * 0.5);
      expect(sample).toBeLessThanOrEqual(RECOVERY.baseDelayMs * 8);
    }
  });

  it('treats a negative attempt count as the first attempt', () => {
    expect(nextCheckDelayMs(-5, () => 1)).toBe(RECOVERY.baseDelayMs);
  });
});
