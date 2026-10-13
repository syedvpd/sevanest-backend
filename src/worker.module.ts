import { Module } from '@nestjs/common';
import { AuditModule } from './common/audit/audit.module';
import { AlertsModule } from './modules/alerts/alerts.module';
import { LegalModule } from './modules/legal/legal.module';
import { AppConfigModule } from './config/config.module';
import { CacheModule } from './infrastructure/cache/cache.module';
import { DatabaseModule } from './infrastructure/database/database.module';
import { ObservabilityLoggerModule } from './infrastructure/observability/logger.module';
import { QueueModule } from './infrastructure/queue/queue.module';
import { NotificationsWorkerModule } from './modules/notifications/notifications.worker';
import { IdempotencyModule } from './common/idempotency/idempotency.module';
import { OutboxModule } from './common/outbox/outbox.module';
import { BookingWorkerModule } from './modules/booking/booking.worker';
import { PaymentWorkerModule } from './modules/payment/payment.worker';
import { SupportWorkerModule } from './modules/support/support.worker';
import { VerificationWorkerModule } from './modules/verification/verification.worker';

/**
 * Background-worker process: same codebase as the API, separate container (BEA p3). Each business module contributes its
 * queue consumers and loops here; today that is Notifications (outbox dispatch and delivery), re-check reminders and payment recovery.
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
    IdempotencyModule,
    AlertsModule,
    LegalModule,
    NotificationsWorkerModule,
    VerificationWorkerModule,
    PaymentWorkerModule,
    BookingWorkerModule,
    SupportWorkerModule,
  ],
})
export class WorkerModule {}
