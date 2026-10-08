import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import Redis from 'ioredis';
import { AppConfigService } from '../../config/app-config.service';

/**
 * Redis access for NON-AUTHORITATIVE data only: throttling counters, OTP attempt state, caches, short-lived locks.
 * Never store booking, payment, verification or other business truth here; PostgreSQL owns that.
 */
@Injectable()
export class RedisService implements OnModuleDestroy {
  private readonly logger = new Logger(RedisService.name);
  readonly client: Redis;

  constructor(config: AppConfigService) {
    this.client = new Redis(config.redisUrl, {
      lazyConnect: true,
      connectTimeout: 5000,
      maxRetriesPerRequest: 2,
      enableOfflineQueue: false,
    });
    // Without a listener ioredis would throw on connection errors. Outages are reported by /health/ready.
    this.client.on('error', (error: Error) => this.logger.warn(`Redis error: ${error.message}`));
  }

  async ping(): Promise<void> {
    if (this.client.status === 'wait' || this.client.status === 'end') {
      await this.client.connect();
    }
    const reply = await this.client.ping();
    if (reply !== 'PONG') {
      throw new Error('Unexpected Redis PING reply');
    }
  }

  async onModuleDestroy(): Promise<void> {
    if (this.client.status !== 'end') {
      await this.client.quit().catch(() => this.client.disconnect());
    }
  }
}
