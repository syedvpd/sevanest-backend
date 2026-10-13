import { Injectable, Logger } from '@nestjs/common';
import { RedisService } from './redis.service';

const PREFIX = 'worker:heartbeat:';
/** Default: a loop that has not ticked for this long is considered stopped (loops that tick every minute). */
const TTL_SECONDS = 180;

/**
 * Proof of life for the background loops. Each loop calls `beat(name)` on every tick; the key expires on its own, so "no key" means
 * "that loop has not run recently" - the answer to "is my worker process running?" that no HTTP health check can give. Redis is
 * non-authoritative: a failed write is logged, never thrown, and never stops the loop.
 */
@Injectable()
export class HeartbeatService {
  private readonly logger = new Logger(HeartbeatService.name);

  constructor(private readonly redis: RedisService) {}

  /** `intervalMs` = how often the loop ticks; the heartbeat then lives for 2.5 ticks (never less than the default), so a slow loop is not reported as stopped between ticks. */
  async beat(name: string, intervalMs?: number): Promise<void> {
    const ttl = Math.max(TTL_SECONDS, Math.ceil(((intervalMs ?? 0) * 2.5) / 1000));
    try {
      await this.redis.ensureConnected();
      await this.redis.client.set(`${PREFIX}${name}`, new Date().toISOString(), 'EX', ttl);
    } catch (error) {
      this.logger.warn(`Heartbeat not recorded for ${name}: ${(error as Error).message}`);
    }
  }

  /** Loops seen recently, with when. `null` = Redis could not be read (unknown, not "stopped"). */
  async alive(): Promise<Array<{ name: string; lastSeen: string }> | null> {
    try {
      await this.redis.ensureConnected();
      const found: Array<{ name: string; lastSeen: string }> = [];
      let cursor = '0';
      do {
        const [next, keys] = await this.redis.client.scan(
          cursor,
          'MATCH',
          `${PREFIX}*`,
          'COUNT',
          100,
        );
        cursor = next;
        for (const key of keys) {
          const value = await this.redis.client.get(key);
          if (value) found.push({ name: key.slice(PREFIX.length), lastSeen: value });
        }
      } while (cursor !== '0');
      return found.sort((a, b) => a.name.localeCompare(b.name));
    } catch {
      return null;
    }
  }
}
