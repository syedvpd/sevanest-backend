import { Module } from '@nestjs/common';
import { PaymentProviderKind } from '../../config/env.validation';
import { AppConfigService } from '../../config/app-config.service';
import { DisabledPaymentProvider } from '../../integrations/payments/disabled-payment.provider';
import { FakePaymentProvider } from '../../integrations/payments/fake-payment.provider';
import { PAYMENT_PROVIDER } from '../../integrations/payments/payment-provider.interface';
import { BookingModule } from '../booking/booking.module';
import { UsersModule } from '../users/users.module';
import {
  AdminPaymentsController,
  PaymentsController,
  PaymentWebhookController,
} from './payment.controller';
import { PaymentRepository } from './payment.repository';
import { PaymentService } from './payment.service';

/**
 * Payment: the payment lifecycle behind the PaymentProvider abstraction (no vendor selected, Q-08). Owns the payment tables.
 * Depends on Booking (to confirm it on success) and Users; Booking knows nothing about Payment.
 */
@Module({
  imports: [BookingModule, UsersModule],
  controllers: [PaymentsController, PaymentWebhookController, AdminPaymentsController],
  providers: [
    PaymentRepository,
    PaymentService,
    {
      provide: PAYMENT_PROVIDER,
      inject: [AppConfigService],
      useFactory: (config: AppConfigService) =>
        config.paymentProvider === PaymentProviderKind.Fake
          ? new FakePaymentProvider(config.paymentFakeWebhookSecret)
          : new DisabledPaymentProvider(),
    },
  ],
  exports: [PaymentService],
})
export class PaymentModule {}
