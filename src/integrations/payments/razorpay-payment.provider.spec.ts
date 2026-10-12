import { createHmac } from 'node:crypto';
import { ProviderError } from '../provider-error';
import { RazorpayPaymentProvider } from './razorpay-payment.provider';

const settings = {
  keyId: 'rzp_test_abcdefgh12',
  keySecret: 'key-secret-0123456789',
  webhookSecret: 'webhook-secret-0123',
  timeoutMs: 2000,
  baseUrl: 'https://rzp.test',
};

type Call = { url: string; init: RequestInit };
let calls: Call[];
let reply: (call: Call) => { status: number; body?: unknown } | Error;

beforeEach(() => {
  calls = [];
  reply = () => ({ status: 200, body: {} });
  jest.spyOn(globalThis, 'fetch').mockImplementation((url, init) => {
    const call = {
      url: typeof url === 'string' ? url : url instanceof URL ? url.href : url.url,
      init: init ?? {},
    };
    calls.push(call);
    const outcome = reply(call);
    if (!('status' in outcome)) return Promise.reject(outcome);
    return Promise.resolve(
      new Response(outcome.body === undefined ? '' : JSON.stringify(outcome.body), {
        status: outcome.status,
      }),
    );
  });
});
afterEach(() => jest.restoreAllMocks());

const hmac = (secret: string, data: string): string =>
  createHmac('sha256', secret).update(data).digest('hex');

describe('RazorpayPaymentProvider', () => {
  const provider = new RazorpayPaymentProvider(settings);

  it('creates an order with HTTP Basic auth and returns public checkout data only', async () => {
    reply = () => ({ status: 200, body: { id: 'order_1', status: 'created' } });
    const order = await provider.createOrder({
      amountMinor: 49900,
      currency: 'INR',
      reference: 'pay-uuid',
      idempotencyKey: 'pay-uuid',
    });
    expect(order.providerOrderId).toBe('order_1');
    expect(order.checkoutPayload).toEqual({
      keyId: settings.keyId,
      orderId: 'order_1',
      amount: 49900,
      currency: 'INR',
    });
    expect(JSON.stringify(order)).not.toContain(settings.keySecret);
    expect(calls[0].url).toBe('https://rzp.test/v1/orders');
    const headers = calls[0].init.headers as Record<string, string>;
    expect(headers.Authorization).toBe(
      `Basic ${Buffer.from(`${settings.keyId}:${settings.keySecret}`).toString('base64')}`,
    );
    expect(JSON.parse(calls[0].init.body as string)).toMatchObject({
      amount: 49900,
      currency: 'INR',
      receipt: 'pay-uuid',
    });
  });

  it('classifies failures: 5xx, 429, timeouts and network errors retry; 4xx does not', async () => {
    const cases: Array<[() => ReturnType<typeof reply>, boolean]> = [
      [() => ({ status: 502 }), true],
      [() => ({ status: 429 }), true],
      [() => new DOMException('timed out', 'TimeoutError'), true],
      [() => new TypeError('fetch failed'), true],
      [() => ({ status: 400, body: { error: { description: 'bad' } } }), false],
      [() => ({ status: 401 }), false],
    ];
    for (const [make, retryable] of cases) {
      reply = make;
      const error = await provider
        .getPayment('pay_1')
        .then(() => null)
        .catch((e: unknown) => e);
      expect(error).toBeInstanceOf(ProviderError);
      expect((error as ProviderError).retryable).toBe(retryable);
      // never leaks the secret or the provider's response text
      expect((error as ProviderError).message).not.toContain(settings.keySecret);
      expect((error as ProviderError).message).not.toContain('bad');
    }
  });

  describe('checkout verification', () => {
    const goodPayment = {
      id: 'pay_1',
      order_id: 'order_1',
      amount: 49900,
      currency: 'INR',
      status: 'captured',
    };

    it('accepts a correctly signed payment that the gateway confirms for the same order', async () => {
      reply = () => ({ status: 200, body: goodPayment });
      const payment = await provider.verifyPayment({
        providerOrderId: 'order_1',
        providerPaymentId: 'pay_1',
        signature: hmac(settings.keySecret, 'order_1|pay_1'),
      });
      expect(payment).toMatchObject({ outcome: 'SUCCEEDED', amountMinor: 49900, currency: 'INR' });
    });

    it('rejects a forged signature without calling the gateway', async () => {
      await expect(
        provider.verifyPayment({
          providerOrderId: 'order_1',
          providerPaymentId: 'pay_1',
          signature: hmac('some-other-secret', 'order_1|pay_1'),
        }),
      ).rejects.toThrow('invalid payment signature');
      expect(calls).toHaveLength(0);
    });

    it('rejects a payment that the gateway says belongs to another order', async () => {
      reply = () => ({ status: 200, body: { ...goodPayment, order_id: 'order_other' } });
      await expect(
        provider.verifyPayment({
          providerOrderId: 'order_1',
          providerPaymentId: 'pay_1',
          signature: hmac(settings.keySecret, 'order_1|pay_1'),
        }),
      ).rejects.toThrow('different order');
    });

    it('never reports success for authorized-but-uncaptured or unknown statuses', async () => {
      for (const status of ['created', 'authorized', 'something_new']) {
        reply = () => ({ status: 200, body: { ...goodPayment, status } });
        expect((await provider.getPayment('pay_1')).outcome).toBe('PENDING');
      }
      reply = () => ({ status: 200, body: { ...goodPayment, status: 'failed' } });
      expect((await provider.getPayment('pay_1')).outcome).toBe('FAILED');
    });
  });

  describe('authoritative lookup by order (lost callbacks)', () => {
    it('lists the payments of an order', async () => {
      reply = () => ({
        status: 200,
        body: {
          items: [
            { id: 'pay_a', order_id: 'order_1', amount: 100, currency: 'INR', status: 'failed' },
            { id: 'pay_b', order_id: 'order_1', amount: 100, currency: 'INR', status: 'captured' },
          ],
        },
      });
      const payments = await provider.findPaymentsForOrder('order_1');
      expect(calls[0].url).toBe('https://rzp.test/v1/orders/order_1/payments');
      expect(payments.map((p) => [p.providerPaymentId, p.outcome])).toEqual([
        ['pay_a', 'FAILED'],
        ['pay_b', 'SUCCEEDED'],
      ]);
    });

    it('returns an empty list when nobody attempted payment, and refuses a malformed answer', async () => {
      reply = () => ({ status: 200, body: { items: [] } });
      expect(await provider.findPaymentsForOrder('order_1')).toEqual([]);
      reply = () => ({ status: 200, body: { nope: true } });
      await expect(provider.findPaymentsForOrder('order_1')).rejects.toBeInstanceOf(ProviderError);
    });
  });

  describe('refunds', () => {
    it('sends the idempotency header and maps pending/processed/failed', async () => {
      reply = () => ({ status: 200, body: { id: 'rfnd_1', status: 'pending', amount: 100 } });
      const refund = await provider.refund({
        providerPaymentId: 'pay_1',
        amountMinor: 100,
        idempotencyKey: 'refund-abc',
      });
      expect(refund).toEqual({ providerRefundId: 'rfnd_1', outcome: 'PENDING', amountMinor: 100 });
      expect((calls[0].init.headers as Record<string, string>)['X-Refund-Idempotency']).toBe(
        'refund-abc',
      );
      expect(calls[0].url).toBe('https://rzp.test/v1/payments/pay_1/refund');
      for (const [status, outcome] of [
        ['processed', 'SUCCEEDED'],
        ['failed', 'FAILED'],
        ['created', 'PENDING'],
      ] as const) {
        reply = () => ({ status: 200, body: { id: 'rfnd_1', status } });
        expect((await provider.getRefund('rfnd_1')).outcome).toBe(outcome);
      }
    });

    it('lists the refunds of a payment', async () => {
      reply = () => ({ status: 200, body: { items: [{ id: 'rfnd_1', status: 'processed' }] } });
      expect(await provider.findRefundsForPayment('pay_1')).toEqual([
        { providerRefundId: 'rfnd_1', outcome: 'SUCCEEDED', amountMinor: undefined },
      ]);
    });
  });

  describe('webhooks', () => {
    const body = Buffer.from(
      JSON.stringify({
        event: 'payment.captured',
        payload: {
          payment: {
            entity: {
              id: 'pay_1',
              order_id: 'order_1',
              amount: 49900,
              currency: 'INR',
              status: 'captured',
            },
          },
        },
      }),
    );

    it('verifies the signature over the raw body with the webhook secret (not the API secret)', () => {
      const good = hmac(settings.webhookSecret, body.toString());
      expect(provider.verifyWebhookSignature(body, { 'x-razorpay-signature': good })).toBe(true);
      expect(
        provider.verifyWebhookSignature(body, {
          'x-razorpay-signature': hmac(settings.keySecret, body.toString()),
        }),
      ).toBe(false);
      expect(provider.verifyWebhookSignature(body, {})).toBe(false);
      expect(
        provider.verifyWebhookSignature(Buffer.from(`${body.toString()} `), {
          'x-razorpay-signature': good,
        }),
      ).toBe(false);
    });

    it('parses payment events and uses the event-id header for duplicate protection', () => {
      expect(provider.parseWebhookEvent(body, { 'x-razorpay-event-id': 'evt_1' })).toEqual({
        kind: 'PAYMENT',
        eventId: 'evt_1',
        providerOrderId: 'order_1',
        providerPaymentId: 'pay_1',
        outcome: 'SUCCEEDED',
        amountMinor: 49900,
        currency: 'INR',
      });
    });

    it('parses refund events, acknowledges unrelated ones and rejects malformed bodies', () => {
      const refund = Buffer.from(
        JSON.stringify({
          event: 'refund.processed',
          payload: { refund: { entity: { id: 'rfnd_1', payment_id: 'pay_1', amount: 100 } } },
        }),
      );
      expect(provider.parseWebhookEvent(refund, { 'x-razorpay-event-id': 'e2' })).toMatchObject({
        kind: 'REFUND',
        providerPaymentId: 'pay_1',
        providerRefundId: 'rfnd_1',
        outcome: 'SUCCEEDED',
      });
      expect(
        provider.parseWebhookEvent(Buffer.from(JSON.stringify({ event: 'invoice.paid' })), {}),
      ).toMatchObject({ kind: 'IGNORED' });
      expect(provider.parseWebhookEvent(Buffer.from('not json'), {})).toBeNull();
      expect(
        provider.parseWebhookEvent(Buffer.from(JSON.stringify({ event: 'payment.captured' })), {}),
      ).toBeNull();
    });
  });
});
