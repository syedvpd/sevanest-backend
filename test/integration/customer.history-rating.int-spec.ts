import '../support/env-api-integration';
import { randomUUID } from 'node:crypto';
import { AppConfigService } from '../../src/config/app-config.service';
import { ProviderError } from '../../src/integrations/provider-error';
import { ApiApp, createApiApp, loginAdmin, loginWithOtp } from '../support/api-app';
import { inDays, makeBooking } from '../support/bookings';
import {
  as,
  categoryId,
  createArea,
  ensureRatingTags,
  setRequiredChecks,
} from '../support/workforce';

const B = '/api/v1/bookings';
const R = '/api/v1/ratings';
const H = '/api/v1/customers/me/booking-history';
const UNKNOWN_ID = '00000000-0000-7000-8000-000000000000';
const YEAR = new Date().getFullYear();

type Made = Awaited<ReturnType<typeof makeBooking>>;
type Who = Awaited<ReturnType<typeof loginWithOtp>> & { userId: string };

/**
 * Customer History and Rating screens: history list and totals, rating eligibility and review limit, "hire again", and the worker
 * identity on bookings. Real HTTP API, real database (dedicated test database), test-issued tokens.
 */
describe('Customer history, rating, rebook and worker identity (integration)', () => {
  let api: ApiApp;
  let admin: Awaited<ReturnType<typeof loginAdmin>>;
  let area: { id: string };
  let stranger: Who;

  const newCustomer = async (): Promise<Who> => await loginWithOtp(api, { appType: 'CUSTOMER' });
  const complete = async (b: Made): Promise<Made> => {
    await as(api, b.customer).post(`${B}/${b.id}/complete`).expect(200);
    return b;
  };
  const name = (b: Made, display: string) =>
    api.prisma.workerProfile.update({ where: { id: b.worker.workerId }, data: { name: display } });
  const actions = async (who: Who, id: string): Promise<string[]> =>
    ((await as(api, who).get(`${B}/${id}`).expect(200)).body.allowedActions as string[])
      .slice()
      .sort();

  beforeAll(async () => {
    api = await createApiApp();
    admin = await loginAdmin(api);
    area = await createArea(api, admin);
    await setRequiredChecks(api, admin, ['IDENTITY']);
    stranger = await newCustomer();
  });
  afterAll(async () => {
    await setRequiredChecks(api, admin, []);
    await api.close();
  });

  describe('history list and totals', () => {
    let me: Who;
    let b1: Made; // COMPLETED, HOUSE_MAID, this year
    let b2: Made; // COMPLETED, COOK, 2025
    let b3: Made; // REPLACED (ended early)
    let b4: Made; // CANCELLED after payment
    let b5: Made; // ACTIVE (not history)
    let b6: Made; // COMPLETED, payment refunded

    beforeAll(async () => {
      me = await newCustomer();
      b1 = await complete(await makeBooking(api, admin, me, area.id, 'ACTIVE'));
      b2 = await complete(await makeBooking(api, admin, me, area.id, 'ACTIVE'));
      b3 = await makeBooking(api, admin, me, area.id, 'ACTIVE');
      b4 = await makeBooking(api, admin, me, area.id, 'CONFIRMED');
      b5 = await makeBooking(api, admin, me, area.id, 'ACTIVE');
      b6 = await complete(await makeBooking(api, admin, me, area.id, 'ACTIVE'));
      await name(b1, 'Anjali Verma');
      await name(b2, 'Bharat Singh');
      await name(b3, 'Chitra Rao');
      await name(b4, 'Deepa Nair');
      await name(b6, 'Esha Patel');
      await api.prisma.booking.update({
        where: { id: b2.id },
        data: {
          categoryId: await categoryId(api, 'COOK'),
          startDate: new Date('2025-03-10T00:00:00.000Z'),
        },
      });
      await api.prisma.booking.update({ where: { id: b3.id }, data: { status: 'REPLACED' } });
      await as(api, me).post(`${B}/${b4.id}/cancel`, { reason: 'Plans changed' }).expect(200);
      const paymentId = (await as(api, me).get(`/api/v1/payments?bookingId=${b6.id}`).expect(200))
        .body.data[0].id;
      await as(api, admin)
        .post(`/api/v1/admin/payments/${paymentId}/refund`, { reason: 'Test refund' })
        .expect(200);
      expect(
        (await api.prisma.payment.findUniqueOrThrow({ where: { id: paymentId } })).status,
      ).toBe('REFUNDED');
    });

    it('lists completed, ended-early and cancelled bookings newest service first, each with what was paid; active ones are not history', async () => {
      const res = await as(api, me).get(`${H}`).expect(200);
      const ids = (res.body.data as Array<{ id: string }>).map((r) => r.id);
      expect(res.body.meta.total).toBe(5);
      expect(ids).not.toContain(b5.id);
      expect(ids[ids.length - 1]).toBe(b2.id); // the 2025 service is the oldest
      expect(new Set(ids)).toEqual(new Set([b1.id, b2.id, b3.id, b4.id, b6.id]));
      const byId = Object.fromEntries(
        (res.body.data as Array<Record<string, unknown>>).map((r) => [r.id as string, r]),
      );
      expect(byId[b1.id]).toMatchObject({
        status: 'COMPLETED',
        amountPaidMinor: 50000,
        currency: 'INR',
      });
      expect(byId[b6.id]).toMatchObject({ amountPaidMinor: 0 }); // refunded money is not spend
      expect(byId[b3.id]).toMatchObject({ status: 'REPLACED' });
      expect(byId[b4.id]).toMatchObject({ status: 'CANCELLED', worker: null });
      expect(byId[b1.id].worker).toEqual({
        displayName: 'Anjali V.',
        name: 'Anjali V.',
        initials: 'AV',
        verified: true,
        photo: null,
      });
    });

    it('totals count delivered services, distinct workers and money still held; the year and category filters narrow all three', async () => {
      const all = (await as(api, me).get(`${H}/summary`).expect(200)).body;
      // delivered: b1, b2, b3 (REPLACED), b6; held money: b1, b2, b3, b4 (cancelled, not refunded), b5 (active); b6 was refunded
      expect(all).toEqual({
        totalServices: 4,
        distinctWorkers: 4,
        totalSpentMinor: 250000,
        currency: 'INR',
        year: null,
        category: null,
      });
      expect((await as(api, me).get(`${H}/summary?year=2025`).expect(200)).body).toMatchObject({
        totalServices: 1,
        distinctWorkers: 1,
        totalSpentMinor: 50000,
        year: 2025,
      });
      expect((await as(api, me).get(`${H}/summary?year=${YEAR}`).expect(200)).body).toMatchObject({
        totalServices: 3,
        distinctWorkers: 3,
        totalSpentMinor: 200000,
      });
      expect((await as(api, me).get(`${H}/summary?category=COOK`).expect(200)).body).toMatchObject({
        totalServices: 1,
        totalSpentMinor: 50000,
        category: 'COOK',
      });
      expect((await as(api, me).get(`${H}/summary?year=1999`).expect(400)).body.code).toBeDefined();
      // someone with no bookings gets zeros, never my numbers
      expect((await as(api, stranger).get(`${H}/summary`).expect(200)).body).toMatchObject({
        totalServices: 0,
        distinctWorkers: 0,
        totalSpentMinor: 0,
      });
      expect((await as(api, stranger).get(`${H}`).expect(200)).body).toMatchObject({
        data: [],
        meta: { total: 0 },
      });
    });

    it('filters by year, category, status and search (category or the worker name where the worker is shown); wildcards are plain text', async () => {
      const ids = async (qs: string) =>
        (
          (await as(api, me).get(`${H}?${qs}`).expect(200)).body.data as Array<{
            id: string;
          }>
        )
          .map((r) => r.id)
          .sort();
      expect(await ids('year=2025')).toEqual([b2.id]);
      expect(await ids(`year=${YEAR}`)).toEqual([b1.id, b3.id, b4.id, b6.id].sort());
      expect(await ids('category=COOK')).toEqual([b2.id]);
      expect(await ids('status=CANCELLED')).toEqual([b4.id]);
      expect(await ids('search=cook')).toEqual([b2.id]);
      expect(await ids('search=bharat')).toEqual([b2.id]);
      expect(await ids('search=CHITRA')).toEqual([b3.id]);
      expect(await ids('search=deepa')).toEqual([]); // a cancelled booking never shows its worker, so the name cannot be searched
      expect(await ids('search=%25')).toEqual([]);
      expect(await ids('search=_')).toEqual([]);
      expect(await ids('search=zzzz')).toEqual([]);
      expect(await ids(`year=${YEAR}&category=HOUSE_MAID&search=anjali`)).toEqual([b1.id]);
    });

    it('paginates, validates every filter, and keeps one worker-name lookup for the whole page', async () => {
      const page2 = (await as(api, me).get(`${H}?limit=2&page=2`).expect(200)).body;
      expect(page2.data).toHaveLength(2);
      expect(page2.meta).toMatchObject({ page: 2, limit: 2, total: 5 });
      for (const qs of [
        'year=abc',
        'year=1999',
        'year=2101',
        'category=cook',
        'category=A',
        'status=ACTIVE',
        'search=' + 'x'.repeat(101),
        'limit=0',
        'page=0',
        'limit=9999',
      ]) {
        expect((await as(api, me).get(`${H}?${qs}`)).status).toBe(400);
      }
      const names = jest.spyOn(api.prisma.workerProfile, 'findMany');
      try {
        await as(api, me).get(`${H}`).expect(200);
        expect(names.mock.calls.length).toBeLessThanOrEqual(1);
      } finally {
        names.mockRestore();
      }
      expect((await api.http().get(`${H}`)).status).toBe(401);
      expect((await as(api, b1.worker).get(`${H}`)).status).toBe(403);
      expect((await as(api, admin).get(`${H}/summary`)).status).toBe(403);
    });

    it('rating eligibility and allowedActions follow the booking state (COMPLETED, REPLACED, CANCELLED, ACTIVE, others)', async () => {
      const elig = async (id: string): Promise<Record<string, unknown>> =>
        (await as(api, me).get(`${R}/bookings/${id}/eligibility`).expect(200)).body as Record<
          string,
          unknown
        >;
      expect(await elig(b1.id)).toMatchObject({
        eligible: true,
        code: 'ELIGIBLE',
        reason: null,
        reviewMaxLength: 300,
        scaleMax: 5,
      });
      expect(await elig(b3.id)).toMatchObject({
        eligible: false,
        code: 'ENDED_EARLY_NOT_RATEABLE',
      });
      expect(await elig(b4.id)).toMatchObject({ eligible: false, code: 'NOT_COMPLETED' });
      expect(await elig(b5.id)).toMatchObject({ eligible: false, code: 'NOT_COMPLETED' });
      const matched = await makeBooking(api, admin, me, area.id, 'MATCHED');
      expect(await elig(matched.id)).toMatchObject({ eligible: false, code: 'NOT_COMPLETED' });

      expect(await actions(me, b1.id)).toEqual(['rate', 'rebook']);
      expect(await actions(me, b3.id)).toEqual([]);
      expect(await actions(me, b4.id)).toEqual([]);
      expect(await actions(me, b5.id)).toEqual(['complete', 'report-attendance-exception']);
      expect(await actions(me, matched.id)).toEqual(expect.arrayContaining(['cancel', 'schedule']));
      const confirmedLike = await makeBooking(api, admin, me, area.id, 'PENDING_PAYMENT');
      expect(await actions(me, confirmedLike.id)).toEqual(
        expect.arrayContaining(['pay', 'cancel']),
      );
      // the list carries the same fields
      const list = (await as(api, me).get(`${B}?limit=50`).expect(200)).body.data as Array<{
        id: string;
        allowedActions: string[];
        rating: { eligible: boolean; rated: boolean };
      }>;
      expect(list.find((x) => x.id === b1.id)).toMatchObject({
        rating: { rated: false, eligible: true },
      });
      expect(
        list
          .find((x) => x.id === b1.id)!
          .allowedActions.slice()
          .sort(),
      ).toEqual(['rate', 'rebook']);
    });

    it('a stranger cannot read eligibility, history rows or booking details of someone else', async () => {
      expect((await as(api, stranger).get(`${R}/bookings/${b1.id}/eligibility`)).status).toBe(404);
      expect((await as(api, stranger).get(`${R}/bookings/${UNKNOWN_ID}/eligibility`)).status).toBe(
        404,
      );
      expect((await as(api, stranger).get(`${B}/${b1.id}`)).status).toBe(404);
      expect((await as(api, stranger).post(R, { bookingId: b1.id, score: 5 })).status).toBe(404);
      expect((await api.http().get(`${R}/bookings/${b1.id}/eligibility`)).status).toBe(401);
    });

    it('home shows the active booking with the same worker, actions and rating fields', async () => {
      const home = (await as(api, me).get('/api/v1/customers/me/home').expect(200)).body;
      expect(home.activeBooking).toMatchObject({
        allowedActions: expect.any(Array),
        rating: expect.any(Object),
      });
    });
  });

  describe('rating: eligibility is enforced by the server, duplicates and the review limit', () => {
    it('rates once; the repeat and a race both answer 409 and leave one row; the action disappears', async () => {
      const me = await newCustomer();
      const b = await complete(await makeBooking(api, admin, me, area.id, 'ACTIVE'));
      const results = await Promise.all(
        [1, 2, 3, 4, 5, 6].map(() => as(api, me).post(R, { bookingId: b.id, score: 4 })),
      );
      expect(results.filter((r) => r.status === 201)).toHaveLength(1);
      expect(
        results
          .filter((r) => r.status === 409)
          .every((r) => r.body.code === 'RATING_ALREADY_EXISTS'),
      ).toBe(true);
      expect(await api.prisma.rating.count({ where: { bookingId: b.id } })).toBe(1);
      expect(
        (await as(api, me).get(`${R}/bookings/${b.id}/eligibility`).expect(200)).body,
      ).toMatchObject({ eligible: false, code: 'ALREADY_RATED' });
      expect(await actions(me, b.id)).toEqual(['rebook']);
      expect((await as(api, me).get(`${B}/${b.id}`).expect(200)).body.rating).toEqual({
        rated: true,
        eligible: false,
        code: 'ALREADY_RATED',
      });
    });

    it('the server refuses ratings the UI would hide: ACTIVE, CANCELLED, REPLACED and out-of-scale scores', async () => {
      const me = await newCustomer();
      const active = await makeBooking(api, admin, me, area.id, 'ACTIVE');
      const replaced = await makeBooking(api, admin, me, area.id, 'ACTIVE');
      await api.prisma.booking.update({ where: { id: replaced.id }, data: { status: 'REPLACED' } });
      const cancelled = await makeBooking(api, admin, me, area.id, 'CONFIRMED');
      await as(api, me).post(`${B}/${cancelled.id}/cancel`, { reason: 'x' }).expect(200);
      for (const b of [active, replaced, cancelled]) {
        const res = await as(api, me).post(R, { bookingId: b.id, score: 5 });
        expect(res.status).toBe(422);
        expect(res.body.code).toBe('RATING_NOT_ELIGIBLE');
      }
      const done = await complete(await makeBooking(api, admin, me, area.id, 'ACTIVE'));
      expect((await as(api, me).post(R, { bookingId: done.id, score: 6 })).body.code).toBe(
        'RATING_SCORE_OUT_OF_SCALE',
      );
      expect((await as(api, me).post(R, { bookingId: done.id, score: 0 })).status).toBe(400);
      expect(
        await api.prisma.rating.count({
          where: { bookingId: { in: [active.id, replaced.id, cancelled.id, done.id] } },
        }),
      ).toBe(0);
    });

    it('an ended-early (REPLACED) booking becomes rateable only when the client switches it on (Q-102)', async () => {
      const me = await newCustomer();
      const config = api.app.get(AppConfigService);
      const replaced = await makeBooking(api, admin, me, area.id, 'ACTIVE');
      await api.prisma.booking.update({ where: { id: replaced.id }, data: { status: 'REPLACED' } });
      const flag = jest.spyOn(config, 'ratingAllowEndedEarly', 'get').mockReturnValue(true);
      try {
        expect(
          (await as(api, me).get(`${R}/bookings/${replaced.id}/eligibility`).expect(200)).body,
        ).toMatchObject({ eligible: true, code: 'ELIGIBLE' });
        expect(await actions(me, replaced.id)).toEqual(['rate']);
        expect((await as(api, me).post(R, { bookingId: replaced.id, score: 5 })).status).toBe(201);
      } finally {
        flag.mockRestore();
      }
    });

    it('review limit: published in /reference-data, enforced in characters at the boundary, empty refused, tags are catalogue codes', async () => {
      await ensureRatingTags(api, admin, [
        { code: 'PUNCTUAL', label: 'Punctual', sentiment: 'POSITIVE' },
      ]);
      const ref = (await api.http().get('/api/v1/reference-data').expect(200)).body;
      expect(ref.ratingReviewMax).toBe(300);
      expect(ref.ratingTags.map((t: { code: string }) => t.code)).toContain('PUNCTUAL');
      const me = await newCustomer();
      const a = await complete(await makeBooking(api, admin, me, area.id, 'ACTIVE'));
      const over = await as(api, me).post(R, {
        bookingId: a.id,
        score: 5,
        review: 'x'.repeat(301),
      });
      expect(over.status).toBe(400);
      expect(over.body.code).toBe('RATING_REVIEW_TOO_LONG');
      expect((await as(api, me).post(R, { bookingId: a.id, score: 5, review: '' })).status).toBe(
        400,
      );
      expect((await as(api, me).post(R, { bookingId: a.id, score: 5, review: '   ' })).status).toBe(
        400,
      );
      expect(await api.prisma.rating.count({ where: { bookingId: a.id } })).toBe(0);
      const ok = await as(api, me).post(R, {
        bookingId: a.id,
        score: 5,
        review: 'x'.repeat(300),
        tags: ['PUNCTUAL'],
      });
      expect(ok.status).toBe(201);
      expect(ok.body.review).toHaveLength(300);
      expect(ok.body.tags).toEqual(['PUNCTUAL']);
      expect((await as(api, me).get(`${R}/${ok.body.id}`).expect(200)).body.tags).toEqual([
        'PUNCTUAL',
      ]);

      // characters, not bytes: 300 emoji are accepted, 301 are not
      const emoji = await complete(await makeBooking(api, admin, me, area.id, 'ACTIVE'));
      expect(
        (await as(api, me).post(R, { bookingId: emoji.id, score: 5, review: '😀'.repeat(301) }))
          .status,
      ).toBe(400);
      expect(
        (await as(api, me).post(R, { bookingId: emoji.id, score: 5, review: '😀'.repeat(300) }))
          .status,
      ).toBe(201);
      // no review at all is fine
      const bare = await complete(await makeBooking(api, admin, me, area.id, 'ACTIVE'));
      expect((await as(api, me).post(R, { bookingId: bare.id, score: 3 })).status).toBe(201);
    });

    it('the configured limit is the one enforced and published', async () => {
      const config = api.app.get(AppConfigService);
      const me = await newCustomer();
      const b = await complete(await makeBooking(api, admin, me, area.id, 'ACTIVE'));
      const limit = jest.spyOn(config, 'ratingReviewMax', 'get').mockReturnValue(20);
      try {
        expect(
          (await api.http().get('/api/v1/reference-data').expect(200)).body.ratingReviewMax,
        ).toBe(20);
        expect(
          (await as(api, me).get(`${R}/bookings/${b.id}/eligibility`).expect(200)).body
            .reviewMaxLength,
        ).toBe(20);
        expect(
          (await as(api, me).post(R, { bookingId: b.id, score: 5, review: 'x'.repeat(21) })).body
            .code,
        ).toBe('RATING_REVIEW_TOO_LONG');
        expect(
          (await as(api, me).post(R, { bookingId: b.id, score: 5, review: 'x'.repeat(20) })).status,
        ).toBe(201);
      } finally {
        limit.mockRestore();
      }
    });
  });

  describe('rebook ("hire again")', () => {
    const rebook = (who: Who, id: string, key: string | null = randomUUID(), body: object = {}) => {
      const req = as(api, who).post(`${B}/rebook`, { bookingId: id, ...body });
      return key ? req.set('Idempotency-Key', key) : req;
    };

    it('creates a NEW booking for the same worker and requirement; nothing of the old one is copied; a replay answers the same booking', async () => {
      const me = await newCustomer();
      const old = await complete(await makeBooking(api, admin, me, area.id, 'ACTIVE'));
      expect(await actions(me, old.id)).toContain('rebook');
      const key = randomUUID();
      const first = await rebook(me, old.id, key);
      expect(first.status).toBe(201);
      expect(first.body.id).not.toBe(old.id);
      expect(first.body).toMatchObject({
        status: 'MATCHED',
        workerId: old.worker.workerId,
        engagement: 'PART_TIME',
        availableFrom: '09:00',
        availableTo: '12:00',
        startDate: null,
        replacesBookingId: null,
      });
      expect(first.body.category.code).toBe('HOUSE_MAID');
      expect(first.body.area.id).toBe(area.id);
      expect(first.body.rating).toMatchObject({ rated: false, eligible: false });
      expect(first.body.timeline).toHaveLength(2); // created, matched - not the old history
      expect(await api.prisma.payment.count({ where: { bookingId: first.body.id } })).toBe(0);
      expect(await api.prisma.attendanceRecord.count({ where: { bookingId: first.body.id } })).toBe(
        0,
      );
      expect(await api.prisma.rating.count({ where: { bookingId: first.body.id } })).toBe(0);
      expect(
        await api.prisma.booking.count({
          where: { customerUserId: me.userId, workerId: old.worker.workerId },
        }),
      ).toBe(2);

      const replay = await rebook(me, old.id, key);
      expect(replay.status).toBe(200);
      expect(replay.body.id).toBe(first.body.id);
      // with a live booking with this worker the action is gone and a second hire answers 409
      expect(await actions(me, old.id)).not.toContain('rebook');
      expect((await rebook(me, old.id)).body.code).toBe('DUPLICATE_BOOKING');
      expect(
        await api.prisma.booking.count({
          where: { customerUserId: me.userId, workerId: old.worker.workerId },
        }),
      ).toBe(2);
    });

    it('accepts an optional start date and refuses a past one; other statuses, other customers and anonymous callers are refused', async () => {
      const me = await newCustomer();
      const done = await complete(await makeBooking(api, admin, me, area.id, 'ACTIVE'));
      expect((await rebook(me, done.id, randomUUID(), { startDate: '2020-01-01' })).status).toBe(
        400,
      );
      const ok = await rebook(me, done.id, randomUUID(), { startDate: inDays(3) });
      expect(ok.status).toBe(201);
      expect(ok.body.requestedStartDate).toBe(inDays(3));

      const active = await makeBooking(api, admin, me, area.id, 'ACTIVE');
      const cancelled = await makeBooking(api, admin, me, area.id, 'CONFIRMED');
      await as(api, me).post(`${B}/${cancelled.id}/cancel`, { reason: 'x' }).expect(200);
      for (const b of [active, cancelled]) {
        const res = await rebook(me, b.id);
        expect(res.status).toBe(409);
        expect(res.body.code).toBe('REBOOK_NOT_ALLOWED');
        expect(await actions(me, b.id)).not.toContain('rebook');
      }
      expect((await rebook(stranger, done.id)).status).toBe(404);
      expect((await rebook(me, UNKNOWN_ID)).status).toBe(404);
      expect((await api.http().post(`${B}/rebook`).send({ bookingId: done.id })).status).toBe(401);
      expect((await as(api, done.worker).post(`${B}/rebook`, { bookingId: done.id })).status).toBe(
        403,
      );
    });

    it('is not offered, and is refused, when the worker is suspended, no longer offers the engagement, is busy, or the service is disabled', async () => {
      const me = await newCustomer();

      const suspended = await complete(await makeBooking(api, admin, me, area.id, 'ACTIVE'));
      await as(api, admin)
        .patch(`/api/v1/admin/users/${suspended.worker.userId}/status`, { status: 'SUSPENDED' })
        .expect(200);
      expect(await actions(me, suspended.id)).not.toContain('rebook');
      expect((await rebook(me, suspended.id)).body.code).toBe('WORKER_NOT_ELIGIBLE');

      const changed = await complete(await makeBooking(api, admin, me, area.id, 'ACTIVE'));
      await as(api, changed.worker)
        .patch('/api/v1/workers/me/availability', { engagementPreference: 'DAILY' })
        .expect(200);
      expect(await actions(me, changed.id)).not.toContain('rebook');
      expect((await rebook(me, changed.id)).body.code).toBe('WORKER_NOT_ELIGIBLE');

      const busy = await complete(await makeBooking(api, admin, me, area.id, 'ACTIVE'));
      const rival = await newCustomer();
      const taken = await as(api, rival)
        .post(B, {
          category: 'HOUSE_MAID',
          areaId: area.id,
          engagement: 'PART_TIME',
          availableFrom: '09:00',
          availableTo: '12:00',
          workerId: busy.worker.workerId,
        })
        .expect(201);
      await as(api, rival)
        .post(`${B}/${taken.body.id}/schedule`, {
          scheduleType: 'INTERVIEW',
          scheduledAt: new Date(Date.now() + 86400000).toISOString(),
        })
        .expect(200);
      await as(api, rival)
        .post(`${B}/${taken.body.id}/interview-complete`, { outcomeNote: 'ok' })
        .expect(200);
      await as(api, rival)
        .post(`${B}/${taken.body.id}/confirm-worker`, { startDate: inDays(1) })
        .expect(200);
      expect(await actions(me, busy.id)).not.toContain('rebook');
      expect((await rebook(me, busy.id)).body.code).toBe('WORKER_UNAVAILABLE');

      const disabled = await complete(await makeBooking(api, admin, me, area.id, 'ACTIVE'));
      const category = await api.prisma.serviceCategory.findUniqueOrThrow({
        where: { code: 'HOUSE_MAID' },
      });
      await as(api, admin)
        .patch(`/api/v1/admin/service-categories/${category.id}`, { isEnabled: false })
        .expect(200);
      try {
        expect(await actions(me, disabled.id)).not.toContain('rebook');
        expect((await rebook(me, disabled.id)).body.code).toBe('CATEGORY_NOT_AVAILABLE');
      } finally {
        await as(api, admin).patch(`/api/v1/admin/service-categories/${category.id}`, {
          isEnabled: true,
        });
      }
    });
  });

  describe('worker identity on bookings', () => {
    it('shows name, initials and a photo link from the interview stage on, never earlier, never for a stranger, and no private data', async () => {
      const me = await newCustomer();
      const done = await complete(await makeBooking(api, admin, me, area.id, 'ACTIVE'));
      await name(done, 'Ramesh Kumar');
      const matched = await makeBooking(api, admin, me, area.id, 'MATCHED');
      const open = await as(api, me)
        .post(B, {
          category: 'HOUSE_MAID',
          areaId: area.id,
          engagement: 'PART_TIME',
          availableFrom: '09:00',
          availableTo: '12:00',
        })
        .expect(201);

      const detail = (await as(api, me).get(`${B}/${done.id}`).expect(200)).body;
      expect(detail.worker).toEqual({
        displayName: 'Ramesh K.',
        name: 'Ramesh K.',
        initials: 'RK',
        verified: true,
        photo: null,
      });
      expect(detail.workerId).toBe(done.worker.workerId); // the opaque reference stays
      expect((await as(api, me).get(`${B}/${matched.id}`).expect(200)).body.worker).toBeNull();
      expect((await as(api, me).get(`${B}/${open.body.id}`).expect(200)).body.worker).toBeNull();
      expect(JSON.stringify(detail)).not.toMatch(
        /mobile|phone|emergency|address(Line|Area)|passport|aadhaar|objectKey|kyc/i,
      );
      expect((await as(api, stranger).get(`${B}/${done.id}`)).status).toBe(404);
      expect(
        (await as(api, done.worker).get(`/api/v1/workers/me/bookings/${done.id}`).expect(200)).body
          .worker,
      ).toBeUndefined();
    });

    it('returns safe photo links when a photo exists, and still answers (photo null) when storage is down or a name is a single word', async () => {
      const me = await newCustomer();
      const b = await complete(await makeBooking(api, admin, me, area.id, 'ACTIVE'));
      await name(b, 'Madonna');
      const key = `photos/${b.worker.workerId}/p1`;
      const photo = await api.prisma.workerProfilePhoto.create({
        data: {
          workerId: b.worker.workerId,
          objectKey: key,
          contentType: 'image/jpeg',
          sizeBytes: 100,
          status: 'READY',
          confirmedAt: new Date(),
          cardObjectKey: `${key}.card.webp`,
          largeObjectKey: `${key}.large.webp`,
        },
      });
      const worker = (await as(api, me).get(`${B}/${b.id}`).expect(200)).body.worker as {
        photo: { cacheKey: string; expiresAt: string; url: string; largeUrl: string };
      };
      expect(worker).toMatchObject({ displayName: 'Madonna', initials: 'M' });
      expect(worker.photo.url).toContain(encodeURIComponent(`${key}.card.webp`));
      expect(worker.photo.largeUrl).toContain(encodeURIComponent(`${key}.large.webp`));
      expect(worker.photo.cacheKey).toBe(photo.id);
      expect(worker.photo.expiresAt).toBeTruthy();
      expect(Object.keys(worker.photo).sort()).toEqual([
        'cacheKey',
        'expiresAt',
        'largeUrl',
        'url',
      ]);
      expect(worker.photo.url).not.toContain(`${key}?`); // the original object is never linked

      const down = jest
        .spyOn(api.storage, 'createDownloadUrl')
        .mockRejectedValue(new ProviderError('storage', 'down', true));
      try {
        const res = await as(api, me).get(`${B}?limit=50`).expect(200);
        expect(
          (res.body.data as Array<{ id: string; worker: { photo: unknown } | null }>).find(
            (x) => x.id === b.id,
          )!.worker,
        ).toMatchObject({ displayName: 'Madonna', photo: null });
      } finally {
        down.mockRestore();
      }
      // a photo that is not READY is never linked
      await api.prisma.workerProfilePhoto.update({
        where: { id: photo.id },
        data: { status: 'PENDING_UPLOAD' },
      });
      expect((await as(api, me).get(`${B}/${b.id}`).expect(200)).body.worker.photo).toBeNull();
    });
  });
});
