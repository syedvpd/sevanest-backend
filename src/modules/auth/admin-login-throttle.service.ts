import { createHash } from 'node:crypto';
import { HttpStatus, Injectable } from '@nestjs/common';
import { DomainException } from '../../common/errors/domain.exception';
import { AdminLoginSettings, AppConfigService } from '../../config/app-config.service';
import { RedisService } from '../../infrastructure/cache/redis.service';
import { AuthErrorCode } from './auth.errors';

/**
 * Atomically checks the account lock and takes one attempt slot for the account. KEYS: lock:acct, fail:acct.
 * ARGV: window seconds, max attempts, lockout seconds. Returns {allowed, retryAfterSeconds, lastAllowed}.
 * A slot is taken BEFORE the slow password hash runs, so concurrent requests cannot all pass a stale "not locked" check.
 * Lockout is intentionally scoped per account (not shared client IP) so failed attempts against one account never block
 * unrelated admin accounts sharing a corporate/NAT/proxy IP; short-window IP flooding is handled by the adminAuth rate limit.
 */
const RESERVE_ATTEMPT = `
local ttl = redis.call('TTL', KEYS[1])
if ttl > 0 then return {0, ttl, 0} end
local max = tonumber(ARGV[2])
local count = redis.call('INCR', KEYS[2])
if count == 1 then redis.call('EXPIRE', KEYS[2], ARGV[1]) end
if count > max then
  redis.call('SET', KEYS[1], '1', 'EX', ARGV[3])
  redis.call('DEL', KEYS[2])
  return {0, tonumber(ARGV[3]), 0}
end
local last = 0
if count == max then last = 1 end
return {1, 0, last}`;

/** Success: clears the account failure counter. KEYS: fail:acct. */
const RELEASE_ATTEMPT = `
redis.call('DEL', KEYS[1])
return 1`;

export interface AttemptReservation {
  /** True when this attempt used the last allowed slot: the next attempt in the window is refused. */
  lastAllowed: boolean;
}

/**
 * Brute-force protection for admin credential login (NFR-SEC-008, BEA p5). Every attempt reserves a slot per account (email)
 * inside a window; once the configured maximum is used, that account is locked for the configured duration without locking the
 * shared client IP. Counters live in Redis (non-authoritative): losing them only resets the protection window, never a business
 * record. Redis errors propagate, so the login fails closed.
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
    return createHash('sha256').update(email.trim().toLowerCase()).digest('hex').slice(0, 32);
  }

  /**
   * Takes an attempt slot or throws 429 while the account is locked / out of attempts.
   * Call it before verifying the password; call {@link release} only after a successful authentication.
   */
  async reserve(accountKey: string, _clientIp?: string): Promise<AttemptReservation> {
    await this.redis.ensureConnected();
    const [allowed, retryAfter, last] = (await this.redis.client.eval(
      RESERVE_ATTEMPT,
      2,
      this.lockKey(accountKey),
      this.failKey(accountKey),
      String(this.settings.failureWindowSeconds),
      String(this.settings.maxFailures),
      String(this.settings.lockoutSeconds),
    )) as [number, number, number];
    if (allowed !== 1) {
      throw new DomainException(
        AuthErrorCode.ADMIN_LOGIN_LOCKED,
        'Too many failed login attempts. Please try again later.',
        HttpStatus.TOO_MANY_REQUESTS,
        [{ field: 'retryAfterSeconds', messages: [String(Math.max(Number(retryAfter) || 1, 1))] }],
      );
    }
    return { lastAllowed: last === 1 };
  }

  /** A successful login clears the account's failure counter. */
  async release(accountKey: string, _clientIp?: string): Promise<void> {
    await this.redis.ensureConnected();
    await this.redis.client.eval(RELEASE_ATTEMPT, 1, this.failKey(accountKey));
  }

  private failKey(id: string): string {
    return `auth:admin:fail:acct:${id}`;
  }

  private lockKey(id: string): string {
    return `auth:admin:lock:acct:${id}`;
  }
}
