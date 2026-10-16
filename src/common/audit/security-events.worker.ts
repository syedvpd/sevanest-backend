import {
  Injectable,
  Logger,
  Module,
  OnApplicationBootstrap,
  OnModuleDestroy,
} from '@nestjs/common';
import { HeartbeatService } from '../../infrastructure/cache/heartbeat.service';
import { reportError } from '../observability/sentry';
import { SecurityEventService } from './security-events.service';

/** Engineering default: how often the counts of finished minutes are written. */
const INTERVAL_MS = 60_000;

/** Worker-process loop that writes the collapsed refusal counts (see SecurityEventService). */
@Injectable()
export class SecurityEventsLoop implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(SecurityEventsLoop.name);
  private timer?: NodeJS.Timeout;
  private running = false;

  constructor(
    private readonly events: SecurityEventService,
    private readonly heartbeat: HeartbeatService,
  ) {}

  onApplicationBootstrap(): void {
    this.timer = setInterval(() => void this.tick(), INTERVAL_MS);
    setTimeout(() => void this.tick(), 30_000).unref();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  private async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      await this.heartbeat.beat('security-events');
      const written = await this.events.flushSuppressed();
      if (written > 0) this.logger.log(`Collapsed access-denied counts written: ${written}`);
    } catch (error) {
      reportError(error, { job: 'security-events' });
      this.logger.error(`Security events flush failed: ${(error as Error).message}`);
    } finally {
      this.running = false;
    }
  }
}

@Module({ providers: [SecurityEventsLoop] })
export class SecurityEventsWorkerModule {}
