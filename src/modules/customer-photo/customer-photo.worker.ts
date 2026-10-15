import {
  Injectable,
  Logger,
  Module,
  OnApplicationBootstrap,
  OnModuleDestroy,
} from '@nestjs/common';
import { reportError } from '../../common/observability/sentry';
import { HeartbeatService } from '../../infrastructure/cache/heartbeat.service';
import { CustomerPhotoModule } from './customer-photo.module';
import { CustomerPhotoService } from './customer-photo.service';

/** Engineering defaults, not retention rules: an upload still unconfirmed after a day is discarded; the sweeper runs every 15 minutes. */
const ABANDONED_AFTER_MS = 24 * 60 * 60 * 1000;
const SWEEP_INTERVAL_MS = 15 * 60 * 1000;

/** Deletes the objects and rows of photo uploads that were never confirmed. Confirmed photos are never touched. */
@Injectable()
export class CustomerPhotoSweepLoop implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(CustomerPhotoSweepLoop.name);
  private timer?: NodeJS.Timeout;
  private running = false;

  constructor(
    private readonly photos: CustomerPhotoService,
    private readonly heartbeat: HeartbeatService,
  ) {}

  onApplicationBootstrap(): void {
    this.timer = setInterval(() => void this.tick(), SWEEP_INTERVAL_MS);
    setTimeout(() => void this.tick(), 35_000).unref();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  private async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      await this.heartbeat.beat('customer-photo-sweep', SWEEP_INTERVAL_MS);
      const purged = await this.photos.purgeAbandonedUploads(ABANDONED_AFTER_MS);
      if (purged > 0) this.logger.log(`Abandoned customer photo uploads discarded: ${purged}`);
    } catch (error) {
      reportError(error, { job: 'customer-photo' });
      this.logger.error(`Customer photo sweep failed: ${(error as Error).message}`);
    } finally {
      this.running = false;
    }
  }
}

@Module({ imports: [CustomerPhotoModule], providers: [CustomerPhotoSweepLoop] })
export class CustomerPhotoWorkerModule {}
