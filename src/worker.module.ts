import { Module } from '@nestjs/common';
import { AuditModule } from './common/audit/audit.module';
import { AppConfigModule } from './config/config.module';
import { CacheModule } from './infrastructure/cache/cache.module';
import { DatabaseModule } from './infrastructure/database/database.module';
import { ObservabilityLoggerModule } from './infrastructure/observability/logger.module';
import { QueueModule } from './infrastructure/queue/queue.module';

/**
 * Background-worker process: same codebase as the API, separate container (BEA p3). It currently registers no
 * processors. Each business module contributes its queue consumers when that module is implemented.
 */
@Module({
  imports: [
    AppConfigModule,
    ObservabilityLoggerModule,
    DatabaseModule,
    CacheModule,
    QueueModule,
    AuditModule,
  ],
})
export class WorkerModule {}
