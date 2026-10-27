import '../support/env-api-integration';
import { randomUUID } from 'node:crypto';
import {
  ApiApp,
  createApiApp,
  loginAdmin,
  loginAdminWithPermissions,
  loginWithOtp,
} from '../support/api-app';
import { ensureFee, fakeGateway, makeBooking, TestBooking } from '../support/bookings';
import { as, createArea, setRequiredChecks } from '../support/workforce';
import { AppConfigService } from '../../src/config/app-config.service';
import { RECOVERY } from '../../src/modules/payment/payment-recovery.constants';
import { PaymentRecoveryService } from '../../src/modules/payment/payment-recovery.service';
import type { ProviderPaymentOutcome } from '../../src/integrations/payments/payment-provider.interface';

interface Started {
  id: string;
  checkout: { orderId: string };
}
const P = '/api/v1/payments';
const WEBHOOK = '/api/v1/webhooks/payments';
const A = '/api/v1/admin';

/**
 * Booking cancellation x payment consistency, late/lost/duplicate callbacks, and the recovery sweeper - against the real
 * PostgreSQL + Redis, through the HTTP API, with the fake gateway (real-gateway behaviour is NOT covered here).
 */
describe('Payment recovery and cancellation consistency (integration)', () => {
  let api: ApiApp;
  let admin: Awaited<ReturnType<typeof loginAdmin>>;
  let area: { id: string };
  let customer: Awaited<ReturnType<typeof loginWithOtp>> & { userId: string };
  let recovery: PaymentRecoveryService;

  const gateway = () => fakeGateway(api);
  const pending = (): Promise<TestBooking> =>
    makeBooking(api, admin, customer, area.id, 'PENDING_PAYMENT');
  const start = async (bookingId: string): Promise<Started> =>
    (await as(api, customer).post(P, { bookingId }).expect(201)).body as Started;
  const bookingStatus = async (id: string): Promise<string> =>
    (await as(api, customer).get(`/api/v1/bookings/${id}`)).body.status as string;
  const cancel = (id: string) =>
    as(api, customer).post(`/api/v1/bookings/${id}/cancel`, { reason: 'changed my mind' });
  const payment = (id: string) => api.prisma.payment.findUniqueOrThrow({ where: { id } });
  const exceptionsOf = (paymentId: string) =>
    api.prisma.paymentException.findMany({ where: { paymentId }, orderBy: { createdAt: 'asc' } });
  const webhook = (event: {
    eventId: string;
    providerOrderId: string;
    providerPaymentId: string;
    outcome: ProviderPaymentOutcome;
    amountMinor: number;
    kind?: 'PAYMENT' | 'REFUND';
    providerRefundId?: string;
  }) => {
    const { body, headers } = gateway().webhook(event);
    return api
      .http()
      .post(WEBHOOK)
      .set(headers)
      .set('Content-Type', 'application/json')
      .send(body.toString());
  };
  /** Makes a payment's next automatic check due now and unclaimed. */
  const makeDue = (id: string) =>
    api.prisma.payment.update({
      where: { id },
      data: { reconcileNextAt: new Date(Date.now() - 1000), reconcileClaimedUntil: null },
    });
  const outboxEvents = async (paymentId: string): Promise<string[]> => {
    const rows = await api.prisma.outboxEvent.findMany({
      where: { payload: { path: ['params', 'paymentId'], equals: paymentId } },
    });
    return rows.map((r) => (r.payload as { event: string }).event).sort();
  };

  beforeAll(async () => {
    api = await createApiApp();
    admin = await loginAdmin(api);
    area = await createArea(api, admin);
    customer = await loginWithOtp(api, { appType: 'CUSTOMER' });
    await setRequiredChecks(api, admin, ['IDENTITY']);
    await ensureFee(api, admin, 50000);
    recovery = api.app.get(PaymentRecoveryService);
  });

  afterAll(async () => {
    await setRequiredChecks(api, admin, []);
    await api.close();
  });

  describe('cancelling a booking that has a payment', () => {
    it('leaves a booking that has no payment alone', async () => {
      const booking = await pending();
      await cancel(booking.id).expect(200);
      expect(await bookingStatus(booking.id)).toBe('CANCELLED');
      expect(await api.prisma.payment.count({ where: { bookingId: booking.id } })).toBe(0);
    });

    it('closes a payment whose gateway order was never opened', async () => {
      const booking = await pending();
      gateway().failNextCreateOrder = true;
      await as(api, customer).post(P, { bookingId: booking.id }).expect(503);
      await cancel(booking.id).expect(200);
      const row = await api.prisma.payment.findFirstOrThrow({ where: { bookingId: booking.id } });
      expect(row).toMatchObject({
        status: 'FAILED',
        failureReason: 'BOOKING_CANCELLED',
        reconcileNextAt: null,
      });
      expect(await exceptionsOf(row.id)).toHaveLength(0);
    });

    it('closes the open gateway order, keeps watching it briefly, and refuses a new payment', async () => {
      const booking = await pending();
      const started = await start(booking.id);
      await cancel(booking.id).expect(200);
      const row = await payment(started.id);
      expect(row).toMatchObject({ status: 'FAILED', failureReason: 'BOOKING_CANCELLED' });
      expect(row.reconcileNextAt).not.toBeNull();
      expect(
        await api.prisma.auditLog.count({
          where: { entityId: started.id, action: 'payment.closed_booking_cancelled' },
        }),
      ).toBe(1);
      const retry = await as(api, customer).post(P, { bookingId: booking.id });
      expect(retry.status).toBe(409);
      expect(retry.body.code).toBe('BOOKING_NOT_PAYABLE');
    });

    it('treats a late payment success for a cancelled booking as a financial exception, never as an ordinary payment', async () => {
      const booking = await pending();
      const started = await start(booking.id);
      await cancel(booking.id).expect(200);
      const done = gateway().completeCheckout(started.checkout.orderId, 'SUCCEEDED');
      const event = {
        eventId: `evt_late_${started.id}`,
        providerOrderId: started.checkout.orderId,
        providerPaymentId: done.providerPaymentId,
        outcome: 'SUCCEEDED' as const,
        amountMinor: 50000,
      };
      await webhook(event).expect(200);
      await webhook(event).expect(200); // duplicate delivery

      expect(await bookingStatus(booking.id)).toBe('CANCELLED');
      const row = await payment(started.id);
      expect(row.status).toBe('SUCCEEDED'); // the money is real and recorded
      const exceptions = await exceptionsOf(started.id);
      expect(exceptions).toHaveLength(1);
      expect(exceptions[0]).toMatchObject({
        kind: 'LATE_PAYMENT_BOOKING_NOT_PENDING',
        status: 'OPEN',
        bookingId: booking.id,
        bookingStatus: 'CANCELLED',
        paymentStatus: 'SUCCEEDED',
        amountMinor: 50000,
        currency: 'INR',
        providerOrderId: started.checkout.orderId,
        providerPaymentId: done.providerPaymentId,
        requiredAction: 'REVIEW_REFUND_OR_RESOLVE',
      });
      // The customer is told it is under review - NOT that the payment succeeded - and staff are alerted.
      expect(await outboxEvents(started.id)).toEqual([
        'PAYMENT_EXCEPTION_ALERT',
        'PAYMENT_UNDER_REVIEW',
      ]);
      const alert = await api.prisma.outboxEvent.findFirstOrThrow({
        where: { payload: { path: ['params', 'exceptionId'], equals: exceptions[0].id } },
      });
      expect((alert.payload as { recipients: string[] }).recipients).toContain(admin.userId);
      // No refund is invented: the policy is open, so a person decides.
      expect(
        gateway().refunds.filter((r) => r.providerPaymentId === done.providerPaymentId),
      ).toHaveLength(0);
    });

    it('refunds a paid CONFIRMED booking automatically when it is cancelled (once, however often it is cancelled)', async () => {
      const booking = await makeBooking(api, admin, customer, area.id, 'CONFIRMED');
      const paid = await api.prisma.payment.findFirstOrThrow({ where: { bookingId: booking.id } });
      await cancel(booking.id).expect(200);
      // A repeated or concurrent cancellation is a no-op: no second refund request.
      await Promise.all([cancel(booking.id), cancel(booking.id)]);
      expect(await bookingStatus(booking.id)).toBe('CANCELLED');
      expect((await payment(paid.id)).status).toBe('REFUND_PENDING');
      expect(await exceptionsOf(paid.id)).toHaveLength(0);
      await recovery.runOnce();
      await recovery.runOnce();
      expect((await payment(paid.id)).status).toBe('REFUNDED');
      expect(
        gateway().refunds.filter((r) => r.providerPaymentId === paid.providerPaymentId),
      ).toHaveLength(1);
      expect(await outboxEvents(paid.id)).toEqual([
        'PAYMENT_REFUNDED',
        'PAYMENT_REFUND_INITIATED',
        'PAYMENT_SUCCEEDED',
      ]);
      const audited = await api.prisma.auditLog.count({
        where: { entityId: paid.id, action: 'payment.refund_request' },
      });
      expect(audited).toBe(1);
    });

    it('sends a refund the gateway refuses to the payment-exception queue and tells the customer', async () => {
      const booking = await makeBooking(api, admin, customer, area.id, 'CONFIRMED');
      const paid = await api.prisma.payment.findFirstOrThrow({ where: { bookingId: booking.id } });
      gateway().refundOutcome = 'FAILED';
      try {
        await cancel(booking.id).expect(200);
        await recovery.runOnce();
      } finally {
        gateway().refundOutcome = 'SUCCEEDED';
      }
      expect((await payment(paid.id)).status).toBe('REFUND_FAILED');
      const exceptions = await exceptionsOf(paid.id);
      expect(exceptions.map((e) => e.kind)).toEqual(['REFUND_STUCK']);
      expect(await outboxEvents(paid.id)).toEqual(
        expect.arrayContaining(['PAYMENT_EXCEPTION_ALERT', 'PAYMENT_UNDER_REVIEW']),
      );
    });

    it('does not refund automatically once the booking is past CONFIRMED (staff decide)', async () => {
      const booking = await makeBooking(api, admin, customer, area.id, 'CONFIRMED');
      const paid = await api.prisma.payment.findFirstOrThrow({ where: { bookingId: booking.id } });
      await api.prisma.booking.update({
        where: { id: booking.id },
        data: { status: 'REPLACEMENT_REQUESTED' },
      });
      await cancel(booking.id).expect(200);
      expect((await payment(paid.id)).status).toBe('SUCCEEDED');
      expect((await exceptionsOf(paid.id)).map((e) => e.kind)).toEqual(['PAID_BOOKING_CANCELLED']);
      expect(
        gateway().refunds.filter((r) => r.providerPaymentId === paid.providerPaymentId),
      ).toHaveLength(0);
    });

    it('flags money for a person (nothing refunded) when AUTO_REFUND_ON_CANCEL is off', async () => {
      const booking = await makeBooking(api, admin, customer, area.id, 'CONFIRMED');
      const paid = await api.prisma.payment.findFirstOrThrow({ where: { bookingId: booking.id } });
      const spy = jest
        .spyOn(api.app.get(AppConfigService), 'autoRefundOnCancel', 'get')
        .mockReturnValue(false);
      try {
        await cancel(booking.id).expect(200);
      } finally {
        spy.mockRestore();
      }
      expect((await payment(paid.id)).status).toBe('SUCCEEDED');
      expect((await exceptionsOf(paid.id)).map((e) => e.kind)).toEqual(['PAID_BOOKING_CANCELLED']);
      expect(
        gateway().refunds.filter((r) => r.providerPaymentId === paid.providerPaymentId),
      ).toHaveLength(0);
    });

    it('leaves a payment that is already being refunded alone', async () => {
      const booking = await makeBooking(api, admin, customer, area.id, 'CONFIRMED');
      const paid = await api.prisma.payment.findFirstOrThrow({ where: { bookingId: booking.id } });
      const refunder = await loginAdminWithPermissions(api, ['payment.refund']);
      await as(api, refunder)
        .post(`${A}/payments/${paid.id}/refund`, { reason: 'we cancelled' })
        .expect(200);
      await cancel(booking.id).expect(200);
      expect((await payment(paid.id)).status).toBe('REFUNDED');
      expect(await exceptionsOf(paid.id)).toHaveLength(0);
    });

    it('stays consistent when cancellation and the payment callback race', async () => {
      for (let i = 0; i < 4; i++) {
        const booking = await pending();
        const started = await start(booking.id);
        const done = gateway().completeCheckout(started.checkout.orderId, 'SUCCEEDED');
        const [, hook] = await Promise.all([
          cancel(booking.id),
          webhook({
            eventId: `evt_race_${started.id}`,
            providerOrderId: started.checkout.orderId,
            providerPaymentId: done.providerPaymentId,
            outcome: 'SUCCEEDED',
            amountMinor: 50000,
          }),
        ]);
        expect(hook.status).toBe(200);
        const row = await payment(started.id);
        const status = await bookingStatus(booking.id);
        const exceptions = await exceptionsOf(started.id);
        // Either order is acceptable; a contradiction is not. Cancellation is allowed from CONFIRMED, so the booking always ends cancelled.
        expect(status).toBe('CANCELLED');
        if (row.status === 'REFUND_PENDING') {
          // payment first: the CONFIRMED booking is cancelled and refunded automatically (DEC-04), nothing for a person to settle
          expect(exceptions).toHaveLength(0);
        } else {
          // cancellation first: the late payment is held for a person
          expect(row.status).toBe('SUCCEEDED');
          expect(exceptions).toHaveLength(1);
        }
      }
    });
  });

  describe('lost, late and duplicate callbacks (recovery sweeper)', () => {
    it('finds a payment whose callback was lost by asking the gateway about the order', async () => {
      const booking = await pending();
      const started = await start(booking.id);
      expect((await payment(started.id)).reconcileNextAt).not.toBeNull(); // booked when the order opened
      gateway().completeCheckout(started.checkout.orderId, 'SUCCEEDED'); // customer paid, no webhook, no verify
      expect(await bookingStatus(booking.id)).toBe('PENDING_PAYMENT');
      await makeDue(started.id);

      const run = await recovery.runOnce();
      expect(run.checked).toBeGreaterThanOrEqual(1);
      const row = await payment(started.id);
      expect(row).toMatchObject({ status: 'SUCCEEDED', reconcileNextAt: null });
      expect(row.receiptNumber).toBeTruthy();
      expect(await bookingStatus(booking.id)).toBe('CONFIRMED');

      // Repeating the job changes nothing and writes no second success.
      await recovery.runOnce();
      expect(
        await api.prisma.auditLog.count({
          where: { entityId: started.id, action: 'payment.succeeded' },
        }),
      ).toBe(1);
      expect(await outboxEvents(started.id)).toEqual(['PAYMENT_SUCCEEDED']);
    });

    it('is not fooled by a pending or unconfirmed payment: no success without gateway evidence', async () => {
      const booking = await pending();
      const started = await start(booking.id);
      gateway().completeCheckout(started.checkout.orderId, 'PENDING');
      await makeDue(started.id);
      await recovery.runOnce();
      const row = await payment(started.id);
      expect(row.status).toBe('PENDING');
      expect(row.reconcileAttempts).toBe(1);
      expect(row.reconcileNextAt!.getTime()).toBeGreaterThan(Date.now());
      expect(await bookingStatus(booking.id)).toBe('PENDING_PAYMENT');
    });

    it('does nothing noisy for an order nobody ever tried to pay', async () => {
      const booking = await pending();
      const started = await start(booking.id);
      await makeDue(started.id);
      await recovery.runOnce();
      const row = await payment(started.id);
      expect(row).toMatchObject({
        status: 'PENDING',
        reconcileAttempts: 1,
        reconcileLastNote: 'NO_GATEWAY_ACTIVITY',
      });
      // Run out the budget: the checks stop quietly (no alert for an abandoned checkout).
      await api.prisma.payment.update({
        where: { id: started.id },
        data: {
          reconcileAttempts: RECOVERY.maxAttempts - 1,
          reconcileNextAt: new Date(Date.now() - 1000),
        },
      });
      await recovery.runOnce();
      expect(await payment(started.id)).toMatchObject({ status: 'PENDING', reconcileNextAt: null });
      expect(await exceptionsOf(started.id)).toHaveLength(0);
    });

    it('records a gateway failure and keeps a short tail of checks for a later success on the same order', async () => {
      const booking = await pending();
      const started = await start(booking.id);
      gateway().completeCheckout(started.checkout.orderId, 'FAILED');
      await makeDue(started.id);
      await recovery.runOnce();
      expect((await payment(started.id)).status).toBe('FAILED');
      // The customer retries with another method on the same order and it works; the webhook is lost.
      gateway().completeCheckout(started.checkout.orderId, 'SUCCEEDED');
      await makeDue(started.id);
      await recovery.runOnce();
      expect((await payment(started.id)).status).toBe('SUCCEEDED');
      expect(await bookingStatus(booking.id)).toBe('CONFIRMED');
    });

    it('survives a gateway outage with bounded backoff, then escalates when the checks run out', async () => {
      const booking = await pending();
      const started = await start(booking.id);
      gateway().completeCheckout(started.checkout.orderId, 'SUCCEEDED');
      gateway().outage = true;
      try {
        await makeDue(started.id);
        await recovery.runOnce();
        let row = await payment(started.id);
        expect(row).toMatchObject({
          status: 'PENDING',
          reconcileAttempts: 1,
          reconcileLastNote: 'PROVIDER_UNAVAILABLE',
        });
        expect(row.reconcileNextAt!.getTime()).toBeGreaterThan(Date.now());
        expect(row.reconcileNextAt!.getTime()).toBeLessThanOrEqual(
          Date.now() + RECOVERY.capDelayMs,
        );

        await api.prisma.payment.update({
          where: { id: started.id },
          data: {
            reconcileAttempts: RECOVERY.maxAttempts - 1,
            reconcileNextAt: new Date(Date.now() - 1000),
          },
        });
        await recovery.runOnce();
        row = await payment(started.id);
        expect(row.reconcileNextAt).toBeNull();
        const [exception] = await exceptionsOf(started.id);
        expect(exception).toMatchObject({ kind: 'RECONCILIATION_EXHAUSTED', status: 'OPEN' });
      } finally {
        gateway().outage = false;
      }
      // The money is still recoverable by a person: the admin reconcile uses the same lookup.
      const manager = await loginAdminWithPermissions(api, ['payment.manage']);
      const res = await as(api, manager).post(`${A}/payments/${started.id}/reconcile`);
      expect(res.status).toBe(200);
      expect(res.body.status).toBe('SUCCEEDED');
    });

    it('reports a provider outage to an admin who reconciles by hand, without consuming the automatic budget', async () => {
      const booking = await pending();
      const started = await start(booking.id);
      const manager = await loginAdminWithPermissions(api, ['payment.manage']);
      gateway().outage = true;
      try {
        const res = await as(api, manager).post(`${A}/payments/${started.id}/reconcile`);
        expect(res.status).toBe(503);
        expect(res.body.code).toBe('PAYMENT_PROVIDER_UNAVAILABLE');
      } finally {
        gateway().outage = false;
      }
      expect((await payment(started.id)).reconcileAttempts).toBe(0);
    });

    it('refuses an amount the gateway reports differently and raises a mismatch exception', async () => {
      const booking = await pending();
      const started = await start(booking.id);
      gateway().completeCheckout(started.checkout.orderId, 'SUCCEEDED');
      gateway().amountOverride = 100;
      try {
        await makeDue(started.id);
        await recovery.runOnce();
      } finally {
        gateway().amountOverride = null;
      }
      expect((await payment(started.id)).status).toBe('PENDING');
      expect(await bookingStatus(booking.id)).toBe('PENDING_PAYMENT');
      const [exception] = await exceptionsOf(started.id);
      expect(exception).toMatchObject({
        kind: 'AMOUNT_MISMATCH',
        amountMinor: 100,
        status: 'OPEN',
      });
      expect(exception.details).toMatchObject({ expectedMinor: 50000, reportedMinor: 100 });
    });

    it('flags a second successful payment on an already paid order as a duplicate charge', async () => {
      const booking = await pending();
      const started = await start(booking.id);
      const first = gateway().completeCheckout(started.checkout.orderId, 'SUCCEEDED');
      const second = gateway().completeCheckout(started.checkout.orderId, 'SUCCEEDED');
      await makeDue(started.id);
      await recovery.runOnce();
      const row = await payment(started.id);
      expect(row.status).toBe('SUCCEEDED');
      expect([first.providerPaymentId, second.providerPaymentId]).toContain(row.providerPaymentId);
      const exceptions = await exceptionsOf(started.id);
      expect(exceptions.map((e) => e.kind)).toEqual(['DUPLICATE_PAYMENT']);
      await recovery.runOnce();
      expect(await exceptionsOf(started.id)).toHaveLength(1);
    });

    it('applies a webhook that raced ahead of its order once the order exists, and escalates one that never matches', async () => {
      const booking = await pending();
      const started = await start(booking.id);
      const done = gateway().completeCheckout(started.checkout.orderId, 'SUCCEEDED');
      // Simulate the webhook arriving before the order id was stored on the payment.
      await api.prisma.payment.update({
        where: { id: started.id },
        data: { providerOrderId: null },
      });
      const eventId = `evt_early_${started.id}`;
      await webhook({
        eventId,
        providerOrderId: started.checkout.orderId,
        providerPaymentId: done.providerPaymentId,
        outcome: 'SUCCEEDED',
        amountMinor: 50000,
      }).expect(200);
      expect(
        await api.prisma.paymentEvent.findUniqueOrThrow({ where: { providerEventId: eventId } }),
      ).toMatchObject({
        applied: false,
        note: 'UNKNOWN_ORDER',
      });
      await api.prisma.payment.update({
        where: { id: started.id },
        data: { providerOrderId: started.checkout.orderId, reconcileNextAt: null },
      });

      const run = await recovery.runOnce();
      expect(run.replayed).toBeGreaterThanOrEqual(1);
      expect((await payment(started.id)).status).toBe('SUCCEEDED');
      expect(await bookingStatus(booking.id)).toBe('CONFIRMED');
      expect(
        await api.prisma.paymentEvent.findUniqueOrThrow({ where: { providerEventId: eventId } }),
      ).toMatchObject({
        applied: true,
        note: 'SUCCEEDED',
      });
      // Replaying again (or re-delivery of the original webhook) cannot apply it twice.
      await recovery.runOnce();
      await webhook({
        eventId,
        providerOrderId: started.checkout.orderId,
        providerPaymentId: done.providerPaymentId,
        outcome: 'SUCCEEDED',
        amountMinor: 50000,
      }).expect(200);
      expect(
        await api.prisma.auditLog.count({
          where: { entityId: started.id, action: 'payment.succeeded' },
        }),
      ).toBe(1);

      // An event for an order that never appears is escalated exactly once.
      const orphan = `evt_orphan_${randomUUID()}`;
      await webhook({
        eventId: orphan,
        providerOrderId: `order_ghost_${randomUUID()}`,
        providerPaymentId: 'pay_ghost',
        outcome: 'SUCCEEDED',
        amountMinor: 50000,
      }).expect(200);
      await api.prisma.paymentEvent.update({
        where: { providerEventId: orphan },
        data: { createdAt: new Date(Date.now() - RECOVERY.unknownOrderEscalateAfterMs - 60_000) },
      });
      await recovery.runOnce();
      await recovery.runOnce();
      const escalated = await api.prisma.paymentException.findMany({
        where: { dedupeKey: `UNKNOWN_ORDER_EVENT:${orphan}` },
      });
      expect(escalated).toHaveLength(1);
      expect(escalated[0]).toMatchObject({
        kind: 'UNKNOWN_ORDER_EVENT',
        providerPaymentId: 'pay_ghost',
      });
      expect(
        (await api.prisma.paymentEvent.findUniqueOrThrow({ where: { providerEventId: orphan } }))
          .note,
      ).toBe('UNKNOWN_ORDER_ESCALATED');
    });

    it('lets competing workers process a payment once, and recovers a crashed worker claim', async () => {
      const booking = await pending();
      const started = await start(booking.id);
      gateway().completeCheckout(started.checkout.orderId, 'SUCCEEDED');
      const spy = jest.spyOn(gateway(), 'findPaymentsForOrder');
      try {
        await makeDue(started.id);
        await Promise.all([recovery.runOnce(), recovery.runOnce(), recovery.runOnce()]);
        const lookups = spy.mock.calls.filter(([order]) => order === started.checkout.orderId);
        expect(lookups).toHaveLength(1);
        expect((await payment(started.id)).status).toBe('SUCCEEDED');

        // A claim held by a live worker blocks others; once it lapses (worker died) the item is taken again.
        const other = await start((await pending()).id);
        gateway().completeCheckout(other.checkout.orderId, 'SUCCEEDED');
        await api.prisma.payment.update({
          where: { id: other.id },
          data: {
            reconcileNextAt: new Date(Date.now() - 1000),
            reconcileClaimedUntil: new Date(Date.now() + 60_000),
          },
        });
        await recovery.runOnce();
        expect((await payment(other.id)).status).toBe('PENDING');
        await api.prisma.payment.update({
          where: { id: other.id },
          data: { reconcileClaimedUntil: new Date(Date.now() - 1000) },
        });
        await recovery.runOnce();
        expect((await payment(other.id)).status).toBe('SUCCEEDED');
      } finally {
        spy.mockRestore();
      }
    });

    it('catches money held for a cancelled booking even if the cancellation hook never ran (backstop sweep)', async () => {
      const booking = await makeBooking(api, admin, customer, area.id, 'CONFIRMED');
      const paid = await api.prisma.payment.findFirstOrThrow({ where: { bookingId: booking.id } });
      // Legacy/inconsistent data: the booking was cancelled without the hook (direct write), no exception recorded.
      await api.prisma.booking.update({
        where: { id: booking.id },
        data: {
          status: 'CANCELLED',
          cancelledAt: new Date(),
          cancelReason: 'legacy',
          cancelledByUserId: customer.userId,
        },
      });
      expect(await exceptionsOf(paid.id)).toHaveLength(0);
      const run = await recovery.runOnce();
      expect(run.flaggedCancelled).toBeGreaterThanOrEqual(1);
      expect((await exceptionsOf(paid.id)).map((e) => e.kind)).toEqual(['PAID_BOOKING_CANCELLED']);
      await recovery.runOnce();
      expect(await exceptionsOf(paid.id)).toHaveLength(1);
    });
  });

  describe('refund recovery', () => {
    const paidPayment = async (): Promise<{ id: string; providerPaymentId: string }> => {
      const booking = await pending();
      const started = await start(booking.id);
      const done = gateway().completeCheckout(started.checkout.orderId, 'SUCCEEDED');
      await as(api, customer).post(`${P}/${started.id}/verify`, done).expect(200);
      return { id: started.id, providerPaymentId: done.providerPaymentId };
    };

    it('never calls a pending refund complete; the sweeper completes it from the gateway answer', async () => {
      const paid = await paidPayment();
      const refunder = await loginAdminWithPermissions(api, ['payment.refund']);
      gateway().refundOutcome = 'PENDING';
      try {
        const res = await as(api, refunder).post(`${A}/payments/${paid.id}/refund`, {
          reason: 'we cancelled',
        });
        expect(res.status).toBe(200);
        expect(res.body.status).toBe('REFUND_PENDING'); // accepted by the gateway is not refunded
      } finally {
        gateway().refundOutcome = 'SUCCEEDED';
      }
      const row = await payment(paid.id);
      expect(row.refundProviderId).toBeTruthy();
      expect(row.reconcileNextAt).not.toBeNull();

      await makeDue(paid.id);
      await recovery.runOnce();
      expect((await payment(paid.id)).status).toBe('REFUND_PENDING'); // gateway still pending

      gateway().settleRefund(row.refundProviderId!, 'SUCCEEDED');
      await makeDue(paid.id);
      await recovery.runOnce();
      const done = await payment(paid.id);
      expect(done).toMatchObject({ status: 'REFUNDED', reconcileNextAt: null });
      expect(done.refundedAt).not.toBeNull();
      // Exactly one refund exists at the gateway, however often the request and the sweeper ran.
      await as(api, refunder)
        .post(`${A}/payments/${paid.id}/refund`, { reason: 'again' })
        .expect(409);
      expect(
        gateway().refunds.filter((r) => r.providerPaymentId === paid.providerPaymentId),
      ).toHaveLength(1);
    });

    it('finishes a refund whose request never reached the gateway (crash or outage) without duplicating it', async () => {
      const paid = await paidPayment();
      const refunder = await loginAdminWithPermissions(api, ['payment.refund']);
      gateway().outage = true;
      try {
        const res = await as(api, refunder).post(`${A}/payments/${paid.id}/refund`, {
          reason: 'we cancelled',
        });
        expect(res.status).toBe(503);
      } finally {
        gateway().outage = false;
      }
      const stuck = await payment(paid.id);
      expect(stuck.status).toBe('REFUND_PENDING');
      expect(stuck.reconcileNextAt).not.toBeNull();
      expect(
        gateway().refunds.filter((r) => r.providerPaymentId === paid.providerPaymentId),
      ).toHaveLength(0);

      await makeDue(paid.id);
      await Promise.all([recovery.runOnce(), recovery.runOnce()]);
      expect((await payment(paid.id)).status).toBe('REFUNDED');
      expect(
        gateway().refunds.filter((r) => r.providerPaymentId === paid.providerPaymentId),
      ).toHaveLength(1);
    });

    it('adopts a refund the gateway already holds (lost response) instead of creating a second', async () => {
      const paid = await paidPayment();
      gateway().refundOutcome = 'PENDING';
      try {
        // The refund exists at the gateway but our record never learned its id.
        await gateway().refund({
          providerPaymentId: paid.providerPaymentId,
          amountMinor: 50000,
          idempotencyKey: `refund-${paid.id}`,
        });
      } finally {
        gateway().refundOutcome = 'SUCCEEDED';
      }
      await api.prisma.payment.update({
        where: { id: paid.id },
        data: {
          status: 'REFUND_PENDING',
          refundReason: 'we cancelled',
          reconcileNextAt: new Date(Date.now() - 1000),
        },
      });
      await recovery.runOnce();
      expect((await payment(paid.id)).status).toBe('REFUND_PENDING');
      expect(
        gateway().refunds.filter((r) => r.providerPaymentId === paid.providerPaymentId),
      ).toHaveLength(1);
      expect((await payment(paid.id)).refundProviderId).toBeTruthy();
    });

    it('escalates a refund that never reaches a final answer', async () => {
      const paid = await paidPayment();
      const refunder = await loginAdminWithPermissions(api, ['payment.refund']);
      gateway().refundOutcome = 'PENDING';
      try {
        await as(api, refunder)
          .post(`${A}/payments/${paid.id}/refund`, { reason: 'we cancelled' })
          .expect(200);
      } finally {
        gateway().refundOutcome = 'SUCCEEDED';
      }
      await api.prisma.payment.update({
        where: { id: paid.id },
        data: {
          reconcileAttempts: RECOVERY.maxAttempts - 1,
          reconcileNextAt: new Date(Date.now() - 1000),
        },
      });
      await recovery.runOnce();
      const [exception] = await exceptionsOf(paid.id);
      expect(exception).toMatchObject({
        kind: 'REFUND_STUCK',
        paymentStatus: 'REFUND_PENDING',
        status: 'OPEN',
      });
      expect((await payment(paid.id)).status).toBe('REFUND_PENDING'); // never assumed complete
    });

    it('applies an authenticated refund notification, and flags a refund nobody requested', async () => {
      const paid = await paidPayment();
      const refunder = await loginAdminWithPermissions(api, ['payment.refund']);
      gateway().refundOutcome = 'PENDING';
      try {
        await as(api, refunder)
          .post(`${A}/payments/${paid.id}/refund`, { reason: 'we cancelled' })
          .expect(200);
      } finally {
        gateway().refundOutcome = 'SUCCEEDED';
      }
      const row = await payment(paid.id);
      const hook = {
        kind: 'REFUND' as const,
        eventId: `evt_refund_${paid.id}`,
        providerOrderId: '',
        providerPaymentId: paid.providerPaymentId,
        providerRefundId: row.refundProviderId!,
        outcome: 'SUCCEEDED' as const,
        amountMinor: 50000,
      };
      await webhook(hook).expect(200);
      await webhook(hook).expect(200);
      expect((await payment(paid.id)).status).toBe('REFUNDED');
      expect(
        await api.prisma.auditLog.count({
          where: { entityId: paid.id, action: 'payment.refunded' },
        }),
      ).toBe(1);

      const other = await paidPayment();
      await webhook({
        ...hook,
        eventId: `evt_refund_${other.id}`,
        providerPaymentId: other.providerPaymentId,
        providerRefundId: 'rfnd_by_hand',
      }).expect(200);
      expect((await payment(other.id)).status).toBe('SUCCEEDED');
      expect((await exceptionsOf(other.id)).map((e) => e.kind)).toEqual(['REFUND_NOT_REQUESTED']);
    });
  });

  describe('operations visibility', () => {
    it('lists, filters and resolves exceptions with the right permissions, and audits the resolution', async () => {
      const booking = await pending();
      const started = await start(booking.id);
      await cancel(booking.id).expect(200);
      const done = gateway().completeCheckout(started.checkout.orderId, 'SUCCEEDED');
      await webhook({
        eventId: `evt_ops_${started.id}`,
        providerOrderId: started.checkout.orderId,
        providerPaymentId: done.providerPaymentId,
        outcome: 'SUCCEEDED',
        amountMinor: 50000,
      }).expect(200);

      const viewer = await loginAdminWithPermissions(api, ['payment.view']);
      const manager = await loginAdminWithPermissions(api, ['payment.manage']);
      expect((await as(api, customer).get(`${A}/payment-exceptions`)).status).toBe(403);
      expect((await api.http().get(`${A}/payment-exceptions`)).status).toBe(401);

      const list = await as(api, viewer)
        .get(`${A}/payment-exceptions?status=OPEN&paymentId=${started.id}`)
        .expect(200);
      expect(list.body.data).toHaveLength(1);
      const id = list.body.data[0].id as string;
      expect(list.body.data[0]).toMatchObject({
        kind: 'LATE_PAYMENT_BOOKING_NOT_PENDING',
        bookingStatus: 'CANCELLED',
      });
      expect((await as(api, viewer).get(`${A}/payment-exceptions?kind=NOT_A_KIND`)).status).toBe(
        400,
      );

      // Viewing is not managing; resolving needs a note and the manage permission.
      expect(
        (await as(api, viewer).post(`${A}/payment-exceptions/${id}/resolve`, { note: 'x' })).status,
      ).toBe(403);
      expect(
        (await as(api, manager).post(`${A}/payment-exceptions/${id}/resolve`, {})).status,
      ).toBe(400);
      const resolved = await as(api, manager).post(`${A}/payment-exceptions/${id}/resolve`, {
        note: 'refunded in gateway dashboard',
      });
      expect(resolved.status).toBe(200);
      expect(resolved.body).toMatchObject({
        status: 'RESOLVED',
        resolvedByUserId: manager.userId,
        resolutionNote: 'refunded in gateway dashboard',
      });
      expect(
        (await as(api, manager).post(`${A}/payment-exceptions/${id}/resolve`, { note: 'again' }))
          .status,
      ).toBe(409);
      expect(
        (
          await as(api, manager).post(`${A}/payment-exceptions/${randomUUID()}/resolve`, {
            note: 'x',
          })
        ).status,
      ).toBe(404);
      expect(
        await api.prisma.auditLog.count({
          where: { entityId: id, action: 'payment.exception_resolved' },
        }),
      ).toBe(1);
      expect(
        await api.prisma.auditLog.count({
          where: { entityId: id, action: 'payment.exception_raised' },
        }),
      ).toBe(1);
      // A resolved problem is not raised again by the sweepers.
      await recovery.runOnce();
      expect(
        (await as(api, viewer).get(`${A}/payment-exceptions?paymentId=${started.id}`)).body.data,
      ).toHaveLength(1);
    });

    it('shows the recovery queue so a stopped worker is noticeable', async () => {
      const booking = await pending();
      const started = await start(booking.id);
      await makeDue(started.id);
      const viewer = await loginAdminWithPermissions(api, ['payment.view']);
      const before = (await as(api, viewer).get(`${A}/payment-recovery/summary`).expect(200)).body;
      expect(before.dueForCheck).toBeGreaterThanOrEqual(1);
      expect(before.oldestDueSeconds).toBeGreaterThanOrEqual(0);
      expect(before.openExceptions).toEqual(expect.any(Number));
      expect(before.openExceptionsByKind).toEqual(expect.any(Object));
      await recovery.runOnce();
      const after = (await as(api, viewer).get(`${A}/payment-recovery/summary`).expect(200)).body;
      expect(after.dueForCheck as number).toBeLessThan(before.dueForCheck as number);
      expect((await as(api, customer).get(`${A}/payment-recovery/summary`)).status).toBe(403);
    });
  });
});
