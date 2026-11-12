import { randomBytes } from 'node:crypto';
import Redis from 'ioredis';
import type { AppConfigService } from '../../config/app-config.service';
import type { RedisService } from '../../infrastructure/cache/redis.service';
import { AdminLoginThrottle } from './admin-login-throttle.service';
import { AuthErrorCode } from './auth.errors';

/**
 * Regression for the check-then-verify race: the attempt slot must be taken atomically BEFORE the slow password hash, so a
 * concurrent burst can never get more than the configured maximum. The atomic part is a Redis Lua script, so this spec needs a
 * real Redis (set THROTTLE_SPEC_REDIS_URL; CI provides one). Without it the suite is skipped, never silently passed.
 */
const url = process.env.THROTTLE_SPEC_REDIS_URL;
const suite = url ? describe : describe.skip;

const MAX = 3;

describe('AdminLoginThrottle (unit)', () => {
  const makeUnit = (evalImpl: jest.Mock) =>
    new AdminLoginThrottle(
      {
        client: { eval: evalImpl },
        ensureConnected: () => Promise.resolve(),
      } as unknown as RedisService,
      {
        adminLogin: { maxFailures: 5, failureWindowSeconds: 900, lockoutSeconds: 900 },
      } as unknown as AppConfigService,
    );

  it('normalizes email case and whitespace when computing accountKey', () => {
    expect(AdminLoginThrottle.accountKey('  Ops.Lead@Example.TEST ')).toBe(
      AdminLoginThrottle.accountKey('ops.lead@example.test'),
    );
  });

  it('scopes reserve and release solely to account keys (never IP keys) and clamps retryAfterSeconds >= 1', async () => {
    const evalMock = jest
      .fn()
      .mockResolvedValueOnce([1, 0, 0])
      .mockResolvedValueOnce([0, 0, 0])
      .mockResolvedValueOnce(1);
    const throttle = makeUnit(evalMock);
    const acctKey = AdminLoginThrottle.accountKey('admin@example.test');

    await expect(throttle.reserve(acctKey, '203.0.113.10')).resolves.toEqual({
      lastAllowed: false,
    });
    expect(evalMock).toHaveBeenNthCalledWith(
      1,
      expect.any(String),
      2,
      `auth:admin:lock:acct:${acctKey}`,
      `auth:admin:fail:acct:${acctKey}`,
      '900',
      '5',
      '900',
    );

    await expect(throttle.reserve(acctKey, '203.0.113.10')).rejects.toMatchObject({
      code: AuthErrorCode.ADMIN_LOGIN_LOCKED,
      details: [{ field: 'retryAfterSeconds', messages: ['1'] }],
    });

    await throttle.release(acctKey, '203.0.113.10');
    expect(evalMock).toHaveBeenNthCalledWith(
      3,
      expect.any(String),
      1,
      `auth:admin:fail:acct:${acctKey}`,
    );
  });
});

suite('AdminLoginThrottle (real Redis)', () => {
  let client: Redis;
  let throttle: AdminLoginThrottle;
  let run: string;

  const make = (lockoutSeconds = 60): AdminLoginThrottle =>
    new AdminLoginThrottle(
      { client, ensureConnected: () => Promise.resolve() } as unknown as RedisService,
      {
        adminLogin: { maxFailures: MAX, failureWindowSeconds: 60, lockoutSeconds },
      } as unknown as AppConfigService,
    );
  const acct = (n: number | string): string => `spec-${run}-a${n}`;
  const ip = (n: number | string): string => `spec-${run}-i${n}`;
  const settle = (calls: Promise<unknown>[]) => Promise.allSettled(calls);
  const count = (results: PromiseSettledResult<unknown>[], status: 'fulfilled' | 'rejected') =>
    results.filter((r) => r.status === status).length;

  beforeAll(() => {
    client = new Redis(url!, { maxRetriesPerRequest: 2 });
  });
  beforeEach(() => {
    run = randomBytes(6).toString('hex');
    throttle = make();
  });
  afterEach(async () => {
    const keys = await client.keys(`auth:admin:*:spec-${run}-*`);
    if (keys.length > 0) await client.del(...keys);
  });
  afterAll(async () => {
    await client.quit();
  });

  it('admits exactly the maximum under a concurrent burst on one account and one IP', async () => {
    const results = await settle(
      Array.from({ length: 60 }, () => throttle.reserve(acct(1), ip(1))),
    );
    expect(count(results, 'fulfilled')).toBe(MAX);
    const refused = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
    expect(refused).toHaveLength(60 - MAX);
    expect(
      refused.every(
        (r) => (r.reason as { code?: string }).code === AuthErrorCode.ADMIN_LOGIN_LOCKED,
      ),
    ).toBe(true);
  });

  it('caps one account at the maximum even when every request comes from a different IP', async () => {
    const results = await settle(
      Array.from({ length: 60 }, (_, i) => throttle.reserve(acct(2), ip(`spread${i}`))),
    );
    expect(count(results, 'fulfilled')).toBe(MAX);
  });

  it('does not lock unrelated accounts sharing the same client IP', async () => {
    const targeted = await settle(
      Array.from({ length: 10 }, () => throttle.reserve(acct('a'), ip(3))),
    );
    expect(count(targeted, 'fulfilled')).toBe(MAX);

    const unrelated = await settle(
      Array.from({ length: 5 }, (_, i) => throttle.reserve(acct(`other${i}`), ip(3))),
    );
    expect(count(unrelated, 'fulfilled')).toBe(5);
  });

  it('reports the last allowed attempt exactly once', async () => {
    const results = await Promise.all(
      Array.from({ length: MAX }, () => throttle.reserve(acct(4), ip(4))),
    );
    expect(results.filter((r) => r.lastAllowed)).toHaveLength(1);
  });

  it('keeps refusing while locked, with a retry hint', async () => {
    await settle(Array.from({ length: MAX + 1 }, () => throttle.reserve(acct(5), ip(5))));
    await expect(throttle.reserve(acct(5), ip(6))).rejects.toMatchObject({
      code: AuthErrorCode.ADMIN_LOGIN_LOCKED,
      details: [{ field: 'retryAfterSeconds', messages: [expect.stringMatching(/^\d+$/)] }],
    });
  });

  it('starts a fresh window after the lockout expires', async () => {
    const short = make(1);
    await settle(Array.from({ length: MAX + 1 }, () => short.reserve(acct(7), ip(7))));
    await expect(short.reserve(acct(7), ip(7))).rejects.toBeDefined();
    await new Promise((resolve) => setTimeout(resolve, 1200));
    const results = await settle(Array.from({ length: 20 }, () => short.reserve(acct(7), ip(7))));
    expect(count(results, 'fulfilled')).toBe(MAX);
  });

  it('release (successful login) clears the account counter without touching IP keys', async () => {
    await throttle.reserve(acct(8), ip(8));
    await throttle.reserve(acct(8), ip(8));
    await throttle.release(acct(8), ip(8));
    expect(await client.get(`auth:admin:fail:acct:${acct(8)}`)).toBeNull();
    expect(await client.get(`auth:admin:fail:ip:${ip(8)}`)).toBeNull();
    expect(await client.get(`auth:admin:lock:ip:${ip(8)}`)).toBeNull();
    const results = await settle(
      Array.from({ length: 20 }, () => throttle.reserve(acct(8), ip(9))),
    );
    expect(count(results, 'fulfilled')).toBe(MAX);
  });

  it('release without a reservation never breaks the account counter', async () => {
    await throttle.release(acct(10), ip(10));
    const results = await settle(
      Array.from({ length: 20 }, () => throttle.reserve(acct(10), ip(10))),
    );
    expect(count(results, 'fulfilled')).toBe(MAX);
  });
});
