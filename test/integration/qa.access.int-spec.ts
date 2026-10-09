import '../support/env-api-integration';
import {
  ApiApp,
  createApiApp,
  loginAdmin,
  loginAdminWithPermissions,
  loginWithOtp,
} from '../support/api-app';
import { makeBooking, TestBooking, fakeGateway } from '../support/bookings';
import { concretePath, listRoutes, RouteInfo } from '../support/routes';
import {
  approveCheck,
  as,
  createArea,
  onboardWorker,
  setRequiredChecks,
  uploadDocument,
} from '../support/workforce';

const UNKNOWN_ID = '00000000-0000-7000-8000-000000000000';
const SKIP_POSITIVE = [/^POST \/api\/v1\/auth\/logout$/, /^DELETE \/api\/v1\/auth\/sessions\//];

/** QA: positive access, cross-user (IDOR) isolation and KYC confidentiality across the whole API. */
describe('QA - access control, ownership and confidentiality (integration)', () => {
  let api: ApiApp;
  let admin: Awaited<ReturnType<typeof loginAdmin>>;
  let area: { id: string };
  let routes: RouteInfo[];

  beforeAll(async () => {
    api = await createApiApp();
    admin = await loginAdmin(api);
    area = await createArea(api, admin);
    routes = listRoutes(api.app);
    await setRequiredChecks(api, admin, ['IDENTITY']);
  });

  afterAll(async () => {
    await setRequiredChecks(api, admin, []);
    await api.close();
  });

  describe('the right caller is let in on every protected route', () => {
    it('admits a customer, a worker, and an admin holding exactly the route permissions - never 401 or 403', async () => {
      const customer = await loginWithOtp(api, { appType: 'CUSTOMER' });
      const worker = await loginWithOtp(api, { appType: 'WORKER' });
      const admins = new Map<string, Awaited<ReturnType<typeof loginAdminWithPermissions>>>();
      const refused: string[] = [];
      let probed = 0;
      for (const route of routes.filter((r) => !r.isPublic)) {
        const id = `${route.method} ${route.path}`;
        if (SKIP_POSITIVE.some((p) => p.test(id))) continue;
        let caller: { accessToken: string };
        if (route.userTypes?.includes('ADMIN')) {
          const key = (route.permissions ?? []).slice().sort().join(',');
          if (!admins.has(key))
            admins.set(key, await loginAdminWithPermissions(api, route.permissions ?? []));
          caller = admins.get(key)!;
        } else if (route.userTypes?.includes('WORKER') && !route.userTypes.includes('CUSTOMER')) {
          caller = worker;
        } else {
          caller = customer;
        }
        const req = api
          .http()
          [route.method.toLowerCase() as 'get'](concretePath(route.path))
          .set('Authorization', `Bearer ${caller.accessToken}`);
        const res = route.method === 'GET' ? await req : await req.send({});
        probed++;
        if ([401, 403].includes(res.status)) refused.push(`${id} -> ${res.status}`);
        if (res.status >= 500) refused.push(`${id} -> ${res.status} (server error)`);
      }
      expect(probed).toBeGreaterThan(140);
      expect(refused).toEqual([]);
    }, 280_000);
  });

  describe("nobody reaches another user's data (IDOR matrix)", () => {
    let a: TestBooking;
    let customerB: Awaited<ReturnType<typeof loginWithOtp>>;
    let workerB: Awaited<ReturnType<typeof onboardWorker>>;
    let paymentId: string;
    let ratingId: string;
    let ticketId: string;
    let requestId: string;
    let addressId: string;
    let docId: string;

    beforeAll(async () => {
      customerB = await loginWithOtp(api, { appType: 'CUSTOMER' });
      await as(api, customerB)
        .post('/api/v1/customers/me', {
          name: 'Other B',
          email: `b.${Date.now()}@example.test`,
          preferredLanguage: 'en',
        })
        .expect(201);
      workerB = await onboardWorker(api, { areaIds: [area.id] });
      await approveCheck(api, admin, workerB, 'IDENTITY');
      const customerA = await loginWithOtp(api, { appType: 'CUSTOMER' });
      a = await makeBooking(api, admin, customerA, area.id, 'ACTIVE');
      const ca = as(api, a.customer);
      paymentId = (await api.prisma.payment.findFirstOrThrow({ where: { bookingId: a.id } })).id;
      await api.prisma
        .$executeRaw`UPDATE bookings SET start_date = (now() AT TIME ZONE 'Asia/Kolkata')::date - 3 WHERE id = ${a.id}::uuid`;
      await as(api, a.worker)
        .post(`/api/v1/workers/me/attendance/bookings/${a.id}`, { status: 'PRESENT' })
        .expect(201);
      await ca.post('/api/v1/customers/me', {
        name: 'Owner A',
        email: `a.${Date.now()}@example.test`,
        preferredLanguage: 'en',
      });
      addressId = (
        await ca.post('/api/v1/customers/me/addresses', {
          line: '1 A Street',
          area: 'X',
          city: 'Y',
          pincode: '500001',
        })
      ).body.id as string;
      await ca.post(`/api/v1/bookings/${a.id}/complete`).expect(200);
      ratingId = (await ca.post('/api/v1/ratings', { bookingId: a.id, score: 4 })).body
        .id as string;
      await as(api, admin).post('/api/v1/admin/support/categories', {
        code: `IDOR_${Date.now()}`,
        name: 'idor',
      });
      const cats = (await ca.get('/api/v1/support/categories')).body as unknown;
      const categoryId = (
        (Array.isArray(cats) ? cats : (cats as { data: unknown[] }).data) as Array<{ id: string }>
      )[0].id;
      ticketId = (
        await ca.post('/api/v1/support/tickets', { categoryId, description: 'A private complaint' })
      ).body.id as string;
      const b2 = await makeBooking(api, admin, a.customer, area.id, 'ACTIVE');
      requestId = (
        await ca.post('/api/v1/replacement-requests', {
          bookingId: b2.id,
          reason: 'private reason',
        })
      ).body.id as string;
      docId = await uploadDocument(api, a.worker, 'ADDRESS');
    });

    it('answers 404 (never data, never 403 that confirms existence) to the other customer', async () => {
      const b = as(api, customerB);
      const probes: Array<[string, string, object?]> = [
        ['get', `/api/v1/bookings/${a.id}`],
        ['post', `/api/v1/bookings/${a.id}/cancel`, { reason: 'x' }],
        [
          'post',
          `/api/v1/payments/${paymentId}/verify`,
          { providerPaymentId: 'p', signature: 's' },
        ],
        ['get', `/api/v1/payments/${paymentId}`],
        ['post', '/api/v1/payments', { bookingId: a.id }],
        ['get', `/api/v1/ratings/${ratingId}`],
        ['get', `/api/v1/ratings/bookings/${a.id}`],
        ['post', '/api/v1/ratings', { bookingId: a.id, score: 1 }],
        ['get', `/api/v1/attendance/bookings/${a.id}`],
        [
          'post',
          `/api/v1/attendance/bookings/${a.id}/exceptions`,
          { date: '2026-10-01', note: 'x' },
        ],
        ['get', `/api/v1/support/tickets/${ticketId}`],
        ['get', `/api/v1/replacement-requests/${requestId}`],
        ['post', `/api/v1/replacement-requests/${requestId}/cancel`],
        [
          'post',
          `/api/v1/replacement-requests/${requestId}/select`,
          { workerId: workerB.workerId },
        ],
        ['post', '/api/v1/replacement-requests', { bookingId: a.id, reason: 'x' }],
        ['get', `/api/v1/customers/me/addresses/${addressId}`],
        ['patch', `/api/v1/customers/me/addresses/${addressId}`, { city: 'Z' }],
        ['delete', `/api/v1/customers/me/addresses/${addressId}`],
        ['put', `/api/v1/customers/me/addresses/${addressId}/default`],
        [
          'post',
          '/api/v1/support/tickets',
          { categoryId: UNKNOWN_ID, description: 'x', bookingId: a.id },
        ],
      ];
      const wrong: string[] = [];
      for (const [verb, url, body] of probes) {
        const res = await (
          b as unknown as Record<
            string,
            (u: string, x?: object) => Promise<{ status: number; body: unknown }>
          >
        )[verb](url, body);
        const text = JSON.stringify(res.body);
        if (
          ![404, 400, 422].includes(res.status) ||
          /A private complaint|private reason|Owner A|1 A Street/.test(text)
        ) {
          wrong.push(`${verb.toUpperCase()} ${url} -> ${res.status}`);
        }
        if (res.status === 400 && /bookingId|ticket|payment/.test(url) === false)
          wrong.push(`${verb} ${url} -> 400 unexpected`);
      }
      expect(wrong).toEqual([]);
      // The data is untouched.
      expect((await api.prisma.booking.findUniqueOrThrow({ where: { id: a.id } })).status).toBe(
        'COMPLETED',
      );
      expect(
        (await api.prisma.payment.findUniqueOrThrow({ where: { id: paymentId } })).status,
      ).toBe('SUCCEEDED');
    });

    it("answers 404 to a different worker on the first worker's booking, attendance, ratings and documents", async () => {
      const w = as(api, workerB);
      const probes: Array<[string, string, object?]> = [
        ['get', `/api/v1/workers/me/bookings/${a.id}`],
        ['post', `/api/v1/workers/me/bookings/${a.id}/start`],
        ['post', `/api/v1/workers/me/bookings/${a.id}/decline`],
        ['get', `/api/v1/workers/me/attendance/bookings/${a.id}`],
        ['post', `/api/v1/workers/me/attendance/bookings/${a.id}`, { status: 'PRESENT' }],
        ['post', `/api/v1/workers/me/verification/documents/${docId}/confirm`],
        ['get', `/api/v1/support/tickets/${ticketId}`],
      ];
      const wrong: string[] = [];
      for (const [verb, url, body] of probes) {
        const res = await (
          w as unknown as Record<string, (u: string, x?: object) => Promise<{ status: number }>>
        )[verb](url, body);
        if (res.status !== 404) wrong.push(`${verb.toUpperCase()} ${url} -> ${res.status}`);
      }
      expect(wrong).toEqual([]);
      expect((await w.get('/api/v1/workers/me/ratings')).body.data).toEqual([]);
    });

    it('does not let a customer act as a worker, a worker as a customer, or either as staff', async () => {
      const cb = as(api, customerB);
      const wb = as(api, workerB);
      for (const url of [
        `/api/v1/workers/me/bookings/${a.id}`,
        '/api/v1/workers/me',
        '/api/v1/workers/me/verification',
      ]) {
        expect((await cb.get(url)).status).toBe(403);
      }
      for (const url of [
        `/api/v1/bookings/${a.id}`,
        '/api/v1/customers/me',
        '/api/v1/payments',
        '/api/v1/ratings',
      ]) {
        expect((await wb.get(url)).status).toBe(403);
      }
      for (const url of [
        `/api/v1/admin/bookings/${a.id}`,
        `/api/v1/admin/payments/${paymentId}`,
        `/api/v1/admin/verification/documents/${docId}/link`,
      ]) {
        expect((await cb.get(url)).status).toBe(403);
        expect((await wb.get(url)).status).toBe(403);
      }
    });

    it("does not let one session revoke another user's session", async () => {
      const victim = await loginWithOtp(api, { appType: 'CUSTOMER' });
      const del = await api
        .http()
        .delete(`/api/v1/auth/sessions/${victim.sessionId}`)
        .set('Authorization', `Bearer ${customerB.accessToken}`);
      expect(del.status).toBe(404);
      expect((await as(api, victim).get('/api/v1/users/me')).status).toBe(200);
    });

    it('lets staff holding the permission see these records, and only the records they hold the permission for', async () => {
      const readOnly = await loginAdminWithPermissions(api, ['booking.view']);
      expect((await as(api, readOnly).get(`/api/v1/admin/bookings/${a.id}`)).status).toBe(200);
      expect((await as(api, readOnly).get(`/api/v1/admin/payments/${paymentId}`)).status).toBe(403);
      expect(
        (await as(api, readOnly).get(`/api/v1/admin/support/tickets/${ticketId}`)).status,
      ).toBe(403);
      expect(
        (await as(api, readOnly).get(`/api/v1/admin/verification/documents/${docId}/link`)).status,
      ).toBe(403);
    });
  });

  describe('KYC data never leaves the verification endpoints', () => {
    const PATTERNS = /kyc\/|objectKey|object_key|storageKey|memory:\/\/|aadhaar/i;

    it('keeps documents, storage keys and signed links out of every other surface', async () => {
      const worker = await onboardWorker(api, { areaIds: [area.id], name: 'Kyc Subject' });
      const docId = await uploadDocument(api, worker, 'IDENTITY');
      await as(api, worker)
        .post('/api/v1/workers/me/verification/checks/IDENTITY/submit')
        .expect(200);
      const queue = (await as(api, admin).get('/api/v1/admin/verification/queue?limit=100')).body
        .data as Array<{ workerId: string; checkId: string }>;
      const checkId = queue.find((q) => q.workerId === worker.workerId)!.checkId;
      await as(api, admin)
        .post(`/api/v1/admin/verification/checks/${checkId}/start-review`)
        .expect(200);
      await as(api, admin)
        .post(`/api/v1/admin/verification/checks/${checkId}/approve`, {})
        .expect(200);
      const link = await as(api, admin).get(`/api/v1/admin/verification/documents/${docId}/link`);
      expect(link.status).toBe(200);
      const customer = await loginWithOtp(api, { appType: 'CUSTOMER' });
      const t = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date());
      const booking = await makeBooking(api, admin, customer, area.id, 'MATCHED');
      const surfaces: Array<[string, { accessToken: string }, string]> = [
        ['worker own profile', worker, '/api/v1/workers/me'],
        ['worker verification status', worker, '/api/v1/workers/me/verification'],
        ['worker bookings', worker, '/api/v1/workers/me/bookings'],
        [
          'customer search',
          customer,
          `/api/v1/search/workers?category=HOUSE_MAID&areaId=${area.id}&limit=100`,
        ],
        ['customer booking', customer, `/api/v1/bookings/${booking.id}`],
        ['admin worker list', admin, '/api/v1/admin/workers?limit=100'],
        ['admin worker detail', admin, `/api/v1/admin/workers/${worker.workerId}`],
        ['admin verification queue', admin, '/api/v1/admin/verification/queue?limit=100'],
        [
          'admin worker verification (metadata only)',
          admin,
          `/api/v1/admin/workers/${worker.workerId}/verification`,
        ],
        ['admin bookings', admin, '/api/v1/admin/bookings?limit=100'],
        ['admin users', admin, '/api/v1/admin/users?limit=100'],
        [
          'audit log (verification entries)',
          admin,
          '/api/v1/admin/audit-logs?actionPrefix=verification.&limit=100',
        ],
        ['audit log (everything)', admin, '/api/v1/admin/audit-logs?limit=100'],
        ['notification log', admin, '/api/v1/admin/notifications?limit=100'],
        ['dashboard', admin, '/api/v1/admin/dashboard'],
        ['support tickets', admin, '/api/v1/admin/support/tickets?limit=100'],
        ['ratings', admin, '/api/v1/admin/ratings?limit=100'],
      ];
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
      ]) {
        surfaces.push([`report ${r}`, admin, `/api/v1/admin/reports/${r}?from=${t}&to=${t}`]);
      }
      surfaces.push(
        ['report worker-utilization', admin, '/api/v1/admin/reports/worker-utilization'],
        ['report top-rated-workers', admin, '/api/v1/admin/reports/top-rated-workers'],
      );
      const leaks: string[] = [];
      for (const [name, caller, url] of surfaces) {
        const res = await as(api, caller).get(url);
        if (res.status !== 200) leaks.push(`${name} -> HTTP ${res.status}`);
        const text = JSON.stringify(res.body);
        const verificationMetadata =
          /^(admin worker verification|worker verification status|audit log)/.test(name);
        if (PATTERNS.test(text)) leaks.push(`${name} contains a storage-key pattern`);
        if (!verificationMetadata && text.includes(docId))
          leaks.push(`${name} contains a document id`);
      }
      expect(leaks).toEqual([]);

      // Refusals and errors do not echo documents either.
      const other = await onboardWorker(api, { areaIds: [area.id] });
      const stolen = await as(api, other).post(
        `/api/v1/workers/me/verification/documents/${docId}/confirm`,
      );
      expect(stolen.status).toBe(404);
      expect(JSON.stringify(stolen.body)).not.toMatch(PATTERNS);
      const denied = await as(api, customer).get(
        `/api/v1/admin/verification/documents/${docId}/link`,
      );
      expect(denied.status).toBe(403);
      expect(JSON.stringify(denied.body)).not.toContain(docId);

      // Every link issue is audited, and the audit trail itself holds no key or URL.
      const rows = await api.prisma.auditLog.findMany({
        where: { action: 'verification.document_view', entityId: docId },
      });
      expect(rows.length).toBeGreaterThanOrEqual(1);
      expect(JSON.stringify(rows)).not.toMatch(PATTERNS);
      // The link is short-lived and the worker-side view never carries one.
      const expires = new Date((link.body as { expiresAt: string }).expiresAt).getTime();
      expect(expires - Date.now()).toBeLessThanOrEqual(
        api.config.verificationDocuments.signedUrlTtlSeconds * 1000 + 2000,
      );
      expect(
        JSON.stringify((await as(api, worker).get('/api/v1/workers/me/verification')).body),
      ).not.toContain('url');
      void fakeGateway;
    });
  });
});
