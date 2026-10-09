import '../support/env-api-integration';
import {
  ApiApp,
  createApiApp,
  loginAdmin,
  loginAdminWithPermissions,
  loginWithOtp,
} from '../support/api-app';
import { makeBooking, payForBooking } from '../support/bookings';
import { as, createArea, setRequiredChecks } from '../support/workforce';
import { ReportsRepository } from '../../src/modules/reports/reports.repository';

const R = '/api/v1/admin/reports';

const today = (): string => {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Kolkata',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
  return parts;
};
const TODAY_Q = (): string => `from=${today()}&to=${today()}`;

/** Reports against the REAL PostgreSQL + Redis (dedicated test database), through the HTTP API. */
describe('Reports API (integration)', () => {
  let api: ApiApp;
  let admin: Awaited<ReturnType<typeof loginAdmin>>;
  let viewer: Awaited<ReturnType<typeof loginAdminWithPermissions>>;
  let area: { id: string };
  let customer: Awaited<ReturnType<typeof loginWithOtp>> & { userId: string };

  const get = async (path: string, caller: { accessToken: string } = viewer) =>
    as(api, caller).get(`${R}/${path}`);
  // Report payloads differ per report; the assertions below name the fields they rely on.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const data = async (path: string): Promise<Record<string, any>> => {
    const res = await get(path);
    expect(res.status).toBe(200);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return res.body.data as Record<string, any>;
  };

  beforeAll(async () => {
    api = await createApiApp();
    admin = await loginAdmin(api);
    viewer = await loginAdminWithPermissions(api, ['report.view']);
    area = await createArea(api, admin);
    customer = await loginWithOtp(api, { appType: 'CUSTOMER' });
    await setRequiredChecks(api, admin, ['IDENTITY']);
  });

  afterAll(async () => {
    await setRequiredChecks(api, admin, []);
    await api.close();
  });

  describe('access and parameters', () => {
    it('needs report.view, an admin account and a token', async () => {
      const nobody = await loginAdminWithPermissions(api, ['booking.view']);
      expect((await get('booking-funnel?' + TODAY_Q(), nobody)).status).toBe(403);
      expect((await get('booking-funnel?' + TODAY_Q(), customer)).status).toBe(403);
      expect((await api.http().get(`${R}/booking-funnel?${TODAY_Q()}`)).status).toBe(401);
      expect((await get('')).status).toBe(200);
    });

    it('describes every report and its definition', async () => {
      const catalog = (await get('')).body as Array<{
        report: string;
        definition: string;
        path: string;
      }>;
      expect(catalog).toHaveLength(13);
      expect(catalog.every((c) => c.definition.length > 20 && c.path.startsWith('/api/v1/'))).toBe(
        true,
      );
      const funnel = await get(`booking-funnel?${TODAY_Q()}`);
      expect(funnel.body.definition).toBe(
        catalog.find((c) => c.report === 'booking-funnel')!.definition,
      );
      expect(funnel.body.notes.length).toBeGreaterThan(0);
    });

    it('rejects missing, malformed, reversed and over-long ranges', async () => {
      const bad = [
        '',
        'from=2026-10-01',
        'from=10-01-2026&to=2026-10-02',
        'from=2026-02-30&to=2026-03-02',
        'from=2026-10-05&to=2026-10-01',
        'from=2025-01-01&to=2026-12-31',
        `${TODAY_Q()}&interval=hour`,
      ];
      for (const q of bad) {
        const res = await get(`new-customers?${q}`);
        expect(res.status).toBe(400);
        expect(res.body.code).toBe('VALIDATION_FAILED');
      }
      // exactly 366 days is accepted
      expect((await get('new-customers?from=2026-01-01&to=2027-01-01')).status).toBe(200);
      expect((await get('top-rated-workers?minRatings=0')).status).toBe(400);
      expect((await get(`demand-by-area?${TODAY_Q()}&limit=101`)).status).toBe(400);
    });

    it('answers an empty period with zeros and null rates, never with invented numbers', async () => {
      const past = 'from=2020-01-01&to=2020-01-31';
      expect(await data(`new-customers?${past}`)).toEqual({
        interval: 'day',
        total: 0,
        series: [],
      });
      expect(await data(`booking-funnel?${past}`)).toMatchObject({
        requests: 0,
        confirmed: 0,
        confirmationRate: null,
      });
      expect(await data(`cancellation-rate?${past}`)).toEqual({
        totalBookings: 0,
        cancelled: 0,
        cancellationRate: null,
      });
      expect(await data(`interview-conversion?${past}`)).toEqual({
        interviewsHeld: 0,
        confirmed: 0,
        conversion: null,
      });
      expect(await data(`replacement-rate?${past}`)).toEqual({
        activeBookings: 0,
        replacementRequests: 0,
        replacementRate: null,
      });
      expect(await data(`payment-collections?${past}`)).toMatchObject({
        totalsByFeeType: [],
        series: [],
      });
      expect(await data(`support-tickets?${past}`)).toMatchObject({
        created: 0,
        closed: 0,
        averageResolutionSeconds: null,
      });
      expect(await data(`worker-registrations?${past}`)).toMatchObject({
        registered: 0,
        verificationConversion: null,
      });
      const categories = await data(`demand-by-category?${past}`);
      expect(categories.total).toBe(0);
      expect(categories.categories.length).toBeGreaterThan(0);
      const area = await get(`demand-by-area?${past}`);
      expect(area.body).toMatchObject({ data: [], meta: { page: 1, limit: 20, total: 0 } });
      expect((await get(`repeat-customers?${past}`)).body.meta.total).toBe(0);
    });
  });

  describe('aggregation is correct', () => {
    it('counts new customers per bucket, matching the database', async () => {
      const before = (await data(`new-customers?${TODAY_Q()}`)).total as number;
      await loginWithOtp(api, { appType: 'CUSTOMER' });
      await loginWithOtp(api, { appType: 'CUSTOMER' });
      const after = await data(`new-customers?${TODAY_Q()}&interval=day`);
      expect(after.total).toBe(before + 2);
      expect(after.series).toEqual([{ period: today(), count: after.total }]);
      const oracle = await api.prisma.$queryRaw<Array<{ n: number }>>`
        SELECT count(*)::int AS n FROM users WHERE type = 'CUSTOMER'
          AND (created_at AT TIME ZONE 'Asia/Kolkata')::date = ${today()}::date`;
      expect(after.total).toBe(oracle[0].n);
      // weekly and monthly buckets cover the same total
      for (const interval of ['week', 'month']) {
        const bucketed = await data(`new-customers?${TODAY_Q()}&interval=${interval}`);
        expect(bucketed.total).toBe(after.total);
        expect(bucketed.series).toHaveLength(1);
      }
    });

    it('builds the booking funnel, cancellations, conversion, demand and repeat customers from real bookings', async () => {
      const q = TODAY_Q();
      const base = {
        funnel: await data(`booking-funnel?${q}`),
        cancel: await data(`cancellation-rate?${q}`),
        interview: await data(`interview-conversion?${q}`),
        category: await data(`demand-by-category?${q}`),
        replacement: await data(`replacement-rate?${q}`),
      };
      const repeater = await loginWithOtp(api, { appType: 'CUSTOMER' });
      const repeaterId = repeater.userId;
      // two requests that stay MATCHED, one that is cancelled, one confirmed (interview done), one active
      await makeBooking(api, admin, repeater, area.id, 'MATCHED');
      const toCancel = await makeBooking(api, admin, repeater, area.id, 'MATCHED');
      await as(api, repeater)
        .post(`/api/v1/bookings/${toCancel.id}/cancel`, { reason: 'x' })
        .expect(200);
      await makeBooking(api, admin, repeater, area.id, 'CONFIRMED');
      const active = await makeBooking(api, admin, repeater, area.id, 'ACTIVE');
      await as(api, repeater)
        .post('/api/v1/replacement-requests', { bookingId: active.id, reason: 'late' })
        .expect(201);

      const funnel = await data(`booking-funnel?${q}`);
      expect(funnel.requests - base.funnel.requests).toBe(4);
      expect(funnel.confirmed - base.funnel.confirmed).toBe(2);
      expect(funnel.confirmationRate).toBe(
        Math.round((funnel.confirmed / funnel.requests) * 10000) / 10000,
      );
      expect(funnel.series).toHaveLength(1);

      const cancel = await data(`cancellation-rate?${q}`);
      expect(cancel.totalBookings - base.cancel.totalBookings).toBe(4);
      expect(cancel.cancelled - base.cancel.cancelled).toBe(1);

      const interview = await data(`interview-conversion?${q}`);
      expect(interview.interviewsHeld - base.interview.interviewsHeld).toBe(2);
      expect(interview.confirmed - base.interview.confirmed).toBe(2);

      const replacement = await data(`replacement-rate?${q}`);
      expect(replacement.activeBookings - base.replacement.activeBookings).toBe(1);
      expect(replacement.replacementRequests - base.replacement.replacementRequests).toBe(1);

      const category = await data(`demand-by-category?${q}`);
      type Rows = { code: string; requests: number }[];
      const maid = (list: Rows) => list.find((c) => c.code === 'HOUSE_MAID')!.requests;
      expect(maid(category.categories as Rows) - maid(base.category.categories as Rows)).toBe(4);
      expect(category.total - base.category.total).toBe(4);

      const oracle = await api.prisma.$queryRaw<Array<{ requests: number }>>`
        SELECT count(*)::int AS requests FROM bookings
        WHERE (created_at AT TIME ZONE 'Asia/Kolkata')::date = ${today()}::date`;
      expect(funnel.requests).toBe(oracle[0].requests);

      const repeats = await get(`repeat-customers?${q}&limit=100`);
      const mine = repeats.body.data.find(
        (r: { customerUserId: string }) => r.customerUserId === repeaterId,
      );
      expect(mine).toMatchObject({ bookings: 4 });
      expect(repeats.body.meta.total).toBe(repeats.body.data.length);
      expect(Object.keys(mine as object).sort()).toEqual(['bookings', 'customerUserId', 'name']);
    });

    it('ranks area demand deterministically and paginates it', async () => {
      const q = TODAY_Q();
      const second = await createArea(api, admin);
      await makeBooking(api, admin, customer, second.id, 'MATCHED');
      const all = await get(`demand-by-area?${q}&limit=100`);
      const rows = all.body.data as Array<{ areaId: string; requests: number; name: string }>;
      expect(rows.length).toBeGreaterThanOrEqual(2);
      expect(all.body.meta.total).toBe(rows.length);
      const sorted = [...rows].sort(
        (a, b) => b.requests - a.requests || a.name.localeCompare(b.name),
      );
      expect(rows.map((r) => r.areaId)).toEqual(sorted.map((r) => r.areaId));
      const first = await get(`demand-by-area?${q}&limit=1&page=1`);
      const next = await get(`demand-by-area?${q}&limit=1&page=2`);
      expect(first.body.data).toHaveLength(1);
      expect(first.body.data[0].areaId).toBe(rows[0].areaId);
      expect(next.body.data[0].areaId).toBe(rows[1].areaId);
      expect(first.body.meta).toEqual({ page: 1, limit: 1, total: rows.length });
      const beyond = await get(`demand-by-area?${q}&limit=1&page=${rows.length + 5}`);
      expect(beyond.body.data).toEqual([]);
    });

    it('reports collections by period and fee type, and the refunded part separately', async () => {
      const q = TODAY_Q();
      const before = await data(`payment-collections?${q}`);
      const b = await makeBooking(api, admin, customer, area.id, 'PENDING_PAYMENT');
      await payForBooking(api, admin, customer, b.id);
      const after = await data(`payment-collections?${q}`);
      const sum = (d: typeof after) =>
        (d.totalsByFeeType as Array<{ grossMinor: number }>).reduce((s, t) => s + t.grossMinor, 0);
      expect(sum(after) - sum(before)).toBe(50000);
      const row = after.totalsByFeeType.find(
        (t: { feeCode: string }) => t.feeCode === 'BOOKING_FEE',
      );
      expect(row).toMatchObject({ currency: expect.any(String) });
      const oracle = await api.prisma.$queryRaw<Array<{ s: string }>>`
        SELECT COALESCE(sum(amount_minor),0)::text AS s FROM payments
        WHERE paid_at IS NOT NULL AND (paid_at AT TIME ZONE 'Asia/Kolkata')::date = ${today()}::date`;
      expect(sum(after)).toBe(Number(oracle[0].s));
    });

    it('measures support volume and average resolution time', async () => {
      const q = TODAY_Q();
      const before = await data(`support-tickets?${q}`);
      const category = await as(api, admin)
        .post('/api/v1/admin/support/categories', { code: `REPORT_${Date.now()}`, name: 'r' })
        .expect(201);
      const manager = await loginAdminWithPermissions(api, ['support.manage']);
      const ids: string[] = [];
      for (let i = 0; i < 3; i += 1) {
        ids.push(
          (
            await as(api, customer)
              .post('/api/v1/support/tickets', {
                categoryId: category.body.id as string,
                description: 'x',
              })
              .expect(201)
          ).body.id as string,
        );
      }
      await as(api, manager)
        .post(`/api/v1/admin/support/tickets/${ids[0]}/close`, { resolution: 'done' })
        .expect(200);
      const after = await data(`support-tickets?${q}`);
      expect(after.created - before.created).toBe(3);
      expect(after.closed - before.closed).toBe(1);
      const status = (d: typeof after, s: string) =>
        (d.byStatus as Array<{ status: string; count: number }>).find((x) => x.status === s)
          ?.count ?? 0;
      expect(status(after, 'OPEN') - status(before, 'OPEN')).toBe(2);
      expect(status(after, 'CLOSED') - status(before, 'CLOSED')).toBe(1);
      expect(after.averageResolutionSeconds).toEqual(expect.any(Number));
      expect(after.averageResolutionSeconds).toBeGreaterThanOrEqual(0);
    });

    it('ranks top-rated workers by average, then count, then id, and paginates', async () => {
      const mk = async (score: number) => {
        const b = await makeBooking(api, admin, customer, area.id, 'ACTIVE');
        await as(api, customer).post(`/api/v1/bookings/${b.id}/complete`).expect(200);
        await as(api, customer).post('/api/v1/ratings', { bookingId: b.id, score }).expect(201);
        return (await api.prisma.booking.findUniqueOrThrow({ where: { id: b.id } })).workerId!;
      };
      const five = await mk(5);
      const one = await mk(1);
      const res = await get('top-rated-workers?limit=100');
      expect(res.status).toBe(200);
      const rows = res.body.data as Array<{
        workerId: string;
        averageRating: number;
        ratingCount: number;
      }>;
      expect(rows.findIndex((r) => r.workerId === five)).toBeLessThan(
        rows.findIndex((r) => r.workerId === one),
      );
      for (let i = 1; i < rows.length; i += 1) {
        expect(rows[i - 1].averageRating).toBeGreaterThanOrEqual(rows[i].averageRating);
      }
      expect(res.body.meta.total).toBe(rows.length);
      const only = await get('top-rated-workers?limit=1&page=1');
      expect(only.body.data).toHaveLength(1);
      expect(only.body.data[0].workerId).toBe(rows[0].workerId);
      expect(Object.keys(rows[0]).sort()).toEqual([
        'averageRating',
        'name',
        'ratingCount',
        'workerId',
      ]);
      const strict = await get('top-rated-workers?limit=100&minRatings=2');
      expect(strict.body.data.every((r: { ratingCount: number }) => r.ratingCount >= 2)).toBe(true);
    });

    it('relates registered workers to verified ones and reports utilization as a snapshot', async () => {
      const q = TODAY_Q();
      const before = await data(`worker-registrations?${q}`);
      await makeBooking(api, admin, customer, area.id, 'ACTIVE'); // a verified, registered worker with an active booking
      const after = await data(`worker-registrations?${q}`);
      expect(after.registered - before.registered).toBe(1);
      expect(after.verified - before.verified).toBe(1);
      expect(after.verificationConversion).toBeLessThanOrEqual(1);
      const utilization = await data('worker-utilization');
      expect(utilization.workersWithActiveBooking).toBeGreaterThanOrEqual(1);
      expect(utilization.verifiedWorkers as number).toBeGreaterThanOrEqual(
        utilization.workersWithActiveBooking as number,
      );
      expect(utilization.utilization).toBe(
        Math.round((utilization.workersWithActiveBooking / utilization.verifiedWorkers) * 10000) /
          10000,
      );
      const res = await get('worker-utilization');
      expect(res.body.from).toBeNull();
    });
  });

  describe('read-only behaviour', () => {
    it('refuses every verb except GET', async () => {
      for (const method of ['post', 'put', 'patch', 'delete'] as const) {
        const res = await api
          .http()
          [method](`${R}/booking-funnel`)
          .set('Authorization', `Bearer ${admin.accessToken}`)
          .send({});
        expect(res.status).toBe(404);
      }
    });

    it('cannot write even if a query tried: the transaction is READ ONLY in PostgreSQL', async () => {
      const repo = api.app.get(ReportsRepository);
      await expect(
        repo.readOnly((db) => db.$executeRaw`UPDATE users SET status = status WHERE false`),
      ).rejects.toThrow(/read-only/i);
      await expect(
        repo.readOnly(
          (db) =>
            db.$executeRaw`INSERT INTO service_areas (id, name, city, updated_at) VALUES (gen_random_uuid(), 'x', 'y', now())`,
        ),
      ).rejects.toThrow(/read-only/i);
    });

    it('leaves the data untouched after running every report', async () => {
      const count = async () =>
        (
          await api.prisma.$queryRaw<Array<{ n: number }>>`
          SELECT ((SELECT count(*) FROM users) + (SELECT count(*) FROM bookings) + (SELECT count(*) FROM payments)
                + (SELECT count(*) FROM audit_logs WHERE action NOT LIKE 'security.%'))::int AS n`
        )[0].n;
      const before = await count();
      const q = TODAY_Q();
      for (const path of [
        `new-customers?${q}`,
        `worker-registrations?${q}`,
        `booking-funnel?${q}`,
        `demand-by-category?${q}`,
        `demand-by-area?${q}`,
        'worker-utilization',
        `interview-conversion?${q}`,
        `cancellation-rate?${q}`,
        `replacement-rate?${q}`,
        `payment-collections?${q}`,
        `support-tickets?${q}`,
        'top-rated-workers',
        `repeat-customers?${q}`,
      ]) {
        expect((await get(path)).status).toBe(200);
      }
      expect(await count()).toBe(before);
    });

    it('uses exactly one read-only transaction per report, whatever the size of the range', async () => {
      const spy = jest.spyOn(api.app.get(ReportsRepository), 'readOnly');
      await get('booking-funnel?from=2026-01-01&to=2026-12-31');
      await get('new-customers?from=2026-10-01&to=2026-10-01');
      await get('demand-by-area?from=2026-01-01&to=2026-12-31&limit=100');
      expect(spy).toHaveBeenCalledTimes(3);
      spy.mockRestore();
    });
  });
});
