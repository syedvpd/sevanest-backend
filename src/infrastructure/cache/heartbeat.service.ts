import { Injectable, Logger } from '@nestjs/common';
import { RedisService } from './redis.service';

const PREFIX = 'worker:heartbeat:';
/** A loop that has not ticked for this long is considered stopped. Loops tick at least once a minute. */
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

  async beat(name: string): Promise<void> {
    try {
      await this.redis.ensureConnected();
      await this.redis.client.set(`${PREFIX}${name}`, new Date().toISOString(), 'EX', TTL_SECONDS);
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
