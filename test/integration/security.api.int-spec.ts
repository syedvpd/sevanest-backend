import '../support/env-api-integration';
import {
  ApiApp,
  createApiApp,
  loginAdmin,
  loginAdminWithPermissions,
  loginWithOtp,
  randomMobile,
  requestOtp,
} from '../support/api-app';
import { makeBooking } from '../support/bookings';
import { concretePath, listRoutes, RouteInfo } from '../support/routes';
import { as, createArea, setRequiredChecks } from '../support/workforce';
import { AuditService } from '../../src/common/audit/audit.service';
import { PERMISSION_CATALOG } from '../../src/modules/users/rbac.constants';

const UNKNOWN_ID = '00000000-0000-7000-8000-000000000000';

/** Routes that are public on purpose: authenticated by their own means (OTP, credentials, refresh token, signature) or probes. */
const PUBLIC_ROUTES = [
  'POST /api/v1/auth/admin/login',
  'POST /api/v1/auth/otp/request',
  'POST /api/v1/auth/otp/verify',
  'POST /api/v1/auth/token/refresh',
  'GET /api/v1/health/live',
  'GET /api/v1/health/ready',
  'POST /api/v1/webhooks/payments',
];
/** Routes any signed-in user may call because the service scopes them to the caller's own data or to shared reference data. */
const ANY_SIGNED_IN_ROUTES = [
  'POST /api/v1/auth/logout',
  'GET /api/v1/auth/sessions',
  'DELETE /api/v1/auth/sessions/:sessionId',
  'GET /api/v1/users/me',
  'GET /api/v1/service-areas',
  'GET /api/v1/service-areas/:areaId',
  'GET /api/v1/service-categories',
  'GET /api/v1/service-categories/:categoryId',
];
/** Admin routes without @Permissions: the dashboard shows each section only to a holder of that section's own permission. */
const ADMIN_WITHOUT_PERMISSION = ['GET /api/v1/admin/dashboard'];

const key = (r: Pick<RouteInfo, 'method' | 'path'>): string => `${r.method} ${r.path}`;

const FORBIDDEN_KEYS = [
  'passwordHash',
  'password_hash',
  'refreshTokenHash',
  'refresh_token_hash',
  'storageKey',
  'storage_key',
  'otpHash',
  'webhookSecret',
  'apiKey',
  'secret',
];
function leakedKeys(value: unknown, path = ''): string[] {
  if (Array.isArray(value)) return value.flatMap((v) => leakedKeys(v, path));
  if (value && typeof value === 'object') {
    return Object.entries(value).flatMap(([k, v]) => [
      ...(FORBIDDEN_KEYS.includes(k) ? [`${path}.${k}`] : []),
      ...leakedKeys(v, `${path}.${k}`),
    ]);
  }
  return [];
}

/** Hardening checks across the whole API, against the REAL PostgreSQL + Redis (dedicated test database). */
describe('Security hardening (integration)', () => {
  let api: ApiApp;
  let superAdmin: Awaited<ReturnType<typeof loginAdmin>>;
  let routes: RouteInfo[];

  beforeAll(async () => {
    api = await createApiApp();
    superAdmin = await loginAdmin(api);
    routes = listRoutes(api.app);
  });

  afterAll(async () => {
    await api.close();
  });

  describe('route inventory (every endpoint is explicitly protected)', () => {
    it('finds the whole API', () => {
      expect(routes.length).toBeGreaterThan(150);
      expect(new Set(routes.map(key)).size).toBe(routes.length);
    });

    it('allows only the known public routes without authentication', () => {
      expect(
        routes
          .filter((r) => r.isPublic)
          .map(key)
          .sort(),
      ).toEqual([...PUBLIC_ROUTES].sort());
    });

    it('gives every other route a user-type restriction, except the reviewed "any signed-in user" list', () => {
      const unrestricted = routes
        .filter((r) => !r.isPublic && !r.userTypes)
        .map(key)
        .sort();
      expect(unrestricted).toEqual([...ANY_SIGNED_IN_ROUTES].sort());
    });

    it('restricts every /admin route to admin accounts and to an explicit permission or role', () => {
      const admin = routes.filter((r) => r.path.startsWith('/api/v1/admin/') && !r.isPublic);
      expect(admin.length).toBeGreaterThan(60);
      const notAdminOnly = admin.filter(
        (r) => !r.userTypes?.includes('ADMIN') || r.userTypes.length !== 1,
      );
      expect(notAdminOnly.map(key)).toEqual([]);
      const noRequirement = admin.filter((r) => !(r.permissions?.length || r.roles?.length));
      expect(noRequirement.map(key).sort()).toEqual([...ADMIN_WITHOUT_PERMISSION].sort());
    });

    it('never mixes an admin-only route into a customer or worker controller', () => {
      const misplaced = routes.filter(
        (r) => r.userTypes?.includes('ADMIN') && !r.path.startsWith('/api/v1/admin/'),
      );
      expect(misplaced.map(key)).toEqual([]);
      const permissioned = routes.filter(
        (r) => r.permissions?.length && !r.userTypes?.includes('ADMIN'),
      );
      expect(permissioned.map(key)).toEqual([]);
    });

    it('only requires permission codes that exist in the catalog', () => {
      const known = new Set<string>(PERMISSION_CATALOG.map((p) => p.code));
      const unknown = routes.flatMap((r) =>
        (r.permissions ?? []).filter((p) => !known.has(p)).map((p) => `${key(r)} -> ${p}`),
      );
      expect(unknown).toEqual([]);
      const used = new Set(routes.flatMap((r) => r.permissions ?? []));
      const unused = [...known].filter((p) => !used.has(p));
      // every catalog permission guards at least one endpoint (no dead permission that gives a false sense of control)
      expect(unused).toEqual([]);
    });
  });

  describe('permission bypass attempts (every protected route, every wrong caller)', () => {
    let customer: Awaited<ReturnType<typeof loginWithOtp>>;
    let worker: Awaited<ReturnType<typeof loginWithOtp>>;
    let noPermissions: Awaited<ReturnType<typeof loginAdminWithPermissions>>;

    beforeAll(async () => {
      customer = await loginWithOtp(api, { appType: 'CUSTOMER' });
      worker = await loginWithOtp(api, { appType: 'WORKER' });
      noPermissions = await loginAdminWithPermissions(api, []);
    });

    const call = (route: RouteInfo, token?: string) => {
      const req = api.http()[route.method.toLowerCase() as 'get'](concretePath(route.path));
      if (token) req.set('Authorization', `Bearer ${token}`);
      return route.method === 'GET' ? req : req.send({});
    };
    const protectedRoutes = () => routes.filter((r) => !r.isPublic && r.userTypes);

    it('answers 401 to an anonymous caller on every protected route', async () => {
      const wrong: string[] = [];
      for (const route of routes.filter((r) => !r.isPublic)) {
        const res = await call(route);
        if (res.status !== 401) wrong.push(`${key(route)} -> ${res.status}`);
      }
      expect(wrong).toEqual([]);
    });

    it('answers 401 to a forged or malformed token', async () => {
      const route = routes.find((r) => r.path === '/api/v1/admin/audit-logs')!;
      for (const token of ['x', 'a.b.c', `${superAdmin.accessToken}tampered`]) {
        expect((await call(route, token)).status).toBe(401);
      }
    });

    it('answers 403 when the user type is not allowed, never 200, 404 or 500', async () => {
      const wrong: string[] = [];
      for (const route of protectedRoutes()) {
        const callers: Array<[string, { accessToken: string }]> = [
          ['CUSTOMER', customer],
          ['WORKER', worker],
          ['ADMIN', noPermissions],
        ];
        for (const [type, caller] of callers) {
          if (route.userTypes!.includes(type)) continue;
          const res = await call(route, caller.accessToken);
          if (res.status !== 403) wrong.push(`${key(route)} as ${type} -> ${res.status}`);
        }
      }
      expect(wrong).toEqual([]);
    });

    it('answers 403 to an admin holding no permission on every permission-guarded route', async () => {
      const wrong: string[] = [];
      for (const route of protectedRoutes().filter((r) => r.permissions?.length)) {
        const res = await call(route, noPermissions.accessToken);
        if (res.status !== 403) wrong.push(`${key(route)} -> ${res.status}`);
      }
      expect(wrong).toEqual([]);
    });

    it('answers 403 when the admin holds some permissions but not the one the route needs', async () => {
      const wrong: string[] = [];
      const held = await loginAdminWithPermissions(api, ['report.view']);
      for (const route of protectedRoutes().filter(
        (r) => r.permissions?.length && !r.permissions.includes('report.view'),
      )) {
        const res = await call(route, held.accessToken);
        if (res.status !== 403) wrong.push(`${key(route)} -> ${res.status}`);
      }
      expect(wrong).toEqual([]);
    });

    it('answers 403 to a suspended admin who still holds an older token', async () => {
      const victim = await loginAdminWithPermissions(api, ['report.view']);
      await as(api, superAdmin)
        .patch(`/api/v1/admin/users/${victim.userId}/status`, { status: 'SUSPENDED' })
        .expect(200);
      const res = await as(api, victim).get('/api/v1/admin/reports');
      expect(res.status).toBe(401);
    });
  });

  describe('refused access is recorded', () => {
    const denials = (actorId: string) =>
      api.prisma.auditLog.findMany({
        where: { action: 'security.access_denied', actorId },
        orderBy: { createdAt: 'asc' },
      });

    it('records who, which route pattern and which check refused, with no ids, query or body', async () => {
      const customer = await loginWithOtp(api, { appType: 'CUSTOMER' });
      const noPerm = await loginAdminWithPermissions(api, []);
      await as(api, customer)
        .get(`/api/v1/admin/users/${UNKNOWN_ID}?secretQuery=abc123`)
        .expect(403);
      await as(api, noPerm)
        .post(`/api/v1/admin/replacement-requests/${UNKNOWN_ID}/approve`, {
          remarks: 'private-remark',
        })
        .expect(403);

      const [byCustomer] = await denials(customer.userId);
      expect(byCustomer.metadata).toEqual({
        method: 'GET',
        route: '/api/v1/admin/users/:userId',
        reason: 'PERMISSION',
        userType: 'CUSTOMER',
      });
      const [byAdmin] = await denials(noPerm.userId);
      expect(byAdmin.metadata).toEqual({
        method: 'POST',
        route: '/api/v1/admin/replacement-requests/:requestId/approve',
        reason: 'PERMISSION',
        userType: 'ADMIN',
      });
      const stored = JSON.stringify([byCustomer, byAdmin]);
      for (const secret of ['secretQuery', 'abc123', 'private-remark', UNKNOWN_ID]) {
        expect(stored).not.toContain(secret);
      }
      expect(byCustomer.requestId).toBeTruthy();
    });

    it('records a user-type refusal on a route of another app', async () => {
      const worker = await loginWithOtp(api, { appType: 'WORKER' });
      await as(api, worker).get('/api/v1/bookings').expect(403);
      const [row] = await denials(worker.userId);
      expect(row.metadata).toEqual({
        method: 'GET',
        route: '/api/v1/bookings',
        reason: 'USER_TYPE',
        userType: 'WORKER',
      });
    });

    it('records a role refusal and nothing for allowed calls or anonymous calls', async () => {
      const viewer = await loginAdminWithPermissions(api, ['report.view']);
      await as(api, viewer).get('/api/v1/admin/reports').expect(200);
      await api.http().get('/api/v1/admin/reports').expect(401);
      expect(await denials(viewer.userId)).toHaveLength(0);
      await as(api, viewer).get('/api/v1/admin/audit-logs').expect(403);
      const rows = await denials(viewer.userId);
      expect(rows).toHaveLength(1);
      expect(rows[0].metadata).toMatchObject({ reason: 'PERMISSION' });
    });

    it('still answers 403 when the audit write itself fails', async () => {
      const customer = await loginWithOtp(api, { appType: 'CUSTOMER' });
      const spy = jest
        .spyOn(api.app.get(AuditService), 'record')
        .mockRejectedValue(new Error('db down'));
      const res = await as(api, customer).get('/api/v1/admin/reports');
      spy.mockRestore();
      expect(res.status).toBe(403);
      expect(res.body.code).toBe('FORBIDDEN');
      expect(JSON.stringify(res.body)).not.toContain('db down');
    });

    it('is visible to the Super Admin through the audit viewer', async () => {
      const customer = await loginWithOtp(api, { appType: 'CUSTOMER' });
      await as(api, customer).get('/api/v1/admin/dashboard').expect(403);
      const res = await as(api, superAdmin)
        .get(`/api/v1/admin/audit-logs?action=security.access_denied&actorId=${customer.userId}`)
        .expect(200);
      expect(res.body.meta.total).toBe(1);
    });
  });

  describe('authentication events', () => {
    it('records wrong OTP attempts and the lockout, without the mobile number or the code', async () => {
      const mobile = randomMobile();
      await requestOtp(api, mobile);
      const before = await api.prisma.auditLog.count({ where: { action: 'auth.otp_failed' } });
      for (let i = 0; i < 4; i += 1) {
        await api
          .http()
          .post('/api/v1/auth/otp/verify')
          .send({ mobile, otp: '000000', appType: 'CUSTOMER' });
      }
      const rows = await api.prisma.auditLog.findMany({
        where: { action: 'auth.otp_failed' },
        orderBy: { createdAt: 'desc' },
        take: 4,
      });
      expect(
        await api.prisma.auditLog.count({ where: { action: 'auth.otp_failed' } }),
      ).toBeGreaterThan(before);
      const reasons = rows.map((r) => (r.metadata as { reason: string }).reason);
      expect(reasons).toContain('OTP_INVALID');
      expect(reasons).toContain('OTP_ATTEMPTS_EXCEEDED');
      const stored = JSON.stringify(rows);
      expect(stored).not.toContain(mobile);
      expect(stored).not.toContain('000000');
      expect(stored).not.toContain(mobile.slice(3));
    });
  });

  describe('sensitive data never leaves the API', () => {
    it('keeps credentials, hashes, storage keys and secrets out of responses', async () => {
      const area = await createArea(api, superAdmin);
      await setRequiredChecks(api, superAdmin, ['IDENTITY']);
      const customer = await loginWithOtp(api, { appType: 'CUSTOMER' });
      const b = await makeBooking(api, superAdmin, customer, area.id, 'PENDING_PAYMENT');
      await setRequiredChecks(api, superAdmin, []);
      const urls: Array<[string, { accessToken: string }]> = [
        ['/api/v1/users/me', superAdmin],
        ['/api/v1/users/me', customer],
        ['/api/v1/users/me', b.worker],
        ['/api/v1/auth/sessions', customer],
        ['/api/v1/admin/users?limit=100', superAdmin],
        [`/api/v1/admin/users/${customer.userId}`, superAdmin],
        ['/api/v1/admin/roles', superAdmin],
        ['/api/v1/admin/audit-logs?limit=100', superAdmin],
        ['/api/v1/admin/customers?limit=100', superAdmin],
        ['/api/v1/admin/payments?limit=100', superAdmin],
        ['/api/v1/admin/notifications?limit=100', superAdmin],
        [`/api/v1/admin/bookings/${b.id}`, superAdmin],
        ['/api/v1/payments', customer],
      ];
      for (const [url, caller] of urls) {
        const res = await as(api, caller).get(url);
        expect([url, res.status < 500]).toEqual([url, true]);
        expect([url, leakedKeys(res.body)]).toEqual([url, []]);
        expect(JSON.stringify(res.body)).not.toMatch(/\$argon|scrypt\$/i);
      }
    });
  });

  describe('error handling and transport', () => {
    it('answers every failure in the one envelope with a request id and no internals', async () => {
      const probes = [
        () => api.http().get('/api/v1/definitely/not/a/route'),
        () =>
          api
            .http()
            .post('/api/v1/auth/otp/verify')
            .set('Content-Type', 'application/json')
            .send('{"broken'),
        () => api.http().get('/api/v1/admin/users').set('Authorization', 'Bearer nonsense'),
        () => as(api, superAdmin).get('/api/v1/admin/users/not-a-uuid'),
        () =>
          as(api, superAdmin).post('/api/v1/admin/support/categories', {
            code: 'x'.repeat(5000),
            name: [],
          }),
      ];
      for (const probe of probes) {
        const res = await probe();
        expect(res.status).toBeGreaterThanOrEqual(400);
        expect(res.status).toBeLessThan(500);
        expect(res.body).toEqual(
          expect.objectContaining({
            code: expect.any(String),
            message: expect.any(String),
            requestId: expect.any(String),
          }),
        );
        expect(JSON.stringify(res.body)).not.toMatch(
          /at .*\.(ts|js):\d+|node_modules|prisma|select .* from|postgres/i,
        );
        expect(res.headers['x-request-id']).toBe(res.body.requestId);
      }
    });

    it('turns a database failure into a generic 500 without SQL or driver text', async () => {
      const prisma = api.prisma;
      const spy = jest
        .spyOn(prisma.supportCategory, 'findMany')
        .mockRejectedValueOnce(
          new Error(
            'connection to server at "10.0.0.5" failed: password authentication failed for user "sevanest"',
          ),
        );
      const res = await as(api, superAdmin).get('/api/v1/admin/support/categories');
      spy.mockRestore();
      expect(res.status).toBe(500);
      expect(res.body.code).toBe('INTERNAL_ERROR');
      expect(JSON.stringify(res.body)).not.toMatch(/10\.0\.0\.5|password|sevanest|connection/i);
      expect(res.body.requestId).toBeTruthy();
    });

    it('sets the hardening headers and hides the framework', async () => {
      const res = await api.http().get('/health/live');
      expect(res.headers['x-powered-by']).toBeUndefined();
      expect(res.headers['x-content-type-options']).toBe('nosniff');
      expect(res.headers['strict-transport-security']).toBeDefined();
      expect(res.headers['x-frame-options']).toBeDefined();
    });

    it('rejects an oversized body before it reaches any handler', async () => {
      const res = await as(api, superAdmin).post('/api/v1/admin/support/categories', {
        code: 'A_B',
        name: 'x'.repeat(2_000_000),
      });
      expect(res.status).toBe(413);
      expect(res.body.code).toBe('PAYLOAD_TOO_LARGE');
    });
  });

  describe('state changes by privileged users leave an audit trail', () => {
    it('audits configuration, status, role and moderation changes with the actor', async () => {
      const customer = await loginWithOtp(api, { appType: 'CUSTOMER' });
      const a = as(api, superAdmin);
      const start = new Date();
      await a
        .put('/api/v1/admin/fees/booking-fee', { amountMinor: 50000, isActive: true })
        .expect(200);
      const category = await a
        .post('/api/v1/admin/service-categories', {
          code: `SEC_${Date.now()}`,
          name: `Security probe ${Date.now()}`,
        })
        .expect(201);
      await a
        .patch(`/api/v1/admin/service-categories/${category.body.id}`, {
          name: `Security probe b ${Date.now()}`,
        })
        .expect(200);
      await createArea(api, superAdmin);
      await setRequiredChecks(api, superAdmin, ['IDENTITY']);
      await setRequiredChecks(api, superAdmin, []);
      await a
        .patch(`/api/v1/admin/users/${customer.userId}/status`, { status: 'SUSPENDED' })
        .expect(200);
      await a
        .patch(`/api/v1/admin/customers/${customer.userId}/verification-status`, {
          status: 'VERIFIED',
        })
        .then(() => undefined);
      await a
        .put('/api/v1/admin/roles/OPERATIONS_ADMIN/permissions', {
          permissionCodes: ['report.view'],
        })
        .expect(200);
      await a
        .put('/api/v1/admin/roles/OPERATIONS_ADMIN/permissions', { permissionCodes: [] })
        .expect(200);

      const actions = await api.prisma.auditLog.findMany({
        where: { actorId: superAdmin.userId, createdAt: { gte: start } },
        select: { action: true, actorRole: true },
      });
      const seen = new Set(actions.map((x) => x.action));
      for (const expected of [
        'payment.fee_set',
        'service_category.create',
        'service_category.update',
        'service_area.create',
        'verification.requirements_set',
        'user.status_change',
        'role.permissions_set',
      ]) {
        expect([expected, seen.has(expected)]).toEqual([expected, true]);
      }
      expect(
        actions.every(
          (x) => (x.actorRole ?? 'SUPER_ADMIN').includes('SUPER_ADMIN') || x.actorRole === null,
        ),
      ).toBe(true);
    });

    it('keeps the audit table append-only at the database level', async () => {
      const row = await api.prisma.auditLog.findFirstOrThrow({
        where: { actorId: superAdmin.userId },
      });
      await expect(
        api.prisma.auditLog.update({ where: { id: row.id }, data: { action: 'tampered' } }),
      ).rejects.toThrow();
      await expect(api.prisma.auditLog.delete({ where: { id: row.id } })).rejects.toThrow();
      await expect(api.prisma.$executeRawUnsafe('TRUNCATE audit_logs')).rejects.toThrow();
    });
  });
});
