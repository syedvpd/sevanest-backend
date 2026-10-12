import '../support/env-api-integration';
import { ApiApp, createApiApp, loginAdmin, loginWithOtp } from '../support/api-app';
import { fakeGateway, makeBooking, TestBooking } from '../support/bookings';
import {
  approveCheck,
  as,
  createArea,
  onboardWorker,
  setRequiredChecks,
} from '../support/workforce';

/**
 * QA: cross-module races where two different workflows touch the same booking. Each pair is fired in parallel several times;
 * the requirement is: no 5xx (a deadlock would surface as one) and a state that is consistent between the modules.
 */
describe('QA - cross-module concurrency and deadlock probes (integration)', () => {
  let api: ApiApp;
  let admin: Awaited<ReturnType<typeof loginAdmin>>;
  let area: { id: string };
  let customer: Awaited<ReturnType<typeof loginWithOtp>>;

  beforeAll(async () => {
    api = await createApiApp();
    admin = await loginAdmin(api);
    area = await createArea(api, admin);
    await setRequiredChecks(api, admin, ['IDENTITY']);
    customer = await loginWithOtp(api, { appType: 'CUSTOMER' });
  }, 60_000);

  afterAll(async () => {
    await setRequiredChecks(api, admin, []);
    await api.close();
  });

  const c = () => as(api, customer);
  const activeWithRequest = async (): Promise<{ b: TestBooking; requestId: string }> => {
    const b = await makeBooking(api, admin, customer, area.id, 'ACTIVE');
    const requestId = (
      await c().post('/api/v1/replacement-requests', { bookingId: b.id, reason: 'race' })
    ).body.id as string;
    return { b, requestId };
  };
  const bookingStatus = async (id: string) =>
    (await api.prisma.booking.findUniqueOrThrow({ where: { id } })).status;
  const requestStatus = async (id: string) =>
    (await api.prisma.replacementRequest.findUniqueOrThrow({ where: { id } })).status;

  it('booking cancellation racing with the withdrawal of its replacement request never deadlocks and ends consistent', async () => {
    const bad: string[] = [];
    for (let i = 0; i < 8; i++) {
      const { b, requestId } = await activeWithRequest();
      const [x, y] = await Promise.all([
        c().post(`/api/v1/bookings/${b.id}/cancel`, { reason: 'race' }),
        c().post(`/api/v1/replacement-requests/${requestId}/cancel`),
      ]);
      const booking = await bookingStatus(b.id);
      const request = await requestStatus(requestId);
      if (x.status >= 500 || y.status >= 500) bad.push(`round ${i}: ${x.status}/${y.status}`);
      if (
        !(booking === 'CANCELLED' && request === 'CANCELLED') &&
        !(booking === 'ACTIVE' && request === 'CANCELLED')
      )
        bad.push(`round ${i}: booking ${booking} / request ${request}`);
    }
    expect(bad).toEqual([]);
  }, 200_000);

  it('booking cancellation racing with the staff decision on the replacement request', async () => {
    const bad: string[] = [];
    for (let i = 0; i < 6; i++) {
      const { b, requestId } = await activeWithRequest();
      const decision = i % 2 === 0 ? 'approve' : 'reject';
      const [x, y] = await Promise.all([
        c().post(`/api/v1/bookings/${b.id}/cancel`, { reason: 'race' }),
        as(api, admin).post(`/api/v1/admin/replacement-requests/${requestId}/${decision}`, {
          remarks: 'race',
        }),
      ]);
      if (x.status >= 500 || y.status >= 500)
        bad.push(`round ${i} ${decision}: ${x.status}/${y.status}`);
      const booking = await bookingStatus(b.id);
      const request = await requestStatus(requestId);
      const consistent =
        (booking === 'CANCELLED' && request === 'CANCELLED') ||
        (booking === 'REPLACEMENT_REQUESTED' && ['APPROVED'].includes(request)) ||
        (booking === 'ACTIVE' && request === 'REJECTED');
      if (!consistent) bad.push(`round ${i} ${decision}: booking ${booking} / request ${request}`);
    }
    expect(bad).toEqual([]);
  }, 200_000);

  it('selecting the replacement worker racing with a booking cancellation', async () => {
    const bad: string[] = [];
    for (let i = 0; i < 6; i++) {
      const { b, requestId } = await activeWithRequest();
      await as(api, admin)
        .post(`/api/v1/admin/replacement-requests/${requestId}/approve`, {})
        .expect(200);
      const other = await onboardWorker(api, { areaIds: [area.id] });
      await approveCheck(api, admin, other, 'IDENTITY');
      const [x, y] = await Promise.all([
        c().post(`/api/v1/bookings/${b.id}/cancel`, { reason: 'race' }),
        c().post(`/api/v1/replacement-requests/${requestId}/select`, { workerId: other.workerId }),
      ]);
      if (x.status >= 500 || y.status >= 500) bad.push(`round ${i}: ${x.status}/${y.status}`);
      const booking = await bookingStatus(b.id);
      const request = await requestStatus(requestId);
      const consistent =
        (booking === 'CANCELLED' && request === 'CANCELLED') ||
        (booking === 'REPLACED' && request === 'COMPLETED');
      if (!consistent) bad.push(`round ${i}: booking ${booking} / request ${request}`);
    }
    expect(bad).toEqual([]);
  }, 250_000);

  it('a payment confirmation racing with the cancellation of the same booking keeps booking and payment consistent', async () => {
    const bad: string[] = [];
    for (let i = 0; i < 6; i++) {
      const b = await makeBooking(api, admin, customer, area.id, 'PENDING_PAYMENT');
      const pay = (await c().post('/api/v1/payments', { bookingId: b.id })).body as {
        id: string;
        checkout: { orderId: string };
      };
      const done = fakeGateway(api).completeCheckout(pay.checkout.orderId, 'SUCCEEDED');
      const [x, y] = await Promise.all([
        c().post(`/api/v1/bookings/${b.id}/cancel`, { reason: 'race' }),
        c().post(`/api/v1/payments/${pay.id}/verify`, {
          providerPaymentId: done.providerPaymentId,
          signature: done.signature,
        }),
      ]);
      if (x.status >= 500 || y.status >= 500) bad.push(`round ${i}: ${x.status}/${y.status}`);
      const booking = await bookingStatus(b.id);
      const payment = (await api.prisma.payment.findUniqueOrThrow({ where: { id: pay.id } }))
        .status;
      // Money is never lost track of: a success is recorded whatever happened to the booking; a confirmed booking has a paid payment.
      if (payment !== 'SUCCEEDED') bad.push(`round ${i}: payment ${payment}`);
      if (booking === 'CONFIRMED' && payment !== 'SUCCEEDED')
        bad.push(`round ${i}: confirmed without payment`);
      if (!['CONFIRMED', 'CANCELLED'].includes(booking)) bad.push(`round ${i}: booking ${booking}`);
    }
    expect(bad).toEqual([]);
  }, 200_000);

  it('verification approval racing with a booking confirmation for the same worker keeps eligibility honest', async () => {
    const bad: string[] = [];
    for (let i = 0; i < 4; i++) {
      const b = await makeBooking(api, admin, customer, area.id, 'INTERVIEW_TRIAL_COMPLETED');
      const checkId = (
        await api.prisma.workerVerificationCheck.findFirstOrThrow({
          where: { workerId: b.worker.workerId, checkType: 'IDENTITY' },
        })
      ).id;
      const start = new Date(Date.now() + 86400000).toISOString().slice(0, 10);
      const [x, y] = await Promise.all([
        c().post(`/api/v1/bookings/${b.id}/confirm-worker`, { startDate: start }),
        as(api, admin).post(`/api/v1/admin/verification/checks/${checkId}/recheck`, {
          remarks: 'race',
        }),
      ]);
      if (x.status >= 500 || y.status >= 500) bad.push(`round ${i}: ${x.status}/${y.status}`);
      const booking = await bookingStatus(b.id);
      if (!['PENDING_PAYMENT', 'INTERVIEW_TRIAL_COMPLETED'].includes(booking))
        bad.push(`round ${i}: ${booking}`);
      if (booking === 'INTERVIEW_TRIAL_COMPLETED' && x.status !== 422)
        bad.push(`round ${i}: refused with ${x.status}`);
    }
    expect(bad).toEqual([]);
  }, 200_000);
});
