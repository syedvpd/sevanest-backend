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
  /** When set, every lookup/refund call fails like an unreachable gateway (retryable). */
  outage = false;
  /** Refund records by id, as the gateway would hold them (for refund reconciliation tests). */
  readonly refundRecords = new Map<
    string,
    { providerPaymentId: string; outcome: ProviderPaymentOutcome; amountMinor: number }
  >();
  /** Test switch: report an amount different from what was charged, from lookups. */
  amountOverride: number | null = null;

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
        gateway: 'fake',
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
    if (this.outage)
      return Promise.reject(new ProviderError('payment', 'gateway unavailable', true));
    for (const [orderId, order] of this.orders) {
      const outcome = order.payments.get(providerPaymentId);
      if (outcome && (!providerOrderId || providerOrderId === orderId)) {
        return Promise.resolve({
          providerPaymentId,
          providerOrderId: orderId,
          outcome,
          amountMinor: this.amountOverride ?? order.amountMinor,
        });
      }
    }
    return Promise.reject(new ProviderError('payment', 'unknown payment', false));
  }

  findPaymentsForOrder(providerOrderId: string): Promise<ProviderPayment[]> {
    if (this.outage)
      return Promise.reject(new ProviderError('payment', 'gateway unavailable', true));
    const order = this.orders.get(providerOrderId);
    if (!order) return Promise.reject(new ProviderError('payment', 'unknown order', false));
    return Promise.resolve(
      [...order.payments].map(([providerPaymentId, outcome]) => ({
        providerPaymentId,
        providerOrderId,
        outcome,
        amountMinor: this.amountOverride ?? order.amountMinor,
      })),
    );
  }

  findRefundsForPayment(providerPaymentId: string): Promise<ProviderRefund[]> {
    if (this.outage)
      return Promise.reject(new ProviderError('payment', 'gateway unavailable', true));
    return Promise.resolve(
      [...this.refundRecords]
        .filter(([, r]) => r.providerPaymentId === providerPaymentId)
        .map(([providerRefundId, r]) => ({
          providerRefundId,
          outcome: r.outcome,
          amountMinor: r.amountMinor,
        })),
    );
  }

  getRefund(providerRefundId: string): Promise<ProviderRefund> {
    if (this.outage)
      return Promise.reject(new ProviderError('payment', 'gateway unavailable', true));
    const record = this.refundRecords.get(providerRefundId);
    if (!record) return Promise.reject(new ProviderError('payment', 'unknown refund', false));
    return Promise.resolve({
      providerRefundId,
      outcome: record.outcome,
      amountMinor: record.amountMinor,
    });
  }

  refund(input: {
    providerPaymentId: string;
    amountMinor: number;
    idempotencyKey: string;
  }): Promise<ProviderRefund> {
    if (this.outage)
      return Promise.reject(new ProviderError('payment', 'gateway unavailable', true));
    this.refunds.push(input);
    const providerRefundId = `refund_fake_${input.idempotencyKey}`;
    // Like a real gateway with an idempotency key: repeating the request returns the same refund, never a second one.
    const existing = this.refundRecords.get(providerRefundId);
    if (existing) {
      return Promise.resolve({
        providerRefundId,
        outcome: existing.outcome,
        amountMinor: existing.amountMinor,
      });
    }
    this.refundRecords.set(providerRefundId, {
      providerPaymentId: input.providerPaymentId,
      outcome: this.refundOutcome,
      amountMinor: input.amountMinor,
    });
    return Promise.resolve({
      providerRefundId,
      outcome: this.refundOutcome,
      amountMinor: input.amountMinor,
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

  /** Test helper: the gateway finishes (or fails) a pending refund. */
  settleRefund(providerRefundId: string, outcome: ProviderPaymentOutcome): void {
    const record = this.refundRecords.get(providerRefundId);
    if (record) record.outcome = outcome;
  }

  /** Test helper: a payment appears at the gateway for an order without any webhook (a lost callback). */
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
