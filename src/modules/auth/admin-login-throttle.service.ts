import { createHash } from 'node:crypto';
import { HttpStatus, Injectable, Logger } from '@nestjs/common';
import { DomainException } from '../../common/errors/domain.exception';
import { ErrorCode } from '../../common/errors/error-codes';
import { AdminLoginSettings, AppConfigService } from '../../config/app-config.service';
import { RedisService } from '../../infrastructure/cache/redis.service';
import { AuthErrorCode } from './auth.errors';

/**
 * Atomically checks the account lock and takes one attempt slot for the account.
 * KEYS: [1] lock:acct, [2] fail:acct
 * ARGV: [1] window seconds, [2] max attempts, [3] lockout seconds
 * Returns {allowed, retryAfterSeconds, lastAllowed}.
 */
const RESERVE_ACCOUNT_ATTEMPT = `
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

/**
 * Atomically checks IP rate-limiting window and records one attempt for the IP.
 * KEYS: [1] ipWindow
 * ARGV: [1] window seconds, [2] max requests per IP window
 * Returns {allowed, retryAfterSeconds, currentCount}.
 */
const RESERVE_IP_ATTEMPT = `
local count = redis.call('INCR', KEYS[1])
local ttl = redis.call('TTL', KEYS[1])
if count == 1 or ttl < 0 then
  redis.call('EXPIRE', KEYS[1], ARGV[1])
  ttl = tonumber(ARGV[1])
end
local max = tonumber(ARGV[2])
if count > max then
  return {0, math.max(ttl, 1), count}
end
return {1, 0, count}`;

/** Success: clears the account failure counter. KEYS: fail:acct. */
const RELEASE_ATTEMPT = `
redis.call('DEL', KEYS[1])
return 1`;

export interface AttemptReservation {
  /** True when this attempt used the last allowed slot: the next attempt in the window is refused. */
  lastAllowed: boolean;
}

/**
 * Brute-force protection for admin credential login (NFR-SEC-008, BEA p5).
 * Applies dual-tier complementary protection:
 *
 * A. Account-based limiter:
 * Every attempt reserves a slot per account (HMAC/SHA-256 derived identifier).
 * Once maxFailures is exceeded, the account is locked for lockoutSeconds without locking unrelated admin accounts.
 *
 * B. Client IP-based limiter:
 * Every attempt reserves an IP slot in Redis (`auth:admin:req:ip:<trusted_ip>`).
 * Protects authentication services from distributed or brute-force flooding from a single source.
 *
 * Redis errors fail closed so brute-force protection cannot be silently bypassed.
 */
@Injectable()
export class AdminLoginThrottle {
  private readonly logger = new Logger(AdminLoginThrottle.name);
  private readonly settings: AdminLoginSettings;
  private readonly ipWindowSeconds: number;
  private readonly maxRequestsPerIp: number;

  constructor(
    private readonly redis: RedisService,
    config: AppConfigService,
  ) {
    this.settings = config.adminLogin;
    this.ipWindowSeconds = config.adminAuthThrottle.ttlMs / 1000;
    this.maxRequestsPerIp = config.adminAuthThrottle.limit;
  }

  static accountKey(email: string): string {
    return createHash('sha256').update(email.trim().toLowerCase()).digest('hex').slice(0, 32);
  }

  static ipKey(ip: string): string {
    return createHash('sha256')
      .update((ip || 'unknown').trim().toLowerCase())
      .digest('hex')
      .slice(0, 32);
  }

  /**
   * Takes an attempt slot across both IP and account limits.
   * Throws 429 if the IP quota is exhausted or the account is locked out.
   */
  async reserve(accountKey: string, clientIp: string = 'unknown'): Promise<AttemptReservation> {
    await this.redis.ensureConnected();

    // 1. IP-level rate-limit check (protects authentication service from flooding from a single IP)
    if (clientIp && clientIp !== 'unknown') {
      const ipHashed = AdminLoginThrottle.ipKey(clientIp);
      const [ipAllowed, ipRetryAfter] = (await this.redis.client.eval(
        RESERVE_IP_ATTEMPT,
        1,
        this.ipKeyRedis(ipHashed),
        String(this.ipWindowSeconds),
        String(this.maxRequestsPerIp),
      )) as [number, number, number];

      if (ipAllowed !== 1) {
        const cooldown = Math.max(Number(ipRetryAfter) || 1, 1);
        this.logger.warn({
          msg: 'Admin login rate limited by client IP',
          category: 'IP',
          cooldown,
        });
        throw new DomainException(
          ErrorCode.RATE_LIMITED,
          'Too many login requests from this network. Please try again later.',
          HttpStatus.TOO_MANY_REQUESTS,
          [{ field: 'retryAfterSeconds', messages: [String(cooldown)] }],
        );
      }
    }

    // 2. Account-level lockout check (prevents brute-forcing an individual admin account)
    const [allowed, retryAfter, last] = (await this.redis.client.eval(
      RESERVE_ACCOUNT_ATTEMPT,
      2,
      this.lockKey(accountKey),
      this.failKey(accountKey),
      String(this.settings.failureWindowSeconds),
      String(this.settings.maxFailures),
      String(this.settings.lockoutSeconds),
    )) as [number, number, number];

    if (allowed !== 1) {
      const cooldown = Math.max(Number(retryAfter) || 1, 1);
      this.logger.warn({
        msg: 'Admin login locked by account lockout policy',
        category: 'ACCOUNT',
        cooldown,
      });
      throw new DomainException(
        AuthErrorCode.ADMIN_LOGIN_LOCKED,
        'Too many failed login attempts. Please try again later.',
        HttpStatus.TOO_MANY_REQUESTS,
        [{ field: 'retryAfterSeconds', messages: [String(cooldown)] }],
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

  private ipKeyRedis(hashedIp: string): string {
    return `auth:admin:req:ip:${hashedIp}`;
  }
}
