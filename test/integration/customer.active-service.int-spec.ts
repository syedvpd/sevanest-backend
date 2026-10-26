import '../support/env-api-integration';
import { ApiApp, createApiApp, loginAdmin, loginWithOtp } from '../support/api-app';
import { makeBooking } from '../support/bookings';
import { indiaToday } from '../../src/common/time/india';
import { as, createArea, setRequiredChecks } from '../support/workforce';

const A = '/api/v1/attendance/bookings';
const W = '/api/v1/workers/me/attendance/bookings';
const ADMIN = '/api/v1/admin/attendance';
const UNKNOWN_ID = '00000000-0000-7000-8000-000000000000';

const day = (offset: number): string => {
  const d = new Date(`${indiaToday()}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + offset);
  return d.toISOString().slice(0, 10);
};

/**
 * Customer Active Service screen (D-76, D-77, D-78..): attendance access, the extra states and check-in/out, the scheduled window,
 * worker identity, and the customer missing-day exception. Everything runs through the real HTTP API on the test database with
 * test-issued tokens; nothing touches a hosted database.
 */
describe('Customer active service and attendance (integration)', () => {
  let api: ApiApp;
  let admin: Awaited<ReturnType<typeof loginAdmin>>;
  let area: { id: string };
  let customer: Awaited<ReturnType<typeof loginWithOtp>> & { userId: string };
  let stranger: Awaited<ReturnType<typeof loginWithOtp>> & { userId: string };
  let active: Awaited<ReturnType<typeof makeBooking>>;
  let completed: Awaited<ReturnType<typeof makeBooking>>;
  let others: Awaited<ReturnType<typeof makeBooking>>;

  /** A repeatable fixture: one customer with an ACTIVE booking that has several entries, a COMPLETED booking, and someone else's booking. */
  beforeAll(async () => {
    api = await createApiApp();
    admin = await loginAdmin(api);
    area = await createArea(api, admin);
    await setRequiredChecks(api, admin, ['IDENTITY']);
    customer = await loginWithOtp(api, { appType: 'CUSTOMER' });
    stranger = await loginWithOtp(api, { appType: 'CUSTOMER' });

    active = await makeBooking(api, admin, customer, area.id, 'ACTIVE');
    await api.prisma.workerProfile.update({
      where: { id: active.worker.workerId },
      data: { name: 'Anjali Verma' },
    });
    await api.prisma.booking.update({
      where: { id: active.id },
      data: { startDate: new Date(`${day(-6)}T00:00:00.000Z`) },
    });
    const record = (date: string, status: string, note?: string) =>
      as(api, admin).post(`${ADMIN}/bookings/${active.id}`, {
        date,
        status,
        ...(note ? { note } : {}),
      });
    await record(day(-6), 'PRESENT').then((r) => expect(r.status).toBe(201));
    await record(day(-5), 'PRESENT').then((r) => expect(r.status).toBe(201));
    await record(day(-4), 'LATE', 'Bus delay').then((r) => expect(r.status).toBe(201));
    await record(day(-3), 'ABSENT').then((r) => expect(r.status).toBe(201));
    await record(day(-2), 'LEAVE', 'Family function').then((r) => expect(r.status).toBe(201));
    // day(-1) is left empty on purpose: the missing day a customer may report

    completed = await makeBooking(api, admin, customer, area.id, 'ACTIVE');
    await as(api, customer).post(`/api/v1/bookings/${completed.id}/complete`).expect(200);
    others = await makeBooking(api, admin, stranger, area.id, 'ACTIVE');
  });

  afterAll(async () => {
    await setRequiredChecks(api, admin, []);
    await api.close();
  });

  describe('1. a customer reads the attendance of their own bookings only', () => {
    it('lists the rows newest first with every field, and the month summary counts each status', async () => {
      const list = await as(api, customer).get(`${A}/${active.id}`).expect(200);
      const rows = list.body.data as Array<Record<string, unknown>>;
      expect(rows.map((r) => r.date)).toEqual([day(-2), day(-3), day(-4), day(-5), day(-6)]);
      expect(rows.map((r) => r.status)).toEqual(['LEAVE', 'ABSENT', 'LATE', 'PRESENT', 'PRESENT']);
      expect(Object.keys(rows[0]).sort()).toEqual(
        [
          'bookingId',
          'checkInAt',
          'checkOutAt',
          'date',
          'id',
          'note',
          'recordedBy',
          'status',
          'updatedAt',
        ].sort(),
      );
      // times are never invented: staff-recorded rows have none
      expect(rows.every((r) => r.checkInAt === null && r.checkOutAt === null)).toBe(true);
      expect(rows.find((r) => r.status === 'LATE')).toMatchObject({
        note: 'Bus delay',
        recordedBy: 'ADMIN',
      });
      expect(list.body.meta.total).toBe(5);

      // summary of a month that holds all five days (use the month of the middle day, counting only days inside it)
      const month = day(-3).slice(0, 7);
      const summary = (
        await as(api, customer).get(`${A}/${active.id}/summary?month=${month}`).expect(200)
      ).body;
      const inMonth = rows.filter((r) => String(r.date).startsWith(month));
      const count = (s: string) => inMonth.filter((r) => r.status === s).length;
      expect(summary).toMatchObject({
        bookingId: active.id,
        month,
        present: count('PRESENT'),
        absent: count('ABSENT'),
        exception: count('EXCEPTION'),
        late: count('LATE'),
        leave: count('LEAVE'),
        recorded: inMonth.length,
      });
    });

    it("returns the booking's own scheduled window (never a default) and the worker display, without private data", async () => {
      const month = day(-3).slice(0, 7);
      const summary = (
        await as(api, customer).get(`${A}/${active.id}/summary?month=${month}`).expect(200)
      ).body;
      expect(summary.scheduledWindow).toEqual({ from: '09:00', to: '12:00' });
      expect(summary.worker).toEqual({
        displayName: 'Anjali V.',
        name: 'Anjali V.',
        initials: 'AV',
        verified: true,
        photo: null,
      });
      expect(JSON.stringify(summary)).not.toMatch(
        /mobile|phone|address|objectKey|passport|aadhaar/i,
      );

      // another booking with another window shows that window
      const other = await makeBooking(api, admin, customer, area.id, 'ACTIVE');
      await api.prisma.booking.update({
        where: { id: other.id },
        data: { fromMinute: 8 * 60, toMinute: 18 * 60 },
      });
      const again = (
        await as(api, customer)
          .get(`${A}/${other.id}/summary?month=${indiaToday().slice(0, 7)}`)
          .expect(200)
      ).body;
      expect(again.scheduledWindow).toEqual({ from: '08:00', to: '18:00' });
    });

    it('a COMPLETED booking stays readable; the worker view has the window but no worker block', async () => {
      const list = await as(api, customer).get(`${A}/${completed.id}`).expect(200);
      expect(list.body.meta.total).toBe(0);
      const mine = (
        await as(api, completed.worker)
          .get(`${W}/${completed.id}/summary?month=${indiaToday().slice(0, 7)}`)
          .expect(200)
      ).body;
      expect(mine.scheduledWindow).toEqual({ from: '09:00', to: '12:00' });
      expect(mine.worker).toBeUndefined();
    });

    it('IDOR: another customer, another worker, a stranger id and anonymous callers get nothing', async () => {
      const month = indiaToday().slice(0, 7);
      for (const path of [`${A}/${active.id}`, `${A}/${active.id}/summary?month=${month}`]) {
        expect((await as(api, stranger).get(path)).status).toBe(404);
        expect((await api.http().get(path)).status).toBe(401);
        expect((await as(api, admin).get(path)).status).toBe(403);
      }
      expect(
        (await as(api, stranger).post(`${A}/${active.id}/exceptions`, { date: day(-1), note: 'x' }))
          .status,
      ).toBe(404);
      expect((await as(api, customer).get(`${A}/${others.id}`)).status).toBe(404);
      expect((await as(api, customer).get(`${A}/${UNKNOWN_ID}`)).status).toBe(404);
      expect((await as(api, customer).get(`${A}/not-a-uuid`)).status).toBe(400);
      expect((await as(api, others.worker).get(`${W}/${active.id}`)).status).toBe(404);
      expect((await as(api, customer).get(`${A}/${active.id}/summary`)).status).toBe(400);
      expect((await as(api, customer).get(`${A}/${active.id}/summary?month=2026-13`)).status).toBe(
        400,
      );
    });
  });

  describe('2. LATE, LEAVE, check-in and check-out', () => {
    it('only the worker (today) and staff record LATE/LEAVE; a customer cannot, and an unknown status is still refused', async () => {
      const b = await makeBooking(api, admin, customer, area.id, 'ACTIVE');
      const w = as(api, b.worker);
      const late = await w.post(`${W}/${b.id}`, { status: 'LATE', note: 'Traffic' });
      expect(late.status).toBe(201);
      expect(late.body).toMatchObject({
        status: 'LATE',
        note: 'Traffic',
        recordedBy: 'WORKER',
        checkInAt: null,
      });
      expect((await w.post(`${W}/${b.id}`, { status: 'HALF_DAY' })).status).toBe(400);
      // the customer route has no status field: one sent anyway is ignored and the entry is an EXCEPTION
      const c = await makeBooking(api, admin, customer, area.id, 'ACTIVE');
      const viaCustomer = await as(api, customer).post(`${A}/${c.id}/exceptions`, {
        date: day(0),
        note: 'x',
        status: 'LEAVE',
      });
      expect(viaCustomer.status).toBe(201);
      expect(viaCustomer.body.status).toBe('EXCEPTION');
      expect((await as(api, customer).post(`${W}/${b.id}`, { status: 'LEAVE' })).status).toBe(403);
      // staff may record LEAVE for an earlier day
      await api.prisma.booking.update({
        where: { id: b.id },
        data: { startDate: new Date(`${day(-3)}T00:00:00.000Z`) },
      });
      const leave = await as(api, admin).post(`${ADMIN}/bookings/${b.id}`, {
        date: day(-1),
        status: 'LEAVE',
      });
      expect(leave.status).toBe(201);
      const summary = (
        await as(api, customer)
          .get(`${A}/${b.id}/summary?month=${day(-1).slice(0, 7)}`)
          .expect(200)
      ).body;
      expect(summary.leave + summary.late).toBeGreaterThanOrEqual(1);
      expect(summary.recorded).toBe(
        summary.present + summary.absent + summary.exception + summary.late + summary.leave,
      );
    });

    it('check-in and check-out are stamped by the server, are repeatable, and need the right order', async () => {
      const b = await makeBooking(api, admin, customer, area.id, 'ACTIVE');
      const w = as(api, b.worker);
      expect((await w.post(`${W}/${b.id}/check-out`)).body.code).toBe('CHECK_IN_REQUIRED');
      const before = Date.now();
      const inRes = await w.post(`${W}/${b.id}/check-in`);
      expect(inRes.status).toBe(201);
      expect(inRes.body).toMatchObject({
        status: 'PRESENT',
        checkOutAt: null,
        recordedBy: 'WORKER',
      });
      const stamped = new Date(inRes.body.checkInAt as string).getTime();
      expect(stamped).toBeGreaterThanOrEqual(before - 2000);
      expect(stamped).toBeLessThanOrEqual(Date.now() + 2000);
      // repeat: unchanged
      const again = await w.post(`${W}/${b.id}/check-in`);
      expect(again.body.checkInAt).toBe(inRes.body.checkInAt);
      expect(again.body.id).toBe(inRes.body.id);
      const out = await w.post(`${W}/${b.id}/check-out`);
      expect(out.status).toBe(201);
      expect(new Date(out.body.checkOutAt as string).getTime()).toBeGreaterThanOrEqual(stamped);
      expect((await w.post(`${W}/${b.id}/check-out`)).body.checkOutAt).toBe(out.body.checkOutAt);
      // the customer sees the same times
      const seen = (await as(api, customer).get(`${A}/${b.id}`).expect(200)).body.data[0];
      expect(seen).toMatchObject({
        checkInAt: inRes.body.checkInAt,
        checkOutAt: out.body.checkOutAt,
      });
      expect(await api.prisma.attendanceRecord.count({ where: { bookingId: b.id } })).toBe(1);
      // history keeps who and what
      const history = (await as(api, admin).get(`${ADMIN}/bookings/${b.id}`).expect(200)).body
        .data[0].history;
      expect(history.map((h: { note: string | null }) => h.note)).toEqual([
        'Checked in',
        'Checked out',
      ]);
      expect(
        await api.prisma.auditLog.count({
          where: {
            entityId: inRes.body.id,
            action: { in: ['attendance.check_in', 'attendance.check_out'] },
          },
        }),
      ).toBe(2);
    });

    it('refuses check-in when today is already ABSENT/LEAVE, for strangers and for a booking that is not active; concurrent first check-ins make one entry', async () => {
      const b = await makeBooking(api, admin, customer, area.id, 'ACTIVE');
      const w = as(api, b.worker);
      const raced = await Promise.all([1, 2, 3, 4].map(() => w.post(`${W}/${b.id}/check-in`)));
      expect(raced.every((r) => r.status === 201)).toBe(true);
      expect(new Set(raced.map((r) => r.body.id as string)).size).toBe(1);
      expect(await api.prisma.attendanceRecord.count({ where: { bookingId: b.id } })).toBe(1);

      const c = await makeBooking(api, admin, customer, area.id, 'ACTIVE');
      await as(api, c.worker).post(`${W}/${c.id}`, { status: 'ABSENT' }).expect(201);
      expect((await as(api, c.worker).post(`${W}/${c.id}/check-in`)).body.code).toBe(
        'ATTENDANCE_ALREADY_RECORDED',
      );
      expect((await as(api, others.worker).post(`${W}/${b.id}/check-in`)).status).toBe(404);
      expect((await as(api, customer).post(`${W}/${b.id}/check-in`)).status).toBe(403);
      expect((await api.http().post(`${W}/${b.id}/check-in`)).status).toBe(401);
      const notActive = await makeBooking(api, admin, customer, area.id, 'CONFIRMED');
      expect(
        (await as(api, notActive.worker).post(`${W}/${notActive.id}/check-in`)).body.code,
      ).toBe('BOOKING_NOT_ACTIVE');
    });

    it('a staff correction to a non-worked status clears the times; the database refuses a check-out before a check-in', async () => {
      const b = await makeBooking(api, admin, customer, area.id, 'ACTIVE');
      const w = as(api, b.worker);
      const inRes = await w.post(`${W}/${b.id}/check-in`);
      await w.post(`${W}/${b.id}/check-out`);
      const fixed = await as(api, admin).patch(`${ADMIN}/${inRes.body.id}`, {
        status: 'ABSENT',
        reason: 'Worker was not there',
      });
      expect(fixed.status).toBe(200);
      expect(fixed.body).toMatchObject({ status: 'ABSENT', checkInAt: null, checkOutAt: null });
      await expect(
        api.prisma.attendanceRecord.update({
          where: { id: inRes.body.id },
          data: { checkOutAt: new Date() },
        }),
      ).rejects.toThrow();
    });
  });

  describe('3. customer missing-day exceptions', () => {
    const raise = (who: { accessToken: string }, id: string, body: object) =>
      as(api, who).post(`${A}/${id}/exceptions`, body);

    it('records a missing day as an EXCEPTION by the customer: auditable, not a verified present day, visible to the worker and staff', async () => {
      const date = day(-1);
      const res = await raise(customer, active.id, { date, note: 'Nobody came, no message' });
      expect(res.status).toBe(201);
      expect(res.body).toMatchObject({
        date,
        status: 'EXCEPTION',
        recordedBy: 'CUSTOMER',
        note: 'Nobody came, no message',
        checkInAt: null,
      });
      const month = date.slice(0, 7);
      const summary = (
        await as(api, customer).get(`${A}/${active.id}/summary?month=${month}`).expect(200)
      ).body;
      expect(summary.exception).toBeGreaterThanOrEqual(1);
      // staff see who raised it, with history; the worker sees the same row
      const adminRow = (
        await as(api, admin).get(`${ADMIN}/bookings/${active.id}`).expect(200)
      ).body.data.find((r: { date: string }) => r.date === date);
      expect(adminRow.history).toHaveLength(1);
      expect(adminRow.history[0]).toMatchObject({
        to: 'EXCEPTION',
        actorKind: 'CUSTOMER',
        actorUserId: customer.userId,
      });
      const workerRows = (await as(api, active.worker).get(`${W}/${active.id}`).expect(200)).body
        .data;
      expect(workerRows.find((r: { date: string }) => r.date === date)).toMatchObject({
        status: 'EXCEPTION',
        recordedBy: 'CUSTOMER',
      });
      expect(
        await api.prisma.auditLog.count({
          where: { entityId: res.body.id, action: 'attendance.record' },
        }),
      ).toBe(1);
      // staff review: a correction with a reason keeps the original in the history
      const reviewed = await as(api, admin).patch(`${ADMIN}/${res.body.id}`, {
        status: 'PRESENT',
        reason: 'Checked with the worker: she did come',
      });
      expect(reviewed.status).toBe(200);
      expect(reviewed.body.history.map((h: { to: string }) => h.to)).toEqual([
        'EXCEPTION',
        'PRESENT',
      ]);
    });

    it('refuses an existing entry, a future date, a date before the start, a missing or oversized note, and unreal dates', async () => {
      expect((await raise(customer, active.id, { date: day(-3), note: 'again' })).body.code).toBe(
        'ATTENDANCE_ALREADY_RECORDED',
      );
      for (const date of [day(1), day(40)]) {
        const res = await raise(customer, active.id, { date, note: 'future' });
        expect(res.status).toBe(422);
        expect(res.body.code).toBe('DATE_NOT_ALLOWED');
      }
      expect(
        (await raise(customer, active.id, { date: day(-30), note: 'before the start' })).body.code,
      ).toBe('DATE_NOT_ALLOWED');
      const before = await api.prisma.attendanceRecord.count({ where: { bookingId: active.id } });
      for (const body of [
        { date: day(-1) },
        { date: day(-1), note: '' },
        { date: day(-1), note: '   ' },
        { date: day(-1), note: 'x'.repeat(501) },
        { note: 'no date' },
        { date: '2026-02-30', note: 'not a date' },
        { date: 'yesterday', note: 'bad' },
      ]) {
        expect((await raise(customer, active.id, body)).status).toBe(400);
      }
      expect(await api.prisma.attendanceRecord.count({ where: { bookingId: active.id } })).toBe(
        before,
      );
      expect(
        (
          await raise(customer, active.id, {
            date: day(0) === day(-1) ? day(-1) : day(-1),
            note: 'x'.repeat(500),
          })
        ).status,
      ).toBeLessThan(500);
    });

    it('a COMPLETED, CANCELLED or not yet active booking cannot take an exception', async () => {
      expect(
        (await raise(customer, completed.id, { date: day(0), note: 'late report' })).body.code,
      ).toBe('BOOKING_NOT_ACTIVE');
      const confirmed = await makeBooking(api, admin, customer, area.id, 'CONFIRMED');
      expect((await raise(customer, confirmed.id, { date: day(0), note: 'n' })).body.code).toBe(
        'BOOKING_NOT_ACTIVE',
      );
      await as(api, customer)
        .post(`/api/v1/bookings/${confirmed.id}/cancel`, { reason: 'Changed plans' })
        .expect(200);
      expect((await raise(customer, confirmed.id, { date: day(0), note: 'n' })).body.code).toBe(
        'BOOKING_NOT_ACTIVE',
      );
    });

    it('the same exception sent many times at once makes one row; two different notes for one day leave exactly one winner', async () => {
      const b = await makeBooking(api, admin, customer, area.id, 'ACTIVE');
      await api.prisma.booking.update({
        where: { id: b.id },
        data: { startDate: new Date(`${day(-4)}T00:00:00.000Z`) },
      });
      const same = await Promise.all(
        [1, 2, 3, 4, 5].map(() => raise(customer, b.id, { date: day(-1), note: 'Missed visit' })),
      );
      expect(same.every((r) => r.status === 201)).toBe(true);
      expect(new Set(same.map((r) => r.body.id as string)).size).toBe(1);

      const different = await Promise.all(
        [1, 2, 3, 4].map((i) => raise(customer, b.id, { date: day(-2), note: `Reason ${i}` })),
      );
      const wins = different.filter((r) => r.status === 201);
      const sameNoteReplays = new Set(wins.map((r) => r.body.note as string));
      expect(sameNoteReplays.size).toBe(1); // everyone who succeeded saw the winner's note
      expect(
        different
          .filter((r) => r.status === 409)
          .every((r) => r.body.code === 'ATTENDANCE_ALREADY_RECORDED'),
      ).toBe(true);
      expect(await api.prisma.attendanceRecord.count({ where: { bookingId: b.id } })).toBe(2);
    });

    it('a worker recording today and a customer exception for the same day cannot both exist', async () => {
      const b = await makeBooking(api, admin, customer, area.id, 'ACTIVE');
      const results = await Promise.all([
        as(api, b.worker).post(`${W}/${b.id}`, { status: 'PRESENT' }),
        raise(customer, b.id, { date: day(0), note: 'Worker has not arrived' }),
      ]);
      expect(results.filter((r) => r.status === 201).length).toBeGreaterThanOrEqual(1);
      expect(await api.prisma.attendanceRecord.count({ where: { bookingId: b.id } })).toBe(1);
    });
  });
});
