import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { AppConfigService } from '../../config/app-config.service';
import { MessagingProviderKind } from '../../config/env.validation';
import {
  DisabledPushProvider,
  DisabledWhatsAppProvider,
  InMemoryPushProvider,
  InMemoryWhatsAppProvider,
} from '../../integrations/notifications/messaging-providers';
import {
  PUSH_PROVIDER,
  WHATSAPP_PROVIDER,
} from '../../integrations/notifications/notification-providers.interface';
import { QueueModule } from '../../infrastructure/queue/queue.module';
import { AuthModule } from '../auth/auth.module';
import { UsersModule } from '../users/users.module';
import { AdminNotificationsController } from './notifications.controller';
import { NOTIFICATION_QUEUE } from './notifications.constants';
import { NotificationsRepository } from './notifications.repository';
import { NotificationsService } from './notifications.service';

/**
 * Notifications: templates, the delivery log, outbox dispatch and delivery. Depends on Users and Auth (SMS adapter, device
 * tokens) and on the shared outbox; business modules never import it - they only write outbox events. The queue consumer
 * and the dispatch loop run in the worker process (`NotificationsWorkerModule`), not in the API process.
 */
@Module({
  imports: [
    QueueModule,
    BullModule.registerQueue({ name: NOTIFICATION_QUEUE }),
    UsersModule,
    AuthModule,
  ],
  controllers: [AdminNotificationsController],
  providers: [
    NotificationsRepository,
    NotificationsService,
    {
      provide: PUSH_PROVIDER,
      inject: [AppConfigService],
      useFactory: (config: AppConfigService) =>
        config.pushProvider === MessagingProviderKind.Memory
          ? new InMemoryPushProvider()
          : new DisabledPushProvider(),
    },
    {
      provide: WHATSAPP_PROVIDER,
      inject: [AppConfigService],
      useFactory: (config: AppConfigService) =>
        config.whatsappProvider === MessagingProviderKind.Memory
          ? new InMemoryWhatsAppProvider()
          : new DisabledWhatsAppProvider(),
    },
  ],
  exports: [NotificationsService],
})
export class NotificationsModule {}
