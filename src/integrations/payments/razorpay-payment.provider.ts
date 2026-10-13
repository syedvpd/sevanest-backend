import { createHmac, timingSafeEqual } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { basicAuth, providerRequest } from '../http/provider-http';
import { ProviderError } from '../provider-error';
import type {
  CreateProviderOrderInput,
  PaymentProvider,
  ProviderOrder,
  ProviderPayment,
  ProviderPaymentDetails,
  ProviderPaymentOutcome,
  ProviderRefund,
  ProviderWebhookEvent,
} from './payment-provider.interface';

export interface RazorpaySettings {
  keyId: string;
  keySecret: string;
  webhookSecret: string;
  timeoutMs: number;
  /** Test seam; production uses the real API host. */
  baseUrl?: string;
}

interface RzpPayment {
  id?: unknown;
  order_id?: unknown;
  amount?: unknown;
  currency?: unknown;
  status?: unknown;
  method?: unknown;
  vpa?: unknown;
  bank?: unknown;
  wallet?: unknown;
  card?: { network?: unknown; last4?: unknown } | null;
  error_code?: unknown;
  error_description?: unknown;
}

const str = (v: unknown): string | undefined =>
  typeof v === 'string' && v.trim() ? v.trim() : undefined;

/** Masked, display-only details of a Razorpay payment entity: never a full card number or UPI id. */
export function razorpayDetails(p: RzpPayment): ProviderPaymentDetails {
  const method = str(p.method)?.toLowerCase();
  let methodDetail: string | undefined;
  if (method === 'upi') {
    const vpa = str(p.vpa);
    if (vpa?.includes('@')) {
      const [user, handle] = vpa.split('@');
      methodDetail = `${user.slice(0, 2)}***@${handle}`;
    }
  } else if (method === 'card') {
    const last4 = str(p.card?.last4);
    const network = str(p.card?.network);
    if (last4) methodDetail = `${network ? `${network} ` : ''}**** ${last4.slice(-4)}`;
  } else if (method === 'netbanking') {
    methodDetail = str(p.bank);
  } else if (method === 'wallet') {
    methodDetail = str(p.wallet);
  }
  return {
    ...(method ? { method } : {}),
    ...(methodDetail ? { methodDetail } : {}),
    ...(str(p.error_code) ? { errorCode: str(p.error_code) } : {}),
    ...(str(p.error_description)
      ? { errorDescription: str(p.error_description)!.slice(0, 200) }
      : {}),
  };
}

interface RzpRefund {
  id?: unknown;
  payment_id?: unknown;
  amount?: unknown;
  status?: unknown;
}

/** Razorpay payment status -> our outcome. Only `captured` is money we may treat as received. */
export function mapRazorpayPaymentStatus(status: unknown): ProviderPaymentOutcome {
  switch (status) {
    case 'captured':
    case 'refunded': // captured first, refunded later: the payment itself did succeed
      return 'SUCCEEDED';
    case 'failed':
      return 'FAILED';
    default: // created, authorized (not captured yet) or anything unknown: never success without evidence
      return 'PENDING';
  }
}

export function mapRazorpayRefundStatus(status: unknown): ProviderPaymentOutcome {
  switch (status) {
    case 'processed':
      return 'SUCCEEDED';
    case 'failed':
      return 'FAILED';
    default: // pending, created, unknown
      return 'PENDING';
  }
}

/**
 * Razorpay adapter (Orders, Payments, Refunds REST API v1, HTTP Basic auth with key id/secret). Endpoints used:
 *   POST /v1/orders · GET /v1/orders/{id}/payments · GET /v1/payments/{id}
 *   POST /v1/payments/{id}/refund (header X-Refund-Idempotency) · GET /v1/payments/{id}/refunds · GET /v1/refunds/{id}
 * Checkout signature = HMAC-SHA256(order_id|payment_id, key secret). Webhook signature = HMAC-SHA256(raw body, webhook secret) in
 * X-Razorpay-Signature. The key secret and webhook secret exist only in this object; error messages never include them, request
 * bodies or response bodies. Unit-tested against recorded-shape fakes: behaviour against the live API is NOT verified here.
 */
@Injectable()
export class RazorpayPaymentProvider implements PaymentProvider {
  constructor(private readonly settings: RazorpaySettings) {}

  async createOrder(input: CreateProviderOrderInput): Promise<ProviderOrder> {
    const body = await this.call('POST', '/v1/orders', {
      amount: input.amountMinor,
      currency: input.currency,
      receipt: input.reference.slice(0, 40),
      notes: { reference: input.reference },
    });
    const id = (body as { id?: unknown } | null)?.id;
    if (typeof id !== 'string') throw new ProviderError('razorpay', 'order was not created', false);
    return {
      providerOrderId: id,
      checkoutPayload: {
        gateway: 'razorpay',
        keyId: this.settings.keyId,
        orderId: id,
        amount: input.amountMinor,
        currency: input.currency,
      },
    };
  }

  async verifyPayment(input: {
    providerOrderId: string;
    providerPaymentId: string;
    signature: string;
  }): Promise<ProviderPayment> {
    const expected = this.hmac(
      this.settings.keySecret,
      Buffer.from(`${input.providerOrderId}|${input.providerPaymentId}`),
    );
    if (!this.same(expected, input.signature)) {
      throw new ProviderError('razorpay', 'invalid payment signature', false);
    }
    const payment = await this.getPayment(input.providerPaymentId);
    // A valid signature proves (order, payment) came from checkout; the authoritative record must agree on the order.
    if (payment.providerOrderId !== input.providerOrderId) {
      throw new ProviderError('razorpay', 'payment belongs to a different order', false);
    }
    return payment;
  }

  verifyWebhookSignature(rawBody: Buffer, headers: Record<string, string | undefined>): boolean {
    const given = headers['x-razorpay-signature'];
    // No webhook secret configured: nothing can be authenticated, so every notification is refused (never HMAC with an empty key).
    if (!this.settings.webhookSecret) return false;
    return (
      typeof given === 'string' && this.same(this.hmac(this.settings.webhookSecret, rawBody), given)
    );
  }

  parseWebhookEvent(
    rawBody: Buffer,
    headers: Record<string, string | undefined> = {},
  ): ProviderWebhookEvent | null {
    let body: {
      event?: unknown;
      created_at?: unknown;
      payload?: { payment?: { entity?: RzpPayment }; refund?: { entity?: RzpRefund } };
    };
    try {
      body = JSON.parse(rawBody.toString('utf8')) as typeof body;
    } catch {
      return null;
    }
    if (typeof body.event !== 'string') return null;
    const header = headers['x-razorpay-event-id'];
    const payment = body.payload?.payment?.entity;
    const refund = body.payload?.refund?.entity;

    if (body.event.startsWith('refund.')) {
      if (typeof refund?.id !== 'string' || typeof refund.payment_id !== 'string') return null;
      const outcome =
        body.event === 'refund.processed'
          ? 'SUCCEEDED'
          : body.event === 'refund.failed'
            ? 'FAILED'
            : 'PENDING';
      return {
        kind: 'REFUND',
        eventId: header ?? `rzp:${body.event}:${refund.id}`,
        providerOrderId: '',
        providerPaymentId: refund.payment_id,
        providerRefundId: refund.id,
        outcome,
        amountMinor: typeof refund.amount === 'number' ? refund.amount : 0,
      };
    }

    const supported = ['payment.captured', 'payment.failed', 'payment.authorized', 'order.paid'];
    if (!supported.includes(body.event))
      return {
        kind: 'IGNORED',
        eventId: header ?? `rzp:${body.event}`,
        providerOrderId: '',
        providerPaymentId: '',
        outcome: 'PENDING',
        amountMinor: 0,
      };
    if (
      typeof payment?.id !== 'string' ||
      typeof payment.order_id !== 'string' ||
      typeof payment.amount !== 'number'
    ) {
      return null;
    }
    return {
      kind: 'PAYMENT',
      eventId: header ?? `rzp:${body.event}:${payment.id}:${String(payment.status)}`,
      providerOrderId: payment.order_id,
      providerPaymentId: payment.id,
      outcome: mapRazorpayPaymentStatus(payment.status),
      amountMinor: payment.amount,
      currency: typeof payment.currency === 'string' ? payment.currency : undefined,
      ...razorpayDetails(payment),
    };
  }

  async getPayment(providerPaymentId: string): Promise<ProviderPayment> {
    const body = await this.call('GET', `/v1/payments/${encodeURIComponent(providerPaymentId)}`);
    return this.toPayment(body as RzpPayment);
  }

  /** Authoritative lookup by merchant order: the answer to a lost callback. */
  async findPaymentsForOrder(providerOrderId: string): Promise<ProviderPayment[]> {
    const body = await this.call(
      'GET',
      `/v1/orders/${encodeURIComponent(providerOrderId)}/payments`,
    );
    const items = (body as { items?: unknown } | null)?.items;
    if (!Array.isArray(items))
      throw new ProviderError('razorpay', 'unexpected payments list', true);
    return (items as RzpPayment[]).map((p) => this.toPayment(p));
  }

  async refund(input: {
    providerPaymentId: string;
    amountMinor: number;
    idempotencyKey: string;
  }): Promise<ProviderRefund> {
    const body = await this.call(
      'POST',
      `/v1/payments/${encodeURIComponent(input.providerPaymentId)}/refund`,
      { amount: input.amountMinor, notes: { idempotencyKey: input.idempotencyKey } },
      { 'X-Refund-Idempotency': input.idempotencyKey },
    );
    return this.toRefund(body as RzpRefund);
  }

  async findRefundsForPayment(providerPaymentId: string): Promise<ProviderRefund[]> {
    const body = await this.call(
      'GET',
      `/v1/payments/${encodeURIComponent(providerPaymentId)}/refunds`,
    );
    const items = (body as { items?: unknown } | null)?.items;
    if (!Array.isArray(items)) throw new ProviderError('razorpay', 'unexpected refunds list', true);
    return (items as RzpRefund[]).map((r) => this.toRefund(r));
  }

  async getRefund(providerRefundId: string): Promise<ProviderRefund> {
    const body = await this.call('GET', `/v1/refunds/${encodeURIComponent(providerRefundId)}`);
    return this.toRefund(body as RzpRefund);
  }

  // --- internals -------------------------------------------------------------------------------------------------

  private async call(
    method: 'GET' | 'POST',
    path: string,
    payload?: unknown,
    extraHeaders: Record<string, string> = {},
  ): Promise<unknown> {
    const { json } = await providerRequest(
      'razorpay',
      `${this.settings.baseUrl ?? 'https://api.razorpay.com'}${path}`,
      {
        method,
        headers: {
          Authorization: basicAuth(this.settings.keyId, this.settings.keySecret),
          'Content-Type': 'application/json',
          ...extraHeaders,
        },
        body: payload === undefined ? undefined : JSON.stringify(payload),
      },
      this.settings.timeoutMs,
    );
    return json;
  }

  private toPayment(p: RzpPayment): ProviderPayment {
    if (typeof p?.id !== 'string' || typeof p.amount !== 'number') {
      throw new ProviderError('razorpay', 'unexpected payment shape', true);
    }
    return {
      providerPaymentId: p.id,
      providerOrderId: typeof p.order_id === 'string' ? p.order_id : '',
      outcome: mapRazorpayPaymentStatus(p.status),
      amountMinor: p.amount,
      currency: typeof p.currency === 'string' ? p.currency : undefined,
      ...razorpayDetails(p),
    };
  }

  private toRefund(r: RzpRefund): ProviderRefund {
    if (typeof r?.id !== 'string')
      throw new ProviderError('razorpay', 'unexpected refund shape', true);
    return {
      providerRefundId: r.id,
      outcome: mapRazorpayRefundStatus(r.status),
      amountMinor: typeof r.amount === 'number' ? r.amount : undefined,
    };
  }

  private hmac(secret: string, data: Buffer): string {
    return createHmac('sha256', secret).update(data).digest('hex');
  }

  private same(a: string, b: string): boolean {
    const left = Buffer.from(a);
    const right = Buffer.from(b);
    return left.length === right.length && timingSafeEqual(left, right);
  }
}
