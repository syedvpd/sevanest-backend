import '../support/env-api-integration';
import { ApiApp, createApiApp, loginAdmin, loginWithOtp } from '../support/api-app';
import { makeBooking } from '../support/bookings';
import { as, createArea, onboardWorker, setRequiredChecks } from '../support/workforce';

const UNKNOWN_ID = '00000000-0000-7000-8000-000000000000';
const SEARCH = '/api/v1/search/workers';

/** Customer-app feedback: worker reviews for customers, rating scale, address label/line2/state. */
describe('Customer app gaps (integration)', () => {
  let api: ApiApp;
  let admin: Awaited<ReturnType<typeof loginAdmin>>;
  let customer: Awaited<ReturnType<typeof loginWithOtp>>;
  let area: { id: string };

  beforeAll(async () => {
    api = await createApiApp();
    admin = await loginAdmin(api);
    area = await createArea(api, admin);
    customer = await loginWithOtp(api, { appType: 'CUSTOMER' });
    await as(api, customer)
      .post('/api/v1/customers/me', {
        name: 'Anita Rao Sharma',
        email: `anita.${Date.now()}@example.test`,
        preferredLanguage: 'en',
      })
      .expect(201);
    await setRequiredChecks(api, admin, ['IDENTITY']);
  });
  afterAll(async () => {
    await setRequiredChecks(api, admin, []);
    await api.close();
  });

  describe('GET /search/workers/:workerId/ratings', () => {
    let workerId: string;
    let ratingId: string;
    let worker: Awaited<ReturnType<typeof onboardWorker>>;

    beforeAll(async () => {
      const b = await makeBooking(api, admin, customer, area.id, 'ACTIVE');
      worker = b.worker;
      workerId = b.worker.workerId;
      await as(api, customer).post(`/api/v1/bookings/${b.id}/complete`).expect(200);
      const rated = await as(api, customer).post('/api/v1/ratings', {
        bookingId: b.id,
        score: 4,
        review: 'Punctual and polite',
      });
      ratingId = (rated.body as { id: string }).id;
      expect(rated.status).toBe(201);
    });

    const list = (id: string, query = '') =>
      as(api, customer).get(`${SEARCH}/${id}/ratings${query}`);

    it('lists score, comment, date and the reviewer first name only, in the standard envelope', async () => {
      const res = await list(workerId);
      expect(res.status).toBe(200);
      const body = res.body as { data: Array<Record<string, unknown>>; meta: object };
      expect(body.meta).toEqual({ page: 1, limit: 20, total: 1 });
      expect(Object.keys(body.data[0]).sort()).toEqual(
        ['comment', 'createdAt', 'reviewerFirstName', 'score', 'tags'].sort(),
      );
      expect(body.data[0]).toMatchObject({
        score: 4,
        comment: 'Punctual and polite',
        reviewerFirstName: 'Anita',
      });
      expect(JSON.stringify(res.body)).not.toMatch(
        /Rao|Sharma|@example|bookingId|customerUserId|\+91/,
      );
    });

    it('agrees with the aggregate on the profile and card', async () => {
      const profile = await as(api, customer).get(`${SEARCH}/${workerId}`);
      expect((profile.body as { rating: unknown }).rating).toEqual({ average: 4, count: 1 });
    });

    it('does not list a review hidden by moderation, and lists it again once restored', async () => {
      await as(api, admin)
        .post(`/api/v1/admin/ratings/${ratingId}/hide`, { reason: 'Test moderation' })
        .expect(200);
      const hidden = await list(workerId);
      expect((hidden.body as { meta: { total: number }; data: unknown[] }).meta.total).toBe(0);
      expect((hidden.body as { data: unknown[] }).data).toEqual([]);
      await as(api, admin)
        .post(`/api/v1/admin/ratings/${ratingId}/unhide`, { reason: 'Restored' })
        .expect(200);
      expect((await list(workerId)).body).toMatchObject({ meta: { total: 1 } });
    });

    it('pages: page 2 is empty but total stays 1; bad paging is a 400', async () => {
      const page2 = await list(workerId, '?page=2&limit=1');
      expect(page2.status).toBe(200);
      expect(page2.body).toMatchObject({ data: [], meta: { page: 2, limit: 1, total: 1 } });
      expect((await list(workerId, '?limit=0')).status).toBe(400);
      expect((await list(workerId, '?limit=101')).status).toBe(400);
      expect((await list(workerId, '?page=0')).status).toBe(400);
    });

    it('answers 404 identically for unknown and not-visible workers, 400 for a bad id', async () => {
      const hiddenWorker = await onboardWorker(api, { areaIds: [area.id] }); // submitted but not verified
      const a = await list(UNKNOWN_ID);
      const b = await list(hiddenWorker.workerId);
      expect(a.status).toBe(404);
      expect(b.status).toBe(404);
      const { requestId: _a, ...bodyA } = a.body as Record<string, unknown>;
      const { requestId: _b, ...bodyB } = b.body as Record<string, unknown>;
      expect(bodyA).toEqual(bodyB);
      expect((a.body as { code: string }).code).toBe('WORKER_NOT_FOUND');
      expect((await list('nope')).status).toBe(400);
    });

    it('is customer-only', async () => {
      expect((await api.http().get(`${SEARCH}/${workerId}/ratings`)).status).toBe(401);
      expect((await as(api, worker).get(`${SEARCH}/${workerId}/ratings`)).status).toBe(403);
      expect((await as(api, admin).get(`${SEARCH}/${workerId}/ratings`)).status).toBe(403);
    });
  });

  describe('GET /reference-data', () => {
    it('exposes the rating scale the average is measured on', async () => {
      const res = await api.http().get('/api/v1/reference-data');
      expect(res.status).toBe(200);
      expect((res.body as { ratingScaleMax: number }).ratingScaleMax).toBe(5);
    });
  });

  describe('address label, line2 and state', () => {
    const addr = (body: object) => as(api, customer).post('/api/v1/customers/me/addresses', body);
    const base = { line: '1 Main Rd', area: 'Madhapur', city: 'Hyderabad', pincode: '500081' };

    it('stores and returns them, and lets them be changed or cleared', async () => {
      const created = await addr({
        ...base,
        label: ' Home ',
        line2: 'Near the temple',
        state: 'Telangana',
      });
      expect(created.status).toBe(201);
      expect(created.body).toMatchObject({
        label: 'Home',
        line2: 'Near the temple',
        state: 'Telangana',
      });
      const id = (created.body as { id: string }).id;
      const patched = await as(api, customer).patch(`/api/v1/customers/me/addresses/${id}`, {
        label: 'Office',
        line2: null,
      });
      expect(patched.status).toBe(200);
      expect(patched.body).toMatchObject({ label: 'Office', line2: null, state: 'Telangana' });
      const read = await as(api, customer).get(`/api/v1/customers/me/addresses/${id}`);
      expect(read.body).toMatchObject({ label: 'Office', line2: null, state: 'Telangana' });
    });

    it('stays optional, and rejects over-long or non-string values', async () => {
      const plain = await addr(base);
      expect(plain.status).toBe(201);
      expect(plain.body).toMatchObject({ label: null, line2: null, state: null });
      expect((await addr({ ...base, label: 'x'.repeat(51) })).status).toBe(400);
      expect((await addr({ ...base, state: 'y'.repeat(101) })).status).toBe(400);
      expect((await addr({ ...base, line2: 42 })).status).toBe(400);
    });

    it("cannot be read or changed through another customer's address id", async () => {
      const mine = await addr({ ...base, label: 'Mine' });
      const other = await loginWithOtp(api, { appType: 'CUSTOMER' });
      await as(api, other)
        .post('/api/v1/customers/me', {
          name: 'Other Person',
          email: `o.${Date.now()}@example.test`,
          preferredLanguage: 'en',
        })
        .expect(201);
      const id = (mine.body as { id: string }).id;
      expect((await as(api, other).get(`/api/v1/customers/me/addresses/${id}`)).status).toBe(404);
      expect(
        (await as(api, other).patch(`/api/v1/customers/me/addresses/${id}`, { label: 'Hacked' }))
          .status,
      ).toBe(404);
      expect((await api.prisma.customerAddress.findUniqueOrThrow({ where: { id } })).label).toBe(
        'Mine',
      );
    });
  });
});
