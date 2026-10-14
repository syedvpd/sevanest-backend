import '../support/env-api-integration';
// Tokens must outlive the measurement run (the server under test is a separate process using the same secret and database).
process.env.JWT_ACCESS_TTL_SECONDS = '28800';

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ApiApp, createApiApp, loginAdmin, loginWithOtp, unique } from '../support/api-app';
import { inDays, makeBooking } from '../support/bookings';
import { as, createArea, setRequiredChecks } from '../support/workforce';

/**
 * Builds a realistic LOCAL dataset for the performance run and writes it, with the OpenAPI document and ready-to-use tokens,
 * to PERF_OUT (default test/perf/out). Not part of the normal suites (its name does not match the integration pattern); run with
 *   jest --config test/jest-integration.config.js --testRegex "perf/.*\.perf-spec\.ts$"
 * Only ever points at a disposable *_ci database (the shared guard in env-api-integration refuses anything else).
 */
describe('Performance dataset', () => {
  let api: ApiApp;

  beforeAll(async () => {
    api = await createApiApp();
  });
  afterAll(async () => {
    await api.close();
  });

  it('builds the dataset', async () => {
    const out = process.env.PERF_OUT ?? join(__dirname, 'out');
    mkdirSync(out, { recursive: true });
    const notes: string[] = [];
    const safe = async <T>(label: string, work: () => Promise<T>): Promise<T | undefined> => {
      try {
        return await work();
      } catch (error) {
        notes.push(`${label}: ${(error as Error).message.slice(0, 160)}`);
        return undefined;
      }
    };

    const admin = await loginAdmin(api);
    const area = await createArea(api, admin, {
      centerLatitude: 17.45,
      centerLongitude: 78.39,
      radiusMeters: 1500,
    });
    await setRequiredChecks(api, admin, ['IDENTITY']);
    await as(api, admin)
      .put('/api/v1/admin/fees/booking-fee', { amountMinor: 50000, isActive: true })
      .expect(200);
    const customer = await loginWithOtp(api, { appType: 'CUSTOMER' });
    const c = as(api, customer);
    const profile = (
      await c
        .post('/api/v1/customers/me', {
          name: 'Perf Customer',
          email: `perf.${unique()}@example.test`,
          preferredLanguage: 'en',
        })
        .expect(201)
    ).body as { id: string };
    const address = (
      await c
        .post('/api/v1/customers/me/addresses', {
          label: 'Home',
          line: '1 Main Rd',
          line2: 'Flat 4',
          area: area.name,
          city: area.city,
          state: 'Telangana',
          pincode: '500081',
          isDefault: true,
        })
        .expect(201)
    ).body as { id: string };
    const supportCategory = (
      await as(api, admin)
        .post('/api/v1/admin/support/categories', {
          code: `PERF_${unique().toUpperCase()}`,
          name: 'Performance',
        })
        .expect(201)
    ).body as { id: string };

    const active = await makeBooking(api, admin, customer, area.id, 'ACTIVE');
    const completed = await makeBooking(api, admin, customer, area.id, 'ACTIVE');
    await c.post(`/api/v1/bookings/${completed.id}/complete`).expect(200);
    const matched = await makeBooking(api, admin, customer, area.id, 'MATCHED');
    const pending = await makeBooking(api, admin, customer, area.id, 'PENDING_PAYMENT');
    const confirmed = await makeBooking(api, admin, customer, area.id, 'CONFIRMED');

    const rating = await safe(
      'rating',
      async () =>
        (
          await c
            .post('/api/v1/ratings', {
              bookingId: completed.id,
              score: 5,
              review: 'Very good service',
            })
            .expect(201)
        ).body as { id: string },
    );
    const payment = await safe(
      'payment',
      async () =>
        (
          (await c.get(`/api/v1/payments?bookingId=${confirmed.id}`).expect(200)).body
            .data as Array<{ id: string }>
        )[0],
    );
    const interview = await safe(
      'interview',
      async () =>
        (
          await c
            .post('/api/v1/interviews', {
              bookingId: matched.id,
              type: 'INTERVIEW',
              preferredAt: new Date(Date.now() + 3 * 86_400_000).toISOString(),
            })
            .expect(201)
        ).body as { id: string },
    );
    await safe('shortlist', async () =>
      c.put(`/api/v1/shortlist/${matched.worker.workerId}`).expect(204),
    );
    const ticket = await safe(
      'ticket',
      async () =>
        (
          await c
            .post('/api/v1/support/tickets', {
              categoryId: supportCategory.id,
              subject: 'Performance check',
              description: 'A ticket created for the performance dataset.',
              bookingId: active.id,
            })
            .expect(201)
        ).body as { id: string },
    );
    const workerTicket = await safe(
      'worker ticket',
      async () =>
        (
          await as(api, active.worker)
            .post('/api/v1/support/tickets', {
              categoryId: supportCategory.id,
              description: 'A worker ticket created for the performance dataset.',
            })
            .expect(201)
        ).body as { id: string },
    );
    const replacement = await safe(
      'replacement',
      async () =>
        (
          await c
            .post('/api/v1/replacement-requests', {
              bookingId: active.id,
              reasonCode: 'OTHER',
              reason: 'Performance dataset request',
            })
            .expect(201)
        ).body as { id: string },
    );
    await safe('check-in', async () =>
      as(api, active.worker)
        .post(`/api/v1/workers/me/attendance/bookings/${active.id}/check-in`)
        .expect(201),
    );
    const attendance = await safe(
      'attendance',
      async () =>
        (
          (await c.get(`/api/v1/attendance/bookings/${active.id}`).expect(200)).body.data as Array<{
            id: string;
          }>
        )[0],
    );
    const notification = await safe(
      'notification',
      async () =>
        ((await c.get('/api/v1/notifications').expect(200)).body.data as Array<{ id: string }>)[0],
    );
    const workerNotification = await safe(
      'worker notification',
      async () =>
        (
          (await as(api, active.worker).get('/api/v1/notifications').expect(200)).body
            .data as Array<{ id: string }>
        )[0],
    );
    const slotsDay = inDays(2);

    const spec = (await api.http().get('/docs/openapi.json').expect(200)).body as object;
    writeFileSync(join(out, 'openapi.json'), JSON.stringify(spec));
    const dataset = {
      builtAt: new Date().toISOString(),
      tokens: {
        admin: admin.accessToken,
        customer: customer.accessToken,
        worker: active.worker.accessToken,
        workerOpportunity: matched.worker.accessToken,
      },
      params: {
        bookingId: active.id,
        completedBookingId: completed.id,
        matchedBookingId: matched.id,
        pendingBookingId: pending.id,
        confirmedBookingId: confirmed.id,
        workerId: active.worker.workerId,
        workerUserId: active.worker.userId,
        customerId: profile.id,
        customerUserId: customer.userId,
        userId: customer.userId,
        areaId: area.id,
        addressId: address.id,
        categoryCode: 'HOUSE_MAID',
        paymentId: payment?.id,
        ratingId: rating?.id,
        interviewId: interview?.id,
        ticketId: ticket?.id,
        workerTicketId: workerTicket?.id,
        requestId: replacement?.id,
        replacementRequestId: replacement?.id,
        attendanceId: attendance?.id,
        notificationId: notification?.id,
        workerNotificationId: workerNotification?.id,
        supportCategoryId: supportCategory.id,
        date: slotsDay,
      },
      notes,
    };
    writeFileSync(join(out, 'dataset.json'), JSON.stringify(dataset, null, 2));
    expect(Object.keys(dataset.params).length).toBeGreaterThan(10);
  }, 180000);
});
