import { Injectable } from '@nestjs/common';
import { ProviderError } from '../provider-error';
import type {
  CreateProviderOrderInput,
  PaymentProvider,
  ProviderOrder,
  ProviderPayment,
  ProviderRefund,
  ProviderWebhookEvent,
} from './payment-provider.interface';

/** Used while no payment gateway is configured (Q-08). Every call fails; webhooks are never authentic. */
@Injectable()
export class DisabledPaymentProvider implements PaymentProvider {
  private fail(): never {
    throw new ProviderError('payment', 'Payments are not configured', false);
  }

  createOrder(_input: CreateProviderOrderInput): Promise<ProviderOrder> {
    return Promise.resolve().then(() => this.fail());
  }

  verifyPayment(): Promise<ProviderPayment> {
    return Promise.resolve().then(() => this.fail());
  }

  verifyWebhookSignature(): boolean {
    return false;
  }

  parseWebhookEvent(): ProviderWebhookEvent | null {
    return null;
  }

  getPayment(): Promise<ProviderPayment> {
    return Promise.resolve().then(() => this.fail());
  }

  refund(): Promise<ProviderRefund> {
    return Promise.resolve().then(() => this.fail());
  }
}
