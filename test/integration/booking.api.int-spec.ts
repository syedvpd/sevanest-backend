import '../support/env-api-integration';
import {
  ApiApp,
  createApiApp,
  loginAdmin,
  loginAdminWithPermissions,
  loginWithOtp,
} from '../support/api-app';
import {
  approveCheck,
  as,
  createArea,
  onboardWorker,
  OnboardedWorker,
  setRequiredChecks,
} from '../support/workforce';
import { BookingService } from '../../src/modules/booking/booking.service';

const UNKNOWN_ID = '00000000-0000-7000-8000-000000000000';
const B = '/api/v1/bookings';
const W = '/api/v1/workers/me/bookings';
const A = '/api/v1/admin/bookings';

/** Booking lifecycle against the REAL PostgreSQL + Redis (dedicated test database), through the HTTP API. */
describe('Booking API (integration)', () => {
  let api: ApiApp;
  let admin: Awaited<ReturnType<typeof loginAdmin>>;
  let area: { id: string };
  let customer: Awaited<ReturnType<typeof loginWithOtp>>;

  const requirement = (extra: object = {}) => ({
    category: 'HOUSE_MAID',
    areaId: area.id,
    engagement: 'PART_TIME',
    availableFrom: '09:00',
    availableTo: '12:00',
    ...extra,
  });
  const verifiedWorker = async (extra: object = {}): Promise<OnboardedWorker> => {
    const worker = await onboardWorker(api, { areaIds: [area.id], ...extra });
    await approveCheck(api, admin, worker, 'IDENTITY');
    return worker;
  };
  const create = (body: object, caller: { accessToken: string } = customer, key?: string) => {
    const req = api.http().post(B).set('Authorization', `Bearer ${caller.accessToken}`);
    return (key ? req.set('Idempotency-Key', key) : req).send(body);
  };
  const act = (
    id: string,
    action: string,
    body: object = {},
    caller: { accessToken: string } = customer,
    base = B,
  ) => as(api, caller).post(`${base}/${id}/${action}`, body);
  const future = (hours = 48) => new Date(Date.now() + hours * 3600 * 1000).toISOString();
  const tomorrow = () => new Date(Date.now() + 24 * 3600 * 1000).toISOString().slice(0, 10);
  const status = async (id: string) =>
    (await as(api, customer).get(`${B}/${id}`)).body.status as string;
  const paid = (id: string) =>
    api.prisma.$transaction((tx) => api.app.get(BookingService).applyPaymentSucceeded(id, tx));

  /** A booking taken through to INTERVIEW_TRIAL_COMPLETED with its worker. */
  async function readyToConfirm(worker: OnboardedWorker): Promise<string> {
    const id = (await create(requirement({ workerId: worker.workerId }))).body.id as string;
    await act(id, 'schedule', { scheduleType: 'INTERVIEW', scheduledAt: future() }).expect(200);
    await act(id, 'interview-complete', { outcomeNote: 'Good fit' }).expect(200);
    return id;
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

  describe('creating a booking', () => {
    it('starts as NEW_REQUEST without a worker, with a timeline, and is listed for the customer only', async () => {
      const res = await create(requirement());
      expect(res.status).toBe(201);
      expect(res.body).toMatchObject({
        status: 'NEW_REQUEST',
        workerId: null,
        category: { code: 'HOUSE_MAID' },
        engagement: 'PART_TIME',
        availableFrom: '09:00',
        availableTo: '12:00',
      });
      expect(res.body.timeline).toHaveLength(1);
      const list = await as(api, customer).get(`${B}?limit=100`).expect(200);
      expect(list.body.data.map((b: { id: string }) => b.id)).toContain(res.body.id);
      const other = await loginWithOtp(api, { appType: 'CUSTOMER' });
      expect((await as(api, other).get(B).expect(200)).body.data).toEqual([]);
    });

    it('starts as MATCHED when an eligible worker is chosen, and offers the worker only a requirement summary', async () => {
      const worker = await verifiedWorker();
      const res = await create(requirement({ workerId: worker.workerId }));
      expect(res.status).toBe(201);
      expect(res.body.status).toBe('MATCHED');
      expect(res.body.workerId).toBe(worker.workerId);
      expect(res.body.timeline.map((t: { to: string }) => t.to)).toEqual([
        'NEW_REQUEST',
        'MATCHED',
      ]);

      const mine = await as(api, worker).get(W).expect(200);
      const offered = mine.body.data.find((b: { id: string }) => b.id === res.body.id);
      expect(Object.keys(offered as object).sort()).toEqual(
        [
          'area',
          'availableFrom',
          'availableTo',
          'category',
          'engagement',
          'id',
          'scheduleType',
          'scheduledAt',
          'startDate',
          'status',
          'updatedAt',
        ].sort(),
      );
      expect(JSON.stringify(mine.body)).not.toContain(customer.userId);
      const outbox = await api.prisma.outboxEvent.findMany({
        where: { payload: { path: ['params', 'bookingId'], equals: res.body.id } },
      });
      expect(outbox).toHaveLength(1);
      expect(outbox[0].payload).toMatchObject({
        event: 'JOB_OPPORTUNITY',
        recipients: [worker.userId],
      });
    });

    it('refuses a worker who is not eligible, whatever the reason, with one answer', async () => {
      const unverified = await onboardWorker(api, { areaIds: [area.id] });
      const wrongWindow = await verifiedWorker({ windows: [{ start: '14:00', end: '18:00' }] });
      const wrongEngagement = await verifiedWorker({ engagement: 'LIVE_IN' });
      for (const workerId of [
        unverified.workerId,
        wrongWindow.workerId,
        wrongEngagement.workerId,
        UNKNOWN_ID,
      ]) {
        const res = await create(requirement({ workerId }));
        expect(res.status).toBe(422);
        expect(res.body.code).toBe('WORKER_NOT_ELIGIBLE');
      }
    });

    it('validates the requirement', async () => {
      for (const bad of [
        { category: 'house' },
        { areaId: 'x' },
        { engagement: 'DAILY' },
        { availableFrom: '12:00', availableTo: '09:00' },
        { availableFrom: '9' },
        { workerId: 'nope' },
      ]) {
        expect((await create(requirement(bad))).status).toBe(400);
      }
      const unknown = await create(requirement({ category: 'NO_SUCH' }));
      expect(unknown.status).toBe(422);
      expect(unknown.body.code).toBe('CATEGORY_NOT_AVAILABLE');
      expect((await create(requirement({ areaId: UNKNOWN_ID }))).body.code).toBe(
        'AREA_NOT_AVAILABLE',
      );
    });

    it('is for customers only', async () => {
      const worker = await onboardWorker(api, { areaIds: [area.id] });
      expect((await api.http().post(B).send(requirement())).status).toBe(401);
      expect((await create(requirement(), worker)).status).toBe(403);
      expect((await create(requirement(), admin)).status).toBe(403);
    });

    it('answers the same request with the same key once, and refuses the key for a different request', async () => {
      const key = `key-${Date.now()}-a`;
      const first = await create(requirement(), customer, key);
      const again = await create(requirement(), customer, key);
      expect(first.status).toBe(201);
      expect(again.status).toBe(200);
      expect(again.body.id).toBe(first.body.id);
      const different = await create(requirement({ engagement: 'FULL_TIME' }), customer, key);
      expect(different.status).toBe(409);
      expect(different.body.code).toBe('IDEMPOTENCY_KEY_REUSED');
      expect((await create(requirement(), customer, 'short')).status).toBe(400);
      // The same key from another customer is a different request.
      const other = await loginWithOtp(api, { appType: 'CUSTOMER' });
      expect((await create(requirement(), other, key)).status).toBe(201);
    });

    it('creates exactly one booking when the same keyed request arrives in parallel', async () => {
      const key = `key-${Date.now()}-parallel`;
      const results = await Promise.all(
        Array.from({ length: 6 }, () => create(requirement(), customer, key)),
      );
      expect(results.every((r) => [200, 201].includes(r.status))).toBe(true);
      expect(new Set(results.map((r) => r.body.id as string)).size).toBe(1);
      expect(await api.prisma.booking.count({ where: { idempotencyKey: key } })).toBe(1);
    });

    it('refuses a second open booking with the same worker and service, and allows it after a cancellation', async () => {
      const worker = await verifiedWorker();
      const buyer = await loginWithOtp(api, { appType: 'CUSTOMER' });
      const first = await create(requirement({ workerId: worker.workerId }), buyer);
      expect(first.status).toBe(201);
      const second = await create(requirement({ workerId: worker.workerId }), buyer);
      expect(second.status).toBe(409);
      expect(second.body.code).toBe('DUPLICATE_BOOKING');
      const parallel = await Promise.all(
        Array.from({ length: 4 }, () => create(requirement({ workerId: worker.workerId }), buyer)),
      );
      expect(parallel.every((r) => r.status === 409)).toBe(true);
      await act(first.body.id as string, 'cancel', { reason: 'Changed my mind' }, buyer).expect(
        200,
      );
      expect((await create(requirement({ workerId: worker.workerId }), buyer)).status).toBe(201);
    });
  });

  describe('lifecycle', () => {
    it('walks the whole state model: schedule, interview done, confirm, paid, start, complete', async () => {
      const worker = await verifiedWorker();
      const id = await readyToConfirm(worker);
      expect(await status(id)).toBe('INTERVIEW_TRIAL_COMPLETED');
      const confirmed = await act(id, 'confirm-worker', { startDate: tomorrow() });
      expect(confirmed.status).toBe(200);
      expect(confirmed.body.status).toBe('PENDING_PAYMENT');
      expect(confirmed.body.startDate).toBe(tomorrow());
      // Payment (a later module) reports success through the booking contract.
      expect(await paid(id)).toBe(true);
      expect(await paid(id)).toBe(false);
      expect(await status(id)).toBe('CONFIRMED');
      await act(id, 'start', {}, worker, W).expect(200);
      const done = await act(id, 'complete');
      expect(done.status).toBe(200);
      expect(done.body.status).toBe('COMPLETED');
      expect(done.body.timeline.map((t: { to: string }) => t.to)).toEqual([
        'NEW_REQUEST',
        'MATCHED',
        'INTERVIEW_TRIAL_SCHEDULED',
        'INTERVIEW_TRIAL_COMPLETED',
        'PENDING_PAYMENT',
        'CONFIRMED',
        'ACTIVE',
        'COMPLETED',
      ]);
      const outbox = await api.prisma.outboxEvent.findMany({
        where: { payload: { path: ['params', 'bookingId'], equals: id } },
      });
      expect(outbox.map((o) => (o.payload as { event: string }).event).sort()).toEqual(
        ['BOOKING_CONFIRMED', 'INTERVIEW_TRIAL_SCHEDULED', 'JOB_OPPORTUNITY'].sort(),
      );
    });

    it('lets the worker decline: MATCHED returns to NEW_REQUEST without the worker, a scheduled one returns to MATCHED', async () => {
      const worker = await verifiedWorker();
      const first = (await create(requirement({ workerId: worker.workerId }))).body.id as string;
      const declined = await act(first, 'decline', {}, worker, W);
      expect(declined.status).toBe(200);
      expect(declined.body.status).toBe('NEW_REQUEST');
      expect((await as(api, customer).get(`${B}/${first}`)).body.workerId).toBeNull();
      // The worker no longer sees it, and cannot act on it.
      expect((await as(api, worker).get(`${W}/${first}`)).status).toBe(404);
      expect((await act(first, 'decline', {}, worker, W)).status).toBe(404);

      const other = await verifiedWorker();
      const second = (await create(requirement({ workerId: other.workerId }))).body.id as string;
      await act(
        second,
        'schedule',
        { scheduleType: 'TRIAL', scheduledAt: future() },
        other,
        W,
      ).expect(200);
      expect((await act(second, 'decline', {}, other, W)).body.status).toBe('MATCHED');
      expect((await as(api, customer).get(`${B}/${second}`)).body.scheduledAt).toBeNull();
    });

    it('lets the customer reopen matching after a schedule or an interview', async () => {
      const worker = await verifiedWorker();
      const id = await readyToConfirm(worker);
      expect((await act(id, 'reopen-matching')).body.status).toBe('MATCHED');
      await act(id, 'schedule', { scheduleType: 'TRIAL', scheduledAt: future(72) }).expect(200);
      expect((await act(id, 'reopen-matching')).body.status).toBe('MATCHED');
    });

    it('lets staff match an eligible worker onto a NEW_REQUEST and refuses an ineligible one', async () => {
      const worker = await verifiedWorker();
      const unverified = await onboardWorker(api, { areaIds: [area.id] });
      const buyer = await loginWithOtp(api, { appType: 'CUSTOMER' });
      const id = (await create(requirement(), buyer)).body.id as string;
      const bad = await act(id, 'match', { workerId: unverified.workerId }, admin, A);
      expect(bad.status).toBe(422);
      const ok = await act(id, 'match', { workerId: worker.workerId }, admin, A);
      expect(ok.status).toBe(200);
      expect(ok.body.status).toBe('MATCHED');
      expect(ok.body.customerUserId).toBe(buyer.userId);
      expect(ok.body.timeline.at(-1)).toMatchObject({ by: 'ADMIN', actorUserId: admin.userId });
      // Repeating the same match changes nothing; matching a different worker is a conflict.
      expect((await act(id, 'match', { workerId: worker.workerId }, admin, A)).status).toBe(200);
      const other = await verifiedWorker();
      expect((await act(id, 'match', { workerId: other.workerId }, admin, A)).status).toBe(409);
    });

    it('cancels from the permitted states with a reason, records who and why, and is final', async () => {
      const id = (await create(requirement())).body.id as string;
      expect((await act(id, 'cancel')).status).toBe(400);
      expect((await act(id, 'cancel', { reason: '   ' })).status).toBe(400);
      const res = await act(id, 'cancel', { reason: 'No longer needed' });
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ status: 'CANCELLED', cancelReason: 'No longer needed' });
      expect((await act(id, 'cancel', { reason: 'again' })).status).toBe(200);
      expect(res.body.timeline.filter((t: { to: string }) => t.to === 'CANCELLED')).toHaveLength(1);
      for (const action of ['schedule', 'complete', 'start']) {
        expect(
          (await act(id, action, { scheduleType: 'TRIAL', scheduledAt: future() })).status,
        ).toBe(409);
      }
      const detail = await as(api, admin).get(`${A}/${id}`).expect(200);
      expect(detail.body.cancelledByUserId).toBe(customer.userId);
    });

    it('does not let an active service be cancelled, and completes only from ACTIVE', async () => {
      const worker = await verifiedWorker();
      const id = await readyToConfirm(worker);
      await act(id, 'confirm-worker', { startDate: tomorrow() }).expect(200);
      expect((await act(id, 'complete')).status).toBe(409);
      await paid(id);
      await act(id, 'start').expect(200);
      const res = await act(id, 'cancel', { reason: 'x' });
      expect(res.status).toBe(409);
      expect(res.body.code).toBe('INVALID_TRANSITION');
    });
  });

  describe('rules on every action', () => {
    it('requires the fields each action needs and rejects past dates', async () => {
      const worker = await verifiedWorker();
      const id = (await create(requirement({ workerId: worker.workerId }))).body.id as string;
      expect((await act(id, 'schedule', {})).status).toBe(400);
      expect((await act(id, 'schedule', { scheduleType: 'TRIAL' })).status).toBe(400);
      expect(
        (await act(id, 'schedule', { scheduleType: 'TRIAL', scheduledAt: '2020-01-01T10:00:00Z' }))
          .status,
      ).toBe(400);
      expect(
        (await act(id, 'schedule', { scheduleType: 'MEETING', scheduledAt: future() })).status,
      ).toBe(400);
      await act(id, 'schedule', { scheduleType: 'TRIAL', scheduledAt: future() }).expect(200);
      expect((await act(id, 'interview-complete', {})).status).toBe(400);
      await act(id, 'interview-complete', { outcomeNote: 'ok' }).expect(200);
      expect((await act(id, 'confirm-worker', {})).status).toBe(400);
      expect((await act(id, 'confirm-worker', { startDate: '2020-01-01' })).status).toBe(400);
      expect((await act(id, 'confirm-worker', { startDate: '2999-02-30' })).status).toBe(400);
      expect(await status(id)).toBe('INTERVIEW_TRIAL_COMPLETED');
      // A client cannot choose the resulting state: the unknown field is dropped and the real transition happens.
      const forged = await act(id, 'confirm-worker', {
        startDate: tomorrow(),
        status: 'CONFIRMED',
      });
      expect(forged.status).toBe(200);
      expect(forged.body.status).toBe('PENDING_PAYMENT');
    });

    it('rejects an invalid action name and a malformed id', async () => {
      expect((await act(UNKNOWN_ID, 'teleport')).status).toBe(400);
      expect((await act('not-a-uuid', 'cancel', { reason: 'x' })).status).toBe(400);
      expect((await act(UNKNOWN_ID, 'cancel', { reason: 'x' })).status).toBe(404);
    });

    it('tells apart "never allowed for you" (403) from "not now" (409) and "not yours" (404)', async () => {
      const worker = await verifiedWorker();
      const id = (await create(requirement({ workerId: worker.workerId }))).body.id as string;
      expect((await act(id, 'match', { workerId: worker.workerId })).status).toBe(403);
      expect((await act(id, 'cancel', { reason: 'x' }, worker, W)).status).toBe(403);
      expect((await act(id, 'interview-complete', { outcomeNote: 'x' }, worker, W)).status).toBe(
        403,
      );
      expect((await act(id, 'start')).status).toBe(409);
      const stranger = await loginWithOtp(api, { appType: 'CUSTOMER' });
      expect((await act(id, 'cancel', { reason: 'x' }, stranger)).status).toBe(404);
      expect((await as(api, stranger).get(`${B}/${id}`)).status).toBe(404);
      const otherWorker = await verifiedWorker();
      expect((await as(api, otherWorker).get(`${W}/${id}`)).status).toBe(404);
      expect((await act(id, 'decline', {}, otherWorker, W)).status).toBe(404);
      expect(await status(id)).toBe('MATCHED');
    });

    it('re-checks the worker before the customer commits: a worker who stopped being verified cannot be confirmed', async () => {
      const worker = await onboardWorker(api, { areaIds: [area.id] });
      const checkId = await approveCheck(api, admin, worker, 'IDENTITY');
      const id = await readyToConfirm(worker);
      await as(api, admin)
        .post(`/api/v1/admin/verification/checks/${checkId}/recheck`, { remarks: 'Expired' })
        .expect(200);
      const res = await act(id, 'confirm-worker', { startDate: tomorrow() });
      expect(res.status).toBe(422);
      expect(res.body.code).toBe('WORKER_NOT_ELIGIBLE');
      expect(await status(id)).toBe('INTERVIEW_TRIAL_COMPLETED');
    });
  });

  describe('concurrency and idempotent repeats', () => {
    it('applies one of many parallel conflicting actions, never two', async () => {
      const worker = await verifiedWorker();
      const id = await readyToConfirm(worker);
      const results = await Promise.all([
        ...Array.from({ length: 4 }, () => act(id, 'confirm-worker', { startDate: tomorrow() })),
        ...Array.from({ length: 4 }, () => act(id, 'cancel', { reason: 'race' })),
      ]);
      const events = await api.prisma.bookingEvent.findMany({ where: { bookingId: id } });
      const final = await status(id);
      expect(['PENDING_PAYMENT', 'CANCELLED']).toContain(final);
      // Exactly one transition out of INTERVIEW_TRIAL_COMPLETED was recorded.
      expect(events.filter((e) => e.fromStatus === 'INTERVIEW_TRIAL_COMPLETED')).toHaveLength(1);
      expect(results.filter((r) => r.status === 200).length).toBeGreaterThanOrEqual(1);
      expect(results.every((r) => [200, 409].includes(r.status))).toBe(true);
    });

    it('records a repeated confirmation once', async () => {
      const worker = await verifiedWorker();
      const id = await readyToConfirm(worker);
      const results = await Promise.all(
        Array.from({ length: 6 }, () => act(id, 'confirm-worker', { startDate: tomorrow() })),
      );
      expect(results.every((r) => r.status === 200)).toBe(true);
      const events = await api.prisma.bookingEvent.findMany({
        where: { bookingId: id, toStatus: 'PENDING_PAYMENT' },
      });
      expect(events).toHaveLength(1);
      expect(
        await api.prisma.auditLog.count({
          where: { entityId: id, action: 'booking.confirm-worker' },
        }),
      ).toBe(1);
      // A different start date after confirmation is a conflict, not a silent change.
      const later = new Date(Date.now() + 5 * 86400000).toISOString().slice(0, 10);
      expect((await act(id, 'confirm-worker', { startDate: later })).status).toBe(409);
    });
  });

  describe('admin', () => {
    it('needs booking.view to read and booking.manage to act, and keeps other callers out', async () => {
      const id = (await create(requirement())).body.id as string;
      const viewer = await loginAdminWithPermissions(api, ['booking.view']);
      const manager = await loginAdminWithPermissions(api, ['booking.manage']);
      const none = await loginAdminWithPermissions(api, ['worker.view']);
      expect((await as(api, viewer).get(`${A}/${id}`)).status).toBe(200);
      expect((await as(api, manager).get(`${A}/${id}`)).status).toBe(403);
      expect((await as(api, none).get(A)).status).toBe(403);
      expect((await act(id, 'cancel', { reason: 'x' }, viewer, A)).status).toBe(403);
      const worker = await onboardWorker(api, { areaIds: [area.id] });
      expect((await as(api, worker).get(A)).status).toBe(403);
      expect((await as(api, customer).get(A)).status).toBe(403);
      expect((await api.http().get(A)).status).toBe(401);
      const res = await act(id, 'cancel', { reason: 'Customer asked by phone' }, manager, A);
      expect(res.status).toBe(200);
      const audit = await api.prisma.auditLog.findFirstOrThrow({
        where: { entityId: id, action: 'booking.cancel' },
      });
      expect(audit.actorId).toBe(manager.userId);
      expect(JSON.stringify(audit.metadata)).not.toContain('Customer asked by phone');
    });

    it('lists and filters bookings with bounded pages', async () => {
      const buyer = await loginWithOtp(api, { appType: 'CUSTOMER' });
      const a = (await create(requirement(), buyer)).body.id as string;
      await create(requirement({ engagement: 'FULL_TIME' }), buyer);
      await act(a, 'cancel', { reason: 'x' }, buyer);
      const all = await as(api, admin).get(`${A}?customerUserId=${buyer.userId}`).expect(200);
      expect(all.body.meta.total).toBe(2);
      const cancelled = await as(api, admin)
        .get(`${A}?customerUserId=${buyer.userId}&status=CANCELLED`)
        .expect(200);
      expect(cancelled.body.data.map((b: { id: string }) => b.id)).toEqual([a]);
      expect((await as(api, admin).get(`${A}?limit=101`)).status).toBe(400);
      expect((await as(api, admin).get(`${A}?status=NOPE`)).status).toBe(400);
    });
  });

  describe('database invariants', () => {
    it('refuses impossible states and any change to the timeline', async () => {
      const id = (await create(requirement())).body.id as string;
      const run = (sql: string) => api.prisma.$executeRawUnsafe(sql);
      await expect(
        run(`UPDATE bookings SET status = 'MATCHED' WHERE id = '${id}'`),
      ).rejects.toThrow();
      await expect(
        run(`UPDATE bookings SET status = 'CANCELLED' WHERE id = '${id}'`),
      ).rejects.toThrow();
      await expect(
        run(`UPDATE bookings SET from_minute = 700, to_minute = 600 WHERE id = '${id}'`),
      ).rejects.toThrow();
      await expect(
        run(`UPDATE bookings SET status = 'PENDING_PAYMENT' WHERE id = '${id}'`),
      ).rejects.toThrow();
      const event = await api.prisma.bookingEvent.findFirstOrThrow({ where: { bookingId: id } });
      await expect(
        run(`UPDATE booking_events SET note = 'x' WHERE id = '${event.id}'`),
      ).rejects.toThrow(/append-only/);
      await expect(run(`DELETE FROM booking_events WHERE id = '${event.id}'`)).rejects.toThrow(
        /append-only/,
      );
    });
  });
});
