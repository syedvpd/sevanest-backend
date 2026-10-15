import '../support/env-api-integration';
import { AppConfigService } from '../../src/config/app-config.service';
import { ApiApp, createApiApp, loginAdmin, loginWithOtp } from '../support/api-app';
import { inDays, makeBooking } from '../support/bookings';
import { as, createArea, setRequiredChecks } from '../support/workforce';

const R = '/api/v1/replacement-requests';
const UNKNOWN_ID = '00000000-0000-7000-8000-000000000000';
const TAGS = [
  'PUNCTUAL',
  'POLITE',
  'SKILLED',
  'CLEAN_WORK',
  'TRUSTWORTHY',
  'LATE',
  'RUDE',
  'POOR_QUALITY_WORK',
  'UNRELIABLE',
];

type Customer = Awaited<ReturnType<typeof loginWithOtp>> & { userId: string };

/** Customer-app developer requests (2026-10-15): rating tags, replacement neededFrom, policy text. */
describe('Customer app developer requests (integration)', () => {
  let api: ApiApp;
  let admin: Awaited<ReturnType<typeof loginAdmin>>;
  let customer: Customer;
  let other: Customer;
  let area: { id: string };

  const newCustomer = async (): Promise<Customer> => {
    const c: Customer = await loginWithOtp(api, { appType: 'CUSTOMER' });
    await as(api, c)
      .post('/api/v1/customers/me', {
        name: 'Tag Tester',
        email: `t.${Date.now()}.${Math.round(Math.random() * 1e6)}@example.test`,
        preferredLanguage: 'en',
      })
      .expect(201);
    return c;
  };
  /** A COMPLETED booking, ready to be rated. */
  const completed = async () => {
    const b = await makeBooking(api, admin, customer, area.id, 'ACTIVE');
    await as(api, customer).post(`/api/v1/bookings/${b.id}/complete`).expect(200);
    return b;
  };

  beforeAll(async () => {
    api = await createApiApp();
    admin = await loginAdmin(api);
    area = await createArea(api, admin);
    customer = await newCustomer();
    other = await newCustomer();
    await setRequiredChecks(api, admin, ['IDENTITY']);
  });
  afterAll(async () => {
    await setRequiredChecks(api, admin, []);
    await api.close();
  });

  describe('rating tags (Q-103, catalogue pending client confirmation)', () => {
    it('publishes the catalogue in reference-data as codes with separate labels', async () => {
      const res = await as(api, customer).get('/api/v1/reference-data');
      const tags = (res.body as { ratingTags: Array<{ code: string; label: string }> }).ratingTags;
      expect(tags.map((t) => t.code)).toEqual(TAGS);
      expect(tags.find((t) => t.code === 'POOR_QUALITY_WORK')).toMatchObject({
        label: 'Poor quality work',
        sentiment: 'NEGATIVE',
      });
      expect(tags.find((t) => t.code === 'PUNCTUAL')).toMatchObject({ sentiment: 'POSITIVE' });
    });

    it('stores valid tags and returns them on every read that shows a rating', async () => {
      const b = await completed();
      const res = await as(api, customer).post('/api/v1/ratings', {
        bookingId: b.id,
        score: 5,
        review: 'Great',
        tags: ['PUNCTUAL', 'POLITE'],
      });
      expect(res.status).toBe(201);
      expect(res.body).toMatchObject({ score: 5, review: 'Great', tags: ['PUNCTUAL', 'POLITE'] });
      const row = await api.prisma.rating.findUniqueOrThrow({ where: { bookingId: b.id } });
      expect(row.tags).toEqual(['PUNCTUAL', 'POLITE']);

      const one = await as(api, customer).get(`/api/v1/ratings/bookings/${b.id}`);
      expect((one.body as { tags: string[] }).tags).toEqual(['PUNCTUAL', 'POLITE']);
      const mine = await as(api, customer).get('/api/v1/ratings');
      const listed = (mine.body as { data: Array<{ bookingId: string; tags: string[] }> }).data;
      expect(listed.find((r) => r.bookingId === b.id)?.tags).toEqual(['PUNCTUAL', 'POLITE']);
      const publicList = await as(api, customer).get(
        `/api/v1/search/workers/${b.worker.workerId}/ratings`,
      );
      expect((publicList.body as { data: Array<{ tags: string[] }> }).data[0].tags).toEqual([
        'PUNCTUAL',
        'POLITE',
      ]);
      const staff = await as(api, admin).get(`/api/v1/admin/ratings/${row.id}`);
      expect((staff.body as { tags: string[] }).tags).toEqual(['PUNCTUAL', 'POLITE']);
    });

    it('accepts omitted, null and empty tags as none (older clients keep working)', async () => {
      for (const tags of [undefined, null, []]) {
        const b = await completed();
        const res = await as(api, customer).post('/api/v1/ratings', {
          bookingId: b.id,
          score: 4,
          ...(tags === undefined ? {} : { tags }),
        });
        expect(res.status).toBe(201);
        expect((res.body as { tags: string[] }).tags).toEqual([]);
      }
    });

    it('rejects unknown codes, display labels, duplicates, non-arrays and too many, writing nothing', async () => {
      const b = await completed();
      const post = (tags: unknown) =>
        as(api, customer).post('/api/v1/ratings', { bookingId: b.id, score: 4, tags });
      const bad: unknown[] = [
        ['NOT_A_TAG'],
        ['Punctual'],
        ['punctual'],
        ['PUNCTUAL', 'PUNCTUAL'],
        'PUNCTUAL',
        [1],
        [...TAGS, 'PUNCTUAL'],
      ];
      for (const tags of bad) {
        const res = await post(tags);
        expect(res.status).toBe(400);
        expect((res.body as { code: string }).code).toBe('VALIDATION_FAILED');
        expect(JSON.stringify(res.body)).toContain('tags');
      }
      expect(await api.prisma.rating.count({ where: { bookingId: b.id } })).toBe(0);
      expect((await post(['LATE'])).status).toBe(201);
    });

    it('does not tie tags to the score (the pairing rule is not approved)', async () => {
      const b = await completed();
      const res = await as(api, customer).post('/api/v1/ratings', {
        bookingId: b.id,
        score: 5,
        tags: ['RUDE', 'PUNCTUAL'],
      });
      expect(res.status).toBe(201);
    });

    it('keeps access rules: anonymous 401, worker 403, another customer 404', async () => {
      const b = await completed();
      const body = { bookingId: b.id, score: 4, tags: ['POLITE'] };
      expect((await api.http().post('/api/v1/ratings').send(body)).status).toBe(401);
      expect((await as(api, b.worker).post('/api/v1/ratings', body)).status).toBe(403);
      expect((await as(api, other).post('/api/v1/ratings', body)).status).toBe(404);
      expect(await api.prisma.rating.count({ where: { bookingId: b.id } })).toBe(0);
    });
  });

  describe('replacement neededFrom', () => {
    const request = (bookingId: string, extra: object, who: Customer = customer) =>
      as(api, who).post(R, { bookingId, reason: 'Worker is often late', ...extra });
    const active = () => makeBooking(api, admin, customer, area.id, 'ACTIVE');

    it('stores and returns the date without touching the booking', async () => {
      const b = await active();
      const before = (await as(api, customer).get(`/api/v1/bookings/${b.id}`)).body as {
        startDate: string | null;
      };
      const needed = inDays(5);
      const res = await request(b.id, { neededFrom: needed });
      expect(res.status).toBe(201);
      expect(res.body).toMatchObject({ neededFrom: needed, status: 'REQUESTED' });
      const id = (res.body as { id: string }).id;
      expect((await as(api, customer).get(`${R}/${id}`)).body).toMatchObject({
        neededFrom: needed,
      });
      const row = await api.prisma.replacementRequest.findUniqueOrThrow({ where: { id } });
      expect(row.neededFrom?.toISOString().slice(0, 10)).toBe(needed);
      const after = (await as(api, customer).get(`/api/v1/bookings/${b.id}`)).body as {
        startDate: string | null;
      };
      expect(after.startDate).toBe(before.startDate);
      const staff = await as(api, admin).get(`/api/v1/admin/replacement-requests/${id}`);
      expect((staff.body as { neededFrom: string }).neededFrom).toBe(needed);
    });

    it('is null when omitted, and today is accepted', async () => {
      const b1 = await active();
      const omitted = await request(b1.id, {});
      expect(omitted.status).toBe(201);
      expect((omitted.body as { neededFrom: string | null }).neededFrom).toBeNull();
      const b2 = await active();
      const today = inDays(0);
      expect((await request(b2.id, { neededFrom: today })).body).toMatchObject({
        neededFrom: today,
      });
    });

    it('rejects past, impossible and malformed dates without creating a request', async () => {
      const b = await active();
      const bad: unknown[] = [
        inDays(-1),
        '2026-02-30',
        '03-11-2026',
        '2026-13-01',
        'tomorrow',
        20261103,
      ];
      for (const neededFrom of bad) {
        const res = await request(b.id, { neededFrom });
        expect(res.status).toBe(400);
        expect(JSON.stringify(res.body)).toContain('neededFrom');
      }
      expect(await api.prisma.replacementRequest.count({ where: { bookingId: b.id } })).toBe(0);
    });

    it('cannot be used on a booking of another customer or an unknown booking', async () => {
      const b = await active();
      expect((await request(b.id, { neededFrom: inDays(2) }, other)).status).toBe(404);
      expect((await request(UNKNOWN_ID, { neededFrom: inDays(2) })).status).toBe(404);
    });
  });

  describe('GET /app-config policy', () => {
    it('is all null while nothing is configured', async () => {
      const res = await api.http().get('/api/v1/app-config');
      expect(res.status).toBe(200);
      expect((res.body as { policy: object }).policy).toEqual({
        cancellationText: null,
        cancellationUrl: null,
        refundText: null,
        refundUrl: null,
      });
    });

    it('returns exactly the configured content', async () => {
      const config = api.app.get(AppConfigService);
      const spy = jest.spyOn(config, 'policyContent', 'get').mockReturnValue({
        cancellationText: 'Configured cancellation wording',
        cancellationUrl: undefined,
        refundText: undefined,
        refundUrl: 'https://example.test/refund',
      });
      try {
        const res = await api.http().get('/api/v1/app-config');
        expect((res.body as { policy: object }).policy).toEqual({
          cancellationText: 'Configured cancellation wording',
          cancellationUrl: null,
          refundText: null,
          refundUrl: 'https://example.test/refund',
        });
      } finally {
        spy.mockRestore();
      }
    });
  });
});
