import '../support/env-api-integration';
import { ApiApp, createApiApp, loginAdmin, loginWithOtp, unique } from '../support/api-app';
import { ensureFee, fakeGateway, makeBooking } from '../support/bookings';
import { as, createArea, setRequiredChecks } from '../support/workforce';

const P = '/api/v1/payments';
const WEBHOOK = '/api/v1/webhooks/payments';

type Session = Awaited<ReturnType<typeof loginWithOtp>>;

/** Customer-app payment contract: typed checkout, receipt, method and gateway reference, failure reason, filters. */
describe('Payment contract for the customer app (integration)', () => {
  let api: ApiApp;
  let admin: Awaited<ReturnType<typeof loginAdmin>>;
  let area: { id: string };

  const gateway = () => fakeGateway(api);
  const webhook = (event: Parameters<ReturnType<typeof fakeGateway>['webhook']>[0]) => {
    const { body, headers } = gateway().webhook(event);
    return api
      .http()
      .post(WEBHOOK)
      .set(headers)
      .set('Content-Type', 'application/json')
      .send(body.toString());
  };
  const customer = async (): Promise<Session> => {
    const s = await loginWithOtp(api, { appType: 'CUSTOMER' });
    await as(api, s)
      .post('/api/v1/customers/me', {
        name: 'Asha Rao',
        email: `c.${unique()}@example.test`,
        preferredLanguage: 'en',
      })
      .expect(201);
    return s;
  };
  const start = async (c: Session) => {
    const b = await makeBooking(api, admin, c, area.id, 'PENDING_PAYMENT');
    const res = await as(api, c).post(P, { bookingId: b.id }).expect(201);
    return {
      bookingId: b.id,
      payment: res.body as { id: string; status: string; checkout: Record<string, unknown> },
    };
  };

  beforeAll(async () => {
    api = await createApiApp();
    admin = await loginAdmin(api);
    area = await createArea(api, admin);
    await setRequiredChecks(api, admin, ['IDENTITY']);
    await ensureFee(api, admin);
  });
  afterAll(async () => {
    await setRequiredChecks(api, admin, []);
    await api.close();
  });

  it('returns a typed checkout and PENDING once the gateway order exists', async () => {
    const c = await customer();
    const { payment } = await start(c);
    expect(payment.status).toBe('PENDING');
    expect(payment.checkout).toEqual({
      gateway: 'fake',
      keyId: null,
      orderId: expect.any(String) as string,
      amount: 50000,
      currency: 'INR',
    });
  });

  it('records the masked payment method and gateway reference on success, and serves the receipt', async () => {
    const c = await customer();
    const { payment } = await start(c);
    const orderId = payment.checkout.orderId as string;
    const reported = gateway().completeCheckout(orderId, 'SUCCEEDED');
    expect(
      (
        await webhook({
          eventId: `evt_${unique()}`,
          providerOrderId: orderId,
          providerPaymentId: reported.providerPaymentId,
          outcome: 'SUCCEEDED',
          amountMinor: 50000,
          currency: 'INR',
          method: 'upi',
          methodDetail: 'as***@okhdfc',
        })
      ).status,
    ).toBe(200);
    const view = (await as(api, c).get(`${P}/${payment.id}`).expect(200)).body as Record<
      string,
      unknown
    >;
    expect(view).toMatchObject({
      status: 'SUCCEEDED',
      paymentMethod: 'upi',
      paymentMethodDetail: 'as***@okhdfc',
      gatewayReference: reported.providerPaymentId,
      failureCode: null,
      failureReason: null,
    });
    const receipt = (await as(api, c).get(`${P}/${payment.id}/receipt`).expect(200)).body as Record<
      string,
      unknown
    >;
    expect(receipt).toMatchObject({
      paymentId: payment.id,
      feeCode: 'BOOKING_FEE',
      amountMinor: 50000,
      currency: 'INR',
      paymentMethod: 'upi',
      gatewayReference: reported.providerPaymentId,
      refundStatus: null,
    });
    expect(receipt.receiptNumber).toEqual(view.receiptNumber);

    const pdf = await as(api, c)
      .get(`${P}/${payment.id}/receipt/pdf`)
      .buffer(true)
      .parse((res, done) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => done(null, Buffer.concat(chunks)));
      })
      .expect(200);
    expect(pdf.headers['content-type']).toContain('application/pdf');
    expect(pdf.headers['content-disposition']).toContain(`${String(view.receiptNumber)}.pdf`);
    const text = (pdf.body as Buffer).toString('latin1');
    expect(text.startsWith('%PDF-')).toBe(true);
    expect(text).toContain(String(view.receiptNumber));
    expect(text).toContain('INR 500.00');
    expect(text).toContain('not a tax invoice');
    // someone else's receipt does not exist for them
    await as(api, await customer())
      .get(`${P}/${payment.id}/receipt/pdf`)
      .expect(404);
  });

  it('refuses the PDF receipt before the payment succeeded', async () => {
    const c = await customer();
    const { payment } = await start(c);
    const res = await as(api, c).get(`${P}/${payment.id}/receipt/pdf`).expect(409);
    expect((res.body as { code: string }).code).toBe('RECEIPT_NOT_AVAILABLE');
  });

  it('exposes the gateway failure reason, and a retry creates a new payment', async () => {
    const c = await customer();
    const { bookingId, payment } = await start(c);
    const orderId = payment.checkout.orderId as string;
    const failed = gateway().completeCheckout(orderId, 'FAILED');
    await webhook({
      eventId: `evt_${unique()}`,
      providerOrderId: orderId,
      providerPaymentId: failed.providerPaymentId,
      outcome: 'FAILED',
      amountMinor: 50000,
      method: 'card',
      errorCode: 'BAD_REQUEST_ERROR',
      errorDescription: 'Your bank declined this payment',
    }).expect(200);
    expect((await as(api, c).get(`${P}/${payment.id}`)).body).toMatchObject({
      status: 'FAILED',
      failureCode: 'BAD_REQUEST_ERROR',
      failureReason: 'Your bank declined this payment',
      paymentMethod: 'card',
    });
    expect((await as(api, c).get(`${P}/${payment.id}/receipt`)).body).toMatchObject({
      code: 'RECEIPT_NOT_AVAILABLE',
    });
    const retry = await as(api, c).post(P, { bookingId }).expect(201);
    expect((retry.body as { id: string }).id).not.toBe(payment.id);
    const forBooking = (await as(api, c).get(`${P}?bookingId=${bookingId}`).expect(200)).body as {
      meta: { total: number };
    };
    expect(forBooking.meta.total).toBe(2);
  });

  it('filters by booking and by refunded, validates the filters and keeps other customers out', async () => {
    const c = await customer();
    const other = await customer();
    const { bookingId, payment } = await start(c);
    expect((await as(api, c).get(`${P}?refunded=true`).expect(200)).body).toMatchObject({
      meta: { total: 0 },
    });
    expect((await as(api, c).get(`${P}?refunded=maybe`)).status).toBe(400);
    expect((await as(api, c).get(`${P}?bookingId=nope`)).status).toBe(400);
    expect((await as(api, other).get(`${P}?bookingId=${bookingId}`)).body).toMatchObject({
      meta: { total: 0 },
    });
    expect((await as(api, other).get(`${P}/${payment.id}/receipt`)).status).toBe(404);
    expect((await api.http().get(`${P}/${payment.id}/receipt`)).status).toBe(401);
  });
});
