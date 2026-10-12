import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { AppConfigService } from '../../config/app-config.service';
import { MessagingProviderKind, WhatsAppProviderKind } from '../../config/env.validation';
import {
  DisabledPushProvider,
  DisabledWhatsAppProvider,
  InMemoryPushProvider,
  InMemoryWhatsAppProvider,
} from '../../integrations/notifications/messaging-providers';
import {
  PUSH_PROVIDER,
  WHATSAPP_PROVIDER,
  type PushProvider,
  type WhatsAppProvider,
} from '../../integrations/notifications/notification-providers.interface';
import {
  FcmPushProvider,
  parseFcmServiceAccount,
} from '../../integrations/notifications/fcm.provider';
import { TwilioWhatsAppProvider } from '../../integrations/notifications/twilio.provider';
import { QueueModule } from '../../infrastructure/queue/queue.module';
import { AuthModule } from '../auth/auth.module';
import { UsersModule } from '../users/users.module';
import { AdminNotificationsController, InboxController } from './notifications.controller';
import { NOTIFICATION_QUEUE } from './notifications.constants';
import { NotificationsRepository } from './notifications.repository';
import { NotificationsService } from './notifications.service';

function whatsAppProviderFor(config: AppConfigService): WhatsAppProvider {
  switch (config.whatsappProvider) {
    case WhatsAppProviderKind.Memory:
      return new InMemoryWhatsAppProvider();
    case WhatsAppProviderKind.Twilio:
      return new TwilioWhatsAppProvider(config.twilio);
    default:
      return new DisabledWhatsAppProvider();
  }
}

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
  controllers: [AdminNotificationsController, InboxController],
  providers: [
    NotificationsRepository,
    NotificationsService,
    {
      provide: PUSH_PROVIDER,
      inject: [AppConfigService],
      useFactory: (config: AppConfigService): PushProvider => {
        switch (config.pushProvider) {
          case MessagingProviderKind.Memory:
            return new InMemoryPushProvider();
          case MessagingProviderKind.Fcm:
            return new FcmPushProvider({
              serviceAccount: parseFcmServiceAccount(config.fcmServiceAccountJson),
              timeoutMs: config.providerHttpTimeoutMs,
            });
          default:
            return new DisabledPushProvider();
        }
      },
    },
    {
      provide: WHATSAPP_PROVIDER,
      inject: [AppConfigService],
      useFactory: (config: AppConfigService) => whatsAppProviderFor(config),
    },
  ],
  exports: [NotificationsService],
})
export class NotificationsModule {}
