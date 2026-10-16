import '../support/env-api-integration';
// Operational thresholds are configuration; the suite turns them on so the scheduled rules can be exercised.
process.env.WORKER_RESPONSE_HOURS = '2';
process.env.PENDING_PAYMENT_ALERT_HOURS = '1';
process.env.PENDING_PAYMENT_AUTO_CANCEL_HOURS = '3';
process.env.SUPPORT_SLA_HOURS_DEFAULT = '4';
process.env.SUPPORT_SLA_HOURS_HIGH = '1';
process.env.APP_MIN_VERSION_CUSTOMER = '1.2.0';
process.env.APP_STORE_URL_CUSTOMER = 'https://play.google.com/store/apps/details?id=test.customer';
process.env.SUPPORT_CONTACT_PHONE = '+911234567890';

import { randomUUID } from 'node:crypto';
import { HeartbeatService } from '../../src/infrastructure/cache/heartbeat.service';
import { AlertsService } from '../../src/modules/alerts/alerts.service';
import { BookingSweepService } from '../../src/modules/booking/booking-sweep.service';
import { NotificationsService } from '../../src/modules/notifications/notifications.service';
import { SupportService } from '../../src/modules/support/support.service';
import {
  ApiApp,
  bearer,
  createApiApp,
  loginAdmin,
  loginAdminWithPermissions,
  loginWithOtp,
  unique,
} from '../support/api-app';
import { ensureFee, fakeGateway, makeBooking } from '../support/bookings';
import {
  approveCheck,
  as,
  createArea,
  onboardWorker,
  OnboardedWorker,
  setRequiredChecks,
} from '../support/workforce';

const B = '/api/v1/bookings';
const W = '/api/v1/workers/me/bookings';
const A = '/api/v1/admin';
const UNKNOWN_ID = '00000000-0000-7000-8000-000000000000';

type Session = Awaited<ReturnType<typeof loginWithOtp>>;

describe('Gap closing (integration)', () => {
  let api: ApiApp;
  let admin: Awaited<ReturnType<typeof loginAdmin>>;
  let area: { id: string; name: string; city: string };
  let customer: Session;
  let addressId: string;

  const tomorrow = (days = 1): string =>
    new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);
  const yesterday = (): string => tomorrow(-1);
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
  const create = (body: object, caller: { accessToken: string } = customer) =>
    as(api, caller).post(B, body);
  const status = async (id: string): Promise<string> =>
    (await as(api, customer).get(`${B}/${id}`)).body.status as string;
  const events = async (key: 'bookingId' | 'ticketId', id: string): Promise<string[]> => {
    const rows = await api.prisma.outboxEvent.findMany({
      where: { payload: { path: ['params', key], equals: id } },
      orderBy: { createdAt: 'asc' },
    });
    return rows.map((r) => (r.payload as { event: string }).event);
  };
  /** The outbox is dispatched in batches and earlier suites leave a backlog: run until it is empty. */
  const drain = async (): Promise<void> => {
    for (let i = 0; i < 400; i++) {
      if ((await api.app.get(NotificationsService).dispatchOutbox()).events === 0) return;
    }
  };
  const ageBooking = (id: string, hours: number) =>
    api.prisma
      .$executeRaw`UPDATE bookings SET updated_at = now() - make_interval(hours => ${hours}) WHERE id = ${id}::uuid`;
  const alertsOf = (entityId: string) =>
    api.prisma.adminAlert.findMany({ where: { entityId }, orderBy: { createdAt: 'asc' } });

  async function newCustomer(): Promise<Session & { addressId: string }> {
    const session = await loginWithOtp(api, { appType: 'CUSTOMER' });
    await as(api, session)
      .post('/api/v1/customers/me', {
        name: 'Asha Rao',
        email: `asha.${unique()}@example.test`,
        preferredLanguage: 'en',
      })
      .expect(201);
    const res = await as(api, session)
      .post('/api/v1/customers/me/addresses', {
        line: '12 Lake View Road',
        area: area.name,
        city: area.city,
        pincode: '500081',
      })
      .expect(201);
    return { ...session, addressId: (res.body as { id: string }).id };
  }

  beforeAll(async () => {
    api = await createApiApp();
    admin = await loginAdmin(api);
    area = await createArea(api, admin);
    const c = await newCustomer();
    customer = c;
    addressId = c.addressId;
    await setRequiredChecks(api, admin, ['IDENTITY']);
    await ensureFee(api, admin);
  });

  afterAll(async () => {
    await setRequiredChecks(api, admin, []);
    await api.close();
  });

  // ------------------------------------------------------------------------------------------------------------
  describe('booking request details (PRD 5.2)', () => {
    it('records address, start date, budget and note; the worker sees the summary but never the address', async () => {
      const worker = await verifiedWorker();
      const res = await create(
        requirement({
          workerId: worker.workerId,
          addressId,
          startDate: tomorrow(3),
          budgetMinMinor: 800000,
          budgetMaxMinor: 1200000,
          budgetPeriod: 'MONTH',
          requirementNote: 'Please cook vegetarian meals',
        }),
      );
      expect(res.status).toBe(201);
      expect(res.body).toMatchObject({
        addressId,
        requestedStartDate: tomorrow(3),
        budgetMinMinor: 800000,
        budgetMaxMinor: 1200000,
        budgetPeriod: 'MONTH',
        requirementNote: 'Please cook vegetarian meals',
      });
      const seen = await as(api, worker).get(`${W}/${res.body.id}`).expect(200);
      expect(seen.body).toMatchObject({
        requestedStartDate: tomorrow(3),
        budgetMinMinor: 800000,
        requirementNote: 'Please cook vegetarian meals',
      });
      expect(Object.keys(seen.body as object)).not.toContain('addressId');
      expect(JSON.stringify(seen.body)).not.toContain('Lake View');
    });

    it('accepts MONTHLY as an alias of the monthly budget period (DEC-07)', async () => {
      const res = await create(
        requirement({ budgetMinMinor: 100000, budgetPeriod: 'MONTHLY', engagement: 'FULL_TIME' }),
      );
      expect(res.status).toBe(201);
      expect(res.body.budgetPeriod).toBe('MONTH');
      expect(res.body.engagement).toBe('FULL_TIME');
      expect(
        (await create(requirement({ budgetMinMinor: 100000, budgetPeriod: 'FORTNIGHTLY' }))).status,
      ).toBe(400);
    });

    it('with no matching worker the search offers admin matching, and a request without workerId alerts staff (FM-03)', async () => {
      const emptyArea = await createArea(api, admin);
      const search = await as(api, customer)
        .get(`/api/v1/search/workers?category=HOUSE_MAID&areaId=${emptyArea.id}`)
        .expect(200);
      expect(search.body.meta.total).toBe(0);
      expect(search.body.canRequestAdminMatching).toBe(true);
      const worker = await verifiedWorker();
      const found = await as(api, customer)
        .get(`/api/v1/search/workers?category=HOUSE_MAID&areaId=${area.id}`)
        .expect(200);
      expect(found.body.data.map((w: { workerId: string }) => w.workerId)).toContain(
        worker.workerId,
      );
      expect(found.body.canRequestAdminMatching).toBe(false);

      const asked = await create({
        category: 'HOUSE_MAID',
        areaId: emptyArea.id,
        engagement: 'PART_TIME',
        availableFrom: '09:00',
        availableTo: '12:00',
      });
      expect(asked.status).toBe(201);
      expect(asked.body.status).toBe('NEW_REQUEST');
      expect(asked.body.workerId ?? null).toBeNull();
      const [alert] = await alertsOf(asked.body.id as string);
      expect(alert).toMatchObject({
        type: 'BOOKING_NEEDS_MATCH',
        status: 'OPEN',
        requiredPermission: 'booking.manage',
      });
    });

    it('refuses bad input before anything is stored', async () => {
      const stranger = await newCustomer();
      const before = await api.prisma.booking.count({ where: { customerUserId: customer.userId } });
      const cases: Array<[object, number, string?]> = [
        [{ addressId: stranger.addressId }, 404, 'ADDRESS_NOT_FOUND'],
        [{ addressId: UNKNOWN_ID }, 404, 'ADDRESS_NOT_FOUND'],
        [{ startDate: yesterday() }, 400],
        [{ startDate: '2026-02-31' }, 400],
        [{ startDate: 'tomorrow' }, 400],
        [{ budgetMinMinor: 500, budgetMaxMinor: 100 }, 400],
        [{ budgetMinMinor: -1 }, 400],
        [{ budgetPeriod: 'MONTH' }, 400],
        [{ budgetMinMinor: 100, budgetPeriod: 'FORTNIGHT' }, 400],
        [{ requirementNote: '<script>alert(1)</script>' }, 400],
        [{ requirementNote: 'x'.repeat(501) }, 400],
      ];
      for (const [extra, code, errorCode] of cases) {
        const res = await create(requirement(extra));
        expect([extra, res.status]).toEqual([extra, code]);
        if (errorCode) expect(res.body.code).toBe(errorCode);
      }
      expect(await api.prisma.booking.count({ where: { customerUserId: customer.userId } })).toBe(
        before,
      );
    });

    it('refuses a removed address and an address outside the area city', async () => {
      const own = await newCustomer();
      const other = await as(api, own)
        .post('/api/v1/customers/me/addresses', {
          line: '1 Far Away Street',
          area: 'Elsewhere',
          city: 'Some Other City',
          pincode: '110001',
        })
        .expect(201);
      const outside = await create(requirement({ addressId: other.body.id }), own);
      expect(outside.status).toBe(422);
      expect(outside.body.code).toBe('OUTSIDE_SERVICE_AREA');
      await as(api, own).delete(`/api/v1/customers/me/addresses/${own.addressId}`).expect(204);
      const removed = await create(requirement({ addressId: own.addressId }), own);
      expect(removed.status).toBe(404);
    });

    it('treats a replay with a changed detail as a different request', async () => {
      const key = `k-${unique()}`;
      const body = requirement({ startDate: tomorrow(5), requirementNote: 'one' });
      const first = await as(api, customer).post(B, body).set('Idempotency-Key', key);
      expect(first.status).toBe(201);
      const again = await api
        .http()
        .post(B)
        .set('Authorization', bearer(customer))
        .set('Idempotency-Key', key)
        .send(body);
      expect(again.status).toBe(200);
      const changed = await api
        .http()
        .post(B)
        .set('Authorization', bearer(customer))
        .set('Idempotency-Key', key)
        .send({ ...body, requirementNote: 'two' });
      expect(changed.status).toBe(409);
      expect(changed.body.code).toBe('IDEMPOTENCY_KEY_REUSED');
    });

    it.each(['DAILY', 'HOURLY', 'SHIFT', 'ONE_TIME'])(
      'supports the %s engagement from worker preference to booking and search',
      async (engagement) => {
        const worker = await verifiedWorker({ engagement });
        const search = await as(api, customer)
          .get(
            `/api/v1/search/workers?category=HOUSE_MAID&areaId=${area.id}&engagement=${engagement}`,
          )
          .expect(200);
        expect(search.body.data.map((w: { workerId: string }) => w.workerId)).toContain(
          worker.workerId,
        );
        const booked = await create(requirement({ engagement, workerId: worker.workerId }));
        expect(booked.status).toBe(201);
        expect(booked.body.engagement).toBe(engagement);
      },
    );

    it('rejects an unknown engagement and an unknown sort (never interpolated)', async () => {
      expect((await create(requirement({ engagement: 'FORTNIGHTLY' }))).status).toBe(400);
      const base = `/api/v1/search/workers?category=HOUSE_MAID&areaId=${area.id}`;
      expect((await as(api, customer).get(`${base}&sort=name;DROP TABLE users`)).status).toBe(400);
      expect((await as(api, customer).get(`${base}&sort=RATING_DESC`)).status).toBe(200);
      expect((await as(api, customer).get(`${base}&minRating=0`)).status).toBe(400);
      expect((await as(api, customer).get(`${base}&minRating=4`)).status).toBe(200);
    });
  });

  // ------------------------------------------------------------------------------------------------------------
  describe('worker response, notifications and scheduled booking checks', () => {
    it('lets the matched worker accept once; the customer is told; strangers and wrong states are refused', async () => {
      const worker = await verifiedWorker();
      const other = await verifiedWorker();
      const id = (await create(requirement({ workerId: worker.workerId }))).body.id as string;
      const matched = await api.prisma.booking.findUniqueOrThrow({ where: { id } });
      expect(matched.workerRespondedAt).toBeNull();
      // respond-by = now + WORKER_RESPONSE_HOURS (2)
      expect(matched.respondBy!.getTime() - Date.now()).toBeGreaterThan(110 * 60_000);
      expect(matched.respondBy!.getTime() - Date.now()).toBeLessThan(121 * 60_000);

      expect((await as(api, customer).post(`${W}/${id}/accept`)).status).toBe(403);
      expect((await as(api, other).post(`${W}/${id}/accept`)).status).toBe(404);
      const accepted = await as(api, worker).post(`${W}/${id}/accept`);
      expect(accepted.status).toBe(200);
      expect(accepted.body.workerRespondedAt).not.toBeNull();
      await as(api, worker).post(`${W}/${id}/accept`).expect(200);
      expect((await events('bookingId', id)).filter((e) => e === 'WORKER_ACCEPTED')).toHaveLength(
        1,
      );
      expect(
        await api.prisma.bookingEvent.count({ where: { bookingId: id, note: 'worker accepted' } }),
      ).toBe(1);

      await as(api, worker)
        .post(`${W}/${id}/schedule`, {
          scheduleType: 'INTERVIEW',
          scheduledAt: new Date(Date.now() + 86_400_000).toISOString(),
        })
        .expect(200);
      expect((await as(api, worker).post(`${W}/${id}/accept`)).status).toBe(409);
      expect((await as(api, worker).post(`${W}/${UNKNOWN_ID}/accept`)).status).toBe(404);
    });

    it('decline: back to staff with a reason, the customer is told and an alert asks someone to re-match', async () => {
      const worker = await verifiedWorker();
      const id = (await create(requirement({ workerId: worker.workerId }))).body.id as string;
      const declined = await as(api, worker).post(`${W}/${id}/decline`, { reason: 'Too far' });
      expect(declined.status).toBe(200);
      expect(declined.body.status).toBe('NEW_REQUEST');
      const after = await api.prisma.booking.findUniqueOrThrow({ where: { id } });
      expect(after).toMatchObject({ workerId: null, respondBy: null, workerRespondedAt: null });
      expect(
        await api.prisma.bookingEvent.count({ where: { bookingId: id, note: 'Too far' } }),
      ).toBe(1);
      expect(await events('bookingId', id)).toContain('WORKER_DECLINED');
      const [alert] = await alertsOf(id);
      expect(alert).toMatchObject({ type: 'BOOKING_NEEDS_MATCH', status: 'OPEN' });
      // staff re-match: the alert closes by itself, and the customer is told about the match
      const next = await verifiedWorker();
      await as(api, admin)
        .post(`${A}/bookings/${id}/match`, { workerId: next.workerId })
        .expect(200);
      expect((await alertsOf(id))[0].status).toBe('RESOLVED');
      expect(await events('bookingId', id)).toContain('BOOKING_MATCHED');
    });

    it('raises a no-response alert once the deadline passes, counts repeats, and closes it when the worker answers', async () => {
      const worker = await verifiedWorker();
      const id = (await create(requirement({ workerId: worker.workerId }))).body.id as string;
      const sweep = api.app.get(BookingSweepService);
      await sweep.runOnce();
      expect(await alertsOf(id)).toHaveLength(0); // deadline not reached
      await api.prisma.booking.update({
        where: { id },
        data: { respondBy: new Date(Date.now() - 1000) },
      });
      await sweep.runOnce();
      await sweep.runOnce();
      const alerts = await alertsOf(id);
      expect(alerts).toHaveLength(1);
      expect(alerts[0]).toMatchObject({
        type: 'BOOKING_NO_RESPONSE',
        status: 'OPEN',
        occurrences: 2,
      });
      // visible in the staff inbox
      const list = await as(api, admin).get(`${A}/alerts?type=BOOKING_NO_RESPONSE`).expect(200);
      expect(list.body.data.map((a: { entityId: string }) => a.entityId)).toContain(id);
      await as(api, worker).post(`${W}/${id}/accept`).expect(200);
      expect((await alertsOf(id))[0].status).toBe('RESOLVED');
      // nothing was reassigned automatically
      expect((await api.prisma.booking.findUniqueOrThrow({ where: { id } })).workerId).toBe(
        worker.workerId,
      );
    });

    it('returns the booking to matching when the worker stays silent past WORKER_REASSIGN_HOURS (decline-equivalent, audited, once)', async () => {
      const worker = await verifiedWorker();
      const id = (await create(requirement({ workerId: worker.workerId }))).body.id as string;
      const sweep = api.app.get(BookingSweepService);
      // Overdue for the alert but not yet for the reassignment (respond-by + 22h = 24h after the match).
      await api.prisma.booking.update({
        where: { id },
        data: { respondBy: new Date(Date.now() - 3 * 3_600_000) },
      });
      expect((await sweep.runOnce()).reassigned).toBe(0);
      expect((await api.prisma.booking.findUniqueOrThrow({ where: { id } })).workerId).toBe(
        worker.workerId,
      );
      await api.prisma.booking.update({
        where: { id },
        data: { respondBy: new Date(Date.now() - 23 * 3_600_000) },
      });
      expect((await sweep.runOnce()).reassigned).toBe(1);
      expect((await sweep.runOnce()).reassigned).toBe(0); // repeating changes nothing
      const after = await api.prisma.booking.findUniqueOrThrow({ where: { id } });
      expect(after).toMatchObject({
        status: 'NEW_REQUEST',
        workerId: null,
        respondBy: null,
        workerRespondedAt: null,
      });
      expect(
        await api.prisma.auditLog.count({
          where: { entityId: id, action: 'booking.auto_reassign' },
        }),
      ).toBe(1);
      expect(await events('bookingId', id)).toContain('WORKER_DECLINED');
      const alerts = await alertsOf(id);
      expect(alerts.find((a) => a.type === 'BOOKING_NEEDS_MATCH')).toMatchObject({
        status: 'OPEN',
      });
      expect(alerts.find((a) => a.type === 'BOOKING_NO_RESPONSE')?.status).toBe('RESOLVED');
      // A worker who answered in time is never reassigned.
      const answered = await verifiedWorker();
      const keep = (await create(requirement({ workerId: answered.workerId }))).body.id as string;
      await as(api, answered).post(`${W}/${keep}/accept`).expect(200);
      await api.prisma.booking.update({
        where: { id: keep },
        data: { respondBy: new Date(Date.now() - 48 * 3_600_000) },
      });
      await sweep.runOnce();
      expect((await api.prisma.booking.findUniqueOrThrow({ where: { id: keep } })).workerId).toBe(
        answered.workerId,
      );
    });

    it('alerts on a booking stuck in PENDING_PAYMENT, then cancels it through the normal path after the configured time', async () => {
      const stuck = await makeBooking(api, admin, customer, area.id, 'PENDING_PAYMENT');
      const started = await as(api, customer)
        .post('/api/v1/payments', { bookingId: stuck.id })
        .expect(201);
      const paid = await makeBooking(api, admin, customer, area.id, 'CONFIRMED');
      const sweep = api.app.get(BookingSweepService);

      await sweep.runOnce();
      expect(await alertsOf(stuck.id)).toHaveLength(0); // just created
      await ageBooking(stuck.id, 2);
      await sweep.runOnce();
      expect(await status(stuck.id)).toBe('PENDING_PAYMENT');
      expect((await alertsOf(stuck.id))[0]).toMatchObject({
        type: 'BOOKING_STUCK_PAYMENT',
        status: 'OPEN',
      });

      await ageBooking(stuck.id, 4);
      await ageBooking(paid.id, 10);
      const run = await sweep.runOnce();
      expect(run.autoCancelled).toBeGreaterThanOrEqual(1);
      expect(await status(stuck.id)).toBe('CANCELLED');
      expect(await status(paid.id)).toBe('CONFIRMED'); // paid bookings are never touched
      expect((await alertsOf(stuck.id))[0].status).toBe('RESOLVED');
      const row = await api.prisma.booking.findUniqueOrThrow({ where: { id: stuck.id } });
      expect(row.cancelReason).toBe('Not paid within 3 hours');
      expect(row.cancelledByUserId).toBeNull();
      const payment = await api.prisma.payment.findUniqueOrThrow({
        where: { id: started.body.id },
      });
      expect(payment).toMatchObject({ status: 'FAILED', failureReason: 'BOOKING_CANCELLED' });
      expect(await events('bookingId', stuck.id)).toContain('BOOKING_CANCELLED');
      // a late payment for it is a money problem, not a normal payment
      const done = fakeGateway(api).completeCheckout(
        started.body.checkout.orderId as string,
        'SUCCEEDED',
      );
      expect(done.providerPaymentId).toBeTruthy();
      await sweep.runOnce(); // idempotent
      expect(await status(stuck.id)).toBe('CANCELLED');
    });

    it('sends lifecycle notifications for every transition that matters', async () => {
      const booking = await makeBooking(api, admin, customer, area.id, 'ACTIVE');
      await as(api, customer).post(`${B}/${booking.id}/complete`).expect(200);
      const names = await events('bookingId', booking.id);
      for (const expected of [
        'JOB_OPPORTUNITY',
        'INTERVIEW_TRIAL_SCHEDULED',
        'INTERVIEW_OUTCOME',
        'BOOKING_PAYMENT_DUE',
        'BOOKING_CONFIRMED',
        'BOOKING_STARTED',
        'BOOKING_COMPLETED',
      ]) {
        expect(names).toContain(expected);
      }
      const cancelled = await makeBooking(api, admin, customer, area.id, 'MATCHED');
      await as(api, customer)
        .post(`${B}/${cancelled.id}/cancel`, { reason: 'changed my mind' })
        .expect(200);
      expect(await events('bookingId', cancelled.id)).toContain('BOOKING_CANCELLED');
    });
  });

  // ------------------------------------------------------------------------------------------------------------
  describe('in-app inbox and templates', () => {
    const template = (eventCode: string, extra: object = {}) =>
      as(api, admin).post(`${A}/notification-templates`, {
        eventCode,
        channel: 'IN_APP',
        title: 'Hello',
        body: 'Booking {{bookingId}} update',
        ...extra,
      });

    it('delivers to the inbox straight away, in the recipient language, with a deep link; read state is per user', async () => {
      await api.prisma.notificationTemplate.deleteMany({
        where: { eventCode: { in: ['BOOKING_MATCHED', 'WORKER_ACCEPTED'] } },
      });
      expect((await template('BOOKING_MATCHED')).status).toBe(201);
      expect((await template('WORKER_ACCEPTED')).status).toBe(201);
      expect(
        (await template('WORKER_ACCEPTED', { language: 'hi', body: 'हिंदी {{bookingId}}' })).status,
      ).toBe(201);
      await api.prisma.notificationTemplate.deleteMany({
        where: { eventCode: 'BOOKING_STARTED', channel: 'SMS' },
      });
      const withDlt = await as(api, admin).post(`${A}/notification-templates`, {
        eventCode: 'BOOKING_STARTED',
        channel: 'SMS',
        body: 'Started {{bookingId}}',
        dltTemplateId: '1007123456789012345',
      });
      expect(withDlt.status).toBe(201);
      expect(withDlt.body.dltTemplateId).toBe('1007123456789012345');

      const worker = await verifiedWorker();
      const fresh = await newCustomer();
      const id = (await create(requirement({ workerId: worker.workerId }), fresh)).body
        .id as string;
      await as(api, worker).post(`${W}/${id}/accept`).expect(200);
      await drain();

      const inbox = await as(api, fresh).get('/api/v1/notifications').expect(200);
      const accepted = inbox.body.data.find(
        (n: { event: string }) => n.event === 'WORKER_ACCEPTED',
      );
      expect(accepted).toMatchObject({
        title: 'Hello',
        body: `Booking ${id} update`,
        route: { type: 'booking', id },
        readAt: null,
      });
      expect(
        (await as(api, fresh).get('/api/v1/notifications/unread-count').expect(200)).body.unread,
      ).toBe(1);
      const row = await api.prisma.notification.findFirstOrThrow({
        where: { recipientUserId: fresh.userId, eventCode: 'WORKER_ACCEPTED' },
      });
      expect(row).toMatchObject({ channel: 'IN_APP', status: 'SENT' });

      // another user cannot read or mark it; the owner can, repeatedly
      const stranger = await newCustomer();
      expect((await as(api, stranger).post(`/api/v1/notifications/${row.id}/read`)).status).toBe(
        404,
      );
      expect((await as(api, fresh).post(`/api/v1/notifications/${UNKNOWN_ID}/read`)).status).toBe(
        404,
      );
      expect((await as(api, fresh).post('/api/v1/notifications/not-a-uuid/read')).status).toBe(400);
      await as(api, fresh).post(`/api/v1/notifications/${row.id}/read`).expect(204);
      await as(api, fresh).post(`/api/v1/notifications/${row.id}/read`).expect(204);
      expect((await as(api, fresh).get('/api/v1/notifications/unread-count')).body.unread).toBe(0);
      expect(
        (await as(api, fresh).get('/api/v1/notifications?unreadOnly=true')).body.data,
      ).toHaveLength(0);
      expect((await as(api, fresh).post('/api/v1/notifications/read-all')).status).toBe(200);
      expect((await api.http().get('/api/v1/notifications')).status).toBe(401);
    });

    it('uses the recipient language where a template exists for it', async () => {
      const worker = await verifiedWorker();
      const fresh = await newCustomer();
      await as(api, fresh).patch('/api/v1/customers/me', { preferredLanguage: 'hi' }).expect(200);
      const id = (await create(requirement({ workerId: worker.workerId }), fresh)).body
        .id as string;
      await as(api, worker).post(`${W}/${id}/accept`).expect(200);
      await drain();
      const inbox = await as(api, fresh).get('/api/v1/notifications').expect(200);
      const accepted = inbox.body.data.find(
        (n: { event: string }) => n.event === 'WORKER_ACCEPTED',
      );
      expect(accepted.body).toBe(`हिंदी ${id}`);
      // an event with no template in that language falls back to the platform default (English)
      const matched = inbox.body.data.find((n: { event: string }) => n.event === 'BOOKING_MATCHED');
      expect(matched).toBeUndefined(); // customer chose the worker: no "matched" message for their own action
    });

    it('validates template placeholders for the new events and the language preference', async () => {
      expect((await template('BOOKING_STARTED', { body: 'Hi {{customerName}}' })).status).toBe(400);
      const worker = await verifiedWorker();
      expect(
        (await as(api, worker).patch('/api/v1/workers/me', { preferredLanguage: 'Not A Lang!' }))
          .status,
      ).toBe(400);
      expect(
        (await as(api, worker).patch('/api/v1/workers/me', { preferredLanguage: null }).expect(200))
          .body.preferredLanguage,
      ).toBeNull();
    });
  });

  // ------------------------------------------------------------------------------------------------------------
  describe('staff alert inbox', () => {
    it('deduplicates, reopens, hides alerts the admin may not see, and audits acknowledge/resolve', async () => {
      const alerts = api.app.get(AlertsService);
      const key = `TEST_ALERT:${randomUUID()}`;
      const entityId = randomUUID();
      const input = {
        dedupeKey: key,
        type: 'TEST_ALERT',
        severity: 'WARNING' as const,
        title: 'Something needs a look',
        entityType: 'thing',
        entityId,
      };
      await alerts.raise(input);
      await alerts.raise(input);
      const rows = await alertsOf(entityId);
      expect(rows).toHaveLength(1);
      expect(rows[0].occurrences).toBe(2);

      const viewer = await loginAdminWithPermissions(api, ['alert.view']);
      const manager = await loginAdminWithPermissions(api, ['alert.view', 'alert.manage']);
      const found = (await as(api, viewer).get(`${A}/alerts?type=TEST_ALERT`).expect(200)).body
        .data;
      const id = found.find((a: { entityId: string }) => a.entityId === entityId).id as string;
      expect((await as(api, viewer).post(`${A}/alerts/${id}/acknowledge`)).status).toBe(403);
      expect((await as(api, customer).get(`${A}/alerts`)).status).toBe(403);
      expect((await api.http().get(`${A}/alerts`)).status).toBe(401);

      const ack = await as(api, manager).post(`${A}/alerts/${id}/acknowledge`).expect(200);
      expect(ack.body.status).toBe('ACKNOWLEDGED');
      await as(api, manager).post(`${A}/alerts/${id}/acknowledge`).expect(200);
      expect((await as(api, manager).post(`${A}/alerts/${id}/resolve`, {})).status).toBe(400);
      const resolved = await as(api, manager).post(`${A}/alerts/${id}/resolve`, {
        note: 'handled',
      });
      expect(resolved.body).toMatchObject({ status: 'RESOLVED', resolutionNote: 'handled' });
      expect(
        (await as(api, manager).post(`${A}/alerts/${id}/resolve`, { note: 'again' })).status,
      ).toBe(409);
      expect(
        await api.prisma.auditLog.count({ where: { entityId: id, action: 'alert.resolve' } }),
      ).toBe(1);

      // the same problem detected again re-opens it
      await alerts.raise(input);
      expect((await alertsOf(entityId))[0]).toMatchObject({ status: 'OPEN', resolvedAt: null });

      // an alert that needs a permission the admin lacks is invisible and answers like an unknown one
      const secretKey = `TEST_ALERT:${randomUUID()}`;
      const secretEntity = randomUUID();
      await alerts.raise({
        ...input,
        dedupeKey: secretKey,
        entityId: secretEntity,
        requiredPermission: 'payment.view',
      });
      const secret = (await alertsOf(secretEntity))[0];
      const visible = (await as(api, manager).get(`${A}/alerts?type=TEST_ALERT&limit=100`)).body
        .data;
      expect(visible.map((a: { id: string }) => a.id)).not.toContain(secret.id);
      expect((await as(api, manager).post(`${A}/alerts/${secret.id}/acknowledge`)).status).toBe(
        404,
      );
      const payer = await loginAdminWithPermissions(api, [
        'alert.view',
        'alert.manage',
        'payment.view',
      ]);
      expect((await as(api, payer).post(`${A}/alerts/${secret.id}/acknowledge`)).status).toBe(200);

      const summary = (await as(api, viewer).get(`${A}/alerts/summary`).expect(200)).body;
      expect(summary.open).toBeGreaterThanOrEqual(1);
      expect(Object.keys(summary.bySeverity as object).sort()).toEqual([
        'CRITICAL',
        'INFO',
        'WARNING',
      ]);
      const dashboard = (await as(api, manager).get(`${A}/dashboard`).expect(200)).body;
      expect(dashboard.sections.alerts.open).toBeGreaterThanOrEqual(1);
    });

    it('money problems also land in the alert inbox, visible to payment viewers, and close with the exception', async () => {
      const booking = await makeBooking(api, admin, customer, area.id, 'PENDING_PAYMENT');
      const started = await as(api, customer)
        .post('/api/v1/payments', { bookingId: booking.id })
        .expect(201);
      await as(api, customer).post(`${B}/${booking.id}/cancel`, { reason: 'x' }).expect(200);
      const done = fakeGateway(api).completeCheckout(
        started.body.checkout.orderId as string,
        'SUCCEEDED',
      );
      const { body, headers } = fakeGateway(api).webhook({
        eventId: `evt_${unique()}`,
        providerOrderId: started.body.checkout.orderId as string,
        providerPaymentId: done.providerPaymentId,
        outcome: 'SUCCEEDED',
        amountMinor: 50000,
      });
      await api
        .http()
        .post('/api/v1/webhooks/payments')
        .set(headers)
        .set('Content-Type', 'application/json')
        .send(body.toString())
        .expect(200);
      const exception = await api.prisma.paymentException.findFirstOrThrow({
        where: { paymentId: started.body.id },
      });
      const [alert] = await alertsOf(exception.id);
      expect(alert).toMatchObject({
        type: 'PAYMENT_EXCEPTION',
        severity: 'CRITICAL',
        status: 'OPEN',
        requiredPermission: 'payment.view',
      });
      await as(api, admin)
        .post(`${A}/payment-exceptions/${exception.id}/resolve`, { note: 'refunded' })
        .expect(200);
      expect((await alertsOf(exception.id))[0].status).toBe('RESOLVED');
    });
  });

  // ------------------------------------------------------------------------------------------------------------
  describe('support conversation and SLA', () => {
    let categoryId: string;
    const raise = async (who: Session = customer, bookingId?: string) =>
      (
        await as(api, who)
          .post('/api/v1/support/tickets', {
            categoryId,
            description: 'Worker did not come',
            bookingId,
          })
          .expect(201)
      ).body as { id: string; dueAt: string | null };

    beforeAll(async () => {
      categoryId = (
        await as(api, admin)
          .post(`${A}/support/categories`, {
            code: `GAP_${unique().toUpperCase().slice(0, 8)}`,
            name: 'General',
          })
          .expect(201)
      ).body.id as string;
    });

    it('lets both sides talk; internal notes stay internal; closed or foreign tickets refuse', async () => {
      const ticket = await raise();
      expect(ticket.dueAt).not.toBeNull(); // SUPPORT_SLA_HOURS_DEFAULT=4
      const hoursLeft = (new Date(ticket.dueAt!).getTime() - Date.now()) / 3_600_000;
      expect(hoursLeft).toBeGreaterThan(3.9);
      expect(hoursLeft).toBeLessThan(4.1);

      const mine = await as(api, customer).post(`/api/v1/support/tickets/${ticket.id}/messages`, {
        body: 'Any update?',
      });
      expect(mine.status).toBe(201);
      expect(mine.body).toMatchObject({ from: 'CUSTOMER', body: 'Any update?' });
      const stranger = await newCustomer();
      expect(
        (
          await as(api, stranger).post(`/api/v1/support/tickets/${ticket.id}/messages`, {
            body: 'hi',
          })
        ).status,
      ).toBe(404);
      expect(
        (await as(api, stranger).get(`/api/v1/support/tickets/${ticket.id}/messages`)).status,
      ).toBe(404);
      for (const bad of ['', '<b>x</b>', 'y'.repeat(2001)]) {
        expect(
          (
            await as(api, customer).post(`/api/v1/support/tickets/${ticket.id}/messages`, {
              body: bad,
            })
          ).status,
        ).toBe(400);
      }

      const support = await loginAdminWithPermissions(api, ['support.view', 'support.manage']);
      const viewer = await loginAdminWithPermissions(api, ['support.view']);
      const base = `${A}/support/tickets/${ticket.id}/messages`;
      expect((await as(api, viewer).post(base, { body: 'x' })).status).toBe(403);
      await as(api, support).post(base, { body: 'We are checking' }).expect(201);
      await as(api, support)
        .post(base, { body: 'Escalate to ops later', internal: true })
        .expect(201);
      expect(await events('ticketId', ticket.id)).toEqual(
        expect.arrayContaining(['TICKET_MESSAGE']),
      );
      expect(
        (await events('ticketId', ticket.id)).filter((e) => e === 'TICKET_MESSAGE'),
      ).toHaveLength(1);

      const seen = (
        await as(api, customer).get(`/api/v1/support/tickets/${ticket.id}/messages`).expect(200)
      ).body;
      expect(seen.data.map((m: { body: string }) => m.body)).toEqual([
        'Any update?',
        'We are checking',
      ]);
      expect(JSON.stringify(seen)).not.toContain('Escalate to ops');
      const staff = (await as(api, viewer).get(base).expect(200)).body;
      expect(staff.data).toHaveLength(3);
      expect(staff.data[2]).toMatchObject({ internal: true });

      await as(api, support)
        .post(`${A}/support/tickets/${ticket.id}/close`, { resolution: 'Sorted' })
        .expect(200);
      expect(
        (
          await as(api, customer).post(`/api/v1/support/tickets/${ticket.id}/messages`, {
            body: 'More',
          })
        ).status,
      ).toBe(409);
      expect((await as(api, support).post(base, { body: 'More' })).status).toBe(409);
      // messages are history: the database refuses edits
      await expect(
        api.prisma
          .$executeRaw`UPDATE support_messages SET body = 'x' WHERE ticket_id = ${ticket.id}::uuid`,
      ).rejects.toThrow();
    });

    it('sets the target from configuration and the priority; flags a breach once and closes the alert on close', async () => {
      const ticket = await raise();
      const support = await loginAdminWithPermissions(api, ['support.view', 'support.manage']);
      const high = await as(api, support)
        .post(`${A}/support/tickets/${ticket.id}/priority`, { priority: 'HIGH' })
        .expect(200);
      const hoursFromCreation =
        (new Date(high.body.dueAt as string).getTime() - Date.now()) / 3_600_000;
      expect(hoursFromCreation).toBeLessThan(1.05);
      expect(hoursFromCreation).toBeGreaterThan(0.9);

      const svc = api.app.get(SupportService);
      expect(await svc.flagSlaBreaches()).toBeGreaterThanOrEqual(0);
      expect((await alertsOf(ticket.id)).length).toBe(0); // not due yet
      await api.prisma
        .$executeRaw`UPDATE support_tickets SET due_at = now() - interval '5 minutes' WHERE id = ${ticket.id}::uuid`;
      await svc.flagSlaBreaches();
      await svc.flagSlaBreaches();
      const [alert] = await alertsOf(ticket.id);
      expect(alert).toMatchObject({
        type: 'SUPPORT_SLA_BREACH',
        severity: 'CRITICAL',
        status: 'OPEN',
        occurrences: 1,
      });
      const row = await api.prisma.supportTicket.findUniqueOrThrow({ where: { id: ticket.id } });
      expect(row.slaBreachedAt).not.toBeNull();
      expect(row.status).toBe('ESCALATED'); // DEC-03: escalated automatically, exactly once
      expect(row.escalatedAt).not.toBeNull();
      const events = await api.prisma.supportTicketEvent.findMany({
        where: { ticketId: ticket.id, type: 'ESCALATED' },
      });
      expect(events).toHaveLength(1);
      expect(events[0].actorUserId).toBeNull();
      expect(
        await api.prisma.auditLog.count({
          where: { entityId: ticket.id, action: 'ticket.auto_escalate' },
        }),
      ).toBe(1);
      const detail = await as(api, support).get(`${A}/support/tickets/${ticket.id}`).expect(200);
      expect(detail.body.slaBreachedAt).not.toBeNull();
      await as(api, support)
        .post(`${A}/support/tickets/${ticket.id}/close`, { resolution: 'Done' })
        .expect(200);
      expect((await alertsOf(ticket.id))[0].status).toBe('RESOLVED');
    });
  });

  // ------------------------------------------------------------------------------------------------------------
  describe('report and block', () => {
    it('a blocked worker disappears for that customer everywhere and cannot be booked; unblocking restores', async () => {
      const worker = await verifiedWorker();
      const c = await newCustomer();
      const searchIds = async (): Promise<string[]> => {
        const res = await as(api, c)
          .get(`/api/v1/search/workers?category=HOUSE_MAID&areaId=${area.id}&limit=100`)
          .expect(200);
        return (res.body.data as Array<{ workerId: string }>).map((w) => w.workerId);
      };
      expect(await searchIds()).toContain(worker.workerId);
      await as(api, c).put(`/api/v1/shortlist/${worker.workerId}`).expect(204);

      const block = await as(api, c).post('/api/v1/safety/blocks', {
        workerId: worker.workerId,
        reason: 'Rude',
      });
      expect(block.status).toBe(200);
      await as(api, c).post('/api/v1/safety/blocks', { workerId: worker.workerId }).expect(200); // repeat is harmless
      expect(await api.prisma.userBlock.count({ where: { blockerUserId: c.userId } })).toBe(1);

      expect(await searchIds()).not.toContain(worker.workerId);
      expect((await as(api, c).get(`/api/v1/search/workers/${worker.workerId}`)).status).toBe(404);
      const booked = await create(requirement({ workerId: worker.workerId }), c);
      expect(booked.status).toBe(422);
      expect(booked.body.code).toBe('WORKER_NOT_ELIGIBLE');
      const shortlist = await as(api, c).get('/api/v1/shortlist').expect(200);
      expect(JSON.stringify(shortlist.body)).not.toContain(worker.workerId + '","available":true');
      // other customers are unaffected
      expect(
        (
          await as(api, customer)
            .get(`/api/v1/search/workers?category=HOUSE_MAID&areaId=${area.id}&limit=100`)
            .expect(200)
        ).body.data.map((w: { workerId: string }) => w.workerId),
      ).toContain(worker.workerId);

      const mine = (await as(api, c).get('/api/v1/safety/blocks').expect(200)).body as Array<{
        id: string;
        workerId: string;
      }>;
      expect(mine).toHaveLength(1);
      expect(mine[0].workerId).toBe(worker.workerId);
      const stranger = await newCustomer();
      expect((await as(api, stranger).delete(`/api/v1/safety/blocks/${mine[0].id}`)).status).toBe(
        404,
      );
      await as(api, c).delete(`/api/v1/safety/blocks/${mine[0].id}`).expect(204);
      expect(await searchIds()).toContain(worker.workerId);
      expect((await create(requirement({ workerId: worker.workerId }), c)).status).toBe(201);
    });

    it('a worker can block the customer of their booking; only parties and real targets are accepted', async () => {
      const worker = await verifiedWorker();
      const c = await newCustomer();
      const id = (await create(requirement({ workerId: worker.workerId }), c)).body.id as string;
      const otherWorker = await verifiedWorker();
      expect(
        (await as(api, otherWorker).post('/api/v1/safety/blocks', { bookingId: id })).status,
      ).toBe(404);
      expect(
        (await as(api, worker).post('/api/v1/safety/blocks', { workerId: worker.workerId })).status,
      ).toBe(404);
      expect((await as(api, worker).post('/api/v1/safety/blocks', {})).status).toBe(400);
      expect(
        (await as(api, c).post('/api/v1/safety/blocks', { workerId: UNKNOWN_ID })).status,
      ).toBe(404);
      expect((await as(api, worker).post('/api/v1/safety/blocks', { bookingId: id })).status).toBe(
        200,
      );
      // the blocked customer can no longer book that worker again
      await as(api, c).post(`${B}/${id}/cancel`, { reason: 'x' }).expect(200);
      const again = await create(requirement({ workerId: worker.workerId }), c);
      expect(again.status).toBe(422);
      expect((await as(api, admin).post('/api/v1/safety/blocks', {})).status).toBe(403);
      expect((await api.http().post('/api/v1/safety/blocks').send({})).status).toBe(401);
    });

    it('a report raises a staff alert with the reason, can block at the same time, and keeps the note out of the audit log', async () => {
      const worker = await verifiedWorker();
      const c = await newCustomer();
      const id = (await create(requirement({ workerId: worker.workerId }), c)).body.id as string;
      expect(
        (
          await as(api, c).post('/api/v1/safety/reports', {
            bookingId: id,
            reasonCode: 'NOT_A_REASON',
          })
        ).status,
      ).toBe(400);
      expect(
        (
          await as(api, c).post('/api/v1/safety/reports', {
            bookingId: id,
            reasonCode: 'THEFT',
            note: '<b>x</b>',
          })
        ).status,
      ).toBe(400);
      const stranger = await newCustomer();
      expect(
        (
          await as(api, stranger).post('/api/v1/safety/reports', {
            bookingId: id,
            reasonCode: 'THEFT',
          })
        ).status,
      ).toBe(404);
      const res = await as(api, c).post('/api/v1/safety/reports', {
        bookingId: id,
        reasonCode: 'SAFETY_CONCERN',
        note: 'Secret detail 12345',
        alsoBlock: true,
      });
      expect(res.status).toBe(201);
      const [alert] = await alertsOf(res.body.id as string);
      expect(alert).toMatchObject({
        type: 'SAFETY_REPORT',
        severity: 'CRITICAL',
        requiredPermission: 'worker.manage',
      });
      // Operations (worker.manage) sees it; a support-only inbox does not.
      const supportOnly = await loginAdminWithPermissions(api, ['alert.view', 'support.view']);
      const seen = (token: typeof supportOnly) =>
        as(api, token).get(`${A}/alerts?type=SAFETY_REPORT&limit=100`).expect(200);
      expect(
        (await seen(supportOnly)).body.data.map((a: { entityId: string }) => a.entityId),
      ).not.toContain(res.body.id);
      const ops = await loginAdminWithPermissions(api, ['alert.view', 'worker.manage']);
      expect((await seen(ops)).body.data.map((a: { entityId: string }) => a.entityId)).toContain(
        res.body.id,
      );
      expect(await api.prisma.userBlock.count({ where: { blockerUserId: c.userId } })).toBe(1);
      const audit = await api.prisma.auditLog.findFirstOrThrow({
        where: { entityId: res.body.id, action: 'safety.report' },
      });
      expect(JSON.stringify(audit.metadata)).not.toContain('Secret detail');

      const viewer = await loginAdminWithPermissions(api, ['support.view']);
      const reports = (
        await as(api, viewer).get(`${A}/safety/reports?userId=${c.userId}`).expect(200)
      ).body;
      expect(reports.data[0]).toMatchObject({
        reasonCode: 'SAFETY_CONCERN',
        note: 'Secret detail 12345',
      });
      expect((await as(api, customer).get(`${A}/safety/reports`)).status).toBe(403);
    });

    it('a block applied by staff cannot be lifted by the user; staff can lift it; both are audited', async () => {
      const worker = await verifiedWorker();
      const c = await newCustomer();
      const manager = await loginAdminWithPermissions(api, ['support.view', 'support.manage']);
      const viewer = await loginAdminWithPermissions(api, ['support.view']);
      const body = {
        blockerUserId: c.userId,
        blockedUserId: worker.userId,
        reason: 'Safety review',
      };
      expect((await as(api, viewer).post(`${A}/safety/blocks`, body)).status).toBe(403);
      expect(
        (await as(api, manager).post(`${A}/safety/blocks`, { ...body, blockedUserId: c.userId }))
          .status,
      ).toBe(422);
      expect(
        (await as(api, manager).post(`${A}/safety/blocks`, { ...body, reason: '' })).status,
      ).toBe(400);
      const made = await as(api, manager).post(`${A}/safety/blocks`, body);
      expect(made.status).toBe(200);
      expect(made.body.createdByAdmin).toBe(true);
      const own = (await as(api, c).get('/api/v1/safety/blocks').expect(200)).body[0] as {
        id: string;
      };
      const refused = await as(api, c).delete(`/api/v1/safety/blocks/${own.id}`);
      expect(refused.status).toBe(409);
      expect(refused.body.code).toBe('BLOCK_ADMIN_APPLIED');
      await as(api, manager).delete(`${A}/safety/blocks/${own.id}`).expect(204);
      expect(
        await api.prisma.auditLog.count({
          where: { entityId: own.id, action: 'safety.admin_unblock' },
        }),
      ).toBe(1);
      expect((await as(api, manager).delete(`${A}/safety/blocks/${own.id}`)).status).toBe(404);
    });
  });

  // ------------------------------------------------------------------------------------------------------------
  describe('app configuration, reference data and account state', () => {
    it('serves public, cacheable start-up configuration without secrets', async () => {
      const res = await api.http().get('/api/v1/app-config').expect(200);
      expect(res.body).toMatchObject({
        customer: {
          minVersion: '1.2.0',
          storeUrl: 'https://play.google.com/store/apps/details?id=test.customer',
        },
        worker: { minVersion: null, storeUrl: null },
        maintenance: false,
        support: { phone: '+911234567890', email: null },
        legal: { acceptanceRequired: false, terms: null, privacy: null },
      });
      expect(res.headers.etag).toBeTruthy();
      await api.http().get('/api/v1/app-config').set('If-None-Match', res.headers.etag).expect(304);
      const reference = (await api.http().get('/api/v1/reference-data').expect(200)).body;
      expect(reference.engagements).toEqual(
        expect.arrayContaining(['DAILY', 'HOURLY', 'SHIFT', 'ONE_TIME']),
      );
      expect(reference.reportReasons).toContain('SAFETY_CONCERN');
      expect(JSON.stringify(res.body) + JSON.stringify(reference)).not.toMatch(
        /secret|password|token/i,
      );
    });

    it('tells a suspended user so (403 ACCOUNT_SUSPENDED) instead of a login loop', async () => {
      const victim = await newCustomer();
      await as(api, victim).get('/api/v1/customers/me').expect(200);
      await as(api, admin)
        .patch(`${A}/users/${victim.userId}/status`, { status: 'SUSPENDED' })
        .expect(200);
      const blocked = await as(api, victim).get('/api/v1/customers/me');
      expect(blocked.status).toBe(403);
      expect(blocked.body.code).toBe('ACCOUNT_SUSPENDED');
      await as(api, admin)
        .patch(`${A}/users/${victim.userId}/status`, { status: 'ACTIVE' })
        .expect(200);
    });

    it('records a deletion request, blocks it while money or an engagement is in progress, and lets the user withdraw it', async () => {
      const user = await newCustomer();
      const worker = await verifiedWorker();
      const booking = (await create(requirement({ workerId: worker.workerId }), user)).body
        .id as string;
      const blocked = await as(api, user).post('/api/v1/me/deletion-request', {
        reason: 'leaving',
      });
      expect(blocked.status).toBe(409);
      expect(blocked.body.code).toBe('DELETION_BLOCKED');
      await as(api, user).post(`${B}/${booking}/cancel`, { reason: 'x' }).expect(200);
      const ok = await as(api, user).post('/api/v1/me/deletion-request', { reason: 'leaving' });
      expect(ok.status).toBe(201);
      const again = await as(api, user).post('/api/v1/me/deletion-request', {});
      expect(again.body.id).toBe(ok.body.id);
      expect(await api.prisma.deletionRequest.count({ where: { userId: user.userId } })).toBe(1);
      expect((await alertsOf(user.userId))[0]).toMatchObject({
        type: 'DELETION_REQUEST',
        status: 'OPEN',
      });
      const listed = (
        await as(api, admin).get(`${A}/deletion-requests?status=REQUESTED`).expect(200)
      ).body.data;
      expect(listed.map((r: { id: string }) => r.id)).toContain(ok.body.id);
      expect((await as(api, user).get(`${A}/deletion-requests`)).status).toBe(403);
      await as(api, user).delete('/api/v1/me/deletion-request').expect(204);
      expect((await as(api, user).delete('/api/v1/me/deletion-request')).status).toBe(404);
      expect(
        Object.keys((await as(api, user).get('/api/v1/me/deletion-request')).body as object),
      ).toHaveLength(0);
    });
  });

  // ------------------------------------------------------------------------------------------------------------
  describe('payments: export and configurable fees', () => {
    it('exports a bounded CSV of payments for staff, audited, without personal data', async () => {
      const booking = await makeBooking(api, admin, customer, area.id, 'CONFIRMED');
      const viewer = await loginAdminWithPermissions(api, ['payment.view']);
      const day = tomorrow(0);
      const res = await as(api, viewer)
        .get(`${A}/payments-export?from=${tomorrow(-1)}&to=${tomorrow(1)}`)
        .expect(200);
      expect(res.headers['content-type']).toContain('text/csv');
      expect(res.headers['content-disposition']).toContain('attachment');
      const lines = res.text.trim().split('\r\n');
      expect(lines[0]).toBe(
        'payment_id,booking_id,status,amount_minor,currency,receipt_number,provider_order_id,provider_payment_id,paid_at,refund_status,refunded_at,created_at',
      );
      expect(lines.some((l) => l.includes(booking.id) && l.includes('SUCCEEDED'))).toBe(true);
      expect(res.text).not.toContain(customer.mobile ?? 'no-mobile');
      expect(day).toBeTruthy();
      expect(
        await api.prisma.auditLog.count({
          where: { action: 'payment.export', actorId: viewer.userId },
        }),
      ).toBe(1);

      const bad = [
        `from=${tomorrow(5)}&to=${tomorrow(1)}`,
        `from=${tomorrow(-400)}&to=${tomorrow(1)}`,
        'from=2026-02-31&to=2026-03-01',
        'from=x&to=y',
        '',
      ];
      for (const q of bad)
        expect((await as(api, viewer).get(`${A}/payments-export?${q}`)).status).toBe(400);
      expect(
        (await as(api, customer).get(`${A}/payments-export?from=${tomorrow(-1)}&to=${tomorrow(1)}`))
          .status,
      ).toBe(403);
      expect(
        (await api.http().get(`${A}/payments-export?from=${tomorrow(-1)}&to=${tomorrow(1)}`))
          .status,
      ).toBe(401);
    });

    it('sets any configured fee by code, validated and audited', async () => {
      const manager = await loginAdminWithPermissions(api, ['payment.manage', 'payment.view']);
      const auditsBefore = await api.prisma.auditLog.count({
        where: { entityId: 'PLACEMENT_FEE', action: 'payment.fee_set' },
      });
      const set = await as(api, manager).put(`${A}/fees/PLACEMENT_FEE`, { amountMinor: 250000 });
      expect(set.status).toBe(200);
      expect(set.body).toMatchObject({
        code: 'PLACEMENT_FEE',
        amountMinor: 250000,
        currency: 'INR',
      });
      expect(
        (await as(api, manager).put(`${A}/fees/placement_fee`, { amountMinor: 1 })).status,
      ).toBe(400);
      expect(
        (await as(api, manager).put(`${A}/fees/PLACEMENT_FEE`, { amountMinor: 0 })).status,
      ).toBe(400);
      const viewer = await loginAdminWithPermissions(api, ['payment.view']);
      expect(
        (await as(api, viewer).put(`${A}/fees/PLACEMENT_FEE`, { amountMinor: 5 })).status,
      ).toBe(403);
      expect(
        await api.prisma.auditLog.count({
          where: { entityId: 'PLACEMENT_FEE', action: 'payment.fee_set' },
        }),
      ).toBe(auditsBefore + 1);
      // the booking fee path still works and is not confused with the generic one
      await as(api, manager).put(`${A}/fees/booking-fee`, { amountMinor: 50000 }).expect(200);
    });
  });

  // ------------------------------------------------------------------------------------------------------------
  describe('launch readiness and worker proof of life', () => {
    it('lists every missing prerequisite and shows which background loops are alive', async () => {
      const heartbeat = api.app.get(HeartbeatService);
      const empty = await api.redis.client.keys('worker:heartbeat:*');
      if (empty.length > 0) await api.redis.client.del(...empty);
      const manager = await loginAdminWithPermissions(api, ['audit.view']);
      expect((await as(api, manager).get(`${A}/system/readiness`)).status).toBe(403);

      const before = (await as(api, admin).get(`${A}/system/readiness`).expect(200)).body;
      const byKey = Object.fromEntries(
        (before.checks as Array<{ key: string; ok: boolean; level: string; message: string }>).map(
          (c) => [c.key, c],
        ),
      );
      expect(byKey.background_workers).toMatchObject({ ok: false, level: 'BLOCKER' });
      expect(byKey.background_workers.message).toContain('EMBEDDED_WORKERS');
      expect(byKey.provider_sms).toMatchObject({ ok: false, level: 'BLOCKER' }); // tests run with a memory adapter
      expect(byKey.booking_fee.ok).toBe(true);
      expect(byKey.verification_requirements.ok).toBe(true);
      expect(byKey.super_admin).toMatchObject({ ok: true, level: 'BLOCKER' });
      expect(byKey.test_otp).toMatchObject({ ok: true, level: 'WARNING' });
      // the shared test database keeps the three non-Super roles empty (D-71 defaults are tested in users.api)
      expect(byKey.admin_role_permissions).toMatchObject({ ok: false, level: 'WARNING' });
      expect(byKey.admin_role_permissions.message).toContain('SUPPORT_EXECUTIVE');
      expect(before.ready).toBe(false);
      expect(JSON.stringify(before)).not.toMatch(/secret|password|apikey/i);

      for (const loop of [
        'notifications',
        'recheck-reminders',
        'abandoned-uploads',
        'payment-recovery',
        'booking-checks',
        'support-sla',
        'retention',
        'security-events',
      ]) {
        await heartbeat.beat(loop);
      }
      const after = (await as(api, admin).get(`${A}/system/readiness`).expect(200)).body;
      expect(after.checks.find((c: { key: string }) => c.key === 'background_workers').ok).toBe(
        true,
      );
      expect(after.workers.map((w: { name: string }) => w.name)).toContain('payment-recovery');
    });
  });
});
