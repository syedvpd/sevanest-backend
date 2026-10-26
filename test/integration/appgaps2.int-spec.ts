import '../support/env-api-integration';
import { ApiApp, createApiApp, loginAdmin, loginWithOtp, unique } from '../support/api-app';
import { ensureFee, inDays, makeBooking } from '../support/bookings';
import {
  approveCheck,
  as,
  createArea,
  onboardWorker,
  setRequiredChecks,
} from '../support/workforce';

const SEARCH = '/api/v1/search/workers';
const UNKNOWN = '00000000-0000-7000-8000-000000000000';

type Session = Awaited<ReturnType<typeof loginWithOtp>>;

/** Customer-app requests, second round: price guidance, area resolution, worker slots, customer interview list, Home aggregate. */
describe('Customer app gaps, round two (integration)', () => {
  let api: ApiApp;
  let admin: Awaited<ReturnType<typeof loginAdmin>>;
  let customer: Session;
  let area: { id: string; name: string; city: string };

  const newCustomer = async (): Promise<Session> => {
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

  beforeAll(async () => {
    api = await createApiApp();
    admin = await loginAdmin(api);
    area = await createArea(api, admin);
    customer = await newCustomer();
    await setRequiredChecks(api, admin, ['IDENTITY']);
    await ensureFee(api, admin);
  });
  afterAll(async () => {
    await setRequiredChecks(api, admin, []);
    await api.close();
  });

  describe('GET /pricing/guidance', () => {
    beforeAll(async () => {
      await api.prisma.pricingGuidance.deleteMany();
    });
    const q = (extra = '') => `/api/v1/pricing/guidance?category=COOK&engagement=PART_TIME${extra}`;
    const band = (extra: object = {}) => ({
      category: 'COOK',
      engagement: 'PART_TIME',
      minMinor: 600000,
      maxMinor: 1000000,
      period: 'MONTH',
      basis: 'Typical for Hyderabad, set by SevaNest',
      ...extra,
    });

    it('answers 404 PRICING_GUIDANCE_NOT_FOUND until an administrator sets a band', async () => {
      const res = await as(api, customer).get(q());
      expect(res.status).toBe(404);
      expect(res.body).toMatchObject({ code: 'PRICING_GUIDANCE_NOT_FOUND' });
    });

    it('serves the category-wide band, and an area band wins over it', async () => {
      const set = await as(api, admin).put('/api/v1/admin/pricing-guidance', band());
      expect(set.status).toBe(200);
      const wide = await as(api, customer).get(q(`&areaId=${area.id}`));
      expect(wide.status).toBe(200);
      expect(wide.body).toEqual({
        minMinor: 600000,
        maxMinor: 1000000,
        period: 'MONTH',
        basis: 'Typical for Hyderabad, set by SevaNest',
      });
      await as(api, admin)
        .put(
          '/api/v1/admin/pricing-guidance',
          band({ areaId: area.id, minMinor: 700000, maxMinor: 1200000 }),
        )
        .expect(200);
      expect((await as(api, customer).get(q(`&areaId=${area.id}`))).body).toMatchObject({
        minMinor: 700000,
        maxMinor: 1200000,
      });
      expect((await as(api, customer).get(q())).body).toMatchObject({ minMinor: 600000 });
    });

    it('replaces the band instead of duplicating it, and lists it for the administrator', async () => {
      await as(api, admin)
        .put('/api/v1/admin/pricing-guidance', band({ minMinor: 650000 }))
        .expect(200);
      const rows = await api.prisma.pricingGuidance.count({
        where: { engagement: 'PART_TIME', areaId: null, category: { code: 'COOK' } },
      });
      expect(rows).toBe(1);
      const list = await as(api, admin).get('/api/v1/admin/pricing-guidance');
      expect(list.status).toBe(200);
      expect((list.body as { meta: { total: number } }).meta.total).toBeGreaterThanOrEqual(2);
    });

    it('rejects a band whose maximum is below the minimum, an unknown category and an unknown area', async () => {
      expect(
        (
          await as(api, admin).put(
            '/api/v1/admin/pricing-guidance',
            band({ maxMinor: 1000, minMinor: 5000 }),
          )
        ).status,
      ).toBe(400);
      expect(
        (
          await as(api, admin).put(
            '/api/v1/admin/pricing-guidance',
            band({ category: 'NOPE_CATEGORY' }),
          )
        ).status,
      ).toBe(422);
      expect(
        (await as(api, admin).put('/api/v1/admin/pricing-guidance', band({ areaId: UNKNOWN })))
          .status,
      ).toBe(404);
    });

    it('is closed to the wrong audience and to anonymous callers', async () => {
      expect((await as(api, customer).put('/api/v1/admin/pricing-guidance', band())).status).toBe(
        403,
      );
      expect((await api.http().get(q())).status).toBe(401);
      expect((await api.http().put('/api/v1/admin/pricing-guidance').send(band())).status).toBe(
        401,
      );
    });

    it('removes a band; a second removal is 404', async () => {
      const id = (
        (await as(api, admin).put('/api/v1/admin/pricing-guidance', band({ engagement: 'HOURLY' })))
          .body as {
          id: string;
        }
      ).id;
      await as(api, admin).delete(`/api/v1/admin/pricing-guidance/${id}`).expect(204);
      expect((await as(api, admin).delete(`/api/v1/admin/pricing-guidance/${id}`)).status).toBe(
        404,
      );
    });
  });

  describe('GET /locations/service-area', () => {
    let geo: { id: string; name: string; city: string };
    beforeAll(async () => {
      await api.prisma.serviceArea.updateMany({
        where: { centerLatitude: { not: null } },
        data: { isEnabled: false },
      });
      geo = await createArea(api, admin, {
        centerLatitude: 17.45,
        centerLongitude: 78.39,
        radiusMeters: 1500,
      });
    });
    const resolve = (query: string) =>
      as(api, customer).get(`/api/v1/locations/service-area?${query}`);

    it('resolves a position inside the circle to the area', async () => {
      const res = await resolve('latitude=17.451&longitude=78.391');
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ id: geo.id, name: geo.name, city: geo.city });
    });

    it('answers 404 AREA_NOT_FOUND for a position outside every circle', async () => {
      const res = await resolve('latitude=17.60&longitude=78.60');
      expect(res.status).toBe(404);
      expect(res.body).toMatchObject({ code: 'AREA_NOT_FOUND' });
    });

    it('falls back to a case-insensitive name match, optionally within a city', async () => {
      expect(
        (await resolve(`name=${encodeURIComponent(area.name.toUpperCase())}`)).body,
      ).toMatchObject({
        id: area.id,
      });
      expect(
        (
          await resolve(
            `name=${encodeURIComponent(area.name)}&city=${encodeURIComponent('Nowhere')}`,
          )
        ).status,
      ).toBe(404);
      // position outside, name inside: the name still resolves
      expect(
        (await resolve(`latitude=17.9&longitude=78.9&name=${encodeURIComponent(geo.name)}`)).body,
      ).toMatchObject({ id: geo.id });
    });

    it('needs both coordinates or a name, and validates ranges', async () => {
      expect((await resolve('latitude=17.4')).status).toBe(400);
      expect((await resolve('')).status).toBe(400);
      expect((await resolve('latitude=99&longitude=78')).status).toBe(400);
    });

    it('does not resolve to a disabled area, and requires sign-in', async () => {
      await as(api, admin)
        .patch(`/api/v1/admin/service-areas/${geo.id}`, { isEnabled: false })
        .expect(200);
      expect((await resolve('latitude=17.451&longitude=78.391')).status).toBe(404);
      expect((await api.http().get('/api/v1/locations/service-area?name=x1')).status).toBe(401);
    });

    it('lets an administrator set and clear the centre, and refuses a partial one', async () => {
      const a = await createArea(api, admin);
      expect(
        (
          await as(api, admin).patch(`/api/v1/admin/service-areas/${a.id}`, {
            centerLatitude: 17.4,
          })
        ).status,
      ).toBe(400);
      const set = await as(api, admin).patch(`/api/v1/admin/service-areas/${a.id}`, {
        centerLatitude: 17.4,
        centerLongitude: 78.4,
        radiusMeters: 800,
      });
      expect(set.body).toMatchObject({
        centerLatitude: 17.4,
        centerLongitude: 78.4,
        radiusMeters: 800,
      });
      const cleared = await as(api, admin).patch(`/api/v1/admin/service-areas/${a.id}`, {
        centerLatitude: null,
        centerLongitude: null,
        radiusMeters: null,
      });
      expect(cleared.body).toMatchObject({ centerLatitude: null, radiusMeters: null });
      expect(
        (
          await as(api, admin).post('/api/v1/admin/service-areas', {
            name: `Z ${unique()}`,
            city: 'C1',
            radiusMeters: 500,
          })
        ).status,
      ).toBe(400);
    });
  });

  describe('GET /search/workers/:workerId/slots', () => {
    const tomorrow = inDays(1);
    const slots = (id: string, date = tomorrow, who: Session = customer) =>
      as(api, who).get(`${SEARCH}/${id}/slots?date=${date}`);

    it('lists one-hour starts inside the availability windows, and the horizon', async () => {
      const w = await onboardWorker(api, { areaIds: [area.id] });
      await approveCheck(api, admin, w, 'IDENTITY');
      const res = await slots(w.workerId);
      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        date: tomorrow,
        slotMinutes: 60,
        horizonDays: 14,
        slots: ['08:00', '09:00', '10:00', '11:00', '12:00', '13:00'],
      });
    });

    it('checks every candidate hour in a fixed number of statements, not one per slot', async () => {
      // Regression: availability checks used to fan out one query per slot at once, which saturates the connection pool
      // (default 10) for a worker with a long day and surfaced as an intermittent 500 on a small host.
      const w = await onboardWorker(api, { areaIds: [area.id] });
      await approveCheck(api, admin, w, 'IDENTITY');
      const spy = jest.spyOn(api.prisma, '$queryRaw');
      try {
        const res = await slots(w.workerId);
        expect(res.status).toBe(200);
        expect((res.body as { slots: string[] }).slots).toHaveLength(6);
        const busyChecks = spy.mock.calls.filter((c) =>
          String((c[0] as { sql?: string }).sql).includes('AS busy'),
        );
        expect(busyChecks).toHaveLength(1);
      } finally {
        spy.mockRestore();
      }
    });

    it('takes out the hours a held booking occupies', async () => {
      const c = await newCustomer();
      const b = await makeBooking(api, admin, c, area.id, 'PENDING_PAYMENT');
      const res = await slots(b.worker.workerId, tomorrow, c);
      expect((res.body as { slots: string[] }).slots).toEqual(['08:00', '12:00', '13:00']);
    });

    it('takes out a confirmed interview', async () => {
      const c = await newCustomer();
      const w = await onboardWorker(api, { areaIds: [area.id] });
      await approveCheck(api, admin, w, 'IDENTITY');
      const booking = await as(api, c)
        .post('/api/v1/bookings', {
          category: 'HOUSE_MAID',
          areaId: area.id,
          engagement: 'PART_TIME',
          availableFrom: '09:00',
          availableTo: '10:00',
          startDate: inDays(5),
          workerId: w.workerId,
        })
        .expect(201);
      const at = new Date(`${tomorrow}T10:00:00.000+05:30`).toISOString();
      const iv = await as(api, c)
        .post('/api/v1/interviews', {
          bookingId: (booking.body as { id: string }).id,
          type: 'INTERVIEW',
          preferredAt: at,
        })
        .expect(201);
      await as(api, w)
        .post(`/api/v1/workers/me/interviews/${(iv.body as { id: string }).id}/accept`)
        .expect(200);
      const res = await slots(w.workerId, tomorrow, c);
      expect((res.body as { slots: string[] }).slots).not.toContain('10:00');
      expect((res.body as { slots: string[] }).slots).toContain('09:00');
    });

    it('rejects a past date, a date beyond the horizon and a malformed date', async () => {
      const w = await onboardWorker(api, { areaIds: [area.id] });
      await approveCheck(api, admin, w, 'IDENTITY');
      expect((await slots(w.workerId, inDays(-1))).status).toBe(400);
      expect((await slots(w.workerId, inDays(40))).status).toBe(400);
      expect((await slots(w.workerId, '2026-13-45')).status).toBe(400);
    });

    it('answers 404 for an unknown or not visible worker, and 401/403 for the wrong caller', async () => {
      const hidden = await onboardWorker(api, { areaIds: [area.id] }); // not verified
      expect((await slots(UNKNOWN)).status).toBe(404);
      expect((await slots(hidden.workerId)).status).toBe(404);
      expect(
        (await api.http().get(`${SEARCH}/${hidden.workerId}/slots?date=${tomorrow}`)).status,
      ).toBe(401);
      expect((await slots(hidden.workerId, tomorrow, hidden as unknown as Session)).status).toBe(
        403,
      );
    });
  });

  describe('GET /interviews and GET /customers/me/home', () => {
    it('lists only my interviews across bookings, newest first, with filters', async () => {
      const c = await newCustomer();
      const other = await newCustomer();
      const b1 = await makeBooking(api, admin, c, area.id, 'MATCHED');
      const b2 = await makeBooking(api, admin, other, area.id, 'MATCHED');
      const at = new Date(Date.now() + 3 * 86_400_000).toISOString();
      const mine = await as(api, c)
        .post('/api/v1/interviews', { bookingId: b1.id, type: 'TRIAL', preferredAt: at })
        .expect(201);
      await as(api, other)
        .post('/api/v1/interviews', { bookingId: b2.id, type: 'INTERVIEW', preferredAt: at })
        .expect(201);
      const list = await as(api, c).get('/api/v1/interviews');
      expect(list.status).toBe(200);
      const body = list.body as { data: Array<{ id: string }>; meta: object };
      expect(body.meta).toEqual({ page: 1, limit: 20, total: 1 });
      expect(body.data[0].id).toBe((mine.body as { id: string }).id);
      expect(body.data[0]).toMatchObject({
        status: 'REQUESTED',
        allowedActions: ['reschedule', 'cancel'],
        timeline: [
          { title: 'Requested', state: 'done' },
          { title: 'Waiting for the worker', state: 'current', at: null },
        ],
      });
      expect((await as(api, c).get('/api/v1/interviews?type=INTERVIEW')).body).toMatchObject({
        meta: { total: 0 },
      });
      expect((await as(api, c).get('/api/v1/interviews?status=BOGUS')).status).toBe(400);
      expect((await api.http().get('/api/v1/interviews')).status).toBe(401);
      expect((await as(api, b1.worker).get('/api/v1/interviews')).status).toBe(403);
    });

    it('gives a new customer an empty Home', async () => {
      const c = await newCustomer();
      const res = await as(api, c).get('/api/v1/customers/me/home');
      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        activeBooking: null,
        activeBookingsTotal: 0,
        upcomingInterview: null,
        unreadNotifications: 0,
        shortlistPreview: [],
        shortlistTotal: 0,
      });
    });

    it('gathers the active booking, the upcoming interview, unread count and shortlist in one call', async () => {
      const c = await newCustomer();
      const b = await makeBooking(api, admin, c, area.id, 'MATCHED');
      const at = new Date(Date.now() + 2 * 86_400_000).toISOString();
      const iv = await as(api, c)
        .post('/api/v1/interviews', { bookingId: b.id, type: 'INTERVIEW', preferredAt: at })
        .expect(201);
      await as(api, b.worker)
        .post(`/api/v1/workers/me/interviews/${(iv.body as { id: string }).id}/accept`)
        .expect(200);
      await as(api, c).put(`/api/v1/shortlist/${b.worker.workerId}`).expect(204);
      const res = await as(api, c).get('/api/v1/customers/me/home');
      expect(res.status).toBe(200);
      const home = res.body as {
        activeBooking: { id: string } | null;
        upcomingInterview: { id: string; status: string } | null;
        unreadNotifications: number;
        shortlistPreview: Array<{ workerId: string }>;
        shortlistTotal: number;
      };
      expect(home.activeBooking?.id).toBe(b.id);
      expect(home.upcomingInterview).toMatchObject({
        id: (iv.body as { id: string }).id,
        status: 'CONFIRMED',
      });
      expect(typeof home.unreadNotifications).toBe('number');
      expect(home.shortlistPreview.map((s) => s.workerId)).toEqual([b.worker.workerId]);
      expect(home.shortlistTotal).toBe(1);
    });

    it('does not show another customer the data, is customer-only and needs sign-in', async () => {
      const c = await newCustomer();
      await makeBooking(api, admin, c, area.id, 'MATCHED');
      const stranger = await newCustomer();
      expect((await as(api, stranger).get('/api/v1/customers/me/home')).body).toMatchObject({
        activeBooking: null,
      });
      const w = await onboardWorker(api, { areaIds: [area.id] });
      expect((await as(api, w).get('/api/v1/customers/me/home')).status).toBe(403);
      expect((await api.http().get('/api/v1/customers/me/home')).status).toBe(401);
    });
  });
});
