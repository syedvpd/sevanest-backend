import { createHmac, timingSafeEqual } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { ProviderError } from '../provider-error';
import type {
  CreateProviderOrderInput,
  PaymentProvider,
  ProviderOrder,
  ProviderPayment,
  ProviderPaymentOutcome,
  ProviderRefund,
  ProviderWebhookEvent,
} from './payment-provider.interface';

interface FakeOrder {
  amountMinor: number;
  payments: Map<string, ProviderPaymentOutcome>;
}

/**
 * Deterministic stand-in for a gateway, for tests and local work (no vendor is selected, Q-08). It signs and verifies with
 * HMAC-SHA256 like real gateways do, so the authenticity boundary is exercised for real. Refused in production by
 * configuration validation. Nothing here talks to a network.
 */
@Injectable()
export class FakePaymentProvider implements PaymentProvider {
  private orderSeq = 0;
  private readonly orders = new Map<string, FakeOrder>();
  readonly createdOrders: CreateProviderOrderInput[] = [];
  readonly refunds: Array<{
    providerPaymentId: string;
    amountMinor: number;
    idempotencyKey: string;
  }> = [];
  /** Test switches. */
  failNextCreateOrder = false;
  refundOutcome: ProviderPaymentOutcome = 'SUCCEEDED';

  constructor(private readonly secret: string) {}

  createOrder(input: CreateProviderOrderInput): Promise<ProviderOrder> {
    if (this.failNextCreateOrder) {
      this.failNextCreateOrder = false;
      return Promise.reject(new ProviderError('payment', 'gateway unavailable', true));
    }
    this.createdOrders.push(input);
    const providerOrderId = `order_fake_${++this.orderSeq}_${Date.now()}`;
    this.orders.set(providerOrderId, { amountMinor: input.amountMinor, payments: new Map() });
    return Promise.resolve({
      providerOrderId,
      checkoutPayload: {
        orderId: providerOrderId,
        amount: input.amountMinor,
        currency: input.currency,
      },
    });
  }

  verifyPayment(input: {
    providerOrderId: string;
    providerPaymentId: string;
    signature: string;
  }): Promise<ProviderPayment> {
    const expected = this.signPayment(input.providerOrderId, input.providerPaymentId);
    if (!this.same(expected, input.signature)) {
      return Promise.reject(new ProviderError('payment', 'invalid payment signature', false));
    }
    return this.getPayment(input.providerPaymentId, input.providerOrderId);
  }

  verifyWebhookSignature(rawBody: Buffer, headers: Record<string, string | undefined>): boolean {
    const given = headers['x-fake-signature'];
    return typeof given === 'string' && this.same(this.sign(rawBody), given);
  }

  parseWebhookEvent(rawBody: Buffer): ProviderWebhookEvent | null {
    try {
      const body = JSON.parse(rawBody.toString('utf8')) as Partial<ProviderWebhookEvent>;
      if (
        typeof body.eventId === 'string' &&
        typeof body.providerOrderId === 'string' &&
        typeof body.providerPaymentId === 'string' &&
        typeof body.amountMinor === 'number' &&
        (body.outcome === 'SUCCEEDED' || body.outcome === 'FAILED' || body.outcome === 'PENDING')
      ) {
        return body as ProviderWebhookEvent;
      }
      return null;
    } catch {
      return null;
    }
  }

  getPayment(providerPaymentId: string, providerOrderId?: string): Promise<ProviderPayment> {
    for (const [orderId, order] of this.orders) {
      const outcome = order.payments.get(providerPaymentId);
      if (outcome && (!providerOrderId || providerOrderId === orderId)) {
        return Promise.resolve({
          providerPaymentId,
          providerOrderId: orderId,
          outcome,
          amountMinor: order.amountMinor,
        });
      }
    }
    return Promise.reject(new ProviderError('payment', 'unknown payment', false));
  }

  refund(input: {
    providerPaymentId: string;
    amountMinor: number;
    idempotencyKey: string;
  }): Promise<ProviderRefund> {
    this.refunds.push(input);
    return Promise.resolve({
      providerRefundId: `refund_fake_${input.idempotencyKey}`,
      outcome: this.refundOutcome,
    });
  }

  // --- test helpers: what the gateway and the checkout would do ------------------------------------------------

  /** The customer completes (or fails) checkout for an order; returns what the client SDK would report. */
  completeCheckout(
    providerOrderId: string,
    outcome: ProviderPaymentOutcome,
  ): { providerPaymentId: string; signature: string; amountMinor: number } {
    const order = this.orders.get(providerOrderId);
    if (!order) throw new Error(`unknown order ${providerOrderId}`);
    const providerPaymentId = `pay_fake_${order.payments.size + 1}_${providerOrderId}`;
    order.payments.set(providerPaymentId, outcome);
    return {
      providerPaymentId,
      signature: this.signPayment(providerOrderId, providerPaymentId),
      amountMinor: order.amountMinor,
    };
  }

  /** A signed webhook body and headers for an event. */
  webhook(event: ProviderWebhookEvent): { body: Buffer; headers: Record<string, string> } {
    const body = Buffer.from(JSON.stringify(event));
    return { body, headers: { 'x-fake-signature': this.sign(body) } };
  }

  signPayment(providerOrderId: string, providerPaymentId: string): string {
    return this.sign(Buffer.from(`${providerOrderId}|${providerPaymentId}`));
  }

  private sign(data: Buffer): string {
    return createHmac('sha256', this.secret).update(data).digest('hex');
  }

  private same(a: string, b: string): boolean {
    const left = Buffer.from(a);
    const right = Buffer.from(b);
    return left.length === right.length && timingSafeEqual(left, right);
  }
}
