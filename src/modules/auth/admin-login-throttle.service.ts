import { createHash } from 'node:crypto';
import { HttpStatus, Injectable } from '@nestjs/common';
import { DomainException } from '../../common/errors/domain.exception';
import { AdminLoginSettings, AppConfigService } from '../../config/app-config.service';
import { RedisService } from '../../infrastructure/cache/redis.service';
import { AuthErrorCode } from './auth.errors';

/**
 * Atomically checks the locks and takes one attempt slot for the account AND the IP. KEYS: lock:acct, lock:ip, fail:acct,
 * fail:ip. ARGV: window seconds, max attempts, lockout seconds. Returns {allowed, retryAfterSeconds, lastAllowed}.
 * A slot is taken BEFORE the slow password hash runs, so concurrent requests cannot all pass a stale "not locked" check.
 * The attempt that would exceed the maximum is refused, hands its slot back, locks the scope and starts it a fresh window.
 */
const RESERVE_ATTEMPT = `
local ttl = math.max(redis.call('TTL', KEYS[1]), redis.call('TTL', KEYS[2]))
if ttl > 0 then return {0, ttl, 0} end
local max = tonumber(ARGV[2])
local counts = {}
for i = 3, 4 do
  counts[i] = redis.call('INCR', KEYS[i])
  if counts[i] == 1 then redis.call('EXPIRE', KEYS[i], ARGV[1]) end
end
if counts[3] > max or counts[4] > max then
  for i = 3, 4 do
    if counts[i] > max then
      redis.call('SET', KEYS[i - 2], '1', 'EX', ARGV[3])
      redis.call('DEL', KEYS[i])
    else
      redis.call('DECR', KEYS[i])
    end
  end
  return {0, tonumber(ARGV[3]), 0}
end
local last = 0
if counts[3] == max or counts[4] == max then last = 1 end
return {1, 0, last}`;

/** Success: clears the account counter and hands the IP slot back (never below zero). KEYS: fail:acct, fail:ip. */
const RELEASE_ATTEMPT = `
redis.call('DEL', KEYS[1])
local v = tonumber(redis.call('GET', KEYS[2]))
if v and v > 0 then redis.call('DECR', KEYS[2]) end
return 1`;

export interface AttemptReservation {
  /** True when this attempt used the last allowed slot: the next attempt in the window is refused. */
  lastAllowed: boolean;
}

/**
 * Brute-force protection for admin credential login (NFR-SEC-008, BEA p5). Every attempt reserves a slot per account (email)
 * and per client IP inside a window; once the configured maximum is used, that key is locked for the configured duration.
 * Counters live in Redis (non-authoritative): losing them only resets the protection window, never a business record.
 * Redis errors propagate, so the login fails closed.
 */
@Injectable()
export class AdminLoginThrottle {
  private readonly settings: AdminLoginSettings;

  constructor(
    private readonly redis: RedisService,
    config: AppConfigService,
  ) {
    this.settings = config.adminLogin;
  }

  static accountKey(email: string): string {
    return createHash('sha256').update(email).digest('hex').slice(0, 32);
  }

  /**
   * Takes an attempt slot or throws 429 while the account or the IP is locked / out of attempts. Does not reveal which one.
   * Call it before verifying the password; call {@link release} only after a successful authentication.
   */
  async reserve(accountKey: string, clientIp: string): Promise<AttemptReservation> {
    await this.redis.ensureConnected();
    const [allowed, retryAfter, last] = (await this.redis.client.eval(
      RESERVE_ATTEMPT,
      4,
      this.lockKey('acct', accountKey),
      this.lockKey('ip', clientIp),
      this.failKey('acct', accountKey),
      this.failKey('ip', clientIp),
      String(this.settings.failureWindowSeconds),
      String(this.settings.maxFailures),
      String(this.settings.lockoutSeconds),
    )) as [number, number, number];
    if (allowed !== 1) {
      throw new DomainException(
        AuthErrorCode.ADMIN_LOGIN_LOCKED,
        'Too many failed login attempts. Please try again later.',
        HttpStatus.TOO_MANY_REQUESTS,
        [{ field: 'retryAfterSeconds', messages: [String(retryAfter)] }],
      );
    }
    return { lastAllowed: last === 1 };
  }

  /** A successful login clears the account's counter and gives its IP slot back (the IP keeps counting other attempts). */
  async release(accountKey: string, clientIp: string): Promise<void> {
    await this.redis.ensureConnected();
    await this.redis.client.eval(
      RELEASE_ATTEMPT,
      2,
      this.failKey('acct', accountKey),
      this.failKey('ip', clientIp),
    );
  }

  private failKey(scope: 'acct' | 'ip', id: string): string {
    return `auth:admin:fail:${scope}:${id}`;
  }

  private lockKey(scope: 'acct' | 'ip', id: string): string {
    return `auth:admin:lock:${scope}:${id}`;
  }
}
