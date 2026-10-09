import { Module } from '@nestjs/common';
import { AuditModule } from './common/audit/audit.module';
import { AppConfigModule } from './config/config.module';
import { CacheModule } from './infrastructure/cache/cache.module';
import { DatabaseModule } from './infrastructure/database/database.module';
import { ObservabilityLoggerModule } from './infrastructure/observability/logger.module';
import { QueueModule } from './infrastructure/queue/queue.module';
import { NotificationsWorkerModule } from './modules/notifications/notifications.worker';
import { OutboxModule } from './common/outbox/outbox.module';

/**
 * Background-worker process: same codebase as the API, separate container (BEA p3). Each business module contributes its
 * queue consumers and loops here; today that is Notifications (outbox dispatch and delivery).
 */
@Module({
  imports: [
    AppConfigModule,
    ObservabilityLoggerModule,
    DatabaseModule,
    CacheModule,
    QueueModule,
    AuditModule,
    OutboxModule,
    NotificationsWorkerModule,
  ],
})
export class WorkerModule {}
