import { ConcurrencyLimiter } from './limiter';

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

describe('ConcurrencyLimiter', () => {
  it('never runs more than the limit at once and finishes everything in order', async () => {
    const limiter = new ConcurrencyLimiter(2);
    let active = 0;
    let peak = 0;
    const started: number[] = [];
    const task = (i: number) =>
      limiter.run(async () => {
        started.push(i);
        active += 1;
        peak = Math.max(peak, active);
        await tick();
        await tick();
        active -= 1;
        return i;
      });
    const results = await Promise.all([0, 1, 2, 3, 4, 5].map(task));
    expect(results).toEqual([0, 1, 2, 3, 4, 5]);
    expect(peak).toBe(2);
    expect(started).toEqual([0, 1, 2, 3, 4, 5]);
  });

  it('releases the slot when a task fails', async () => {
    const limiter = new ConcurrencyLimiter(1);
    await expect(limiter.run(() => Promise.reject(new Error('boom')))).rejects.toThrow('boom');
    await expect(limiter.run(() => Promise.resolve('ok'))).resolves.toBe('ok');
  });

  it('rejects an invalid limit', () => {
    expect(() => new ConcurrencyLimiter(0)).toThrow(RangeError);
  });
});
