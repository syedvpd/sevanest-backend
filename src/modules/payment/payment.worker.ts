import { reportError } from '../../common/observability/sentry';
import {
  Injectable,
  Logger,
  Module,
  OnApplicationBootstrap,
  OnModuleDestroy,
} from '@nestjs/common';
import { HeartbeatService } from '../../infrastructure/cache/heartbeat.service';
import { PaymentModule } from './payment.module';
import { PaymentRecoveryService } from './payment-recovery.service';

/** Engineering default, not a business rule: how often the recovery sweeper looks for due payment checks. */
const INTERVAL_MS = 60_000;

/**
 * Worker-process loop for payment recovery: lost-webhook reconciliation, pending refunds, late payments on cancelled bookings and
 * webhooks that raced ahead of their order. The state lives in PostgreSQL (rows claimed atomically), so a restart loses nothing,
 * several workers never process the same payment, and Redis is not involved.
 */
@Injectable()
export class PaymentRecoveryLoop implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(PaymentRecoveryLoop.name);
  private timer?: NodeJS.Timeout;
  private running = false;

  constructor(
    private readonly recovery: PaymentRecoveryService,
    private readonly heartbeat: HeartbeatService,
  ) {}

  onApplicationBootstrap(): void {
    this.timer = setInterval(() => void this.tick(), INTERVAL_MS);
    setTimeout(() => void this.tick(), 10_000).unref();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  private async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      await this.heartbeat.beat('payment-recovery');
      const run = await this.recovery.runOnce();
      if (run.claimed + run.replayed + run.escalated + run.flaggedCancelled + run.failed > 0) {
        this.logger.log(`Payment recovery: ${JSON.stringify(run)}`);
      }
    } catch (error) {
      reportError(error, { job: 'payment' });
      this.logger.error(`Payment recovery run failed: ${(error as Error).message}`);
    } finally {
      this.running = false;
    }
  }
}

@Module({ imports: [PaymentModule], providers: [PaymentRecoveryLoop] })
export class PaymentWorkerModule {}
