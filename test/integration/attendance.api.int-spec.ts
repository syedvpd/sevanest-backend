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

const UNKNOWN_ID = '00000000-0000-7000-8000-000000000000';
const daysAgo = (n: number): string =>
  new Date(Date.now() - n * 86400000).toISOString().slice(0, 10);
const today = (): string =>
  new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date());

/** Attendance against the REAL PostgreSQL + Redis (dedicated test database), through the HTTP API. */
describe('Attendance API (integration)', () => {
  let api: ApiApp;
  let admin: Awaited<ReturnType<typeof loginAdmin>>;
  let area: { id: string };
  let customer: Awaited<ReturnType<typeof loginWithOtp>> & { userId: string };

  const wPath = (id: string) => `/api/v1/workers/me/attendance/bookings/${id}`;
  const cPath = (id: string) => `/api/v1/attendance/bookings/${id}`;
  const aPath = (id: string) => `/api/v1/admin/attendance/bookings/${id}`;

  /** An ACTIVE booking whose service started five days ago. */
  async function active(): Promise<TestBooking> {
    const booking = await makeBooking(api, admin, customer, area.id, 'ACTIVE');
    await api.prisma
      .$executeRaw`UPDATE bookings SET start_date = ${daysAgo(5)}::date WHERE id = ${booking.id}::uuid`;
    return booking;
  }

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

  describe('worker', () => {
    it("records today's status once, repeats safely, and cannot change a recorded day", async () => {
      const b = await active();
      const first = await as(api, b.worker).post(wPath(b.id), { status: 'PRESENT' });
      expect(first.status).toBe(201);
      expect(first.body).toMatchObject({
        bookingId: b.id,
        date: today(),
        status: 'PRESENT',
        recordedBy: 'WORKER',
        note: null,
      });
      const again = await as(api, b.worker).post(wPath(b.id), { status: 'PRESENT' });
      expect(again.status).toBe(201);
      expect(again.body.id).toBe(first.body.id);
      const change = await as(api, b.worker).post(wPath(b.id), { status: 'ABSENT' });
      expect(change.status).toBe(409);
      expect(change.body.code).toBe('ATTENDANCE_ALREADY_RECORDED');
      expect(await api.prisma.attendanceRecord.count({ where: { bookingId: b.id } })).toBe(1);
      expect(
        await api.prisma.attendanceEvent.count({ where: { record: { bookingId: b.id } } }),
      ).toBe(1);
    });

    it('needs a note for an exception and rejects unknown statuses and a self-chosen date', async () => {
      const b = await active();
      expect((await as(api, b.worker).post(wPath(b.id), { status: 'EXCEPTION' })).status).toBe(400);
      expect((await as(api, b.worker).post(wPath(b.id), { status: 'LATE' })).status).toBe(400);
      expect((await as(api, b.worker).post(wPath(b.id), {})).status).toBe(400);
      const ok = await as(api, b.worker).post(wPath(b.id), {
        status: 'EXCEPTION',
        note: 'Family emergency',
        date: '2020-01-01',
      });
      expect(ok.status).toBe(201);
      expect(ok.body.date).toBe(today());
    });

    it('works only on the worker own booking, and only while the service is active', async () => {
      const b = await active();
      const other = await makeBooking(api, admin, customer, area.id, 'ACTIVE');
      expect((await as(api, other.worker).post(wPath(b.id), { status: 'PRESENT' })).status).toBe(
        404,
      );
      expect((await as(api, other.worker).get(wPath(b.id))).status).toBe(404);
      expect((await as(api, b.worker).post(wPath(UNKNOWN_ID), { status: 'PRESENT' })).status).toBe(
        404,
      );
      expect((await as(api, b.worker).post(wPath('nope'), { status: 'PRESENT' })).status).toBe(400);
      expect((await as(api, customer).post(wPath(b.id), { status: 'PRESENT' })).status).toBe(403);
      expect((await as(api, admin).post(wPath(b.id), { status: 'PRESENT' })).status).toBe(403);
      expect((await api.http().post(wPath(b.id)).send({ status: 'PRESENT' })).status).toBe(401);
      const notStarted = await makeBooking(api, admin, customer, area.id, 'CONFIRMED');
      const res = await as(api, notStarted.worker).post(wPath(notStarted.id), {
        status: 'PRESENT',
      });
      expect(res.status).toBe(409);
      expect(res.body.code).toBe('BOOKING_NOT_ACTIVE');
      expect(await api.prisma.attendanceRecord.count({ where: { bookingId: b.id } })).toBe(0);
    });

    it('records one entry when the same day is submitted many times at once, and lets one of two conflicting statuses win', async () => {
      const b = await active();
      const same = await Promise.all(
        Array.from({ length: 6 }, () => as(api, b.worker).post(wPath(b.id), { status: 'PRESENT' })),
      );
      expect(same.every((r) => [200, 201].includes(r.status))).toBe(true);
      expect(await api.prisma.attendanceRecord.count({ where: { bookingId: b.id } })).toBe(1);
      expect(
        await api.prisma.attendanceEvent.count({ where: { record: { bookingId: b.id } } }),
      ).toBe(1);

      const c = await active();
      const mixed = await Promise.all([
        ...Array.from({ length: 3 }, () =>
          as(api, c.worker).post(wPath(c.id), { status: 'PRESENT' }),
        ),
        ...Array.from({ length: 3 }, () =>
          as(api, c.worker).post(wPath(c.id), { status: 'ABSENT' }),
        ),
      ]);
      expect(mixed.every((r) => [200, 201, 409].includes(r.status))).toBe(true);
      const rows = await api.prisma.attendanceRecord.findMany({ where: { bookingId: c.id } });
      expect(rows).toHaveLength(1);
      const winner = rows[0].status;
      expect(mixed.filter((r) => r.status === 409).length).toBe(winner === 'PRESENT' ? 3 : 3);
    });
  });

  describe('customer', () => {
    it('sees exactly what the worker recorded, and nobody else does', async () => {
      const b = await active();
      await as(api, b.worker).post(wPath(b.id), { status: 'PRESENT' }).expect(201);
      const mine = await as(api, customer).get(cPath(b.id)).expect(200);
      const theirs = await as(api, b.worker).get(wPath(b.id)).expect(200);
      expect(mine.body.data).toEqual(theirs.body.data);
      expect(mine.body.data[0]).toMatchObject({
        date: today(),
        status: 'PRESENT',
        recordedBy: 'WORKER',
      });
      expect(Object.keys(mine.body.data[0] as object).sort()).toEqual([
        'bookingId',
        'date',
        'id',
        'note',
        'recordedBy',
        'status',
        'updatedAt',
      ]);
      const stranger = await loginWithOtp(api, { appType: 'CUSTOMER' });
      expect((await as(api, stranger).get(cPath(b.id))).status).toBe(404);
      expect(
        (await as(api, stranger).post(`${cPath(b.id)}/exceptions`, { date: today(), note: 'x' }))
          .status,
      ).toBe(404);
      expect((await as(api, b.worker).get(cPath(b.id))).status).toBe(403);
    });

    it('raises an exception for a missed day, once, within the service period', async () => {
      const b = await active();
      const res = await as(api, customer).post(`${cPath(b.id)}/exceptions`, {
        date: daysAgo(2),
        note: 'Worker did not come',
      });
      expect(res.status).toBe(201);
      expect(res.body).toMatchObject({
        status: 'EXCEPTION',
        date: daysAgo(2),
        recordedBy: 'CUSTOMER',
        note: 'Worker did not come',
      });
      expect(
        (
          await as(api, customer).post(`${cPath(b.id)}/exceptions`, {
            date: daysAgo(2),
            note: 'Worker did not come',
          })
        ).status,
      ).toBe(201);
      expect(
        (
          await as(api, customer).post(`${cPath(b.id)}/exceptions`, {
            date: daysAgo(2),
            note: 'different text',
          })
        ).status,
      ).toBe(409);
      // The worker can no longer record a different status on that day.
      const future = new Date(Date.now() + 3 * 86400000).toISOString().slice(0, 10);
      for (const [date, status] of [
        [future, 422],
        [daysAgo(30), 422],
        ['2026-02-30', 400],
        ['yesterday', 400],
      ] as const) {
        expect(
          (await as(api, customer).post(`${cPath(b.id)}/exceptions`, { date, note: 'x' })).status,
        ).toBe(status);
      }
      expect(
        (await as(api, customer).post(`${cPath(b.id)}/exceptions`, { date: today() })).status,
      ).toBe(400);
    });

    it('cannot record attendance as a status other than an exception', async () => {
      const b = await active();
      const res = await as(api, customer).post(`${cPath(b.id)}/exceptions`, {
        date: today(),
        note: 'x',
        status: 'PRESENT',
      });
      expect(res.status).toBe(201);
      expect(res.body.status).toBe('EXCEPTION');
    });
  });

  describe('admin', () => {
    it('records on behalf of the worker, corrects with a reason, and keeps the history', async () => {
      const b = await active();
      await as(api, b.worker).post(wPath(b.id), { status: 'PRESENT' }).expect(201);
      const entry = (await as(api, customer).get(cPath(b.id))).body.data[0];
      const fixed = await as(api, admin).patch(`/api/v1/admin/attendance/${entry.id}`, {
        status: 'ABSENT',
        reason: 'Customer confirmed by phone',
      });
      expect(fixed.status).toBe(200);
      expect(fixed.body.status).toBe('ABSENT');
      expect(fixed.body.history.map((h: { to: string }) => h.to)).toEqual(['PRESENT', 'ABSENT']);
      expect(fixed.body.history[1]).toMatchObject({
        from: 'PRESENT',
        reason: 'Customer confirmed by phone',
        actorUserId: admin.userId,
        actorKind: 'ADMIN',
      });
      // Both parties now see the corrected status, still attributed to the original recorder.
      const seen = (await as(api, b.worker).get(wPath(b.id))).body.data[0];
      expect(seen).toMatchObject({ status: 'ABSENT', recordedBy: 'WORKER' });
      expect(JSON.stringify(seen)).not.toContain('Customer confirmed by phone');
      // Correcting to what it already is changes nothing.
      const same = await as(api, admin).patch(`/api/v1/admin/attendance/${entry.id}`, {
        status: 'ABSENT',
        reason: 'again',
      });
      expect(same.body.history).toHaveLength(2);
      expect(
        await api.prisma.auditLog.count({
          where: { entityId: entry.id, action: 'attendance.correct' },
        }),
      ).toBe(1);
      expect(
        (await as(api, admin).patch(`/api/v1/admin/attendance/${entry.id}`, { status: 'PRESENT' }))
          .status,
      ).toBe(400);
      expect(
        (
          await as(api, admin).patch(`/api/v1/admin/attendance/${entry.id}`, {
            status: 'EXCEPTION',
            reason: 'x',
          })
        ).status,
      ).toBe(400);
      expect(
        (
          await as(api, admin).patch(`/api/v1/admin/attendance/${UNKNOWN_ID}`, {
            status: 'PRESENT',
            reason: 'x',
          })
        ).status,
      ).toBe(404);

      const other = await as(api, admin).post(aPath(b.id), { date: daysAgo(1), status: 'PRESENT' });
      expect(other.status).toBe(201);
      expect(other.body.recordedBy).toBe('ADMIN');
      const list = await as(api, admin).get(aPath(b.id)).expect(200);
      expect(list.body.data.map((r: { date: string }) => r.date)).toEqual([today(), daysAgo(1)]);
    });

    it('keeps view and manage separate and refuses everyone else', async () => {
      const b = await active();
      const viewer = await loginAdminWithPermissions(api, ['attendance.view']);
      const manager = await loginAdminWithPermissions(api, ['attendance.manage']);
      expect((await as(api, viewer).get(aPath(b.id))).status).toBe(200);
      expect((await as(api, manager).get(aPath(b.id))).status).toBe(403);
      expect(
        (await as(api, viewer).post(aPath(b.id), { date: today(), status: 'PRESENT' })).status,
      ).toBe(403);
      expect(
        (await as(api, manager).post(aPath(b.id), { date: today(), status: 'PRESENT' })).status,
      ).toBe(201);
      expect((await as(api, b.worker).get(aPath(b.id))).status).toBe(403);
      expect((await as(api, customer).get(aPath(b.id))).status).toBe(403);
      expect((await api.http().get(aPath(b.id))).status).toBe(401);
      expect(
        (await as(api, manager).post(aPath(UNKNOWN_ID), { date: today(), status: 'PRESENT' }))
          .status,
      ).toBe(404);
      expect(
        (await as(api, manager).post(aPath(b.id), { date: '2999-01-01', status: 'PRESENT' }))
          .status,
      ).toBe(422);
    });

    it('can still correct an entry after the service ended, but nobody can add one', async () => {
      const b = await active();
      await as(api, b.worker).post(wPath(b.id), { status: 'PRESENT' }).expect(201);
      await as(api, customer).post(`/api/v1/bookings/${b.id}/complete`).expect(200);
      expect((await as(api, b.worker).post(wPath(b.id), { status: 'PRESENT' })).status).toBe(409);
      const entry = (await as(api, customer).get(cPath(b.id))).body.data[0];
      expect(
        (
          await as(api, admin).patch(`/api/v1/admin/attendance/${entry.id}`, {
            status: 'ABSENT',
            reason: 'late fix',
          })
        ).status,
      ).toBe(200);
      const res = await as(api, admin).post(aPath(b.id), { date: daysAgo(1), status: 'PRESENT' });
      expect(res.status).toBe(409);
      expect(res.body.code).toBe('BOOKING_NOT_ACTIVE');
    });
  });

  describe('listing and the database', () => {
    it('pages newest first, filters by date, and bounds the input', async () => {
      const b = await active();
      for (const n of [4, 3, 2, 1]) {
        await as(api, admin)
          .post(aPath(b.id), { date: daysAgo(n), status: 'PRESENT' })
          .expect(201);
      }
      const page1 = await as(api, customer)
        .get(`${cPath(b.id)}?limit=2&page=1`)
        .expect(200);
      const page2 = await as(api, customer)
        .get(`${cPath(b.id)}?limit=2&page=2`)
        .expect(200);
      expect(page1.body.meta).toEqual({ page: 1, limit: 2, total: 4 });
      expect([...page1.body.data, ...page2.body.data].map((r: { date: string }) => r.date)).toEqual(
        [daysAgo(1), daysAgo(2), daysAgo(3), daysAgo(4)],
      );
      const ranged = await as(api, customer)
        .get(`${cPath(b.id)}?from=${daysAgo(3)}&to=${daysAgo(2)}`)
        .expect(200);
      expect(ranged.body.data).toHaveLength(2);
      for (const bad of [
        'limit=101',
        'from=2026-02-30',
        'to=x',
        `from=${daysAgo(1)}&to=${daysAgo(3)}`,
      ]) {
        expect((await as(api, customer).get(`${cPath(b.id)}?${bad}`)).status).toBe(400);
      }
    });

    it('rejects a second entry for a day, an unexplained exception, and any change to the history', async () => {
      const b = await active();
      await as(api, b.worker).post(wPath(b.id), { status: 'PRESENT' }).expect(201);
      const record = await api.prisma.attendanceRecord.findFirstOrThrow({
        where: { bookingId: b.id },
      });
      const run = (sql: string) => api.prisma.$executeRawUnsafe(sql);
      await expect(
        run(
          `INSERT INTO attendance_records (id, booking_id, worker_id, date, status, recorded_by_user_id, recorded_by_kind, updated_at) VALUES (gen_random_uuid(), '${b.id}', '${record.workerId}', '${today()}', 'ABSENT', '${record.recordedByUserId}', 'ADMIN', now())`,
        ),
      ).rejects.toThrow();
      await expect(
        run(
          `UPDATE attendance_records SET status = 'EXCEPTION', note = NULL WHERE id = '${record.id}'`,
        ),
      ).rejects.toThrow();
      const event = await api.prisma.attendanceEvent.findFirstOrThrow({
        where: { recordId: record.id },
      });
      await expect(
        run(`UPDATE attendance_events SET reason = 'x' WHERE id = '${event.id}'`),
      ).rejects.toThrow(/append-only/);
      await expect(run(`DELETE FROM attendance_events WHERE id = '${event.id}'`)).rejects.toThrow(
        /append-only/,
      );
    });
  });
});
