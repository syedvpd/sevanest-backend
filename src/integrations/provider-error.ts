/**
 * Failure from an external provider. `retryable` tells job handlers whether backoff-and-retry makes sense
 * (timeouts, 5xx, rate limits) or the call must be failed permanently (rejected request, bad credentials).
 */
export class ProviderError extends Error {
  constructor(
    readonly provider: string,
    message: string,
    readonly retryable: boolean,
    override readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'ProviderError';
  }
}
