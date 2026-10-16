import '../support/env-api-integration';
import { randomUUID } from 'node:crypto';
import {
  ApiApp,
  createApiApp,
  loginAdmin,
  loginAdminWithPermissions,
  loginWithOtp,
  unique,
} from '../support/api-app';
import { ensureFee, fakeGateway, makeBooking, TestBooking } from '../support/bookings';
import { AppConfigService } from '../../src/config/app-config.service';
import { as, createArea, setRequiredChecks } from '../support/workforce';

const A = '/api/v1/admin';
const FEE_PAY = '/api/v1/fee-payments';

interface Started {
  id: string;
  amountMinor: number;
  checkout: { orderId: string };
}

/** Fee catalogue (DEC-11): kinds, admin CRUD, and the generic "pay a fee against a booking" path. */
describe('Fee catalogue and fee payments (integration)', () => {
  let api: ApiApp;
  let admin: Awaited<ReturnType<typeof loginAdmin>>;
  let manager: Awaited<ReturnType<typeof loginAdminWithPermissions>>;
  let viewer: Awaited<ReturnType<typeof loginAdminWithPermissions>>;
  let area: { id: string };
  let customer: Awaited<ReturnType<typeof loginWithOtp>> & { userId: string };

  const code = (prefix: string) =>
    `${prefix}_${unique()
      .toUpperCase()
      .replace(/[^A-Z0-9]/g, '')}`;
  const createFee = (body: object) => as(api, manager).post(`${A}/fees`, body);
  const gateway = () => fakeGateway(api);
  const startFee = (bookingId: string, feeCode: string, who = customer) =>
    as(api, who).post(FEE_PAY, { bookingId, feeCode });
  const pay = async (started: Started) => {
    const done = gateway().completeCheckout(started.checkout.orderId, 'SUCCEEDED');
    return as(api, customer).post(`/api/v1/payments/${started.id}/verify`, done);
  };
  const exceptionsOf = (paymentId: string) =>
    api.prisma.paymentException.findMany({ where: { paymentId } });

  beforeAll(async () => {
    api = await createApiApp();
    admin = await loginAdmin(api);
    area = await createArea(api, admin);
    customer = await loginWithOtp(api, { appType: 'CUSTOMER' });
    await setRequiredChecks(api, admin, ['IDENTITY']);
    await ensureFee(api, admin, 50000);
    manager = await loginAdminWithPermissions(api, ['payment.manage', 'payment.view']);
    viewer = await loginAdminWithPermissions(api, ['payment.view']);
  });
  afterAll(async () => {
    await setRequiredChecks(api, admin, []);
    await api.close();
  });

  describe('admin catalogue', () => {
    it('creates, lists by kind, reads with an ETag, updates and deletes a fee; only payment.manage may write', async () => {
      const feeCode = code('PLACEMENT');
      const body = { code: feeCode, kind: 'PLACEMENT', amountMinor: 250000 };
      expect((await as(api, viewer).post(`${A}/fees`, body)).status).toBe(403);
      expect((await as(api, customer).post(`${A}/fees`, body)).status).toBe(403);
      expect((await api.http().post(`${A}/fees`).send(body)).status).toBe(401);

      const created = await createFee(body).expect(201);
      expect(created.body).toMatchObject({
        code: feeCode,
        kind: 'PLACEMENT',
        amountMinor: 250000,
        currency: 'INR',
        isActive: true,
      });
      const dup = await createFee(body);
      expect(dup.status).toBe(409);
      expect(dup.body.code).toBe('FEE_EXISTS');

      const byKind = await as(api, viewer).get(`${A}/fees?kind=PLACEMENT`).expect(200);
      expect(byKind.body.map((f: { code: string }) => f.code)).toContain(feeCode);
      expect(byKind.body.every((f: { kind: string }) => f.kind === 'PLACEMENT')).toBe(true);
      expect((await as(api, viewer).get(`${A}/fees?kind=LUNCH`)).status).toBe(400);

      const one = await as(api, viewer).get(`${A}/fees/${feeCode}`).expect(200);
      const etag = one.headers['etag'];
      expect(etag).toBeTruthy();
      const patched = await as(api, manager)
        .patch(`${A}/fees/${feeCode}`, { amountMinor: 300000 })
        .expect(200);
      expect(patched.body.amountMinor).toBe(300000);
      expect(patched.body.kind).toBe('PLACEMENT');
      expect(
        (await as(api, viewer).patch(`${A}/fees/${feeCode}`, { isActive: false })).status,
      ).toBe(403);
      expect((await as(api, manager).patch(`${A}/fees/${feeCode}`, {})).status).toBe(400);
      expect(
        (await as(api, manager).patch(`${A}/fees/${code('NOPE')}`, { isActive: false })).status,
      ).toBe(404);

      const audit = await api.prisma.auditLog.findFirstOrThrow({
        where: { entityId: feeCode, action: 'payment.fee_set' },
        orderBy: { createdAt: 'desc' },
      });
      expect(audit.metadata).toMatchObject({
        before: { amountMinor: 250000, kind: 'PLACEMENT' },
        after: { amountMinor: 300000, kind: 'PLACEMENT' },
      });

      await as(api, manager).delete(`${A}/fees/${feeCode}`).expect(204);
      expect((await as(api, viewer).get(`${A}/fees/${feeCode}`)).status).toBe(404);
    });

    it('validates input: positive amount (0 only for the cancellation fee), a kind for unknown codes, upper-case codes', async () => {
      for (const bad of [
        { code: code('PLACEMENT'), kind: 'PLACEMENT', amountMinor: 0 },
        { code: code('PLACEMENT'), kind: 'PLACEMENT', amountMinor: -1 },
        { code: code('PLACEMENT'), kind: 'PLACEMENT', amountMinor: 1.5 },
        { code: code('PLACEMENT'), kind: 'GIFT', amountMinor: 100 },
        { code: 'lower_case', kind: 'PLACEMENT', amountMinor: 100 },
        { code: code('PLACEMENT'), kind: 'PLACEMENT', amountMinor: 100, currency: 'USD' },
        { code: code('PLACEMENT'), amountMinor: 100 },
      ]) {
        expect((await createFee(bad)).status).toBe(400);
      }
      // the legacy upsert still works for known codes and needs a kind for unknown ones
      await as(api, manager)
        .put(`${A}/fees/${code('VERIFICATION_FEE')}`, { amountMinor: 100 })
        .expect(200);
      expect(
        (await as(api, manager).put(`${A}/fees/${code('MYSTERY')}`, { amountMinor: 100 })).status,
      ).toBe(400);
    });

    it('protects the booking fee and any fee that was ever charged; used fees are deactivated instead', async () => {
      const protectedDelete = await as(api, manager).delete(`${A}/fees/BOOKING_FEE`);
      expect(protectedDelete.status).toBe(409);
      expect(protectedDelete.body.code).toBe('FEE_PROTECTED');

      const feeCode = code('VERIFICATION');
      await createFee({ code: feeCode, kind: 'VERIFICATION', amountMinor: 9900 }).expect(201);
      const booking = await makeBooking(api, admin, customer, area.id, 'CONFIRMED');
      await startFee(booking.id, feeCode).expect(201);
      const used = await as(api, manager).delete(`${A}/fees/${feeCode}`);
      expect(used.status).toBe(409);
      expect(used.body.code).toBe('FEE_IN_USE');
      await as(api, manager).patch(`${A}/fees/${feeCode}`, { isActive: false }).expect(200);
      const kindChange = await as(api, manager).put(`${A}/fees/${feeCode}`, {
        amountMinor: 9900,
        kind: 'PLACEMENT',
      });
      expect(kindChange.status).toBe(409);
    });

    it('requires If-Match on changes when ADMIN_IF_MATCH_REQUIRED is on (428 without, 412 when stale)', async () => {
      const feeCode = code('PLACEMENT');
      await createFee({ code: feeCode, kind: 'PLACEMENT', amountMinor: 1000 }).expect(201);
      const spy = jest
        .spyOn(api.app.get(AppConfigService), 'adminIfMatchRequired', 'get')
        .mockReturnValue(true);
      try {
        const etag = (await as(api, viewer).get(`${A}/fees/${feeCode}`).expect(200)).headers[
          'etag'
        ];
        const missing = await as(api, manager).patch(`${A}/fees/${feeCode}`, { amountMinor: 2000 });
        expect(missing.status).toBe(428);
        expect(missing.body.code).toBe('PRECONDITION_REQUIRED');
        const put = await as(api, manager).put(`${A}/fees/${feeCode}`, { amountMinor: 2000 });
        expect(put.status).toBe(428);
        const win = await api
          .http()
          .patch(`${A}/fees/${feeCode}`)
          .set('Authorization', `Bearer ${manager.accessToken}`)
          .set('If-Match', etag)
          .send({ amountMinor: 2000 });
        expect(win.status).toBe(200);
        const stale = await api
          .http()
          .patch(`${A}/fees/${feeCode}`)
          .set('Authorization', `Bearer ${manager.accessToken}`)
          .set('If-Match', etag)
          .send({ amountMinor: 3000 });
        expect(stale.status).toBe(412);
        expect(stale.body.code).toBe('STALE_VERSION');
        expect(
          (await api.prisma.feeConfig.findUniqueOrThrow({ where: { code: feeCode } })).amountMinor,
        ).toBe(2000);
      } finally {
        spy.mockRestore();
      }
    });
  });

  describe('paying a fee against a booking', () => {
    let booking: TestBooking;
    beforeAll(async () => {
      booking = await makeBooking(api, admin, customer, area.id, 'ACTIVE');
    });

    it('is disabled until an ACTIVE fee of a payable kind exists', async () => {
      await api.prisma.feeConfig.updateMany({
        where: { kind: { in: ['PLACEMENT', 'VERIFICATION', 'REPLACEMENT_PLAN'] } },
        data: { isActive: false },
      });
      const none = await as(api, customer).get('/api/v1/fees/payable').expect(200);
      expect(none.body).toEqual([]);
      const feeCode = code('REPLACEMENT_PLAN');
      await createFee({
        code: feeCode,
        kind: 'REPLACEMENT_PLAN',
        amountMinor: 120000,
        isActive: false,
      }).expect(201);
      const off = await startFee(booking.id, feeCode);
      expect(off.status).toBe(422);
      expect(off.body.code).toBe('FEE_NOT_CONFIGURED');
      const unknown = await startFee(booking.id, code('NO_SUCH'));
      expect(unknown.status).toBe(422);
      await as(api, manager).patch(`${A}/fees/${feeCode}`, { isActive: true }).expect(200);
      const listed = await as(api, customer).get('/api/v1/fees/payable').expect(200);
      expect(listed.body).toEqual([
        { code: feeCode, kind: 'REPLACEMENT_PLAN', amountMinor: 120000, currency: 'INR' },
      ]);
      await api.prisma.feeConfig.update({ where: { code: feeCode }, data: { isActive: false } });
    });

    it('takes the amount from the configuration only, refuses fees that are not payable kinds, and other customers', async () => {
      const feeCode = code('PLACEMENT');
      await createFee({ code: feeCode, kind: 'PLACEMENT', amountMinor: 400000 }).expect(201);
      const sneaky = await as(api, customer).post(FEE_PAY, {
        bookingId: booking.id,
        feeCode,
        amountMinor: 1,
      });
      // unknown body fields are stripped: the customer cannot choose the amount
      expect(sneaky.status).toBe(201);
      expect(sneaky.body.amountMinor).toBe(400000);
      const stored = await api.prisma.payment.findFirstOrThrow({
        where: { bookingId: booking.id, feeCode },
      });
      expect(stored.amountMinor).toBe(400000);

      const subscription = code('SUBSCRIPTION');
      await createFee({ code: subscription, kind: 'SUBSCRIPTION', amountMinor: 99900 }).expect(201);
      const notPayable = await startFee(booking.id, subscription);
      expect(notPayable.status).toBe(422);
      expect(notPayable.body.code).toBe('FEE_NOT_PAYABLE');
      expect((await startFee(booking.id, 'BOOKING_FEE')).status).toBe(422);
      expect((await startFee(booking.id, 'CANCELLATION_FEE')).status).toBe(422);

      const stranger = await loginWithOtp(api, { appType: 'CUSTOMER' });
      expect((await startFee(booking.id, feeCode, stranger)).status).toBe(404);
      expect((await startFee(randomUUID(), feeCode)).status).toBe(404);
      expect((await api.http().post(FEE_PAY).send({ bookingId: booking.id, feeCode })).status).toBe(
        401,
      );
      expect(
        (await as(api, manager).post(FEE_PAY, { bookingId: booking.id, feeCode })).status,
      ).toBe(403);
      const worker = booking.worker;
      expect((await as(api, worker).post(FEE_PAY, { bookingId: booking.id, feeCode })).status).toBe(
        403,
      );
    });

    it('pays through the normal state machine: resumable, verified by the gateway, one receipt, never twice, booking untouched', async () => {
      const feeCode = code('PLACEMENT');
      await createFee({ code: feeCode, kind: 'PLACEMENT', amountMinor: 450000 }).expect(201);
      const first = await startFee(booking.id, feeCode).expect(201);
      expect(first.body.amountMinor).toBe(450000);
      const again = await startFee(booking.id, feeCode).expect(201);
      expect(again.body.id).toBe(first.body.id); // resumed, not duplicated
      expect(await api.prisma.payment.count({ where: { bookingId: booking.id, feeCode } })).toBe(1);

      // a wrong signature changes nothing
      const forged = await as(api, customer).post(`/api/v1/payments/${first.body.id}/verify`, {
        providerPaymentId: 'pay_forged',
        signature: 'x'.repeat(40),
      });
      expect(forged.status).toBe(400);
      expect(
        (await api.prisma.payment.findUniqueOrThrow({ where: { id: first.body.id } })).status,
      ).not.toBe('SUCCEEDED');

      const verified = await pay(first.body as Started);
      expect(verified.status).toBe(200);
      expect(verified.body.status).toBe('SUCCEEDED');
      const row = await api.prisma.payment.findUniqueOrThrow({ where: { id: first.body.id } });
      expect(row.receiptNumber).toBeTruthy();
      expect(row.feeCode).toBe(feeCode);
      // the booking is exactly where it was
      const status = (await as(api, customer).get(`/api/v1/bookings/${booking.id}`)).body.status;
      expect(status).toBe('ACTIVE');
      // the booking-fee payment of the same booking is a different row and untouched
      const bookingFee = await api.prisma.payment.findFirstOrThrow({
        where: { bookingId: booking.id, feeCode: 'BOOKING_FEE' },
      });
      expect(bookingFee.status).toBe('SUCCEEDED');

      const twice = await startFee(booking.id, feeCode);
      expect(twice.status).toBe(409);
      expect(twice.body.code).toBe('ALREADY_PAID');
      expect(await api.prisma.payment.count({ where: { bookingId: booking.id, feeCode } })).toBe(1);
    });

    it('rejects an amount that does not match the fee as a payment exception, never as a success', async () => {
      const feeCode = code('VERIFICATION');
      await createFee({ code: feeCode, kind: 'VERIFICATION', amountMinor: 20000 }).expect(201);
      const started = (await startFee(booking.id, feeCode).expect(201)).body as Started;
      const done = gateway().completeCheckout(started.checkout.orderId, 'SUCCEEDED');
      const { body, headers } = gateway().webhook({
        eventId: `evt_${randomUUID()}`,
        providerOrderId: started.checkout.orderId,
        providerPaymentId: done.providerPaymentId,
        outcome: 'SUCCEEDED',
        amountMinor: 100,
      });
      await api
        .http()
        .post('/api/v1/webhooks/payments')
        .set(headers)
        .set('Content-Type', 'application/json')
        .send(body.toString());
      const row = await api.prisma.payment.findUniqueOrThrow({ where: { id: started.id } });
      expect(row.status).not.toBe('SUCCEEDED');
      expect((await exceptionsOf(started.id)).map((e) => e.kind)).toContain('AMOUNT_MISMATCH');
    });

    it('cancelling the booking closes an open fee payment and flags a paid one for a person (no automatic refund of extra fees)', async () => {
      const feeCode = code('PLACEMENT');
      await createFee({ code: feeCode, kind: 'PLACEMENT', amountMinor: 150000 }).expect(201);
      const confirmed = await makeBooking(api, admin, customer, area.id, 'CONFIRMED');
      const open = (await startFee(confirmed.id, feeCode).expect(201)).body as Started;
      await as(api, customer)
        .post(`/api/v1/bookings/${confirmed.id}/cancel`, { reason: 'changed my mind' })
        .expect(200);
      const closed = await api.prisma.payment.findUniqueOrThrow({ where: { id: open.id } });
      expect(closed).toMatchObject({ status: 'FAILED', failureReason: 'BOOKING_CANCELLED' });
      // the booking fee was paid and CONFIRMED -> refunded automatically (DEC-04); the extra fee never is
      const bookingFee = await api.prisma.payment.findFirstOrThrow({
        where: { bookingId: confirmed.id, feeCode: 'BOOKING_FEE' },
      });
      expect(bookingFee.status).toBe('REFUND_PENDING');

      const second = await makeBooking(api, admin, customer, area.id, 'CONFIRMED');
      const paid = (await startFee(second.id, feeCode).expect(201)).body as Started;
      expect((await pay(paid)).body.status).toBe('SUCCEEDED');
      await as(api, customer)
        .post(`/api/v1/bookings/${second.id}/cancel`, { reason: 'changed my mind' })
        .expect(200);
      const after = await api.prisma.payment.findUniqueOrThrow({ where: { id: paid.id } });
      expect(after.status).toBe('SUCCEEDED');
      expect((await exceptionsOf(paid.id)).map((e) => e.kind)).toEqual(['PAID_BOOKING_CANCELLED']);
      expect(
        gateway().refunds.filter((r) => r.providerPaymentId === after.providerPaymentId),
      ).toHaveLength(0);
      const refused = await startFee(second.id, feeCode);
      expect(refused.status).toBe(409);
    });
  });
});
