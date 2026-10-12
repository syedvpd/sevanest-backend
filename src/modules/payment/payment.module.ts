import { Module } from '@nestjs/common';
import { PaymentProviderKind } from '../../config/env.validation';
import { AppConfigService } from '../../config/app-config.service';
import { DisabledPaymentProvider } from '../../integrations/payments/disabled-payment.provider';
import { FakePaymentProvider } from '../../integrations/payments/fake-payment.provider';
import {
  PAYMENT_PROVIDER,
  type PaymentProvider,
} from '../../integrations/payments/payment-provider.interface';
import { RazorpayPaymentProvider } from '../../integrations/payments/razorpay-payment.provider';
import { BookingModule } from '../booking/booking.module';
import { UsersModule } from '../users/users.module';
import {
  AdminPaymentsController,
  PaymentsController,
  PaymentWebhookController,
} from './payment.controller';
import { PaymentRecoveryService } from './payment-recovery.service';
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
    PaymentRecoveryService,
    {
      provide: PAYMENT_PROVIDER,
      inject: [AppConfigService],
      useFactory: (config: AppConfigService): PaymentProvider => {
        switch (config.paymentProvider) {
          case PaymentProviderKind.Fake:
            return new FakePaymentProvider(config.paymentFakeWebhookSecret);
          case PaymentProviderKind.Razorpay:
            return new RazorpayPaymentProvider(config.razorpay);
          default:
            return new DisabledPaymentProvider();
        }
      },
    },
  ],
  exports: [PaymentService, PaymentRecoveryService],
})
export class PaymentModule {}
