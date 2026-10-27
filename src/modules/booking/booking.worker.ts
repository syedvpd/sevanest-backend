import { reportError } from '../../common/observability/sentry';
import {
  Injectable,
  Logger,
  Module,
  OnApplicationBootstrap,
  OnModuleDestroy,
} from '@nestjs/common';
import { IdempotencyService } from '../../common/idempotency/idempotency.service';
import { HeartbeatService } from '../../infrastructure/cache/heartbeat.service';
import { BookingModule } from './booking.module';
import { BookingSweepService } from './booking-sweep.service';

/** Engineering default, not a business rule: how often the booking checks run. */
const INTERVAL_MS = 60_000;

/** Worker-process loop for the configured booking checks (worker no-response, unpaid bookings). Does nothing until a rule is configured. */
@Injectable()
export class BookingSweepLoop implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(BookingSweepLoop.name);
  private timer?: NodeJS.Timeout;
  // The delayed first run must be cancelled too: it would otherwise query a closed database after shutdown.
  private firstTick?: NodeJS.Timeout;
  private running = false;

  constructor(
    private readonly sweep: BookingSweepService,
    private readonly heartbeat: HeartbeatService,
    private readonly idempotency: IdempotencyService,
  ) {}

  onApplicationBootstrap(): void {
    this.timer = setInterval(() => void this.tick(), INTERVAL_MS);
    this.firstTick = setTimeout(() => void this.tick(), 15_000).unref();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
    clearTimeout(this.firstTick);
  }

  private async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      await this.heartbeat.beat('booking-checks');
      await this.idempotency.purgeExpired().catch(() => 0);
      const run = await this.sweep.runOnce();
      if (run.noResponseAlerts + run.stuckPaymentAlerts + run.autoCancelled + run.failed > 0) {
        this.logger.log(`Booking checks: ${JSON.stringify(run)}`);
      }
    } catch (error) {
      reportError(error, { job: 'booking' });
      this.logger.error(`Booking checks failed: ${(error as Error).message}`);
    } finally {
      this.running = false;
    }
  }
}

@Module({ imports: [BookingModule], providers: [BookingSweepLoop] })
export class BookingWorkerModule {}
