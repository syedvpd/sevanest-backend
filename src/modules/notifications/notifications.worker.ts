import { Processor, WorkerHost } from '@nestjs/bullmq';
import {
  Injectable,
  Logger,
  Module,
  OnApplicationBootstrap,
  OnModuleDestroy,
} from '@nestjs/common';
import type { Job } from 'bullmq';
import { NOTIFICATION_QUEUE } from './notifications.constants';
import { NotificationsModule } from './notifications.module';
import { NotificationsService } from './notifications.service';

/** Delivers one queued notification. A thrown error makes BullMQ retry with the platform backoff (queue.constants). */
@Processor(NOTIFICATION_QUEUE)
export class NotificationProcessor extends WorkerHost {
  constructor(private readonly notifications: NotificationsService) {
    super();
  }

  async process(job: Job<{ notificationId: string }>): Promise<string> {
    return this.notifications.deliver(job.data.notificationId, {
      number: job.attemptsMade + 1,
      max: job.opts.attempts ?? 1,
    });
  }
}

/**
 * Turns outbox events into queued notifications on a short interval (and re-offers stale ones). The interval is an
 * engineering default, not a business rule. Only the worker process runs it.
 */
@Injectable()
export class NotificationDispatchLoop implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(NotificationDispatchLoop.name);
  private timer?: NodeJS.Timeout;
  private running = false;

  constructor(private readonly notifications: NotificationsService) {}

  onApplicationBootstrap(): void {
    this.timer = setInterval(() => void this.tick(), 5_000);
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  private async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      await this.notifications.dispatchOutbox();
      await this.notifications.requeueStale();
    } catch (error) {
      this.logger.error(`Notification dispatch failed: ${(error as Error).message}`);
    } finally {
      this.running = false;
    }
  }
}

@Module({
  imports: [NotificationsModule],
  providers: [NotificationProcessor, NotificationDispatchLoop],
})
export class NotificationsWorkerModule {}
