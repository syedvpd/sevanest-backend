/** Runs at most `limit` tasks at once; further callers wait in arrival order. Used to bound CPU/memory-heavy work (password hashing). */
export class ConcurrencyLimiter {
  private running = 0;
  private readonly waiting: Array<() => void> = [];

  constructor(private readonly limit: number) {
    if (!Number.isInteger(limit) || limit < 1)
      throw new RangeError('limit must be a positive integer');
  }

  async run<T>(work: () => Promise<T>): Promise<T> {
    if (this.running >= this.limit) {
      await new Promise<void>((resolve) => this.waiting.push(resolve));
    } else {
      this.running += 1;
    }
    try {
      return await work();
    } finally {
      const next = this.waiting.shift();
      if (next)
        next(); // the slot passes straight to the next waiter
      else this.running -= 1;
    }
  }
}
