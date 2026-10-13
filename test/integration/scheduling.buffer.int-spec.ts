import '../support/env-api-integration';
// Configured for this suite only: a 30 minute travel buffer and the unpaid-booking rules.
process.env.BOOKING_TRAVEL_BUFFER_MINUTES = '30';
process.env.PENDING_PAYMENT_ALERT_HOURS = '1';
process.env.PENDING_PAYMENT_AUTO_CANCEL_HOURS = '3';

import { BookingSweepService } from '../../src/modules/booking/booking-sweep.service';
import { ApiApp, createApiApp, loginAdmin, loginWithOtp, unique } from '../support/api-app';
import { ensureFee, fakeGateway, inDays } from '../support/bookings';
import {
  approveCheck,
  as,
  createArea,
  OnboardedWorker,
  onboardWorker,
  setRequiredChecks,
} from '../support/workforce';

const B = '/api/v1/bookings';
type Session = Awaited<ReturnType<typeof loginWithOtp>>;

/** Availability edge cases: travel buffer boundaries, search/booking consistency, releasing holds, payment and cancellation races. */
describe('Worker availability edge cases (integration)', () => {
  let api: ApiApp;
  let admin: Awaited<ReturnType<typeof loginAdmin>>;
  let area: { id: string; name: string; city: string };

  const customer = async (): Promise<Session> => {
    const session = await loginWithOtp(api, { appType: 'CUSTOMER' });
    await as(api, session)
      .post('/api/v1/customers/me', {
        name: 'Asha Rao',
        email: `c.${unique()}@example.test`,
        preferredLanguage: 'en',
      })
      .expect(201);
    return session;
  };
  const worker = async (): Promise<OnboardedWorker> => {
    const w = await onboardWorker(api, {
      areaIds: [area.id],
      engagement: 'HOURLY',
      windows: [{ start: '06:00', end: '22:00' }],
    });
    await approveCheck(api, admin, w, 'IDENTITY');
    return w;
  };
  const request = (from: string, to: string, extra: object = {}) => ({
    category: 'HOUSE_MAID',
    areaId: area.id,
    engagement: 'HOURLY',
    availableFrom: from,
    availableTo: to,
    startDate: inDays(2),
    ...extra,
  });
  const ask = (who: Session, w: OnboardedWorker, from: string, to: string, extra: object = {}) =>
    as(api, who).post(B, { ...request(from, to, extra), workerId: w.workerId });
  const confirm = async (who: Session, id: string, startDate = inDays(2)) => {
    const c = as(api, who);
    await c
      .post(`${B}/${id}/schedule`, {
        scheduleType: 'INTERVIEW',
        scheduledAt: new Date(Date.now() + 86_400_000).toISOString(),
      })
      .expect(200);
    await c.post(`${B}/${id}/interview-complete`, { outcomeNote: 'ok' }).expect(200);
    return c.post(`${B}/${id}/confirm-worker`, { startDate });
  };
  const hold = async (who: Session, w: OnboardedWorker, from = '09:00', to = '10:00') => {
    const created = await ask(who, w, from, to).expect(201);
    const id = created.body.id as string;
    expect((await confirm(who, id)).status).toBe(200);
    return id;
  };
  const search = async (who: Session, from: string, to: string): Promise<string[]> =>
    (
      (
        await as(api, who).get(
          `/api/v1/search/workers?category=HOUSE_MAID&areaId=${area.id}&engagement=HOURLY&availableFrom=${from}&availableTo=${to}&startDate=${inDays(2)}&limit=100`,
        )
      ).body.data as Array<{ workerId: string }>
    ).map((x) => x.workerId);

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

  it('applies the configured travel buffer at every boundary, and search agrees with booking', async () => {
    const w = await worker();
    const viewer = await customer();
    await hold(await customer(), w); // 09:00-10:00 held; with a 30 minute buffer the worker is busy 08:30-10:30

    const cases: Array<[string, string, boolean]> = [
      ['10:00', '11:00', false], // inside the buffer after the job
      ['10:29', '11:29', false],
      ['10:30', '11:30', true], // exactly the buffer after the end: free
      ['07:30', '08:30', true], // ends exactly when the buffer before the job starts
      ['07:30', '08:31', false],
      ['08:30', '09:00', false],
      ['09:15', '09:45', false], // inside the held hour
      ['06:00', '07:00', true], // far away the same day
    ];
    for (const [from, to, free] of cases) {
      const res = await ask(await customer(), w, from, to);
      expect([from, to, res.status === 201]).toEqual([from, to, free]);
      if (!free) expect(res.body.code).toBe('WORKER_UNAVAILABLE');
      expect([from, to, (await search(viewer, from, to)).includes(w.workerId)]).toEqual([
        from,
        to,
        free,
      ]);
    }
  });

  it('is released when the booking is cancelled, and a payment racing a cancellation leaves one consistent outcome', async () => {
    const w = await worker();
    const a = await customer();
    const id = await hold(a, w);
    const b = await customer();
    expect((await ask(b, w, '09:00', '10:00')).status).toBe(409);

    // pay and cancel at the same moment
    const payment = await as(api, a).post('/api/v1/payments', { bookingId: id }).expect(201);
    const done = fakeGateway(api).completeCheckout(
      payment.body.checkout.orderId as string,
      'SUCCEEDED',
    );
    const [paid, cancelled] = await Promise.all([
      as(api, a).post(`/api/v1/payments/${payment.body.id}/verify`, done),
      as(api, a).post(`${B}/${id}/cancel`, { reason: 'changed my mind' }),
    ]);
    expect([200, 409]).toContain(paid.status);
    expect([200, 409]).toContain(cancelled.status);
    const status = (await as(api, a).get(`${B}/${id}`)).body.status as string;
    expect(['CONFIRMED', 'CANCELLED']).toContain(status);
    const free = (await ask(await customer(), w, '09:00', '10:00')).status === 201;
    expect(free).toBe(status === 'CANCELLED'); // held exactly while the booking is alive
  });

  it('an unpaid confirmed booking holds the worker until it is auto-cancelled, then the worker is free again', async () => {
    const w = await worker();
    const a = await customer();
    const id = await hold(a, w);
    expect((await ask(await customer(), w, '09:00', '10:00')).status).toBe(409);
    await api.prisma
      .$executeRaw`UPDATE bookings SET updated_at = now() - make_interval(hours => 4) WHERE id = ${id}::uuid`;
    await api.app.get(BookingSweepService).runOnce();
    expect((await as(api, a).get(`${B}/${id}`)).body.status).toBe('CANCELLED');
    expect((await ask(await customer(), w, '09:00', '10:00')).status).toBe(201);
  });

  it('a failed payment does not release the hold: the booking stays unpaid and keeps the worker until cancelled or expired', async () => {
    const w = await worker();
    const a = await customer();
    const id = await hold(a, w);
    const payment = await as(api, a).post('/api/v1/payments', { bookingId: id }).expect(201);
    fakeGateway(api).completeCheckout(payment.body.checkout.orderId as string, 'FAILED');
    expect((await as(api, a).get(`${B}/${id}`)).body.status).toBe('PENDING_PAYMENT');
    expect((await ask(await customer(), w, '09:00', '10:00')).status).toBe(409);
  });

  it('concurrent confirmations of the same worker allocate exactly once, also across the buffer', async () => {
    const w = await worker();
    const people = await Promise.all([customer(), customer(), customer()]);
    const slots: Array<[string, string]> = [
      ['09:00', '10:00'],
      ['10:00', '11:00'], // within the buffer of the first
      ['09:30', '10:30'],
    ];
    const ids: string[] = [];
    for (let i = 0; i < people.length; i++) {
      const created = await ask(people[i], w, slots[i][0], slots[i][1]).expect(201);
      const id = created.body.id as string;
      const c = as(api, people[i]);
      await c
        .post(`${B}/${id}/schedule`, {
          scheduleType: 'INTERVIEW',
          scheduledAt: new Date(Date.now() + 86_400_000).toISOString(),
        })
        .expect(200);
      await c.post(`${B}/${id}/interview-complete`, { outcomeNote: 'ok' }).expect(200);
      ids.push(id);
    }
    const results = await Promise.all(
      people.map((p, i) =>
        as(api, p).post(`${B}/${ids[i]}/confirm-worker`, { startDate: inDays(2) }),
      ),
    );
    expect(results.filter((r) => r.status === 200)).toHaveLength(1);
    for (const r of results.filter((x) => x.status !== 200)) {
      expect(r.status).toBe(409);
      expect(r.body.code).toBe('WORKER_UNAVAILABLE');
    }
  });
});
