import '../support/env-api-integration';
import { randomUUID } from 'node:crypto';
import { RedisThrottlerStorage } from '../../src/infrastructure/cache/redis-throttler.storage';
import { ApiApp, createApiApp } from '../support/api-app';

/** Remediation: the global rate limit is shared by every API replica when THROTTLE_STORAGE=redis. */
describe('Redis throttler storage (integration)', () => {
  let api: ApiApp;

  beforeAll(async () => {
    api = await createApiApp();
  });
  afterAll(async () => {
    await api.close();
  });

  it('counts hits across independent instances (replicas) and expires the window', async () => {
    const replicaA = new RedisThrottlerStorage(api.redis);
    const replicaB = new RedisThrottlerStorage(api.redis);
    const key = `test-${randomUUID()}`;

    expect((await replicaA.increment(key, 1500, 3, 0, 'default')).totalHits).toBe(1);
    expect((await replicaB.increment(key, 1500, 3, 0, 'default')).totalHits).toBe(2);
    const third = await replicaA.increment(key, 1500, 3, 0, 'default');
    expect(third).toMatchObject({ totalHits: 3, isBlocked: false });
    expect(third.timeToExpire).toBeGreaterThan(0);
    expect((await replicaB.increment(key, 1500, 3, 0, 'default')).totalHits).toBe(4); // over the limit of 3

    await new Promise((resolve) => setTimeout(resolve, 1700));
    expect((await replicaA.increment(key, 1500, 3, 0, 'default')).totalHits).toBe(1);
  });

  it('blocks for the block duration once the limit is exceeded', async () => {
    const storage = new RedisThrottlerStorage(api.redis);
    const key = `test-${randomUUID()}`;
    await storage.increment(key, 60_000, 1, 5000, 'default');
    const over = await storage.increment(key, 60_000, 1, 5000, 'default');
    expect(over.isBlocked).toBe(true);
    expect(over.timeToBlockExpire).toBeGreaterThan(0);
  });

  it('keeps counting in process memory when Redis is unavailable instead of failing', async () => {
    const broken = new RedisThrottlerStorage({
      ensureConnected: () => Promise.reject(new Error('redis down')),
    } as never);
    const key = `test-${randomUUID()}`;
    expect((await broken.increment(key, 60_000, 5, 0, 'default')).totalHits).toBe(1);
    expect((await broken.increment(key, 60_000, 5, 0, 'default')).totalHits).toBe(2);
  });
});
