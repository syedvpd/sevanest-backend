import {
  Injectable,
  Logger,
  Module,
  OnApplicationBootstrap,
  OnModuleDestroy,
} from '@nestjs/common';
import { HeartbeatService } from '../../infrastructure/cache/heartbeat.service';
import { VerificationModule } from './verification.module';
import { VerificationService } from './verification.service';

/** Engineering default, not a business rule: how often the re-check reminder loop looks for due checks. */
const INTERVAL_MS = 5 * 60 * 1000;

/** Worker-process loop that sends the "re-check due" reminder once per due date. Never changes a verification. */
@Injectable()
export class RecheckDueLoop implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(RecheckDueLoop.name);
  private timer?: NodeJS.Timeout;
  private running = false;

  constructor(
    private readonly verification: VerificationService,
    private readonly heartbeat: HeartbeatService,
  ) {}

  onApplicationBootstrap(): void {
    this.timer = setInterval(() => void this.tick(), INTERVAL_MS);
    void this.tick();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  private async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      await this.heartbeat.beat('recheck-reminders', INTERVAL_MS);
      const reminded = await this.verification.notifyRecheckDue();
      if (reminded > 0) this.logger.log(`Re-check reminders queued: ${reminded}`);
    } catch (error) {
      this.logger.error(`Re-check reminder run failed: ${(error as Error).message}`);
    } finally {
      this.running = false;
    }
  }
}

/** Engineering defaults, not retention rules: an upload still unconfirmed after a day is discarded; the sweeper runs every 15 minutes. */
const ABANDONED_AFTER_MS = 24 * 60 * 60 * 1000;
const SWEEP_INTERVAL_MS = 15 * 60 * 1000;

/** Deletes objects of uploads that were never confirmed. Confirmed documents are never touched. */
@Injectable()
export class AbandonedUploadLoop implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(AbandonedUploadLoop.name);
  private timer?: NodeJS.Timeout;
  private running = false;

  constructor(
    private readonly verification: VerificationService,
    private readonly heartbeat: HeartbeatService,
  ) {}

  onApplicationBootstrap(): void {
    this.timer = setInterval(() => void this.tick(), SWEEP_INTERVAL_MS);
    setTimeout(() => void this.tick(), 25_000).unref();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  private async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      await this.heartbeat.beat('abandoned-uploads', SWEEP_INTERVAL_MS);
      const purged = await this.verification.purgeAbandonedUploads(ABANDONED_AFTER_MS);
      if (purged > 0) this.logger.log(`Abandoned uploads discarded: ${purged}`);
    } catch (error) {
      this.logger.error(`Abandoned-upload sweep failed: ${(error as Error).message}`);
    } finally {
      this.running = false;
    }
  }
}

@Module({ imports: [VerificationModule], providers: [RecheckDueLoop, AbandonedUploadLoop] })
export class VerificationWorkerModule {}
