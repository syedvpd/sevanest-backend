import { Logger } from '@nestjs/common';
import { ThrottlerStorage, ThrottlerStorageService } from '@nestjs/throttler';
import { RedisService } from './redis.service';

/**
 * Fixed-window counter shared by every API replica (the in-memory default multiplies the limit by the replica count).
 * One atomic Lua script per hit. Redis is non-authoritative: if it is unreachable the request is counted in this process's
 * memory instead (degraded to per-replica limits, logged) rather than failing every request.
 */
const SCRIPT = `
local hits = redis.call('INCR', KEYS[1])
local ttl = redis.call('PTTL', KEYS[1])
if hits == 1 or ttl < 0 then
  redis.call('PEXPIRE', KEYS[1], ARGV[1])
  ttl = tonumber(ARGV[1])
end
local blocked = 0
local blockTtl = redis.call('PTTL', KEYS[2])
if blockTtl > 0 then
  blocked = 1
elseif hits > tonumber(ARGV[2]) and tonumber(ARGV[3]) > 0 then
  redis.call('SET', KEYS[2], '1', 'PX', ARGV[3])
  blocked = 1
  blockTtl = tonumber(ARGV[3])
end
return {hits, ttl, blocked, blockTtl}
`;

type ThrottlerStorageRecord = Awaited<ReturnType<ThrottlerStorage['increment']>>;

export class RedisThrottlerStorage implements ThrottlerStorage {
  private readonly logger = new Logger(RedisThrottlerStorage.name);
  private readonly fallback = new ThrottlerStorageService();
  private lastWarningAt = 0;

  constructor(private readonly redis: RedisService) {}

  async increment(
    key: string,
    ttl: number,
    limit: number,
    blockDuration: number,
    throttlerName: string,
  ): Promise<ThrottlerStorageRecord> {
    try {
      await this.redis.ensureConnected();
      const base = `throttle:${throttlerName}:${key}`;
      const reply = (await this.redis.client.eval(
        SCRIPT,
        2,
        base,
        `${base}:block`,
        String(ttl),
        String(limit),
        String(blockDuration),
      )) as [number, number, number, number];
      return {
        totalHits: Number(reply[0]),
        timeToExpire: Math.ceil(Number(reply[1]) / 1000),
        isBlocked: Number(reply[2]) === 1,
        timeToBlockExpire: Math.ceil(Number(reply[3]) / 1000),
      };
    } catch (error) {
      const now = Date.now();
      if (now - this.lastWarningAt > 60_000) {
        this.lastWarningAt = now;
        this.logger.warn(
          `Redis rate-limit storage unavailable, counting in process memory: ${error instanceof Error ? error.message : 'unknown error'}`,
        );
      }
      return this.fallback.increment(key, ttl, limit, blockDuration, throttlerName);
    }
  }
}
