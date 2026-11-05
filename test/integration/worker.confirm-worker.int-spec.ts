import '../support/env-api-integration';
import { ApiApp, createApiApp, loginAdmin, loginWithOtp } from '../support/api-app';
import { makeBooking, inDays } from '../support/bookings';
import {
  as,
  createArea,
  onboardWorker,
  approveCheck,
  setRequiredChecks,
} from '../support/workforce';

/**
 * Regression tests for the worker `confirm-worker` permission.
 *
 * Root cause: `confirm-worker` was only permitted for CUSTOMER and ADMIN actors
 * (`src/modules/booking/booking.service.ts` RULES), and `BookingService.act()` rejected any
 * worker `confirm-worker` whose booking was not MATCHED (HTTP 403 ACTION_NOT_ALLOWED).
 *
 * Fix: WORKER is now a permitted actor on `confirm-worker`, and a worker's `confirm-worker`
 * behaves as `accept` on a MATCHED booking (records workerRespondedAt) or as `confirm-worker`
 * on an INTERVIEW_TRIAL_COMPLETED booking (moves to PENDING_PAYMENT with the agreed start date).
 */
describe('Worker confirm-worker permission (regression)', () => {
  let api: ApiApp;
  let admin: Awaited<ReturnType<typeof loginAdmin>>;
  let area: { id: string; name: string; city: string };
  let customer: Awaited<ReturnType<typeof loginWithOtp>> & { userId: string };

  beforeAll(async () => {
    api = await createApiApp();
    admin = await loginAdmin(api);
    area = await createArea(api, admin);
    await setRequiredChecks(api, admin, ['IDENTITY']);
    customer = await loginWithOtp(api, { appType: 'CUSTOMER' });
  });

  afterAll(async () => {
    await setRequiredChecks(api, admin, []);
    await api.close();
  });

  it('worker confirm-worker on MATCHED booking accepts (sets workerRespondedAt, stays MATCHED)', async () => {
    const worker = await onboardWorker(api, { areaIds: [area.id] });
    await approveCheck(api, admin, worker, 'IDENTITY');
    const booking = await makeBooking(api, admin, customer, area.id, 'MATCHED', worker);

    const res = await as(api, worker).post(
      `/api/v1/workers/me/bookings/${booking.id}/confirm-worker`,
      {},
    );

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('MATCHED');
    expect(res.body.workerRespondedAt).not.toBeNull();
  });

  it('worker confirm-worker on INTERVIEW_TRIAL_COMPLETED booking moves to PENDING_PAYMENT', async () => {
    const worker = await onboardWorker(api, { areaIds: [area.id] });
    await approveCheck(api, admin, worker, 'IDENTITY');
    const booking = await makeBooking(
      api,
      admin,
      customer,
      area.id,
      'INTERVIEW_TRIAL_COMPLETED',
      worker,
    );

    const startDate = inDays(1);
    const res = await as(api, worker).post(
      `/api/v1/workers/me/bookings/${booking.id}/confirm-worker`,
      { startDate },
    );

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('PENDING_PAYMENT');
    expect(res.body.startDate).toBe(startDate);
    // The opportunity is no longer awaiting a worker response.
    const list = await as(api, worker).get('/api/v1/workers/me/opportunities');
    expect(list.body.data.some((b: { id: string }) => b.id === booking.id)).toBe(false);
  });

  it('worker confirm-worker on CANCELLED booking rejects with 403 ACTION_NOT_ALLOWED', async () => {
    const worker = await onboardWorker(api, { areaIds: [area.id] });
    await approveCheck(api, admin, worker, 'IDENTITY');
    const booking = await makeBooking(api, admin, customer, area.id, 'MATCHED', worker);

    // Move out of MATCHED.
    await as(api, customer).post(`/api/v1/bookings/${booking.id}/cancel`, {
      reason: 'no longer needed',
    });

    const res = await as(api, worker).post(
      `/api/v1/workers/me/bookings/${booking.id}/confirm-worker`,
      {},
    );

    expect(res.status).toBe(403);
    expect(res.body.code).toBe('ACTION_NOT_ALLOWED');
  });

  it("worker confirm-worker on another worker's assigned booking returns 404 (no cross-worker access)", async () => {
    const worker1 = await onboardWorker(api, { areaIds: [area.id] });
    const worker2 = await onboardWorker(api, { areaIds: [area.id] });
    await approveCheck(api, admin, worker1, 'IDENTITY');
    await approveCheck(api, admin, worker2, 'IDENTITY');
    const booking = await makeBooking(api, admin, customer, area.id, 'MATCHED', worker1);

    const res = await as(api, worker2).post(
      `/api/v1/workers/me/bookings/${booking.id}/confirm-worker`,
      {},
    );

    expect(res.status).toBe(404);
  });

  it('customer confirm-worker on INTERVIEW_TRIAL_COMPLETED booking still works (200, PENDING_PAYMENT)', async () => {
    const worker = await onboardWorker(api, { areaIds: [area.id] });
    await approveCheck(api, admin, worker, 'IDENTITY');
    const booking = await makeBooking(
      api,
      admin,
      customer,
      area.id,
      'INTERVIEW_TRIAL_COMPLETED',
      worker,
    );

    const res = await as(api, customer).post(`/api/v1/bookings/${booking.id}/confirm-worker`, {
      startDate: inDays(1),
    });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('PENDING_PAYMENT');
  });

  it('worker confirm-worker without startDate on INTERVIEW_TRIAL_COMPLETED rejects 400', async () => {
    const worker = await onboardWorker(api, { areaIds: [area.id] });
    await approveCheck(api, admin, worker, 'IDENTITY');
    const booking = await makeBooking(
      api,
      admin,
      customer,
      area.id,
      'INTERVIEW_TRIAL_COMPLETED',
      worker,
    );

    const res = await as(api, worker).post(
      `/api/v1/workers/me/bookings/${booking.id}/confirm-worker`,
      {},
    );

    expect(res.status).toBe(400);
  });

  it('duplicate worker confirm-worker is idempotent (200, no double assignment)', async () => {
    const worker = await onboardWorker(api, { areaIds: [area.id] });
    await approveCheck(api, admin, worker, 'IDENTITY');
    const booking = await makeBooking(api, admin, customer, area.id, 'MATCHED', worker);

    const first = await as(api, worker).post(
      `/api/v1/workers/me/bookings/${booking.id}/confirm-worker`,
      {},
    );
    expect(first.status).toBe(200);

    const second = await as(api, worker).post(
      `/api/v1/workers/me/bookings/${booking.id}/confirm-worker`,
      {},
    );
    expect(second.status).toBe(200);
    expect(second.body.workerRespondedAt).not.toBeNull();
  });
});
