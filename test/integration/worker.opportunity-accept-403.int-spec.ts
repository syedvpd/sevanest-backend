import '../support/env-api-integration';
import { ApiApp, createApiApp, loginAdmin, loginWithOtp } from '../support/api-app';
import { makeBooking } from '../support/bookings';
import {
  as,
  createArea,
  onboardWorker,
  approveCheck,
  setRequiredChecks,
} from '../support/workforce';

describe('Worker Opportunity Acceptance Fix (Integration)', () => {
  let api: ApiApp;
  let admin: Awaited<ReturnType<typeof loginAdmin>>;
  let area: { id: string; name: string };
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

  it('Worker calling confirm-worker on MATCHED booking succeeds with 200', async () => {
    const worker = await onboardWorker(api, { areaIds: [area.id] });
    await approveCheck(api, admin, worker, 'IDENTITY');
    const booking = await makeBooking(api, admin, customer, area.id, 'MATCHED', worker);

    const res = await as(api, worker).post(
      `/api/v1/workers/me/bookings/${booking.id}/confirm-worker`,
      {},
    );

    expect(res.status).toBe(200);
    expect(res.body.workerRespondedAt).not.toBeNull();
  });

  it('Worker calling accept on MATCHED booking with REQUESTED interview confirms interview and moves booking to INTERVIEW_TRIAL_SCHEDULED', async () => {
    const worker = await onboardWorker(api, { areaIds: [area.id] });
    await approveCheck(api, admin, worker, 'IDENTITY');
    const booking = await makeBooking(api, admin, customer, area.id, 'MATCHED', worker);

    const interviewRes = await as(api, customer).post('/api/v1/interviews', {
      bookingId: booking.id,
      type: 'INTERVIEW',
      preferredAt: new Date(Date.now() + 2 * 86400000).toISOString(),
    });
    expect(interviewRes.status).toBe(201);

    const acceptRes = await as(api, worker).post(
      `/api/v1/workers/me/bookings/${booking.id}/accept`,
      {},
    );

    expect(acceptRes.status).toBe(200);
    expect(acceptRes.body.status).toBe('INTERVIEW_TRIAL_SCHEDULED');

    const updatedBooking = (await as(api, customer).get(`/api/v1/bookings/${booking.id}`)).body;
    expect(updatedBooking.status).toBe('INTERVIEW_TRIAL_SCHEDULED');
  });

  it('Worker calling accept on direct MATCHED booking without interview sets workerRespondedAt and succeeds with 200', async () => {
    const worker = await onboardWorker(api, { areaIds: [area.id] });
    await approveCheck(api, admin, worker, 'IDENTITY');
    const booking = await makeBooking(api, admin, customer, area.id, 'MATCHED', worker);

    const res = await as(api, worker).post(`/api/v1/workers/me/bookings/${booking.id}/accept`, {});

    expect(res.status).toBe(200);
    expect(res.body.workerRespondedAt).not.toBeNull();
  });

  it('Worker calling confirm-worker on non-MATCHED booking rejects with 403', async () => {
    const worker = await onboardWorker(api, { areaIds: [area.id] });
    await approveCheck(api, admin, worker, 'IDENTITY');
    const booking = await makeBooking(api, admin, customer, area.id, 'MATCHED', worker);

    // Cancel the booking first to move out of MATCHED
    await as(api, customer).post(`/api/v1/bookings/${booking.id}/cancel`, {
      reason: 'not needed',
    });

    const res = await as(api, worker).post(
      `/api/v1/workers/me/bookings/${booking.id}/confirm-worker`,
      {},
    );

    expect(res.status).toBe(403);
    expect(res.body.code).toBe('ACTION_NOT_ALLOWED');
  });
});
