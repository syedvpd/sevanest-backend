import { createHash, createHmac, randomInt } from 'node:crypto';
import { HttpStatus, Inject, Injectable, Logger } from '@nestjs/common';
import { DomainException } from '../../common/errors/domain.exception';
import { AppConfigService, OtpSettings } from '../../config/app-config.service';
import { RedisService } from '../../infrastructure/cache/redis.service';
import { SMS_PROVIDER } from '../../integrations/notifications/notification-providers.interface';
import type { SmsProvider } from '../../integrations/notifications/notification-providers.interface';
import { ProviderError } from '../../integrations/provider-error';
import { AuthErrorCode } from './auth.errors';

/** Atomically INCR a counter and start its window on first use. Returns {count, secondsLeft}. */
const INCREMENT_WITH_WINDOW = `
local count = redis.call('INCR', KEYS[1])
if count == 1 then redis.call('EXPIRE', KEYS[1], ARGV[1]) end
return {count, redis.call('TTL', KEYS[1])}`;

/**
 * Atomically check an OTP guess. Counting the attempt and comparing happen in one step, so parallel guesses cannot
 * exceed the attempt limit. Returns {code, attempts}: 1 = match (verifier deleted, single use), 0 = wrong,
 * -1 = no verifier (expired or never requested), -2 = wrong and the attempt limit is now exhausted (verifier deleted).
 */
const VERIFY_ATTEMPT = `
local stored = redis.call('HGET', KEYS[1], 'h')
if not stored then return {-1, 0} end
local attempts = redis.call('HINCRBY', KEYS[1], 'a', 1)
if stored == ARGV[1] then redis.call('DEL', KEYS[1]) return {1, attempts} end
if attempts >= tonumber(ARGV[2]) then redis.call('DEL', KEYS[1]) return {-2, attempts} end
return {0, attempts}`;

export interface OtpIssueResult {
  expiresInSeconds: number;
  resendAfterSeconds: number;
}

type CounterReply = [number, number];

/**
 * Mobile OTP (FR-AUTH-001/003, FRD FM-01). Only a keyed hash of the OTP is stored, in Redis with a TTL; the OTP is
 * never logged and never returned. All numeric limits come from configuration (they are open business decisions).
 */
@Injectable()
export class OtpService {
  private readonly logger = new Logger(OtpService.name);
  private readonly settings: OtpSettings;

  constructor(
    private readonly redis: RedisService,
    private readonly config: AppConfigService,
    @Inject(SMS_PROVIDER) private readonly sms: SmsProvider,
  ) {
    this.settings = config.otp;
  }

  /**
   * Applies lock, per-IP, resend-cooldown and per-mobile limits, creates the OTP and sends it. `beforeIssue` runs
   * after the IP limit (so probing is rate-limited) and before anything is sent; it may throw to refuse.
   */
  async issue(
    mobile: string,
    clientIp: string,
    beforeIssue: () => Promise<void>,
  ): Promise<OtpIssueResult> {
    await this.redis.ensureConnected();
    const redis = this.redis.client;
    const keys = this.keys(mobile, clientIp);

    await this.assertNotLocked(keys.lock);

    const [ipCount, ipLeft] = await this.increment(keys.ipWindow, this.settings.sendWindowSeconds);
    if (ipCount > this.settings.maxRequestsPerIpPerWindow) {
      throw this.tooManyRequests(
        AuthErrorCode.OTP_RATE_LIMITED,
        'Too many OTP requests from this network. Please try again later.',
        ipLeft,
      );
    }

    await beforeIssue();

    const cooldownSet = await redis.set(
      keys.cooldown,
      '1',
      'EX',
      this.settings.resendCooldownSeconds,
      'NX',
    );
    if (cooldownSet === null) {
      const left = await redis.ttl(keys.cooldown);
      throw this.tooManyRequests(
        AuthErrorCode.OTP_RESEND_COOLDOWN,
        `Please wait ${Math.max(left, 1)} seconds before requesting another OTP.`,
        left,
      );
    }

    const [sendCount, sendLeft] = await this.increment(
      keys.mobileWindow,
      this.settings.sendWindowSeconds,
    );
    if (sendCount > this.settings.maxSendsPerMobilePerWindow) {
      await redis.del(keys.cooldown);
      throw this.tooManyRequests(
        AuthErrorCode.OTP_SEND_LIMIT,
        'OTP limit reached for this number. Please try again later.',
        sendLeft,
      );
    }

    const code = this.generateCode();
    await redis
      .multi()
      .del(keys.code)
      .hset(keys.code, 'h', this.hashCode(mobile, code), 'a', '0')
      .expire(keys.code, this.settings.ttlSeconds)
      .exec();

    try {
      await this.sms.sendSms({
        to: mobile,
        body: `${code} is your SevaNest verification code. Do not share it with anyone.`,
      });
    } catch (error) {
      // Let the user retry immediately: nothing was delivered. Counters keep counting (abuse protection).
      await redis.del(keys.code, keys.cooldown);
      const notConfigured = error instanceof ProviderError && !error.retryable;
      this.logger.warn(
        `OTP delivery failed (${notConfigured ? 'provider not configured/rejected' : 'provider error'})`,
      );
      throw new DomainException(
        notConfigured ? AuthErrorCode.SMS_NOT_CONFIGURED : AuthErrorCode.SMS_DELIVERY_FAILED,
        notConfigured
          ? 'OTP delivery is currently unavailable'
          : 'We could not send the OTP. Please try again.',
        HttpStatus.SERVICE_UNAVAILABLE,
      );
    }

    return {
      expiresInSeconds: this.settings.ttlSeconds,
      resendAfterSeconds: this.settings.resendCooldownSeconds,
    };
  }

  /** Single-use check. Throws a DomainException for every failure; returns normally only for a valid OTP. */
  async verify(mobile: string, code: string): Promise<void> {
    await this.redis.ensureConnected();
    const keys = this.keys(mobile, '');
    await this.assertNotLocked(keys.lock);

    const reply = (await this.redis.client.eval(
      VERIFY_ATTEMPT,
      1,
      keys.code,
      this.hashCode(mobile, code),
      String(this.settings.maxVerifyAttempts),
    )) as [number, number];
    const [outcome, attempts] = reply;

    if (outcome === 1) {
      return;
    }
    if (outcome === -1) {
      throw new DomainException(
        AuthErrorCode.OTP_EXPIRED,
        'The OTP has expired or was not requested. Please request a new one.',
        HttpStatus.BAD_REQUEST,
      );
    }
    if (outcome === -2) {
      await this.redis.client.set(keys.lock, '1', 'EX', this.settings.lockoutSeconds);
      throw this.tooManyRequests(
        AuthErrorCode.OTP_ATTEMPTS_EXCEEDED,
        'Too many incorrect attempts. Please try again later.',
        this.settings.lockoutSeconds,
      );
    }
    throw new DomainException(
      AuthErrorCode.OTP_INVALID,
      `The OTP is incorrect. ${Math.max(this.settings.maxVerifyAttempts - attempts, 0)} attempt(s) remaining.`,
      HttpStatus.BAD_REQUEST,
    );
  }

  private async assertNotLocked(lockKey: string): Promise<void> {
    const left = await this.redis.client.ttl(lockKey);
    if (left > 0) {
      throw this.tooManyRequests(
        AuthErrorCode.OTP_LOCKED,
        'Too many incorrect attempts. Please try again later.',
        left,
      );
    }
  }

  private async increment(key: string, windowSeconds: number): Promise<CounterReply> {
    return (await this.redis.client.eval(
      INCREMENT_WITH_WINDOW,
      1,
      key,
      String(windowSeconds),
    )) as CounterReply;
  }

  private tooManyRequests(
    code: string,
    message: string,
    retryAfterSeconds: number,
  ): DomainException {
    return new DomainException(code, message, HttpStatus.TOO_MANY_REQUESTS, [
      { field: 'retryAfterSeconds', messages: [String(Math.max(retryAfterSeconds, 1))] },
    ]);
  }

  private generateCode(): string {
    return randomInt(0, 10 ** this.settings.length)
      .toString()
      .padStart(this.settings.length, '0');
  }

  private hashCode(mobile: string, code: string): string {
    return createHmac('sha256', this.config.otpHmacSecret)
      .update(`${mobile}:${code}`)
      .digest('hex');
  }

  /** Keys carry a hash of the mobile so phone numbers do not appear in Redis key names. */
  private keys(mobile: string, clientIp: string) {
    const id = createHash('sha256').update(mobile).digest('hex').slice(0, 32);
    return {
      code: `auth:otp:code:${id}`,
      cooldown: `auth:otp:cooldown:${id}`,
      mobileWindow: `auth:otp:sends:${id}`,
      lock: `auth:otp:lock:${id}`,
      ipWindow: `auth:otp:ip:${clientIp}`,
    };
  }
}
