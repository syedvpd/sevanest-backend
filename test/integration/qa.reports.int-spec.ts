import '../support/env-api-integration';
import { Prisma } from '../../src/generated/prisma/client';
import {
  ApiApp,
  createApiApp,
  loginAdmin,
  loginAdminWithPermissions,
  loginWithOtp,
} from '../support/api-app';
import { makeBooking } from '../support/bookings';
import { as, createArea, setRequiredChecks } from '../support/workforce';

/**
 * QA: every report is recomputed with independent SQL written from the published definition (not from the report code),
 * for a window that includes today. The database is shared with other tests, so the SQL is the reference, not a constant.
 */
describe('QA - reports against independent SQL (integration)', () => {
  let api: ApiApp;
  let admin: Awaited<ReturnType<typeof loginAdmin>>;
  let today: string;

  const win = (): Prisma.Sql => Prisma.sql`(${today}::date)::timestamp AT TIME ZONE 'Asia/Kolkata'`;
  const winEnd = (): Prisma.Sql =>
    Prisma.sql`((${today}::date) + 1)::timestamp AT TIME ZONE 'Asia/Kolkata'`;
  const one = async <T>(query: Prisma.Sql): Promise<T> =>
    (await api.prisma.$queryRaw<T[]>(query))[0];
  const report = async (
    name: string,
    extra = '',
  ): Promise<{ data: Record<string, unknown> & { series?: unknown[] }; definition: string }> => {
    const res = await as(api, admin).get(
      `/api/v1/admin/reports/${name}?from=${today}&to=${today}${extra}`,
    );
    expect([name, res.status]).toEqual([name, 200]);
    return res.body as never;
  };

  beforeAll(async () => {
    api = await createApiApp();
    admin = await loginAdmin(api);
    today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date());
    // Make sure the window holds a confirmed, an active, a cancelled, a replaced and a refunded booking.
    const area = await createArea(api, admin);
    await setRequiredChecks(api, admin, ['IDENTITY']);
    const customer = await loginWithOtp(api, { appType: 'CUSTOMER' });
    const active = await makeBooking(api, admin, customer, area.id, 'ACTIVE');
    const cancelled = await makeBooking(api, admin, customer, area.id, 'MATCHED');
    await as(api, customer)
      .post(`/api/v1/bookings/${cancelled.id}/cancel`, { reason: 'qa' })
      .expect(200);
    await as(api, customer)
      .post('/api/v1/replacement-requests', { bookingId: active.id, reason: 'qa' })
      .expect(201);
    const payment = await api.prisma.payment.findFirstOrThrow({ where: { bookingId: active.id } });
    const refunder = await loginAdminWithPermissions(api, ['payment.refund']);
    await as(api, refunder)
      .post(`/api/v1/admin/payments/${payment.id}/refund`, { reason: 'qa' })
      .expect(200);
  }, 120_000);

  afterAll(async () => {
    await setRequiredChecks(api, admin, []);
    await api.close();
  });

  it('new-customers = customer accounts created in the window', async () => {
    const sql = await one<{ n: bigint }>(
      Prisma.sql`SELECT count(*) AS n FROM users WHERE type = 'CUSTOMER' AND created_at >= ${win()} AND created_at < ${winEnd()}`,
    );
    const r = await report('new-customers');
    expect(r.data.total).toBe(Number(sql.n));
    expect((r.data.series as Array<{ count: number }>).reduce((s, p) => s + p.count, 0)).toBe(
      Number(sql.n),
    );
  });

  it('worker-registrations = worker profiles created, and how many of them are fully verified now', async () => {
    const registered = await one<{ n: bigint }>(
      Prisma.sql`SELECT count(*) AS n FROM worker_profiles WHERE created_at >= ${win()} AND created_at < ${winEnd()}`,
    );
    const verified = await one<{ n: bigint }>(Prisma.sql`
      SELECT count(*) AS n FROM worker_profiles wp
      WHERE wp.created_at >= ${win()} AND wp.created_at < ${winEnd()}
        AND EXISTS (SELECT 1 FROM verification_requirements)
        AND NOT EXISTS (SELECT 1 FROM verification_requirements vr WHERE NOT EXISTS (
          SELECT 1 FROM worker_verification_checks c WHERE c.worker_id = wp.id AND c.check_type = vr.check_type
            AND c.status = 'APPROVED' AND (c.recheck_at IS NULL OR c.recheck_at > (now() AT TIME ZONE 'Asia/Kolkata')::date)))`);
    const r = await report('worker-registrations');
    expect(r.data.registered).toBe(Number(registered.n));
    expect(r.data.verified).toBe(Number(verified.n));
  });

  it('booking-funnel, demand-by-category, cancellation-rate, interview-conversion and replacement-rate agree with the booking tables', async () => {
    const base = Prisma.sql`b.created_at >= ${win()} AND b.created_at < ${winEnd()}`;
    const everReached = (status: string): Prisma.Sql =>
      Prisma.sql`EXISTS (SELECT 1 FROM booking_events e WHERE e.booking_id = b.id AND e.to_status = ${status}::"BookingStatus")`;
    const requests = await one<{ n: bigint }>(
      Prisma.sql`SELECT count(*) AS n FROM bookings b WHERE ${base}`,
    );
    const confirmed = await one<{ n: bigint }>(
      Prisma.sql`SELECT count(*) AS n FROM bookings b WHERE ${base} AND ${everReached('CONFIRMED')}`,
    );
    const cancelled = await one<{ n: bigint }>(
      Prisma.sql`SELECT count(*) AS n FROM bookings b WHERE ${base} AND b.status = 'CANCELLED'`,
    );
    const held = await one<{ n: bigint }>(
      Prisma.sql`SELECT count(*) AS n FROM bookings b WHERE ${base} AND ${everReached('INTERVIEW_TRIAL_COMPLETED')}`,
    );
    const heldConfirmed = await one<{ n: bigint }>(
      Prisma.sql`SELECT count(*) AS n FROM bookings b WHERE ${base} AND ${everReached('INTERVIEW_TRIAL_COMPLETED')} AND ${everReached('CONFIRMED')}`,
    );
    const active = await one<{ n: bigint }>(
      Prisma.sql`SELECT count(*) AS n FROM bookings b WHERE ${base} AND ${everReached('ACTIVE')}`,
    );
    const replacements = await one<{ n: bigint }>(
      Prisma.sql`SELECT count(*) AS n FROM replacement_requests r JOIN bookings b ON b.id = r.booking_id WHERE ${base} AND ${everReached('ACTIVE')}`,
    );
    const maid = await one<{ n: bigint }>(
      Prisma.sql`SELECT count(*) AS n FROM bookings b JOIN service_categories c ON c.id = b.category_id WHERE ${base} AND c.code = 'HOUSE_MAID'`,
    );

    const funnel = await report('booking-funnel');
    expect(funnel.data.requests).toBe(Number(requests.n));
    expect(funnel.data.confirmed).toBe(Number(confirmed.n));
    const cancel = await report('cancellation-rate');
    expect(cancel.data).toMatchObject({
      totalBookings: Number(requests.n),
      cancelled: Number(cancelled.n),
    });
    const interview = await report('interview-conversion');
    expect(interview.data).toMatchObject({
      interviewsHeld: Number(held.n),
      confirmed: Number(heldConfirmed.n),
    });
    const replacement = await report('replacement-rate');
    expect(replacement.data).toMatchObject({
      activeBookings: Number(active.n),
      replacementRequests: Number(replacements.n),
    });
    const category = await report('demand-by-category');
    expect(category.data.total).toBe(Number(requests.n));
    const row = (category.data.categories as Array<{ code: string; requests: number }>).find(
      (c) => c.code === 'HOUSE_MAID',
    )!;
    expect(row.requests).toBe(Number(maid.n));
    // No booking is counted twice across categories.
    expect(
      (category.data.categories as Array<{ requests: number }>).reduce((s, c) => s + c.requests, 0),
    ).toBe(Number(requests.n));
    expect(Number(held.n)).toBeGreaterThan(0);
    expect(Number(cancelled.n)).toBeGreaterThan(0);
  });

  it('demand-by-area and repeat-customers rank the same rows the tables hold', async () => {
    const areas = await api.prisma.$queryRaw<Array<{ area_id: string; n: bigint }>>(Prisma.sql`
      SELECT b.area_id, count(*) AS n FROM bookings b WHERE b.created_at >= ${win()} AND b.created_at < ${winEnd()}
      GROUP BY b.area_id ORDER BY n DESC, b.area_id ASC LIMIT 5`);
    const r = (
      await as(api, admin).get(
        `/api/v1/admin/reports/demand-by-area?from=${today}&to=${today}&limit=5`,
      )
    ).body as { data: Array<{ areaId: string; requests: number }> };
    expect(r.data.map((a) => [a.areaId, a.requests])).toEqual(
      areas.map((a) => [a.area_id, Number(a.n)]),
    );
    const repeat = await one<{ n: bigint }>(
      Prisma.sql`SELECT count(*) AS n FROM (SELECT customer_user_id FROM bookings b WHERE b.created_at >= ${win()} AND b.created_at < ${winEnd()} GROUP BY customer_user_id HAVING count(*) > 1) s`,
    );
    const res = (
      await as(api, admin).get(
        `/api/v1/admin/reports/repeat-customers?from=${today}&to=${today}&limit=100`,
      )
    ).body as { meta: { total: number } };
    expect(res.meta.total).toBe(Number(repeat.n));
  });

  it('payment-collections = payments paid in the window, gross and refunded, by fee type', async () => {
    const sql = await one<{ n: bigint; gross: bigint; refunded: bigint }>(Prisma.sql`
      SELECT count(*) AS n, coalesce(sum(amount_minor), 0) AS gross,
             coalesce(sum(amount_minor) FILTER (WHERE status = 'REFUNDED'), 0) AS refunded
      FROM payments WHERE paid_at >= ${win()} AND paid_at < ${winEnd()} AND fee_code = 'BOOKING_FEE'`);
    const r = await report('payment-collections');
    const row = (
      r.data.totalsByFeeType as Array<{
        feeCode: string;
        payments: number;
        grossMinor: number;
        refundedMinor: number;
      }>
    ).find((t) => t.feeCode === 'BOOKING_FEE')!;
    expect(row).toMatchObject({
      payments: Number(sql.n),
      grossMinor: Number(sql.gross),
      refundedMinor: Number(sql.refunded),
    });
    expect(Number(sql.refunded)).toBeGreaterThan(0);
  });

  it('support-tickets = tickets created in the window by status, with the average time to closure', async () => {
    const created = await one<{ n: bigint }>(
      Prisma.sql`SELECT count(*) AS n FROM support_tickets WHERE created_at >= ${win()} AND created_at < ${winEnd()}`,
    );
    const byStatus = await api.prisma.$queryRaw<Array<{ status: string; n: bigint }>>(
      Prisma.sql`SELECT status::text AS status, count(*) AS n FROM support_tickets WHERE created_at >= ${win()} AND created_at < ${winEnd()} GROUP BY status`,
    );
    const avg = await one<{ avg: number | null }>(
      Prisma.sql`SELECT avg(extract(epoch FROM (closed_at - created_at)))::float8 AS avg FROM support_tickets WHERE created_at >= ${win()} AND created_at < ${winEnd()} AND closed_at IS NOT NULL`,
    );
    const r = await report('support-tickets');
    expect(r.data.created).toBe(Number(created.n));
    const got = Object.fromEntries(
      (r.data.byStatus as Array<{ status: string; count: number }>).map((s) => [s.status, s.count]),
    );
    expect(got).toEqual(Object.fromEntries(byStatus.map((s) => [s.status, Number(s.n)])));
    if (avg.avg !== null)
      expect(Math.abs((r.data.averageResolutionSeconds as number) - avg.avg)).toBeLessThan(1);
  });

  it('worker-utilization and top-rated-workers follow their definitions', async () => {
    const verified = await one<{ n: bigint }>(Prisma.sql`
      SELECT count(*) AS n FROM worker_profiles wp JOIN users u ON u.id = wp.user_id
      WHERE wp.onboarding_status = 'SUBMITTED' AND u.status = 'ACTIVE' AND EXISTS (SELECT 1 FROM verification_requirements)
        AND NOT EXISTS (SELECT 1 FROM verification_requirements vr WHERE NOT EXISTS (
          SELECT 1 FROM worker_verification_checks c WHERE c.worker_id = wp.id AND c.check_type = vr.check_type
            AND c.status = 'APPROVED' AND (c.recheck_at IS NULL OR c.recheck_at > (now() AT TIME ZONE 'Asia/Kolkata')::date)))`);
    const util = (await as(api, admin).get('/api/v1/admin/reports/worker-utilization')).body as {
      data: { verifiedWorkers: number; workersWithActiveBooking: number };
    };
    expect(util.data.verifiedWorkers).toBe(Number(verified.n));
    expect(util.data.workersWithActiveBooking).toBeLessThanOrEqual(util.data.verifiedWorkers);
    const top = (await as(api, admin).get('/api/v1/admin/reports/top-rated-workers?limit=20'))
      .body as { data: Array<{ workerId: string; ratingCount: number; averageRating: number }> };
    const sql = await api.prisma.$queryRaw<
      Array<{ worker_id: string; c: number; avg: number }>
    >(Prisma.sql`
      SELECT worker_id, rating_count AS c, (rating_sum::float8 / rating_count) AS avg FROM worker_rating_summaries
      WHERE rating_count > 0 ORDER BY avg DESC, rating_count DESC, worker_id ASC LIMIT 20`);
    expect(top.data.map((t) => t.workerId)).toEqual(sql.map((s) => s.worker_id));
  });

  it('is read-only: running every report changes no row anywhere', async () => {
    const tables = [
      'users',
      'bookings',
      'payments',
      'worker_profiles',
      'support_tickets',
      'ratings',
      'replacement_requests',
    ];
    const counts = async () =>
      Promise.all(
        tables.map(async (t) =>
          Number(
            (
              await api.prisma.$queryRawUnsafe<Array<{ n: bigint }>>(
                `SELECT count(*) AS n FROM ${t}`,
              )
            )[0].n,
          ),
        ),
      );
    const audit = () =>
      api.prisma.auditLog.count({ where: { action: { not: 'security.access_denied' } } });
    const before = [await counts(), await audit()];
    for (const r of [
      'new-customers',
      'worker-registrations',
      'booking-funnel',
      'demand-by-category',
      'demand-by-area',
      'interview-conversion',
      'cancellation-rate',
      'replacement-rate',
      'payment-collections',
      'support-tickets',
      'repeat-customers',
    ])
      await report(r);
    await as(api, admin).get('/api/v1/admin/reports/worker-utilization').expect(200);
    await as(api, admin).get('/api/v1/admin/reports/top-rated-workers').expect(200);
    expect([await counts(), await audit()]).toEqual(before);
  });
});
