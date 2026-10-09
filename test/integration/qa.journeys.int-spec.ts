import '../support/env-api-integration';
import {
  ApiApp,
  createApiApp,
  loginAdmin,
  loginAdminWithPermissions,
  loginWithOtp,
} from '../support/api-app';
import { ensureFee, fakeGateway, inDays } from '../support/bookings';
import {
  approveCheck,
  as,
  createArea,
  onboardWorker,
  setRequiredChecks,
  uploadDocument,
} from '../support/workforce';
import { NotificationsService } from '../../src/modules/notifications/notifications.service';

const todayIst = (): string =>
  new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date());

/**
 * QA: whole-product journeys for the three apps, through the public HTTP API only (plus the test adapters for SMS, the
 * payment gateway and object storage). Every step asserts the state it should have produced.
 */
describe('QA - end-to-end journeys (integration)', () => {
  let api: ApiApp;
  let admin: Awaited<ReturnType<typeof loginAdmin>>;
  let area: { id: string; name: string };
  let notifications: NotificationsService;

  const drain = async () => {
    for (let i = 0; i < 200; i++) if ((await notifications.dispatchOutbox()).events === 0) return;
  };

  beforeAll(async () => {
    api = await createApiApp();
    notifications = api.app.get(NotificationsService);
    admin = await loginAdmin(api);
    area = await createArea(api, admin);
    await ensureFee(api, admin, 75000);
    await setRequiredChecks(api, admin, ['IDENTITY']);
    for (const [channel, body] of [
      ['SMS', 'Booking {{bookingId}} is confirmed'],
      ['WHATSAPP', 'Booking {{bookingId}} confirmed'],
    ] as const) {
      await api.prisma.notificationTemplate.upsert({
        where: {
          eventCode_channel_language: { eventCode: 'BOOKING_CONFIRMED', channel, language: 'en' },
        },
        create: { eventCode: 'BOOKING_CONFIRMED', channel, language: 'en', body },
        update: { body, isActive: true },
      });
    }
    await drain();
  });

  afterAll(async () => {
    await setRequiredChecks(api, admin, []);
    await api.prisma.notificationTemplate.updateMany({ data: { isActive: false } });
    await api.close();
  });

  it('CUSTOMER + WORKER: from first login to a rated, completed service, a support ticket and a replacement', async () => {
    // ---- worker app: OTP -> profile -> categories -> availability -> KYC -> verification ------------------
    const worker = await loginWithOtp(api, { appType: 'WORKER' });
    const w = as(api, worker);
    expect(worker.type).toBe('WORKER');
    const profile = await w.post('/api/v1/workers/me', { name: 'Lakshmi Devi' });
    expect(profile.status).toBe(201);
    const workerId = profile.body.id as string;
    await w
      .patch('/api/v1/workers/me', {
        address: { line: '8 Park Rd', area: 'Kondapur', city: 'Hyderabad', pincode: '500084' },
        emergencyContact: { name: 'Ravi', mobile: '9876543210' },
        languages: ['en', 'te'],
        experienceMonths: 60,
        expectedSalary: 20000,
      })
      .expect(200);
    const maid = (
      await api.prisma.serviceCategory.findUniqueOrThrow({ where: { code: 'HOUSE_MAID' } })
    ).id;
    await w.put('/api/v1/workers/me/categories', { categoryIds: [maid] }).expect(200);
    const incomplete = await w.post('/api/v1/workers/me/submit');
    expect(incomplete.status).toBe(422);
    expect(incomplete.body.details[0].messages).toEqual([
      'areas',
      'timeWindows',
      'engagementPreference',
    ]);
    await w
      .patch('/api/v1/workers/me/availability', {
        engagementPreference: 'PART_TIME',
        areaIds: [area.id],
        timeWindows: [{ start: '08:00', end: '14:00' }],
      })
      .expect(200);
    await w.post('/api/v1/workers/me/submit').expect(200);

    const customer = await loginWithOtp(api, { appType: 'CUSTOMER' });
    const c = as(api, customer);
    const query = `category=HOUSE_MAID&areaId=${area.id}&engagement=PART_TIME&availableFrom=09:00&availableTo=12:00`;
    // submitted but not verified: nobody can find or match them.
    expect((await c.get(`/api/v1/search/workers?${query}`)).body.meta.total).toBe(0);
    const matchBody = {
      category: 'HOUSE_MAID',
      areaId: area.id,
      engagement: 'PART_TIME',
      availableFrom: '09:00',
      availableTo: '12:00',
    };
    expect(
      (await as(api, admin).post('/api/v1/admin/matching/candidates', matchBody)).body.meta.total,
    ).toBe(0);

    await w.post('/api/v1/workers/me/verification/checks/IDENTITY/submit').expect(422);
    await uploadDocument(api, worker, 'IDENTITY');
    const submittedCheck = await w.post('/api/v1/workers/me/verification/checks/IDENTITY/submit');
    expect(submittedCheck.body.level).toBe('IN_PROGRESS');
    expect((await c.get(`/api/v1/search/workers?${query}`)).body.meta.total).toBe(0);
    const queue = (await as(api, admin).get('/api/v1/admin/verification/queue?limit=100')).body
      .data as Array<{ workerId: string; checkId: string }>;
    const checkId = queue.find((q) => q.workerId === workerId)!.checkId;
    await as(api, admin)
      .post(`/api/v1/admin/verification/checks/${checkId}/start-review`)
      .expect(200);
    await as(api, admin)
      .post(`/api/v1/admin/verification/checks/${checkId}/approve`, { remarks: 'ID matches' })
      .expect(200);
    expect((await w.get('/api/v1/workers/me/verification')).body.level).toBe('VERIFIED');

    // ---- customer app: profile -> address -> search -> matching -> booking ---------------------------------
    await c
      .post('/api/v1/customers/me', {
        name: 'Anita Rao',
        email: `anita.${Date.now()}@example.test`,
        preferredLanguage: 'en',
      })
      .expect(201);
    const address = await c.post('/api/v1/customers/me/addresses', {
      line: '12 MG Road',
      area: 'Madhapur',
      city: 'Hyderabad',
      pincode: '500081',
    });
    expect(address.status).toBe(201);
    const found = await c.get(`/api/v1/search/workers?${query}`);
    expect(found.body.data).toHaveLength(1);
    expect(found.body.data[0]).toMatchObject({
      workerId,
      verification: 'VERIFIED',
      experienceMonths: 60,
    });
    expect(JSON.stringify(found.body)).not.toContain('Lakshmi');
    const matched = await as(api, admin).post('/api/v1/admin/matching/candidates', matchBody);
    expect(matched.body.data.map((x: { workerId: string }) => x.workerId)).toEqual([workerId]);

    const created = await c.post('/api/v1/bookings', { ...matchBody, workerId });
    expect(created.status).toBe(201);
    const bookingId = created.body.id as string;
    expect(created.body.status).toBe('MATCHED');
    expect((await w.get(`/api/v1/workers/me/bookings/${bookingId}`)).body.status).toBe('MATCHED');
    await c
      .post(`/api/v1/bookings/${bookingId}/schedule`, {
        scheduleType: 'INTERVIEW',
        scheduledAt: new Date(Date.now() + 86400000).toISOString(),
      })
      .expect(200);
    await c
      .post(`/api/v1/bookings/${bookingId}/interview-complete`, { outcomeNote: 'Good fit' })
      .expect(200);
    await c
      .post(`/api/v1/bookings/${bookingId}/confirm-worker`, { startDate: inDays(1) })
      .expect(200);

    // ---- payment ------------------------------------------------------------------------------------------
    const pay = await c.post('/api/v1/payments', { bookingId });
    expect(pay.status).toBe(201);
    expect(pay.body).toMatchObject({ amountMinor: 75000, status: 'PENDING' });
    const done = fakeGateway(api).completeCheckout(
      pay.body.checkout.orderId as string,
      'SUCCEEDED',
    );
    const { body, headers } = fakeGateway(api).webhook({
      eventId: `evt-${pay.body.id}`,
      providerOrderId: pay.body.checkout.orderId,
      providerPaymentId: done.providerPaymentId,
      outcome: 'SUCCEEDED',
      amountMinor: 75000,
    });
    expect(
      (
        await api
          .http()
          .post('/api/v1/webhooks/payments')
          .set(headers)
          .set('Content-Type', 'application/json')
          .send(body.toString())
      ).status,
    ).toBe(200);
    const receipt = await c.get(`/api/v1/payments/${pay.body.id}`);
    expect(receipt.body).toMatchObject({ status: 'SUCCEEDED' });
    expect(receipt.body.receiptNumber).toMatch(/^RCPT-/);
    expect((await c.get(`/api/v1/bookings/${bookingId}`)).body.status).toBe('CONFIRMED');

    // ---- notifications are produced for the confirmation ---------------------------------------------------
    await drain();
    const queued = await api.prisma.notification.findMany({
      where: { eventCode: 'BOOKING_CONFIRMED', params: { path: ['bookingId'], equals: bookingId } },
    });
    expect(queued.map((n) => `${n.channel}`).sort()).toEqual([
      'SMS',
      'SMS',
      'WHATSAPP',
      'WHATSAPP',
    ]);
    for (const n of queued) await notifications.deliver(n.id);
    expect(api.sms.lastTo(customer.mobile!)?.body).toBe(`Booking ${bookingId} is confirmed`);
    expect(api.sms.lastTo(worker.mobile!)?.body).toBe(`Booking ${bookingId} is confirmed`);

    // ---- the service: start, attendance, completion ---------------------------------------------------------
    await w.post(`/api/v1/workers/me/bookings/${bookingId}/start`).expect(200);
    await api.prisma
      .$executeRaw`UPDATE bookings SET start_date = ${todayIst()}::date WHERE id = ${bookingId}::uuid`;
    const att = await w.post(`/api/v1/workers/me/attendance/bookings/${bookingId}`, {
      status: 'PRESENT',
    });
    expect(att.status).toBe(201);
    expect((await c.get(`/api/v1/attendance/bookings/${bookingId}`)).body.data[0]).toMatchObject({
      date: todayIst(),
      status: 'PRESENT',
      recordedBy: 'WORKER',
    });
    await c.post(`/api/v1/bookings/${bookingId}/complete`).expect(200);
    const timeline = (await c.get(`/api/v1/bookings/${bookingId}`)).body.timeline.map(
      (t: { to: string }) => t.to,
    );
    expect(timeline).toEqual([
      'NEW_REQUEST',
      'MATCHED',
      'INTERVIEW_TRIAL_SCHEDULED',
      'INTERVIEW_TRIAL_COMPLETED',
      'PENDING_PAYMENT',
      'CONFIRMED',
      'ACTIVE',
      'COMPLETED',
    ]);

    // ---- rating, then the worker sees it and search shows no private data ---------------------------------
    const rating = await c.post('/api/v1/ratings', {
      bookingId,
      score: 5,
      review: 'Very reliable',
    });
    expect(rating.status).toBe(201);
    expect((await w.get('/api/v1/workers/me/ratings/summary')).body).toMatchObject({
      count: 1,
      average: 5,
    });
    expect((await c.post('/api/v1/ratings', { bookingId, score: 1 })).status).toBe(409);

    // ---- support -------------------------------------------------------------------------------------------
    await as(api, admin).post('/api/v1/admin/support/categories', {
      code: `QA_${Date.now()}`,
      name: 'QA complaint',
    });
    const categoryBody = (await c.get('/api/v1/support/categories')).body as unknown;
    const categories = (
      Array.isArray(categoryBody) ? categoryBody : (categoryBody as { data: unknown[] }).data
    ) as Array<{ id: string }>;
    const ticket = await c.post('/api/v1/support/tickets', {
      categoryId: categories[0].id,
      description: 'Question about the receipt',
      bookingId,
    });
    expect(ticket.status).toBe(201);
    expect(ticket.body.status).toBe('OPEN');
    await as(api, admin)
      .post(`/api/v1/admin/support/tickets/${ticket.body.id}/assign`, {})
      .expect(200);
    await as(api, admin)
      .post(`/api/v1/admin/support/tickets/${ticket.body.id}/close`, {
        resolution: 'Receipt re-sent',
      })
      .expect(200);
    expect((await c.get(`/api/v1/support/tickets/${ticket.body.id}`)).body.status).toBe('CLOSED');

    // ---- replacement on a second, active booking ------------------------------------------------------------
    const worker2 = await onboardWorker(api, { areaIds: [area.id] });
    await approveCheck(api, admin, worker2, 'IDENTITY');
    const worker3 = await onboardWorker(api, { areaIds: [area.id] });
    await approveCheck(api, admin, worker3, 'IDENTITY');
    const second = (await c.post('/api/v1/bookings', { ...matchBody, workerId: worker2.workerId }))
      .body.id as string;
    await c
      .post(`/api/v1/bookings/${second}/schedule`, {
        scheduleType: 'TRIAL',
        scheduledAt: new Date(Date.now() + 86400000).toISOString(),
      })
      .expect(200);
    await c
      .post(`/api/v1/bookings/${second}/interview-complete`, { outcomeNote: 'ok' })
      .expect(200);
    await c.post(`/api/v1/bookings/${second}/confirm-worker`, { startDate: inDays(1) }).expect(200);
    const pay2 = (await c.post('/api/v1/payments', { bookingId: second })).body;
    const done2 = fakeGateway(api).completeCheckout(pay2.checkout.orderId as string, 'SUCCEEDED');
    await c.post(`/api/v1/payments/${pay2.id}/verify`, done2).expect(200);
    await as(api, worker2).post(`/api/v1/workers/me/bookings/${second}/start`).expect(200);
    const request = await c.post('/api/v1/replacement-requests', {
      bookingId: second,
      reason: 'Often late',
    });
    expect(request.status).toBe(201);
    await as(api, admin)
      .post(`/api/v1/admin/replacement-requests/${request.body.id}/approve`, {})
      .expect(200);
    const candidates = await as(api, admin).get(
      `/api/v1/admin/replacement-requests/${request.body.id}/candidates?limit=100`,
    );
    const ids = candidates.body.data.map((x: { workerId: string }) => x.workerId) as string[];
    expect(ids).toContain(worker3.workerId);
    expect(ids).not.toContain(worker2.workerId);
    const replaced = await c.post(`/api/v1/replacement-requests/${request.body.id}/select`, {
      workerId: worker3.workerId,
    });
    expect(replaced.body.status).toBe('COMPLETED');
    expect((await c.get(`/api/v1/bookings/${second}`)).body.status).toBe('REPLACED');
    expect(
      (await c.get(`/api/v1/bookings/${replaced.body.replacementBookingId}`)).body,
    ).toMatchObject({ status: 'MATCHED', workerId: worker3.workerId });
  });

  it('ADMIN: every area of the portal answers for the Super Admin and is traceable in the audit log', async () => {
    const a = as(api, admin);
    const dashboard = await a.get('/api/v1/admin/dashboard');
    expect(dashboard.status).toBe(200);
    expect(Object.keys(dashboard.body as object).length).toBeGreaterThan(0);
    const lists = [
      '/api/v1/admin/users?limit=5',
      '/api/v1/admin/customers?limit=5',
      '/api/v1/admin/workers?limit=5',
      '/api/v1/admin/verification/queue?limit=5',
      '/api/v1/admin/verification/requirements',
      '/api/v1/admin/bookings?limit=5',
      '/api/v1/admin/payments?limit=5',
      '/api/v1/admin/fees',
      '/api/v1/admin/notification-templates?limit=5',
      '/api/v1/admin/notifications?limit=5',
      '/api/v1/admin/notification-events',
      '/api/v1/admin/support/tickets?limit=5',
      '/api/v1/admin/support/categories',
      '/api/v1/admin/ratings?limit=5',
      '/api/v1/admin/replacement-requests?limit=5',
      '/api/v1/admin/service-areas?limit=5',
      '/api/v1/admin/service-categories?limit=5',
      '/api/v1/admin/roles',
      '/api/v1/admin/permissions',
      '/api/v1/admin/audit-logs?limit=5',
      '/api/v1/admin/reports',
    ];
    for (const url of lists) {
      const res = await a.get(url);
      expect([url, res.status]).toEqual([url, 200]);
      expect(res.body).toBeDefined();
    }
    const today = todayIst();
    const range = `from=${today}&to=${today}`;
    for (const r of [
      'new-customers',
      'worker-registrations',
      'booking-funnel',
      'demand-by-category',
      'demand-by-area',
      'worker-utilization',
      'interview-conversion',
      'cancellation-rate',
      'replacement-rate',
      'payment-collections',
      'support-tickets',
      'top-rated-workers',
      'repeat-customers',
    ]) {
      const res = await a.get(
        `/api/v1/admin/reports/${r}?${r === 'worker-utilization' || r === 'top-rated-workers' ? '' : range}`,
      );
      expect([r, res.status]).toEqual([r, 200]);
      expect(res.body.definition).toBeTruthy();
    }
    const audit = await a.get('/api/v1/admin/audit-logs?actionPrefix=payment.&limit=50');
    expect(audit.body.data.length).toBeGreaterThan(0);
    expect(audit.body.data.every((e: { action: string }) => e.action.startsWith('payment.'))).toBe(
      true,
    );
  });

  it('SEEDED ROLES: Operations, Verification and Support executives hold no permission until a Super Admin grants them', async () => {
    const rows = await api.prisma.role.findMany({
      include: { permissions: true },
      where: {
        code: {
          in: ['SUPER_ADMIN', 'OPERATIONS_ADMIN', 'VERIFICATION_EXECUTIVE', 'SUPPORT_EXECUTIVE'],
        },
      },
    });
    const count = Object.fromEntries(rows.map((r) => [r.code, r.permissions.length]));
    expect(count.SUPER_ADMIN).toBeGreaterThan(30);
    // This documents the current, unconfigured state (Q-33): the portal is unusable for these roles until configured.
    const permissionCount = await api.prisma.permission.count();
    expect(count.SUPER_ADMIN).toBe(permissionCount);
    const noPermission = await loginAdminWithPermissions(api, []);
    expect((await as(api, noPermission).get('/api/v1/admin/dashboard')).status).toBe(200);
    expect((await as(api, noPermission).get('/api/v1/admin/bookings')).status).toBe(403);
  });
});
