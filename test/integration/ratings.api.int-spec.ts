import '../support/env-api-integration';
import {
  ApiApp,
  createApiApp,
  loginAdmin,
  loginAdminWithPermissions,
  loginWithOtp,
} from '../support/api-app';
import { makeBooking, TestBooking } from '../support/bookings';
import { as, createArea, setRequiredChecks } from '../support/workforce';
import { RatingsService } from '../../src/modules/ratings/ratings.service';

const UNKNOWN_ID = '00000000-0000-7000-8000-000000000000';
const R = '/api/v1/ratings';
const A = '/api/v1/admin/ratings';
const W = '/api/v1/workers/me/ratings';

/** Ratings against the REAL PostgreSQL + Redis (dedicated test database), through the HTTP API. */
describe('Ratings API (integration)', () => {
  let api: ApiApp;
  let admin: Awaited<ReturnType<typeof loginAdmin>>;
  let area: { id: string };
  let customer: Awaited<ReturnType<typeof loginWithOtp>> & { userId: string };

  /** A booking taken through the real lifecycle to COMPLETED. */
  async function completed(): Promise<TestBooking> {
    const b = await makeBooking(api, admin, customer, area.id, 'ACTIVE');
    await as(api, customer).post(`/api/v1/bookings/${b.id}/complete`).expect(200);
    return b;
  }
  const rate = (bookingId: string, score = 4, extra: object = {}, caller = customer) =>
    as(api, caller).post(R, { bookingId, score, ...extra });
  const summaryRow = (workerId: string) =>
    api.prisma.workerRatingSummary.findUnique({ where: { workerId } });
  const workerIdOf = async (b: TestBooking): Promise<string> =>
    (await api.prisma.booking.findUniqueOrThrow({ where: { id: b.id } })).workerId!;

  beforeAll(async () => {
    api = await createApiApp();
    admin = await loginAdmin(api);
    area = await createArea(api, admin);
    customer = await loginWithOtp(api, { appType: 'CUSTOMER' });
    await setRequiredChecks(api, admin, ['IDENTITY']);
  });

  afterAll(async () => {
    await setRequiredChecks(api, admin, []);
    await api.close();
  });

  describe('creating', () => {
    it('rates the worker of a completed booking; the worker comes from the booking', async () => {
      const b = await completed();
      const res = await rate(b.id, 5, { review: '  Very reliable  ' });
      expect(res.status).toBe(201);
      expect(res.body).toMatchObject({
        bookingId: b.id,
        score: 5,
        review: 'Very reliable',
        status: 'VISIBLE',
      });
      expect(Object.keys(res.body as object)).not.toEqual(expect.arrayContaining(['workerId']));
      const stored = await api.prisma.rating.findUniqueOrThrow({ where: { bookingId: b.id } });
      expect(stored.workerId).toBe(await workerIdOf(b));
      expect(stored.customerUserId).toBe(customer.userId);
    });

    it('is not allowed before the engagement is completed', async () => {
      for (const stage of ['MATCHED', 'CONFIRMED', 'ACTIVE'] as const) {
        const b = await makeBooking(api, admin, customer, area.id, stage);
        const res = await rate(b.id);
        expect(res.status).toBe(422);
        expect(res.body.code).toBe('RATING_NOT_ELIGIBLE');
      }
      const cancelled = await makeBooking(api, admin, customer, area.id, 'MATCHED');
      await as(api, customer)
        .post(`/api/v1/bookings/${cancelled.id}/cancel`, { reason: 'changed my mind' })
        .expect(200);
      expect((await rate(cancelled.id)).status).toBe(422);
      expect(await api.prisma.rating.count({ where: { bookingId: cancelled.id } })).toBe(0);
    });

    it('validates the score against the configured scale and the review length', async () => {
      const b = await completed();
      expect((await rate(b.id, 0)).status).toBe(400);
      expect((await rate(b.id, -1)).status).toBe(400);
      expect((await rate(b.id, 3.5)).status).toBe(400);
      const over = await rate(b.id, api.config.ratingScaleMax + 1);
      expect(over.status).toBe(400);
      expect(over.body.code).toBe('RATING_SCORE_OUT_OF_SCALE');
      expect((await as(api, customer).post(R, { bookingId: b.id })).status).toBe(400);
      expect((await rate(b.id, 3, { review: '   ' })).status).toBe(400);
      expect((await rate(b.id, 3, { review: 'x'.repeat(2001) })).status).toBe(400);
      expect((await rate('not-a-uuid')).status).toBe(400);
      expect(await api.prisma.rating.count({ where: { bookingId: b.id } })).toBe(0);
      expect((await rate(b.id, api.config.ratingScaleMax)).status).toBe(201);
    });

    it('accepts one rating per booking, even when sent many times at once', async () => {
      const b = await completed();
      const results = await Promise.all(Array.from({ length: 6 }, () => rate(b.id, 3)));
      expect(results.filter((r) => r.status === 201)).toHaveLength(1);
      const duplicates = results.filter((r) => r.status === 409);
      expect(duplicates).toHaveLength(5);
      expect(duplicates[0].body.code).toBe('RATING_ALREADY_EXISTS');
      expect(await api.prisma.rating.count({ where: { bookingId: b.id } })).toBe(1);
      expect((await summaryRow(await workerIdOf(b)))!.ratingCount).toBe(1);
    });

    it('cannot rate someone else booking, an unknown booking, or act as another user type', async () => {
      const b = await completed();
      const stranger = await loginWithOtp(api, { appType: 'CUSTOMER' });
      expect((await rate(b.id, 4, {}, stranger)).status).toBe(404);
      expect((await rate(UNKNOWN_ID)).status).toBe(404);
      expect((await rate(b.id, 4, {}, b.worker as never)).status).toBe(403);
      expect((await rate(b.id, 4, {}, admin as never)).status).toBe(403);
      expect((await api.http().post(R).send({ bookingId: b.id, score: 4 })).status).toBe(401);
      // a worker id smuggled in the body is ignored: the rating goes to the worker of the booking
      const other = await completed();
      const smuggled = await as(api, customer).post(R, {
        bookingId: other.id,
        score: 4,
        workerId: await workerIdOf(b),
      });
      expect(smuggled.status).toBe(201);
      expect(
        (await api.prisma.rating.findUniqueOrThrow({ where: { bookingId: other.id } })).workerId,
      ).toBe(await workerIdOf(other));
      expect(await api.prisma.rating.count({ where: { bookingId: b.id } })).toBe(0);
    });

    it('audits the creation without the review text', async () => {
      const b = await completed();
      const res = await rate(b.id, 2, { review: 'secret review wording' });
      const rows = await api.prisma.auditLog.findMany({
        where: { action: 'rating.create', entityId: res.body.id },
      });
      expect(rows).toHaveLength(1);
      expect(rows[0].actorId).toBe(customer.userId);
      expect(JSON.stringify(rows[0].metadata)).not.toContain('secret review wording');
      expect(rows[0].metadata).toMatchObject({ bookingId: b.id, score: 2 });
    });

    it('offers no edit or delete to the customer (Q-60)', async () => {
      const b = await completed();
      const id = (await rate(b.id, 4)).body.id as string;
      const token = `Bearer ${customer.accessToken}`;
      for (const method of ['patch', 'put', 'delete'] as const) {
        const res = await api
          .http()
          [method](`${R}/${id}`)
          .set('Authorization', token)
          .send({ score: 1 });
        expect(res.status).toBe(404);
      }
      expect((await api.prisma.rating.findUniqueOrThrow({ where: { id } })).score).toBe(4);
    });
  });

  describe('reading', () => {
    it('shows a customer only their own ratings', async () => {
      const b = await completed();
      const id = (await rate(b.id, 4)).body.id as string;
      expect((await as(api, customer).get(`${R}/${id}`)).body.id).toBe(id);
      expect((await as(api, customer).get(`${R}/bookings/${b.id}`)).body.id).toBe(id);
      const list = await as(api, customer).get(`${R}?limit=100`).expect(200);
      expect(list.body.data.map((r: { id: string }) => r.id)).toContain(id);
      const stranger = await loginWithOtp(api, { appType: 'CUSTOMER' });
      expect((await as(api, stranger).get(`${R}/${id}`)).status).toBe(404);
      expect((await as(api, stranger).get(`${R}/bookings/${b.id}`)).status).toBe(404);
      const theirs = await as(api, stranger).get(R).expect(200);
      expect(theirs.body.data).toEqual([]);
      expect(theirs.body.meta.total).toBe(0);
      expect((await as(api, customer).get(`${R}/${UNKNOWN_ID}`)).status).toBe(404);
    });

    it('lets a worker see received visible ratings and totals, with no customer identity', async () => {
      const b = await completed();
      await rate(b.id, 5, { review: 'Excellent' });
      const received = await as(api, b.worker).get(W).expect(200);
      expect(received.body.meta.total).toBe(1);
      expect(received.body.data[0]).toMatchObject({ score: 5, review: 'Excellent' });
      expect(Object.keys(received.body.data[0] as object).sort()).toEqual([
        'createdAt',
        'id',
        'review',
        'score',
      ]);
      const summary = await as(api, b.worker).get(`${W}/summary`).expect(200);
      expect(summary.body).toEqual({ count: 1, average: 5, scaleMax: api.config.ratingScaleMax });
      const otherWorker = (await completed()).worker;
      expect((await as(api, otherWorker).get(W).expect(200)).body.meta.total).toBe(0);
      expect((await as(api, otherWorker).get(`${W}/summary`)).body).toMatchObject({
        count: 0,
        average: null,
      });
      expect((await as(api, customer).get(W)).status).toBe(403);
      expect((await as(api, b.worker).get(R)).status).toBe(403);
    });

    it('averages several ratings of one worker in the stored totals', async () => {
      const first = await completed();
      const workerId = await workerIdOf(first);
      await rate(first.id, 5);
      // a second completed booking for the same worker: attach via the database (the lifecycle forbids two live bookings)
      const second = await completed();
      await api.prisma.booking.update({ where: { id: second.id }, data: { workerId } });
      await rate(second.id, 2);
      const summary = await as(api, first.worker).get(`${W}/summary`).expect(200);
      expect(summary.body).toMatchObject({ count: 2, average: 3.5 });
      const [viaContract] = await api.app.get(RatingsService).getSummaries([workerId]);
      expect(viaContract).toEqual({ workerId, count: 2, average: 3.5 });
    });
  });

  describe('administration', () => {
    it('lets staff with rating.view list and read; others are refused', async () => {
      const b = await completed();
      const id = (await rate(b.id, 4)).body.id as string;
      const viewer = await loginAdminWithPermissions(api, ['rating.view']);
      const list = await as(api, viewer)
        .get(`${A}?workerId=${await workerIdOf(b)}`)
        .expect(200);
      expect(list.body.data.map((r: { id: string }) => r.id)).toEqual([id]);
      expect((await as(api, viewer).get(`${A}/${id}`)).body).toMatchObject({
        id,
        customerUserId: customer.userId,
        status: 'VISIBLE',
      });
      expect((await as(api, viewer).get(`${A}?status=BOGUS`)).status).toBe(400);
      expect((await as(api, viewer).post(`${A}/${id}/hide`, { reason: 'x' })).status).toBe(403);
      const nobody = await loginAdminWithPermissions(api, []);
      expect((await as(api, nobody).get(A)).status).toBe(403);
      expect((await as(api, customer).get(A)).status).toBe(403);
      expect((await as(api, b.worker).get(A)).status).toBe(403);
      expect((await api.http().get(A)).status).toBe(401);
      expect((await as(api, viewer).get(`${A}/${UNKNOWN_ID}`)).status).toBe(404);
    });

    it('hides and restores a rating, keeping totals and the worker view correct', async () => {
      const b = await completed();
      const workerId = await workerIdOf(b);
      const id = (await rate(b.id, 1, { review: 'abusive words' })).body.id as string;
      const moderator = await loginAdminWithPermissions(api, ['rating.moderate', 'rating.view']);
      expect((await as(api, moderator).post(`${A}/${id}/hide`, {})).status).toBe(400);

      const hidden = await as(api, moderator)
        .post(`${A}/${id}/hide`, { reason: 'Abusive language' })
        .expect(200);
      expect(hidden.body).toMatchObject({
        status: 'HIDDEN',
        moderatedByUserId: moderator.userId,
        moderationReason: 'Abusive language',
      });
      expect(await summaryRow(workerId)).toMatchObject({ ratingCount: 0, ratingSum: 0 });
      expect((await as(api, b.worker).get(W)).body.meta.total).toBe(0);
      expect((await as(api, customer).get(`${R}/${id}`)).body.status).toBe('HIDDEN');

      // repeating changes nothing
      await as(api, moderator).post(`${A}/${id}/hide`, { reason: 'again' }).expect(200);
      expect(await summaryRow(workerId)).toMatchObject({ ratingCount: 0, ratingSum: 0 });

      await as(api, moderator)
        .post(`${A}/${id}/unhide`, { reason: 'Reviewed, acceptable' })
        .expect(200);
      expect(await summaryRow(workerId)).toMatchObject({ ratingCount: 1, ratingSum: 1 });
      expect((await as(api, b.worker).get(W)).body.meta.total).toBe(1);

      const audit = await api.prisma.auditLog.findMany({
        where: {
          entityType: 'rating',
          entityId: id,
          action: { in: ['rating.hide', 'rating.unhide'] },
        },
        orderBy: { createdAt: 'asc' },
      });
      expect(audit.map((a) => a.action)).toEqual(['rating.hide', 'rating.unhide']);
      expect(audit[0].actorId).toBe(moderator.userId);
    });

    it('keeps the totals equal to the visible ratings under parallel moderation', async () => {
      const b = await completed();
      const workerId = await workerIdOf(b);
      const id = (await rate(b.id, 3)).body.id as string;
      const moderator = await loginAdminWithPermissions(api, ['rating.moderate']);
      await Promise.all(
        Array.from({ length: 6 }, (_, i) =>
          as(api, moderator).post(`${A}/${id}/${i % 2 === 0 ? 'hide' : 'unhide'}`, {
            reason: 'race',
          }),
        ),
      );
      const stored = await api.prisma.rating.findUniqueOrThrow({ where: { id } });
      const aggregate = await api.prisma.rating.aggregate({
        where: { workerId, status: 'VISIBLE' },
        _count: true,
        _sum: { score: true },
      });
      expect(await summaryRow(workerId)).toMatchObject({
        ratingCount: aggregate._count,
        ratingSum: aggregate._sum.score ?? 0,
      });
      expect(['VISIBLE', 'HIDDEN']).toContain(stored.status);
    });
  });
});
