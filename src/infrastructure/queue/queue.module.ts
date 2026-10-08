import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { AppConfigService } from '../../config/app-config.service';
import { DEFAULT_JOB_OPTIONS } from './queue.constants';
import { redisConnectionFromUrl } from './redis-connection';

/**
 * BullMQ infrastructure only. No queues are registered here: each business module registers and owns its queues
 * (e.g. notification delivery, payment reconciliation) when that module is implemented.
 */
@Module({
  imports: [
    BullModule.forRootAsync({
      inject: [AppConfigService],
      useFactory: (config: AppConfigService) => ({
        connection: redisConnectionFromUrl(config.redisUrl),
        defaultJobOptions: DEFAULT_JOB_OPTIONS,
      }),
    }),
  ],
  exports: [BullModule],
})
export class QueueModule {}
