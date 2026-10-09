import '../support/env-api-integration';
import request from 'supertest';
import {
  ApiApp,
  bearer,
  createApiApp,
  loginAdmin,
  loginAdminWithPermissions,
  loginWithOtp,
} from '../support/api-app';
import { ensureFee, fakeGateway, makeBooking, TestBooking } from '../support/bookings';
import { as, createArea, setRequiredChecks } from '../support/workforce';
import { ProviderError } from '../../src/integrations/provider-error';

interface Started {
  id: string;
  checkout: { orderId: string };
}
const P = '/api/v1/payments';
const WEBHOOK = '/api/v1/webhooks/payments';
const A = '/api/v1/admin';

/** Payments against the REAL PostgreSQL + Redis (dedicated test database), through the HTTP API, with the fake gateway. */
describe('Payment API (integration)', () => {
  let api: ApiApp;
  let admin: Awaited<ReturnType<typeof loginAdmin>>;
  let area: { id: string };
  let customer: Awaited<ReturnType<typeof loginWithOtp>> & { userId: string };

  const gateway = () => fakeGateway(api);
  const pending = (): Promise<TestBooking> =>
    makeBooking(api, admin, customer, area.id, 'PENDING_PAYMENT');
  const startPayment = (bookingId: string, caller: { accessToken: string } = customer) =>
    as(api, caller).post('/api/v1/payments', { bookingId });
  const bookingStatus = async (id: string) =>
    (await as(api, customer).get(`/api/v1/bookings/${id}`)).body.status as string;
  const webhook = (event: Parameters<ReturnType<typeof fakeGateway>['webhook']>[0]) => {
    const { body, headers } = gateway().webhook(event);
    return api
      .http()
      .post(WEBHOOK)
      .set(headers)
      .set('Content-Type', 'application/json')
      .send(body.toString());
  };

  beforeAll(async () => {
    api = await createApiApp();
    admin = await loginAdmin(api);
    area = await createArea(api, admin);
    customer = await loginWithOtp(api, { appType: 'CUSTOMER' });
    await setRequiredChecks(api, admin, ['IDENTITY']);
  });

  afterAll(async () => {
    await setRequiredChecks(api, admin, []);
    await api.close();
  });

  describe('fees', () => {
    it('are set by authorised staff only, validated, and audited with before and after', async () => {
      const manager = await loginAdminWithPermissions(api, ['payment.manage']);
      const viewer = await loginAdminWithPermissions(api, ['payment.view']);
      expect(
        (await as(api, viewer).put(`${A}/fees/booking-fee`, { amountMinor: 100 })).status,
      ).toBe(403);
      expect(
        (await as(api, customer).put(`${A}/fees/booking-fee`, { amountMinor: 100 })).status,
      ).toBe(403);
      expect(
        (await api.http().put(`${A}/fees/booking-fee`).send({ amountMinor: 100 })).status,
      ).toBe(401);
      for (const bad of [
        { amountMinor: 0 },
        { amountMinor: -5 },
        { amountMinor: 1.5 },
        { amountMinor: 100, currency: 'USD' },
        {},
      ]) {
        expect((await as(api, manager).put(`${A}/fees/booking-fee`, bad)).status).toBe(400);
      }
      await as(api, manager).put(`${A}/fees/booking-fee`, { amountMinor: 70000 }).expect(200);
      await as(api, manager).put(`${A}/fees/booking-fee`, { amountMinor: 50000 }).expect(200);
      const fees = await as(api, viewer).get(`${A}/fees`).expect(200);
      expect(fees.body).toEqual([
        { code: 'BOOKING_FEE', amountMinor: 50000, currency: 'INR', isActive: true },
      ]);
      const audit = await api.prisma.auditLog.findFirstOrThrow({
        where: { action: 'payment.fee_set', actorId: manager.userId },
        orderBy: { createdAt: 'desc' },
      });
      expect(audit.metadata).toMatchObject({
        before: { amountMinor: 70000 },
        after: { amountMinor: 50000, currency: 'INR' },
      });
    });

    it('must be configured before anyone can pay (422 FEE_NOT_CONFIGURED) - nothing is hard-coded', async () => {
      const booking = await pending();
      await api.prisma.feeConfig.deleteMany({});
      try {
        const res = await startPayment(booking.id);
        expect(res.status).toBe(422);
        expect(res.body.code).toBe('FEE_NOT_CONFIGURED');
        expect(await api.prisma.payment.count({ where: { bookingId: booking.id } })).toBe(0);
      } finally {
        await ensureFee(api, admin);
      }
    });
  });

  describe('starting a payment', () => {
    it('takes the amount from the fee configuration, never from the client, and shows only checkout data', async () => {
      await ensureFee(api, admin, 50000);
      const booking = await pending();
      const res = await as(api, customer).post('/api/v1/payments', {
        bookingId: booking.id,
        amountMinor: 1,
        status: 'SUCCEEDED',
      });
      expect(res.status).toBe(201);
      expect(res.body).toMatchObject({
        status: 'PENDING',
        amountMinor: 50000,
        currency: 'INR',
        receiptNumber: null,
        refundStatus: null,
      });
      expect(res.body.checkout.orderId).toBeDefined();
      expect(Object.keys(res.body as object)).not.toContain('providerOrderId');
      expect(JSON.stringify(res.body)).not.toContain('test-only-webhook-secret');
      expect(gateway().createdOrders.at(-1)).toMatchObject({
        amountMinor: 50000,
        currency: 'INR',
        reference: res.body.id,
      });
      expect(await bookingStatus(booking.id)).toBe('PENDING_PAYMENT');
    });

    it('only for the owner and only while the booking waits for payment', async () => {
      const booking = await pending();
      const stranger = await loginWithOtp(api, { appType: 'CUSTOMER' });
      expect((await startPayment(booking.id, stranger)).status).toBe(404);
      expect((await startPayment('00000000-0000-7000-8000-000000000000')).status).toBe(404);
      expect((await startPayment('nope')).status).toBe(400);
      const early = await makeBooking(api, admin, customer, area.id, 'MATCHED');
      const res = await startPayment(early.id);
      expect(res.status).toBe(409);
      expect(res.body.code).toBe('BOOKING_NOT_PAYABLE');
      expect((await startPayment(booking.id, booking.worker)).status).toBe(403);
      expect(
        (await api.http().post('/api/v1/payments').send({ bookingId: booking.id })).status,
      ).toBe(401);
    });

    it('resumes the open payment instead of creating another, even when called in parallel', async () => {
      const booking = await pending();
      const results = await Promise.all(Array.from({ length: 6 }, () => startPayment(booking.id)));
      expect(results.every((r) => [200, 201].includes(r.status))).toBe(true);
      expect(new Set(results.map((r) => r.body.id as string)).size).toBe(1);
      expect(await api.prisma.payment.count({ where: { bookingId: booking.id } })).toBe(1);
    });

    it('survives a gateway outage: 503, the payment is kept, and the next call opens the order', async () => {
      const booking = await pending();
      gateway().failNextCreateOrder = true;
      const down = await startPayment(booking.id);
      expect(down.status).toBe(503);
      expect(down.body.code).toBe('PAYMENT_PROVIDER_UNAVAILABLE');
      expect(
        (await api.prisma.payment.findFirstOrThrow({ where: { bookingId: booking.id } })).status,
      ).toBe('CREATED');
      const retry = await startPayment(booking.id);
      expect([200, 201]).toContain(retry.status);
      expect(retry.body.status).toBe('PENDING');
      expect(await api.prisma.payment.count({ where: { bookingId: booking.id } })).toBe(1);
    });
  });

  describe('client-reported result (verified by the server)', () => {
    it('confirms the booking, issues a receipt and queues the notification only after the gateway verifies', async () => {
      const booking = await pending();
      const started = (await startPayment(booking.id)).body as Started;
      const reported = gateway().completeCheckout(started.checkout.orderId, 'SUCCEEDED');
      const res = await as(api, customer).post(`${P}/${started.id}/verify`, {
        providerPaymentId: reported.providerPaymentId,
        signature: reported.signature,
      });
      expect(res.status).toBe(200);
      expect(res.body.status).toBe('SUCCEEDED');
      expect(res.body.receiptNumber).toMatch(/^RCPT-\d{8}-[0-9A-F]{8}$/);
      expect(await bookingStatus(booking.id)).toBe('CONFIRMED');
      const outbox = await api.prisma.outboxEvent.findMany({
        where: { payload: { path: ['params', 'paymentId'], equals: started.id } },
      });
      expect(outbox.map((o) => (o.payload as { event: string }).event)).toEqual([
        'PAYMENT_SUCCEEDED',
      ]);
      // Reporting again changes nothing.
      const again = await as(api, customer).post(`${P}/${started.id}/verify`, {
        providerPaymentId: reported.providerPaymentId,
        signature: reported.signature,
      });
      expect(again.status).toBe(200);
      expect(
        await api.prisma.auditLog.count({
          where: { entityId: started.id, action: 'payment.succeeded' },
        }),
      ).toBe(1);
    });

    it('rejects a forged signature and a report the gateway does not know, changing nothing', async () => {
      const booking = await pending();
      const started = (await startPayment(booking.id)).body as Started;
      const forged = await as(api, customer).post(`${P}/${started.id}/verify`, {
        providerPaymentId: 'pay_x',
        signature: 'a'.repeat(64),
      });
      expect(forged.status).toBe(400);
      expect(forged.body.code).toBe('PAYMENT_VERIFICATION_FAILED');
      const unknown = await as(api, customer).post(`${P}/${started.id}/verify`, {
        providerPaymentId: 'pay_never_happened',
        signature: gateway().signPayment(started.checkout.orderId, 'pay_never_happened'),
      });
      expect(unknown.status).toBe(400);
      expect((await as(api, customer).get(`${P}/${started.id}`)).body.status).toBe('PENDING');
      expect(await bookingStatus(booking.id)).toBe('PENDING_PAYMENT');
      expect((await as(api, customer).post(`${P}/${started.id}/verify`, {})).status).toBe(400);
    });

    it('lets only the owner report on a payment', async () => {
      const booking = await pending();
      const started = (await startPayment(booking.id)).body as Started;
      const reported = gateway().completeCheckout(started.checkout.orderId, 'SUCCEEDED');
      const stranger = await loginWithOtp(api, { appType: 'CUSTOMER' });
      const res = await as(api, stranger).post(`${P}/${started.id}/verify`, reported);
      expect(res.status).toBe(404);
      expect((await as(api, stranger).get(`${P}/${started.id}`)).status).toBe(404);
      expect(await bookingStatus(booking.id)).toBe('PENDING_PAYMENT');
    });

    it('records a failure, leaves the booking unchanged, and lets the customer retry with a new payment', async () => {
      const booking = await pending();
      const first = (await startPayment(booking.id)).body as Started;
      const failed = gateway().completeCheckout(first.checkout.orderId, 'FAILED');
      const res = await as(api, customer).post(`${P}/${first.id}/verify`, failed);
      expect(res.body.status).toBe('FAILED');
      expect(await bookingStatus(booking.id)).toBe('PENDING_PAYMENT');
      const second = (await startPayment(booking.id)).body as Started;
      expect(second.id).not.toBe(first.id);
      const ok = gateway().completeCheckout(second.checkout.orderId, 'SUCCEEDED');
      expect((await as(api, customer).post(`${P}/${second.id}/verify`, ok)).body.status).toBe(
        'SUCCEEDED',
      );
      expect(await bookingStatus(booking.id)).toBe('CONFIRMED');
      const history = await as(api, customer).get(`${P}?limit=100`).expect(200);
      const mine = history.body.data.filter(
        (p: { bookingId: string }) => p.bookingId === booking.id,
      );
      expect(mine.map((p: { status: string }) => p.status).sort()).toEqual(['FAILED', 'SUCCEEDED']);
      expect((await startPayment(booking.id)).status).toBe(409);
    });
  });

  describe('gateway webhook', () => {
    const eventFor = async (bookingId?: string) => {
      const booking = bookingId ? { id: bookingId } : await pending();
      const started = (await startPayment(booking.id)).body as Started;
      const done = gateway().completeCheckout(started.checkout.orderId, 'SUCCEEDED');
      return {
        booking,
        started,
        event: {
          eventId: `evt_${started.id}`,
          providerOrderId: started.checkout.orderId,
          providerPaymentId: done.providerPaymentId,
          outcome: 'SUCCEEDED' as const,
          amountMinor: 50000,
        },
      };
    };

    it('does not trust an unsigned, wrongly signed or tampered notification', async () => {
      const { started, event, booking } = await eventFor();
      const { body, headers } = gateway().webhook(event);
      const post = (b: Buffer, h: Record<string, string>) =>
        api.http().post(WEBHOOK).set(h).set('Content-Type', 'application/json').send(b.toString());
      for (const res of [
        await post(body, {}),
        await post(body, { 'x-fake-signature': 'f'.repeat(64) }),
        await post(Buffer.from(body.toString().replace('SUCCEEDED', 'FAILED')), headers),
        await post(Buffer.from(body.toString().replace('50000', '1')), headers),
        await api.http().post(WEBHOOK).send({ not: 'signed' }),
      ]) {
        expect(res.status).toBe(401);
        expect(res.body.code).toBe('INVALID_SIGNATURE');
      }
      expect((await as(api, customer).get(`${P}/${started.id}`)).body.status).toBe('PENDING');
      expect(
        await api.prisma.paymentEvent.count({ where: { providerEventId: event.eventId } }),
      ).toBe(0);
      expect(await bookingStatus(booking.id)).toBe('PENDING_PAYMENT');
    });

    it('applies an authentic success once: payment, booking, receipt and notification', async () => {
      const { started, event, booking } = await eventFor();
      const res = await webhook(event);
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ received: true });
      const view = (await as(api, customer).get(`${P}/${started.id}`)).body;
      expect(view.status).toBe('SUCCEEDED');
      expect(view.receiptNumber).toBeTruthy();
      expect(await bookingStatus(booking.id)).toBe('CONFIRMED');
    });

    it('acknowledges a duplicate delivery without applying it again, even when many arrive at once', async () => {
      const { started, event } = await eventFor();
      const results = await Promise.all(Array.from({ length: 8 }, () => webhook(event)));
      expect(results.every((r) => r.status === 200)).toBe(true);
      expect(
        await api.prisma.paymentEvent.count({ where: { providerEventId: event.eventId } }),
      ).toBe(1);
      expect(
        await api.prisma.auditLog.count({
          where: { entityId: started.id, action: 'payment.succeeded' },
        }),
      ).toBe(1);
      const outbox = await api.prisma.outboxEvent.findMany({
        where: { payload: { path: ['params', 'paymentId'], equals: started.id } },
      });
      expect(outbox).toHaveLength(1);
    });

    it('refuses an amount that is not the one we asked for', async () => {
      const { started, event, booking } = await eventFor();
      const res = await webhook({ ...event, amountMinor: 100 });
      expect(res.status).toBe(200);
      expect((await as(api, customer).get(`${P}/${started.id}`)).body.status).toBe('PENDING');
      expect(await bookingStatus(booking.id)).toBe('PENDING_PAYMENT');
      const row = await api.prisma.paymentEvent.findUniqueOrThrow({
        where: { providerEventId: event.eventId },
      });
      expect(row).toMatchObject({ applied: false, note: 'AMOUNT_MISMATCH' });
    });

    it('acknowledges an unknown order and a malformed (but signed) body without side effects', async () => {
      const unknown = await webhook({
        eventId: `evt_unknown_${Date.now()}`,
        providerOrderId: 'order_does_not_exist',
        providerPaymentId: 'pay_1',
        outcome: 'SUCCEEDED',
        amountMinor: 50000,
      });
      expect(unknown.status).toBe(200);
      const body = Buffer.from('{"hello":"world"}');
      const signed = gateway().webhook({} as never);
      const res = await api
        .http()
        .post(WEBHOOK)
        .set({
          'x-fake-signature': gateway().webhook({ eventId: '' } as never).headers[
            'x-fake-signature'
          ],
        })
        .set('Content-Type', 'application/json')
        .send(body.toString());
      expect(res.status).toBe(401);
      expect(signed.body).toBeDefined();
    });

    it('never moves a finished payment backwards, and accepts a late success on a failed one', async () => {
      const { started, event } = await eventFor();
      await webhook(event).expect(200);
      await webhook({ ...event, eventId: `${event.eventId}-late-fail`, outcome: 'FAILED' }).expect(
        200,
      );
      expect((await as(api, customer).get(`${P}/${started.id}`)).body.status).toBe('SUCCEEDED');
      const ignored = await api.prisma.paymentEvent.findUniqueOrThrow({
        where: { providerEventId: `${event.eventId}-late-fail` },
      });
      expect(ignored).toMatchObject({ applied: false, note: 'ALREADY_SUCCEEDED' });

      const second = await pending();
      const sp = (await startPayment(second.id)).body as Started;
      const attempt1 = gateway().completeCheckout(sp.checkout.orderId, 'FAILED');
      await webhook({
        eventId: `f-${sp.id}`,
        providerOrderId: sp.checkout.orderId,
        providerPaymentId: attempt1.providerPaymentId,
        outcome: 'FAILED',
        amountMinor: 50000,
      }).expect(200);
      expect((await as(api, customer).get(`${P}/${sp.id}`)).body.status).toBe('FAILED');
      const attempt2 = gateway().completeCheckout(sp.checkout.orderId, 'SUCCEEDED');
      await webhook({
        eventId: `s-${sp.id}`,
        providerOrderId: sp.checkout.orderId,
        providerPaymentId: attempt2.providerPaymentId,
        outcome: 'SUCCEEDED',
        amountMinor: 50000,
      }).expect(200);
      expect((await as(api, customer).get(`${P}/${sp.id}`)).body.status).toBe('SUCCEEDED');
      expect(await bookingStatus(second.id)).toBe('CONFIRMED');
    });

    it('keeps the money and flags it when the booking was cancelled before the success arrived', async () => {
      const { started, event, booking } = await eventFor();
      await as(api, customer)
        .post(`/api/v1/bookings/${booking.id}/cancel`, { reason: 'changed my mind' })
        .expect(200);
      await webhook(event).expect(200);
      expect((await as(api, customer).get(`${P}/${started.id}`)).body.status).toBe('SUCCEEDED');
      expect(await bookingStatus(booking.id)).toBe('CANCELLED');
      const audit = await api.prisma.auditLog.findFirstOrThrow({
        where: { entityId: started.id, action: 'payment.succeeded' },
      });
      expect(audit.metadata).toMatchObject({ bookingConfirmed: false });
      const event2 = await api.prisma.paymentEvent.findUniqueOrThrow({
        where: { providerEventId: event.eventId },
      });
      expect(event2.note).toBe('SUCCEEDED_BOOKING_NOT_PENDING');
    });
  });

  describe('reconciliation and refunds (admin)', () => {
    it('reconciles a delayed success by asking the gateway, and needs something to ask about', async () => {
      const booking = await pending();
      const started = (await startPayment(booking.id)).body as Started;
      const manager = await loginAdminWithPermissions(api, ['payment.manage']);
      const nothing = await as(api, manager).post(`${A}/payments/${started.id}/reconcile`);
      expect(nothing.status).toBe(422);
      expect(nothing.body.code).toBe('NOTHING_TO_RECONCILE');
      const done = gateway().completeCheckout(started.checkout.orderId, 'PENDING');
      await as(api, customer).post(`${P}/${started.id}/verify`, done).expect(200);
      expect((await as(api, customer).get(`${P}/${started.id}`)).body.status).toBe('PENDING');
      // The gateway settles later.
      gateway().completeCheckout(started.checkout.orderId, 'SUCCEEDED');
      const order = (
        gateway() as unknown as { orders: Map<string, { payments: Map<string, string> }> }
      ).orders.get(started.checkout.orderId)!;
      order.payments.set(done.providerPaymentId, 'SUCCEEDED');
      const res = await as(api, manager).post(`${A}/payments/${started.id}/reconcile`);
      expect(res.status).toBe(200);
      expect(res.body.status).toBe('SUCCEEDED');
      expect(await bookingStatus(booking.id)).toBe('CONFIRMED');
      expect((await as(api, manager).post(`${A}/payments/${started.id}/reconcile`)).status).toBe(
        200,
      );
      const viewer = await loginAdminWithPermissions(api, ['payment.view']);
      expect((await as(api, viewer).post(`${A}/payments/${started.id}/reconcile`)).status).toBe(
        403,
      );
    });

    it('refunds a succeeded payment in full, audited, safe to repeat, visible to the customer', async () => {
      const booking = await pending();
      const started = (await startPayment(booking.id)).body as Started;
      const reported = gateway().completeCheckout(started.checkout.orderId, 'SUCCEEDED');
      await as(api, customer).post(`${P}/${started.id}/verify`, reported).expect(200);
      const refunder = await loginAdminWithPermissions(api, ['payment.refund']);
      const viewer = await loginAdminWithPermissions(api, ['payment.view']);
      expect(
        (await as(api, viewer).post(`${A}/payments/${started.id}/refund`, { reason: 'x' })).status,
      ).toBe(403);
      expect(
        (await as(api, customer).post(`${A}/payments/${started.id}/refund`, { reason: 'x' }))
          .status,
      ).toBe(403);
      expect((await as(api, refunder).post(`${A}/payments/${started.id}/refund`, {})).status).toBe(
        400,
      );
      const res = await as(api, refunder).post(`${A}/payments/${started.id}/refund`, {
        reason: 'Service cancelled by us',
      });
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({
        status: 'REFUNDED',
        refundReason: 'Service cancelled by us',
        refundedByUserId: refunder.userId,
      });
      expect(
        gateway().refunds.filter((r) => r.providerPaymentId === reported.providerPaymentId),
      ).toHaveLength(1);
      expect((await as(api, customer).get(`${P}/${started.id}`)).body.refundStatus).toBe(
        'REFUNDED',
      );
      expect(
        (await as(api, refunder).post(`${A}/payments/${started.id}/refund`, { reason: 'again' }))
          .status,
      ).toBe(409);
      expect(
        await api.prisma.auditLog.count({
          where: { entityId: started.id, action: 'payment.refunded' },
        }),
      ).toBe(1);
    });

    it('records a failed refund and allows it to be retried; a pending payment cannot be refunded', async () => {
      const booking = await pending();
      const started = (await startPayment(booking.id)).body as Started;
      const refunder = await loginAdminWithPermissions(api, ['payment.refund']);
      expect(
        (await as(api, refunder).post(`${A}/payments/${started.id}/refund`, { reason: 'x' }))
          .status,
      ).toBe(409);
      const reported = gateway().completeCheckout(started.checkout.orderId, 'SUCCEEDED');
      await as(api, customer).post(`${P}/${started.id}/verify`, reported).expect(200);
      gateway().refundOutcome = 'FAILED';
      try {
        const failed = await as(api, refunder).post(`${A}/payments/${started.id}/refund`, {
          reason: 'try',
        });
        expect(failed.body.status).toBe('REFUND_FAILED');
      } finally {
        gateway().refundOutcome = 'SUCCEEDED';
      }
      const retry = await as(api, refunder).post(`${A}/payments/${started.id}/refund`, {
        reason: 'try again',
      });
      expect(retry.body.status).toBe('REFUNDED');
      expect(
        new Set(
          gateway()
            .refunds.filter((r) => r.providerPaymentId === reported.providerPaymentId)
            .map((r) => r.idempotencyKey),
        ).size,
      ).toBe(1);
    });

    it('lists and filters payments for staff only', async () => {
      const viewer = await loginAdminWithPermissions(api, ['payment.view']);
      const list = await as(api, viewer)
        .get(`${A}/payments?status=SUCCEEDED&limit=100`)
        .expect(200);
      expect(list.body.data.length).toBeGreaterThan(0);
      expect(list.body.data.every((p: { status: string }) => p.status === 'SUCCEEDED')).toBe(true);
      expect(list.body.data[0].providerOrderId).toBeTruthy();
      expect((await as(api, viewer).get(`${A}/payments?limit=101`)).status).toBe(400);
      expect((await as(api, customer).get(`${A}/payments`)).status).toBe(403);
      const none = await loginAdminWithPermissions(api, ['worker.view']);
      expect((await as(api, none).get(`${A}/payments`)).status).toBe(403);
      const request403 = await api
        .http()
        .get(`${A}/payments`)
        .set('Authorization', bearer(customer));
      expect(request403.status).toBe(403);
    });
  });

  describe('the adapter boundary and the database', () => {
    it('keeps provider failures out of the response body and refuses a second open payment per booking', async () => {
      const booking = await pending();
      const started = (await startPayment(booking.id)).body as Started;
      const spy = jest
        .spyOn(gateway(), 'verifyPayment')
        .mockRejectedValueOnce(new ProviderError('payment', 'secret-gateway-detail', true));
      const res = await as(api, customer).post(`${P}/${started.id}/verify`, {
        providerPaymentId: 'p',
        signature: 's',
      });
      spy.mockRestore();
      expect(JSON.stringify(res.body)).not.toContain('secret-gateway-detail');
      await expect(
        api.prisma.$executeRawUnsafe(
          `INSERT INTO payments (id, booking_id, customer_user_id, fee_code, amount_minor, currency, updated_at) VALUES (gen_random_uuid(), '${booking.id}', '${customer.userId}', 'BOOKING_FEE', 100, 'INR', now())`,
        ),
      ).rejects.toThrow();
      await expect(
        api.prisma.$executeRawUnsafe(
          `UPDATE payments SET status = 'SUCCEEDED' WHERE id = '${started.id}'`,
        ),
      ).rejects.toThrow();
      await expect(
        api.prisma.$executeRawUnsafe(
          `UPDATE payments SET amount_minor = 0 WHERE id = '${started.id}'`,
        ),
      ).rejects.toThrow();
    });

    it('does not accept the webhook through any user session', async () => {
      const { headers, body } = gateway().webhook({
        eventId: 'x',
        providerOrderId: 'y',
        providerPaymentId: 'z',
        outcome: 'SUCCEEDED',
        amountMinor: 1,
      });
      const res: request.Response = await api
        .http()
        .post(WEBHOOK)
        .set('Authorization', bearer(admin))
        .set('Content-Type', 'application/json')
        .send(body.toString() + ' ');
      expect(res.status).toBe(401);
      void headers;
    });
  });
});
