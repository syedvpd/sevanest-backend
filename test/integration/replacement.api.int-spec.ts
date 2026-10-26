import '../support/env-api-integration';
import {
  ApiApp,
  createApiApp,
  loginAdmin,
  loginAdminWithPermissions,
  loginWithOtp,
} from '../support/api-app';
import { makeBooking, TestBooking } from '../support/bookings';
import {
  approveCheck,
  as,
  createArea,
  onboardWorker,
  OnboardedWorker,
  setRequiredChecks,
} from '../support/workforce';
import { SearchService } from '../../src/modules/search/search.service';
import { REPLACEMENT_POLICY } from '../../src/modules/replacement/replacement.policy';

const UNKNOWN_ID = '00000000-0000-7000-8000-000000000000';
const R = '/api/v1/replacement-requests';
const A = '/api/v1/admin/replacement-requests';

/** Replacement workflow against the REAL PostgreSQL + Redis (dedicated test database), through the HTTP API. */
describe('Replacement API (integration)', () => {
  let api: ApiApp;
  let admin: Awaited<ReturnType<typeof loginAdmin>>;
  let area: { id: string };
  let customer: Awaited<ReturnType<typeof loginWithOtp>> & { userId: string };

  const active = (): Promise<TestBooking> => makeBooking(api, admin, customer, area.id, 'ACTIVE');
  const request = (
    bookingId: string,
    caller: { accessToken: string } = customer,
    extra: object = {},
  ) => as(api, caller).post(R, { bookingId, reason: 'Worker is often late', ...extra });
  const bookingStatus = async (id: string) =>
    (await as(api, customer).get(`/api/v1/bookings/${id}`)).body.status as string;
  const alternative = async (): Promise<OnboardedWorker> => {
    const worker = await onboardWorker(api, { areaIds: [area.id] });
    await approveCheck(api, admin, worker, 'IDENTITY');
    return worker;
  };
  /** An APPROVED request on a fresh active booking. */
  async function approved(): Promise<{ b: TestBooking; id: string }> {
    const b = await active();
    const id = (await request(b.id)).body.id as string;
    await as(api, admin).post(`${A}/${id}/approve`, { remarks: 'Eligible' }).expect(200);
    return { b, id };
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

  describe('requesting', () => {
    it('moves an active booking to REPLACEMENT_REQUESTED and records the reason', async () => {
      const b = await active();
      const res = await request(b.id, customer, { notes: 'Third time this month' });
      expect(res.status).toBe(201);
      expect(res.body).toMatchObject({
        bookingId: b.id,
        status: 'REQUESTED',
        reason: 'Worker is often late',
        notes: 'Third time this month',
        replacementBookingId: null,
      });
      expect(await bookingStatus(b.id)).toBe('REPLACEMENT_REQUESTED');
      const outbox = await api.prisma.outboxEvent.findMany({
        where: { payload: { path: ['params', 'replacementId'], equals: res.body.id } },
      });
      expect(outbox.map((o) => (o.payload as { event: string }).event)).toEqual([
        'REPLACEMENT_UPDATE',
      ]);
      expect((outbox[0].payload as { recipients: string[] }).recipients).toHaveLength(2);
    });

    it('is only for the owner, only for an eligible booking, and needs a reason', async () => {
      const b = await active();
      const stranger = await loginWithOtp(api, { appType: 'CUSTOMER' });
      expect((await request(b.id, stranger)).status).toBe(404);
      expect((await request(UNKNOWN_ID)).status).toBe(404);
      expect((await request('nope')).status).toBe(400);
      expect((await as(api, customer).post(R, { bookingId: b.id })).status).toBe(400);
      expect((await as(api, customer).post(R, { bookingId: b.id, reason: '   ' })).status).toBe(
        400,
      );
      expect((await request(b.id, b.worker)).status).toBe(403);
      expect((await request(b.id, admin)).status).toBe(403);
      expect((await api.http().post(R).send({ bookingId: b.id, reason: 'x' })).status).toBe(401);
      const notActive = await makeBooking(api, admin, customer, area.id, 'CONFIRMED');
      const res = await request(notActive.id);
      expect(res.status).toBe(422);
      expect(res.body.code).toBe('REPLACEMENT_NOT_ELIGIBLE');
      expect(await bookingStatus(b.id)).toBe('ACTIVE');
    });

    it('allows one open request per booking, even when asked many times at once', async () => {
      const b = await active();
      const results = await Promise.all(Array.from({ length: 5 }, () => request(b.id)));
      expect(results.filter((r) => r.status === 201)).toHaveLength(1);
      expect(results.filter((r) => r.status === 409)).toHaveLength(4);
      expect(await api.prisma.replacementRequest.count({ where: { bookingId: b.id } })).toBe(1);
      expect((await request(b.id)).status).toBe(409);
    });

    it('asks the eligibility policy, which is the one place a future rule goes', async () => {
      const b = await active();
      const policy = api.app.get<{ evaluate: (x: unknown) => Promise<unknown> }>(
        REPLACEMENT_POLICY,
      );
      const spy = jest
        .spyOn(policy, 'evaluate')
        .mockResolvedValueOnce({ eligible: false, reason: 'Too soon after the start' });
      const res = await request(b.id);
      spy.mockRestore();
      expect(res.status).toBe(422);
      expect(res.body.message).toBe('Too soon after the start');
      expect(await bookingStatus(b.id)).toBe('ACTIVE');
    });
  });

  describe('reading', () => {
    it('shows a customer only their own requests', async () => {
      const b = await active();
      const id = (await request(b.id)).body.id as string;
      expect((await as(api, customer).get(`${R}/${id}`)).body.id).toBe(id);
      const list = await as(api, customer).get(`${R}?limit=100&status=REQUESTED`).expect(200);
      expect(list.body.data.map((r: { id: string }) => r.id)).toContain(id);
      const stranger = await loginWithOtp(api, { appType: 'CUSTOMER' });
      expect((await as(api, stranger).get(`${R}/${id}`)).status).toBe(404);
      expect((await as(api, stranger).get(R).expect(200)).body.data).toEqual([]);
      expect((await as(api, customer).get(`${R}?limit=101`)).status).toBe(400);
      expect((await as(api, customer).get(`${R}?status=NOPE`)).status).toBe(400);
      expect((await as(api, customer).get(`${R}/${UNKNOWN_ID}`)).status).toBe(404);
    });
  });

  describe('staff review', () => {
    it('approves once (repeat is harmless) and never after a rejection', async () => {
      const b = await active();
      const id = (await request(b.id)).body.id as string;
      const first = await as(api, admin).post(`${A}/${id}/approve`, {
        remarks: 'ok',
        message: 'Approved, please pick a worker',
      });
      expect(first.status).toBe(200);
      expect(first.body).toMatchObject({
        status: 'APPROVED',
        decidedByUserId: admin.userId,
        currentWorkerId: b.worker.workerId,
      });
      expect((await as(api, admin).post(`${A}/${id}/approve`, {})).status).toBe(200);
      expect((await as(api, admin).post(`${A}/${id}/reject`, { remarks: 'late' })).status).toBe(
        409,
      );
      expect(
        await api.prisma.auditLog.count({ where: { entityId: id, action: 'replacement.approve' } }),
      ).toBe(1);
      const seen = (await as(api, customer).get(`${R}/${id}`)).body;
      expect(seen.decisionMessage).toBe('Approved, please pick a worker');
      expect(seen).not.toHaveProperty('decisionRemarks');
      expect(first.body.decisionRemarks).toBe('ok');
    });

    it('needs remarks to reject, and a rejection returns the booking to ACTIVE', async () => {
      const b = await active();
      const id = (await request(b.id)).body.id as string;
      expect((await as(api, admin).post(`${A}/${id}/reject`, {})).status).toBe(400);
      expect((await as(api, admin).post(`${A}/${id}/reject`, { remarks: '  ' })).status).toBe(400);
      const res = await as(api, admin).post(`${A}/${id}/reject`, {
        remarks: 'Not enough evidence',
      });
      expect(res.status).toBe(200);
      expect(res.body.status).toBe('REJECTED');
      expect(await bookingStatus(b.id)).toBe('ACTIVE');
      expect((await as(api, admin).post(`${A}/${id}/approve`, {})).status).toBe(409);
      // The customer can ask again.
      expect((await request(b.id)).status).toBe(201);
    });

    it('keeps view, manage and candidate permissions separate and keeps others out', async () => {
      const b = await active();
      const id = (await request(b.id)).body.id as string;
      const viewer = await loginAdminWithPermissions(api, ['replacement.view']);
      const manager = await loginAdminWithPermissions(api, ['replacement.manage']);
      const matcher = await loginAdminWithPermissions(api, ['replacement.view', 'matching.run']);
      expect((await as(api, viewer).get(`${A}/${id}`)).status).toBe(200);
      expect((await as(api, manager).get(`${A}/${id}`)).status).toBe(403);
      expect((await as(api, viewer).post(`${A}/${id}/approve`, {})).status).toBe(403);
      expect((await as(api, viewer).get(`${A}/${id}/candidates`)).status).toBe(403);
      expect((await as(api, matcher).get(`${A}/${id}/candidates`)).status).toBe(200);
      expect((await as(api, manager).post(`${A}/${id}/approve`, {})).status).toBe(200);
      expect((await as(api, customer).get(A)).status).toBe(403);
      expect((await as(api, b.worker).get(A)).status).toBe(403);
      expect((await api.http().get(A)).status).toBe(401);
      expect((await as(api, viewer).get(`${A}?bookingId=${b.id}`)).body.meta.total).toBe(1);
      expect((await as(api, viewer).get(`${A}/${UNKNOWN_ID}`)).status).toBe(404);
    });

    it('offers alternative workers for the booking requirement, never the worker being replaced, and audits the search', async () => {
      const { b, id } = await approved();
      const other = await alternative();
      const res = await as(api, admin).get(`${A}/${id}/candidates?limit=100`).expect(200);
      const ids = res.body.data.map((c: { workerId: string }) => c.workerId);
      expect(ids).toContain(other.workerId);
      expect(ids).not.toContain(b.worker.workerId);
      expect(res.body.ranked).toBe(false);
      expect(
        await api.prisma.auditLog.count({
          where: { action: 'matching.candidates', actorId: admin.userId },
        }),
      ).toBeGreaterThan(0);
    });
  });

  describe('selecting the replacement', () => {
    it('creates the replacement booking, closes the old one as REPLACED, and notifies', async () => {
      const { b, id } = await approved();
      const other = await alternative();
      const res = await as(api, customer).post(`${R}/${id}/select`, { workerId: other.workerId });
      expect(res.status).toBe(200);
      expect(res.body.status).toBe('COMPLETED');
      expect(res.body.replacementBookingId).toBeTruthy();
      expect(await bookingStatus(b.id)).toBe('REPLACED');
      const created = (
        await as(api, customer).get(`/api/v1/bookings/${res.body.replacementBookingId}`)
      ).body;
      expect(created).toMatchObject({
        status: 'MATCHED',
        workerId: other.workerId,
        replacesBookingId: b.id,
        engagement: 'PART_TIME',
        availableFrom: '09:00',
        availableTo: '12:00',
      });
      expect((await as(api, other).get(`/api/v1/workers/me/bookings/${created.id}`)).status).toBe(
        200,
      );
      // The old worker no longer works on a replaced booking.
      expect(
        (
          await as(api, b.worker).post(`/api/v1/workers/me/attendance/bookings/${b.id}`, {
            status: 'PRESENT',
          })
        ).status,
      ).toBe(409);
      const events = await api.prisma.outboxEvent.findMany({
        where: { payload: { path: ['params', 'replacementId'], equals: id } },
      });
      expect(
        events.map((e) => (e.payload as { params: { status: string } }).params.status).sort(),
      ).toEqual(['APPROVED', 'COMPLETED', 'REQUESTED']);
      expect(
        await api.prisma.auditLog.count({
          where: { entityId: id, action: 'replacement.complete' },
        }),
      ).toBe(1);
    });

    it('repeats safely with the same worker and refuses a different one afterwards', async () => {
      const { id } = await approved();
      const other = await alternative();
      const another = await alternative();
      const first = await as(api, customer).post(`${R}/${id}/select`, { workerId: other.workerId });
      const again = await as(api, customer).post(`${R}/${id}/select`, { workerId: other.workerId });
      expect(again.status).toBe(200);
      expect(again.body.replacementBookingId).toBe(first.body.replacementBookingId);
      expect(
        (await as(api, customer).post(`${R}/${id}/select`, { workerId: another.workerId })).status,
      ).toBe(409);
    });

    it('lets only one of many parallel selections win', async () => {
      const { b, id } = await approved();
      const workers = [await alternative(), await alternative(), await alternative()];
      const results = await Promise.all(
        workers.flatMap((w) =>
          [1, 2].map(() => as(api, customer).post(`${R}/${id}/select`, { workerId: w.workerId })),
        ),
      );
      expect(results.filter((r) => r.status === 200).length).toBeGreaterThanOrEqual(1);
      expect(await api.prisma.booking.count({ where: { replacesBookingId: b.id } })).toBe(1);
      const done = await api.prisma.replacementRequest.findUniqueOrThrow({ where: { id } });
      expect(done.status).toBe('COMPLETED');
    });

    it('needs approval first, a different worker, and an eligible one', async () => {
      const b = await active();
      const id = (await request(b.id)).body.id as string;
      const other = await alternative();
      const early = await as(api, customer).post(`${R}/${id}/select`, { workerId: other.workerId });
      expect(early.status).toBe(409);
      await as(api, admin).post(`${A}/${id}/approve`, {}).expect(200);
      const same = await as(api, customer).post(`${R}/${id}/select`, {
        workerId: b.worker.workerId,
      });
      expect(same.status).toBe(422);
      expect(same.body.code).toBe('SAME_WORKER');
      const unverified = await onboardWorker(api, { areaIds: [area.id] });
      for (const workerId of [unverified.workerId, UNKNOWN_ID]) {
        const res = await as(api, customer).post(`${R}/${id}/select`, { workerId });
        expect(res.status).toBe(422);
        expect(res.body.code).toBe('WORKER_NOT_ELIGIBLE');
      }
      expect((await as(api, customer).post(`${R}/${id}/select`, { workerId: 'nope' })).status).toBe(
        400,
      );
      expect(await bookingStatus(b.id)).toBe('REPLACEMENT_REQUESTED');
      expect(await api.prisma.booking.count({ where: { replacesBookingId: b.id } })).toBe(0);
    });

    it("cannot be done by someone else's customer, and staff can do it on the customer behalf", async () => {
      const { id } = await approved();
      const other = await alternative();
      const stranger = await loginWithOtp(api, { appType: 'CUSTOMER' });
      expect(
        (await as(api, stranger).post(`${R}/${id}/select`, { workerId: other.workerId })).status,
      ).toBe(404);
      const manager = await loginAdminWithPermissions(api, ['replacement.manage']);
      const res = await as(api, manager).post(`${A}/${id}/select`, { workerId: other.workerId });
      expect(res.status).toBe(200);
      expect(res.body.status).toBe('COMPLETED');
      const audit = await api.prisma.auditLog.findFirstOrThrow({
        where: { entityId: id, action: 'replacement.complete' },
      });
      expect(audit.actorId).toBe(manager.userId);
    });
  });

  describe('withdrawing and cancelling', () => {
    it('lets the customer withdraw an open request, returning the booking to ACTIVE, and repeats safely', async () => {
      const b = await active();
      const id = (await request(b.id)).body.id as string;
      const res = await as(api, customer).post(`${R}/${id}/cancel`);
      expect(res.status).toBe(200);
      expect(res.body.status).toBe('CANCELLED');
      expect(await bookingStatus(b.id)).toBe('ACTIVE');
      expect((await as(api, customer).post(`${R}/${id}/cancel`)).status).toBe(200);
      expect(
        await api.prisma.auditLog.count({ where: { entityId: id, action: 'replacement.cancel' } }),
      ).toBe(1);
      const stranger = await loginWithOtp(api, { appType: 'CUSTOMER' });
      expect((await as(api, stranger).post(`${R}/${id}/cancel`)).status).toBe(404);
    });

    it('cannot withdraw a finished request', async () => {
      const { id } = await approved();
      const other = await alternative();
      await as(api, customer).post(`${R}/${id}/select`, { workerId: other.workerId }).expect(200);
      expect((await as(api, customer).post(`${R}/${id}/cancel`)).status).toBe(409);
    });

    it('closes the open request when the booking itself is cancelled', async () => {
      const b = await active();
      const id = (await request(b.id)).body.id as string;
      await as(api, customer)
        .post(`/api/v1/bookings/${b.id}/cancel`, { reason: 'No longer needed' })
        .expect(200);
      expect((await as(api, customer).get(`${R}/${id}`)).body.status).toBe('CANCELLED');
      expect(await bookingStatus(b.id)).toBe('CANCELLED');
    });
  });

  describe('customer workflow (requests 37-44)', () => {
    const history = async (id: string) =>
      (await as(api, customer).get(`${R}/${id}`).expect(200)).body as {
        status: string;
        decisionMessage: string | null;
        timeline: Array<{ status: string; actor: string; remarks: string | null; at: string }>;
      };

    it('finds the requests of one booking and shows the persisted timeline', async () => {
      const b = await active();
      const other = await active();
      const first = (await request(b.id)).body.id as string;
      await request(other.id);
      const byBooking = await as(api, customer).get(`${R}?bookingId=${b.id}`).expect(200);
      expect(byBooking.body.data.map((r: { id: string }) => r.id)).toEqual([first]);
      expect(byBooking.body.meta.total).toBe(1);
      expect((await as(api, customer).get(`${R}?bookingId=nope`)).status).toBe(400);
      const stranger = await loginWithOtp(api, { appType: 'CUSTOMER' });
      expect((await as(api, stranger).get(`${R}?bookingId=${b.id}`)).body.data).toEqual([]);

      await as(api, admin)
        .post(`${A}/${first}/approve`, { remarks: 'internal note', message: 'Eligible' })
        .expect(200);
      const detail = await history(first);
      expect(detail.timeline.map((t) => [t.status, t.actor, t.remarks])).toEqual([
        ['REQUESTED', 'CUSTOMER', null],
        ['APPROVED', 'STAFF', 'Eligible'],
      ]);
      expect(detail).not.toHaveProperty('reviewEta');
      const rows = await api.prisma.auditLog.findMany({
        where: { entityId: first, action: { startsWith: 'replacement.' } },
      });
      expect(rows).toHaveLength(2);
    });

    it('with no alternative the request stays open, staff are alerted once, and the alert closes when one appears (FM-11)', async () => {
      const { id } = await approved();
      const search = api.app.get(SearchService);
      const spy = jest.spyOn(search, 'findEligible').mockResolvedValue({ items: [], total: 0 });
      try {
        await as(api, customer).get(`${R}/${id}/alternatives`).expect(200);
        await as(api, customer).get(`${R}/${id}/alternatives`).expect(200);
      } finally {
        spy.mockRestore();
      }
      const alerts = await api.prisma.adminAlert.findMany({ where: { entityId: id } });
      expect(alerts).toHaveLength(1);
      expect(alerts[0]).toMatchObject({
        type: 'REPLACEMENT_NO_ALTERNATIVE',
        status: 'OPEN',
        requiredPermission: 'replacement.manage',
      });
      expect(
        (await api.prisma.replacementRequest.findUniqueOrThrow({ where: { id } })).status,
      ).toBe('APPROVED');
      await alternative();
      await as(api, customer).get(`${R}/${id}/alternatives`).expect(200);
      expect(
        (await api.prisma.adminAlert.findFirstOrThrow({ where: { entityId: id } })).status,
      ).toBe('RESOLVED');
    });

    it('lists alternatives only for the owner of an APPROVED request, and selection uses one of them', async () => {
      const b = await active();
      const id = (await request(b.id)).body.id as string;
      const eligible = await alternative();
      const unverified = await onboardWorker(api, { areaIds: [area.id] });
      const url = `${R}/${id}/alternatives`;
      // Not approved yet.
      const early = await as(api, customer).get(url);
      expect(early.status).toBe(409);
      expect(early.body.code).toBe('INVALID_TRANSITION');
      await as(api, admin).post(`${A}/${id}/approve`, {}).expect(200);

      const res = await as(api, customer).get(`${url}?limit=100`).expect(200);
      const ids = res.body.data.map((c: { workerId: string }) => c.workerId);
      expect(ids).toContain(eligible.workerId);
      expect(ids).not.toContain(b.worker.workerId);
      expect(ids).not.toContain(unverified.workerId);
      expect(res.body.data[0]).not.toHaveProperty('userId');
      // customer-safe card: first name and last initial only (D-91), never the surname
      expect(res.body.data[0].name).toMatch(/^\S+( \S\.)?$/);
      expect(JSON.stringify(res.body.data)).not.toContain('Kumar');
      expect(res.body.meta.total).toBeGreaterThanOrEqual(1);

      const stranger = await loginWithOtp(api, { appType: 'CUSTOMER' });
      expect((await as(api, stranger).get(url)).status).toBe(404);
      expect((await as(api, b.worker).get(url)).status).toBe(403);
      expect((await as(api, admin).get(url)).status).toBe(403);
      expect((await api.http().get(url)).status).toBe(401);
      expect((await as(api, customer).get(`${R}/${UNKNOWN_ID}/alternatives`)).status).toBe(404);

      const done = await as(api, customer)
        .post(`${R}/${id}/select`, { workerId: eligible.workerId })
        .expect(200);
      const detail = await history(id);
      expect(detail.timeline.map((t) => [t.status, t.actor])).toEqual([
        ['REQUESTED', 'CUSTOMER'],
        ['APPROVED', 'STAFF'],
        ['COMPLETED', 'CUSTOMER'],
      ]);
      // Closed requests no longer list alternatives.
      expect((await as(api, customer).get(url)).status).toBe(409);

      // Post-selection state: a NEW booking at MATCHED with no payment, the old one REPLACED and linked.
      const created = await api.prisma.booking.findUniqueOrThrow({
        where: { id: done.body.replacementBookingId },
      });
      expect(created).toMatchObject({ status: 'MATCHED', replacesBookingId: b.id });
      expect(
        await api.prisma.payment.count({ where: { bookingId: done.body.replacementBookingId } }),
      ).toBe(0);
      expect((await api.prisma.booking.findUniqueOrThrow({ where: { id: b.id } })).status).toBe(
        'REPLACED',
      );
    });

    it('a rejection is final for that request, is explained to the customer, and a new request is allowed', async () => {
      const b = await active();
      const id = (await request(b.id)).body.id as string;
      await as(api, admin)
        .post(`${A}/${id}/reject`, {
          remarks: 'Not enough evidence',
          message: 'We could not verify the complaint',
        })
        .expect(200);
      const detail = await history(id);
      expect(detail.decisionMessage).toBe('We could not verify the complaint');
      expect(JSON.stringify(detail)).not.toContain('Not enough evidence');
      expect(detail.timeline.map((t) => [t.status, t.actor, t.remarks])).toEqual([
        ['REQUESTED', 'CUSTOMER', null],
        ['REJECTED', 'STAFF', 'We could not verify the complaint'],
      ]);
      const alt = await alternative();
      for (const call of [
        () => as(api, customer).get(`${R}/${id}/alternatives`),
        () => as(api, customer).post(`${R}/${id}/select`, { workerId: alt.workerId }),
        () => as(api, customer).post(`${R}/${id}/cancel`),
        () => as(api, admin).post(`${A}/${id}/approve`, {}),
      ]) {
        const res = await call();
        expect(res.status).toBe(409);
        expect(res.body.code).toBe('INVALID_TRANSITION');
      }
      expect(await bookingStatus(b.id)).toBe('ACTIVE');
      expect((await request(b.id)).status).toBe(201);
    });

    it('uses stable error codes for duplicate, ineligible, unavailable and stale operations', async () => {
      const { b, id } = await approved();
      const dup = await request(b.id);
      expect(dup.status).toBe(409);
      expect(dup.body.code).toBe('REPLACEMENT_ALREADY_OPEN');

      const unverified = await onboardWorker(api, { areaIds: [area.id] });
      const ineligible = await as(api, customer).post(`${R}/${id}/select`, {
        workerId: unverified.workerId,
      });
      expect([ineligible.status, ineligible.body.code]).toEqual([422, 'WORKER_NOT_ELIGIBLE']);

      // A worker who is eligible but already booked for the same hours.
      const busy = await alternative();
      const otherCustomer = await loginWithOtp(api, { appType: 'CUSTOMER' });
      await makeBooking(api, admin, otherCustomer, area.id, 'ACTIVE', busy);
      const unavailable = await as(api, customer).post(`${R}/${id}/select`, {
        workerId: busy.workerId,
      });
      expect([unavailable.status, unavailable.body.code]).toEqual([409, 'WORKER_UNAVAILABLE']);
      expect(await bookingStatus(b.id)).toBe('REPLACEMENT_REQUESTED');

      // Cancel is allowed while open, then stale for every later action.
      await as(api, customer).post(`${R}/${id}/cancel`).expect(200);
      const detail = await history(id);
      expect(detail.timeline.map((t) => t.status)).toEqual(['REQUESTED', 'APPROVED', 'CANCELLED']);
      const alt = await alternative();
      const stale = await as(api, customer).post(`${R}/${id}/select`, { workerId: alt.workerId });
      expect([stale.status, stale.body.code]).toEqual([409, 'INVALID_TRANSITION']);
    });

    it('records a booking cancellation as a SYSTEM timeline entry', async () => {
      const b = await active();
      const id = (await request(b.id)).body.id as string;
      await as(api, customer)
        .post(`/api/v1/bookings/${b.id}/cancel`, { reason: 'No longer needed' })
        .expect(200);
      const detail = await history(id);
      expect(detail.timeline.map((t) => [t.status, t.actor])).toEqual([
        ['REQUESTED', 'CUSTOMER'],
        ['CANCELLED', 'SYSTEM'],
      ]);
    });
  });

  describe('reason codes and reference data (Q-107)', () => {
    it('publishes the fixed reasons and stores the chosen code', async () => {
      const ref = await api.http().get('/api/v1/reference-data').expect(200);
      const reasons = (ref.body.data ?? ref.body).replacementReasons as Array<{
        code: string;
        label: string;
      }>;
      expect(reasons.map((x) => x.code)).toEqual([
        'WORK_QUALITY',
        'BEHAVIOUR',
        'ATTENDANCE',
        'MISMATCH',
        'WORKER_UNAVAILABLE',
        'OTHER',
      ]);
      const b = await active();
      const res = await as(api, customer)
        .post(R, { bookingId: b.id, reasonCode: 'ATTENDANCE' })
        .expect(201);
      expect(res.body).toMatchObject({
        reasonCode: 'ATTENDANCE',
        reason: reasons.find((x) => x.code === 'ATTENDANCE')!.label,
        notes: null,
      });
      const row = await api.prisma.replacementRequest.findUniqueOrThrow({
        where: { id: res.body.id },
      });
      expect(row.reasonCode).toBe('ATTENDANCE');
    });

    it('keeps older clients working and rejects unknown codes, OTHER without detail and long notes', async () => {
      const b = await active();
      const legacy = await request(b.id);
      expect(legacy.status).toBe(201);
      expect(legacy.body.reasonCode).toBe('OTHER');
      await as(api, customer).post(`${R}/${legacy.body.id}/cancel`).expect(200);
      for (const body of [
        { reasonCode: 'NOPE' },
        { reasonCode: 'OTHER' },
        {},
        { reasonCode: 'BEHAVIOUR', notes: 'x'.repeat(2001) },
      ]) {
        const res = await as(api, customer).post(R, { bookingId: b.id, ...body });
        expect([res.status, body]).toEqual([400, body]);
      }
      const ok = await as(api, customer).post(R, {
        bookingId: b.id,
        reasonCode: 'BEHAVIOUR',
        notes: 'x'.repeat(2000),
      });
      expect(ok.status).toBe(201);
    });

    it('keeps internal remarks away from customers but visible to staff, with audit history', async () => {
      const b = await active();
      const id = (await request(b.id)).body.id as string;
      const res = await as(api, admin)
        .post(`${A}/${id}/approve`, { remarks: 'internal only', message: 'Go ahead' })
        .expect(200);
      expect(res.body).toMatchObject({
        decisionRemarks: 'internal only',
        decisionMessage: 'Go ahead',
      });
      const mine = (await as(api, customer).get(`${R}/${id}`)).body;
      const listed = (await as(api, customer).get(`${R}?bookingId=${b.id}`)).body.data[0];
      for (const view of [mine, listed]) {
        expect(view.decisionMessage).toBe('Go ahead');
        expect(JSON.stringify(view)).not.toContain('internal only');
      }
      expect(
        await api.prisma.auditLog.count({ where: { entityId: id, action: 'replacement.approve' } }),
      ).toBe(1);
    });
  });

  describe('database invariants', () => {
    it('refuses a second open request and an inconsistent completion', async () => {
      const b = await active();
      const id = (await request(b.id)).body.id as string;
      const run = (sql: string) => api.prisma.$executeRawUnsafe(sql);
      await expect(
        run(
          `INSERT INTO replacement_requests (id, booking_id, requested_by_user_id, reason, updated_at) VALUES (gen_random_uuid(), '${b.id}', '${customer.userId}', 'x', now())`,
        ),
      ).rejects.toThrow();
      await expect(
        run(`UPDATE replacement_requests SET status = 'COMPLETED' WHERE id = '${id}'`),
      ).rejects.toThrow();
      await expect(
        run(
          `UPDATE replacement_requests SET status = 'REJECTED', decided_by_user_id = '${admin.userId}', decided_at = now() WHERE id = '${id}'`,
        ),
      ).rejects.toThrow();
      await expect(
        run(`UPDATE bookings SET status = 'REPLACED' WHERE id = '${UNKNOWN_ID}'`),
      ).resolves.toBe(0);
    });
  });
});
