import {
  Injectable,
  Logger,
  Module,
  OnApplicationBootstrap,
  OnModuleDestroy,
} from '@nestjs/common';
import { reportError } from '../../common/observability/sentry';
import { AppConfigService } from '../../config/app-config.service';
import { HeartbeatService } from '../../infrastructure/cache/heartbeat.service';
import { RetentionModule } from './retention.module';
import { RetentionService } from './retention.service';

/** Engineering default: how often the loop wakes up. The real period is RETENTION_INTERVAL_MINUTES, and nothing runs unless RETENTION_ENABLED. */
const TICK_MS = 60_000;

/** Worker-process loop for the retention run (DEC-08). Beats its heartbeat every tick so a stopped worker is visible even while the feature is off. */
@Injectable()
export class RetentionLoop implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(RetentionLoop.name);
  private timer?: NodeJS.Timeout;
  private running = false;
  private lastRunAt = 0;

  constructor(
    private readonly retention: RetentionService,
    private readonly heartbeat: HeartbeatService,
    private readonly config: AppConfigService,
  ) {}

  onApplicationBootstrap(): void {
    this.timer = setInterval(() => void this.tick(), TICK_MS);
    setTimeout(() => void this.tick(), 45_000).unref();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  private async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      await this.heartbeat.beat('retention');
      const settings = this.config.retention;
      if (!settings.enabled) return;
      if (Date.now() - this.lastRunAt < settings.intervalMinutes * 60_000) return;
      this.lastRunAt = Date.now();
      const report = await this.retention.runOnce();
      const total = report.tasks.reduce((n, t) => n + (report.dryRun ? t.matched : t.affected), 0);
      this.logger.log(
        `Retention run (${report.dryRun ? 'dry run' : 'live'}): ${total} item(s), deletions ${JSON.stringify(report.deletions)}`,
      );
    } catch (error) {
      reportError(error, { job: 'retention' });
      this.logger.error(`Retention run failed: ${(error as Error).message}`);
    } finally {
      this.running = false;
    }
  }
}

@Module({ imports: [RetentionModule], providers: [RetentionLoop] })
export class RetentionWorkerModule {}
