import { createHash } from 'node:crypto';
import { HttpStatus, Injectable } from '@nestjs/common';
import { DomainException } from '../../common/errors/domain.exception';
import { AdminLoginSettings, AppConfigService } from '../../config/app-config.service';
import { RedisService } from '../../infrastructure/cache/redis.service';
import { AuthErrorCode } from './auth.errors';

const INCREMENT_WITH_WINDOW = `
local count = redis.call('INCR', KEYS[1])
if count == 1 then redis.call('EXPIRE', KEYS[1], ARGV[1]) end
return count`;

/**
 * Brute-force protection for admin credential login (NFR-SEC-008, BEA p5). Failures are counted per account (email)
 * and per client IP inside a window; reaching the configured maximum locks that key for the configured duration.
 * Counters live in Redis (non-authoritative): losing them only resets the protection window, never a business record.
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

  /** Throws 429 while either the account or the IP is locked. Does not reveal which one. */
  async assertNotLocked(accountKey: string, clientIp: string): Promise<void> {
    await this.redis.ensureConnected();
    const [account, ip] = await Promise.all([
      this.redis.client.ttl(this.lockKey('acct', accountKey)),
      this.redis.client.ttl(this.lockKey('ip', clientIp)),
    ]);
    const left = Math.max(account, ip);
    if (left > 0) {
      throw new DomainException(
        AuthErrorCode.ADMIN_LOGIN_LOCKED,
        'Too many failed login attempts. Please try again later.',
        HttpStatus.TOO_MANY_REQUESTS,
        [{ field: 'retryAfterSeconds', messages: [String(left)] }],
      );
    }
  }

  /** Records a failed attempt. Returns true when this failure caused a lockout of the account or the IP. */
  async recordFailure(accountKey: string, clientIp: string): Promise<boolean> {
    await this.redis.ensureConnected();
    let lockedNow = false;
    for (const [scope, id] of [
      ['acct', accountKey],
      ['ip', clientIp],
    ] as const) {
      const count = (await this.redis.client.eval(
        INCREMENT_WITH_WINDOW,
        1,
        this.failKey(scope, id),
        String(this.settings.failureWindowSeconds),
      )) as number;
      if (count >= this.settings.maxFailures) {
        await this.redis.client.set(
          this.lockKey(scope, id),
          '1',
          'EX',
          this.settings.lockoutSeconds,
        );
        lockedNow = true;
      }
    }
    return lockedNow;
  }

  /** A successful login clears the account's failure counter (the IP counter keeps running its window). */
  async reset(accountKey: string): Promise<void> {
    await this.redis.ensureConnected();
    await this.redis.client.del(this.failKey('acct', accountKey));
  }

  private failKey(scope: 'acct' | 'ip', id: string): string {
    return `auth:admin:fail:${scope}:${id}`;
  }

  private lockKey(scope: 'acct' | 'ip', id: string): string {
    return `auth:admin:lock:${scope}:${id}`;
  }
}
