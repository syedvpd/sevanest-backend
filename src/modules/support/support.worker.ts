import { reportError } from '../../common/observability/sentry';
import {
  Injectable,
  Logger,
  Module,
  OnApplicationBootstrap,
  OnModuleDestroy,
} from '@nestjs/common';
import { HeartbeatService } from '../../infrastructure/cache/heartbeat.service';
import { SupportModule } from './support.module';
import { SupportService } from './support.service';

/** Engineering default, not a business rule: how often resolution targets are checked. */
const INTERVAL_MS = 60_000;

/** Worker-process loop that flags tickets past their configured resolution target. Does nothing when no SUPPORT_SLA_HOURS_* is set. */
@Injectable()
export class SupportSlaLoop implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(SupportSlaLoop.name);
  private timer?: NodeJS.Timeout;
  private running = false;

  constructor(
    private readonly support: SupportService,
    private readonly heartbeat: HeartbeatService,
  ) {}

  onApplicationBootstrap(): void {
    this.timer = setInterval(() => void this.tick(), INTERVAL_MS);
    setTimeout(() => void this.tick(), 20_000).unref();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  private async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      await this.heartbeat.beat('support-sla');
      const flagged = await this.support.flagSlaBreaches();
      if (flagged > 0) this.logger.log(`Support tickets past their resolution target: ${flagged}`);
    } catch (error) {
      reportError(error, { job: 'support' });
      this.logger.error(`Support SLA check failed: ${(error as Error).message}`);
    } finally {
      this.running = false;
    }
  }
}

@Module({ imports: [SupportModule], providers: [SupportSlaLoop] })
export class SupportWorkerModule {}
