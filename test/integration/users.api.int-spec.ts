import '../support/env-api-integration';
import {
  ADMIN_PASSWORD,
  ApiApp,
  adminLogin,
  bearer,
  createApiApp,
  loginAdmin,
  loginAdminWithPermissions,
  loginWithOtp,
  otpKeyId,
  randomMobile,
  unique,
} from '../support/api-app';
import { AdminRoleCode, PERMISSION_CATALOG } from '../../src/modules/users/rbac.constants';
import { RbacSeedService } from '../../src/modules/users/rbac-seed.service';

const UNKNOWN_ID = '00000000-0000-7000-8000-000000000000';

async function eventually(check: () => Promise<boolean>, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('condition not met in time');
}

/** Users module + RBAC against the REAL PostgreSQL + Redis (dedicated test database), through the HTTP API. */
describe('Users API (integration)', () => {
  let api: ApiApp;
  let superAdmin: Awaited<ReturnType<typeof loginAdmin>>;

  beforeAll(async () => {
    api = await createApiApp();
    superAdmin = await loginAdmin(api);
  });
  afterAll(async () => {
    await api.close();
  });

  describe('GET /users/me', () => {
    it('answers who a customer is, with no roles or permissions', async () => {
      const customer = await loginWithOtp(api);
      const res = await api.http().get('/api/v1/users/me').set('Authorization', bearer(customer));
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({
        id: customer.userId,
        type: 'CUSTOMER',
        status: 'ACTIVE',
        mobile: customer.mobile,
        email: null,
        roles: [],
        permissions: [],
      });
    });

    it('answers a worker and an admin with their own type, role and permissions', async () => {
      const worker = await loginWithOtp(api, { appType: 'WORKER' });
      const asWorker = await api
        .http()
        .get('/api/v1/users/me')
        .set('Authorization', bearer(worker));
      expect(asWorker.body).toMatchObject({ type: 'WORKER', roles: [] });

      const asAdmin = await api
        .http()
        .get('/api/v1/users/me')
        .set('Authorization', bearer(superAdmin));
      expect(asAdmin.body).toMatchObject({ type: 'ADMIN', roles: ['SUPER_ADMIN'] });
      expect(asAdmin.body.permissions).toEqual(
        expect.arrayContaining(PERMISSION_CATALOG.map((p) => p.code)),
      );
      expect(JSON.stringify(asAdmin.body)).not.toMatch(/passwordHash|scrypt/i);
    });

    it('requires authentication', async () => {
      await api.http().get('/api/v1/users/me').expect(401);
    });
  });

  describe('POST /admin/users (create admin)', () => {
    const body = (extra: object = {}) => ({
      email: `ops.${unique()}@example.test`,
      password: ADMIN_PASSWORD,
      roleCode: AdminRoleCode.OPERATIONS_ADMIN,
      ...extra,
    });

    it('lets a Super Admin create an admin who can then log in', async () => {
      const payload = body();
      const res = await api
        .http()
        .post('/api/v1/admin/users')
        .set('Authorization', bearer(superAdmin))
        .send(payload);
      expect(res.status).toBe(201);
      expect(res.body).toMatchObject({
        type: 'ADMIN',
        status: 'ACTIVE',
        email: payload.email,
        mobile: null,
      });
      expect(JSON.stringify(res.body)).not.toMatch(/password|scrypt/i);

      const login = await adminLogin(api, payload);
      expect(login.status).toBe(200);
      expect(login.body.user.roles).toEqual(['OPERATIONS_ADMIN']);

      const stored = await api.prisma.user.findUniqueOrThrow({ where: { email: payload.email } });
      expect(stored.passwordHash).toMatch(/^scrypt\$/);
      expect(stored.passwordHash).not.toContain(payload.password);
      const audit = await api.prisma.auditLog.findMany({
        where: { action: 'admin.create', entityId: stored.id },
      });
      expect(audit).toHaveLength(1);
      expect(audit[0].actorId).toBe(superAdmin.userId);
      expect(audit[0].actorRole).toBe('SUPER_ADMIN');
      expect(JSON.stringify(audit[0])).not.toContain(payload.password);
    });

    it('rejects a duplicate email with 409 ADMIN_EMAIL_TAKEN', async () => {
      const payload = body();
      await api
        .http()
        .post('/api/v1/admin/users')
        .set('Authorization', bearer(superAdmin))
        .send(payload)
        .expect(201);
      const dup = await api
        .http()
        .post('/api/v1/admin/users')
        .set('Authorization', bearer(superAdmin))
        .send({ ...payload, email: payload.email.toUpperCase() });
      expect(dup.status).toBe(409);
      expect(dup.body.code).toBe('ADMIN_EMAIL_TAKEN');
    });

    it('creates exactly one account when the same request is sent in parallel', async () => {
      const payload = body();
      const results = await Promise.all(
        Array.from({ length: 4 }, () =>
          api
            .http()
            .post('/api/v1/admin/users')
            .set('Authorization', bearer(superAdmin))
            .send(payload),
        ),
      );
      expect(results.filter((r) => r.status === 201)).toHaveLength(1);
      expect(results.filter((r) => r.status === 409)).toHaveLength(3);
      expect(await api.prisma.user.count({ where: { email: payload.email } })).toBe(1);
    });

    it('enforces the configured minimum password length and field validation', async () => {
      const short = await api
        .http()
        .post('/api/v1/admin/users')
        .set('Authorization', bearer(superAdmin))
        .send(body({ password: 'short-pw' }));
      expect(short.status).toBe(400);
      expect(short.body.code).toBe('VALIDATION_FAILED');
      expect(short.body.details[0].field).toBe('password');
      expect(JSON.stringify(short.body)).not.toContain('short-pw');

      for (const bad of [
        { email: 'nope' },
        { roleCode: 'ROOT' },
        { roleCode: undefined },
        { password: undefined },
      ]) {
        const res = await api
          .http()
          .post('/api/v1/admin/users')
          .set('Authorization', bearer(superAdmin))
          .send(body(bad));
        expect(res.status).toBe(400);
        expect(res.body.code).toBe('VALIDATION_FAILED');
      }
    });

    it('ignores fields a client must not control (mass assignment)', async () => {
      const payload = body({
        status: 'SUSPENDED',
        type: 'CUSTOMER',
        id: UNKNOWN_ID,
        passwordHash: 'x',
      });
      const res = await api
        .http()
        .post('/api/v1/admin/users')
        .set('Authorization', bearer(superAdmin))
        .send(payload);
      expect(res.status).toBe(201);
      expect(res.body).toMatchObject({ type: 'ADMIN', status: 'ACTIVE' });
      expect(res.body.id).not.toBe(UNKNOWN_ID);
    });

    it('is forbidden to an admin whose role lacks admin.manage_users, to customers, to workers, and to anonymous callers', async () => {
      const noPermission = await loginAdminWithPermissions(api, ['customer.view']);
      const customer = await loginWithOtp(api);
      const worker = await loginWithOtp(api, { appType: 'WORKER' });
      for (const caller of [noPermission, customer, worker]) {
        const res = await api
          .http()
          .post('/api/v1/admin/users')
          .set('Authorization', bearer(caller))
          .send(body());
        expect(res.status).toBe(403);
        expect(res.body.code).toBe('FORBIDDEN');
      }
      await api.http().post('/api/v1/admin/users').send(body()).expect(401);
    });
  });

  describe('GET /admin/users/:userId', () => {
    it('returns the account with the mobile masked', async () => {
      const customer = await loginWithOtp(api);
      const res = await api
        .http()
        .get(`/api/v1/admin/users/${customer.userId}`)
        .set('Authorization', bearer(superAdmin));
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ id: customer.userId, type: 'CUSTOMER', status: 'ACTIVE' });
      expect(res.body.mobile).toMatch(/^\+91\*{6}\d{4}$/);
      expect(res.body.mobile).not.toBe(customer.mobile);
    });

    it('returns 404 for an unknown account, 400 for a malformed id, 403 without user.view', async () => {
      await api
        .http()
        .get(`/api/v1/admin/users/${UNKNOWN_ID}`)
        .set('Authorization', bearer(superAdmin))
        .expect(404);
      await api
        .http()
        .get('/api/v1/admin/users/not-a-uuid')
        .set('Authorization', bearer(superAdmin))
        .expect(400);
      const noPermission = await loginAdminWithPermissions(api, ['customer.view']);
      await api
        .http()
        .get(`/api/v1/admin/users/${UNKNOWN_ID}`)
        .set('Authorization', bearer(noPermission))
        .expect(403);
    });
  });

  describe('PATCH /admin/users/:userId/status', () => {
    const patch = (caller: { accessToken: string }, userId: string, body: object) =>
      api
        .http()
        .patch(`/api/v1/admin/users/${userId}/status`)
        .set('Authorization', bearer(caller))
        .send(body);

    it('suspends a customer: login stops, sessions are revoked, the change is audited with before/after', async () => {
      const customer = await loginWithOtp(api);
      const res = await patch(superAdmin, customer.userId, {
        status: 'SUSPENDED',
        reason: 'abuse report 123',
      });
      expect(res.status).toBe(200);
      expect(res.body.status).toBe('SUSPENDED');

      await api.http().get('/api/v1/users/me').set('Authorization', bearer(customer)).expect(401); // immediately, via the guard
      await eventually(async () => {
        const session = await api.prisma.session.findUniqueOrThrow({
          where: { id: customer.sessionId },
        });
        return session.revokedAt !== null; // and physically, via the event handler
      });
      const refresh = await api
        .http()
        .post('/api/v1/auth/token/refresh')
        .send({ refreshToken: customer.refreshToken });
      expect(refresh.status).toBe(401);

      const audit = await api.prisma.auditLog.findMany({
        where: { action: 'user.status_change', entityId: customer.userId },
      });
      expect(audit).toHaveLength(1);
      expect(audit[0]).toMatchObject({ actorId: superAdmin.userId, actorRole: 'SUPER_ADMIN' });
      expect(audit[0].metadata).toMatchObject({
        from: 'ACTIVE',
        to: 'SUSPENDED',
        userType: 'CUSTOMER',
        reason: 'abuse report 123',
      });
    });

    it('reactivates a suspended account, which can then log in again', async () => {
      const customer = await loginWithOtp(api);
      await patch(superAdmin, customer.userId, { status: 'SUSPENDED' }).expect(200);
      await patch(superAdmin, customer.userId, { status: 'ACTIVE' }).expect(200);
      await api.redis.ensureConnected();
      await api.redis.client.del(`auth:otp:cooldown:${otpKeyId(customer.mobile!)}`);
      const again = await loginWithOtp(api, { mobile: customer.mobile });
      expect(again.userId).toBe(customer.userId);
    });

    it('is idempotent: repeating the same status writes no extra audit record', async () => {
      const customer = await loginWithOtp(api);
      await patch(superAdmin, customer.userId, { status: 'SUSPENDED' }).expect(200);
      await patch(superAdmin, customer.userId, { status: 'SUSPENDED' }).expect(200);
      expect(
        await api.prisma.auditLog.count({
          where: { action: 'user.status_change', entityId: customer.userId },
        }),
      ).toBe(1);
    });

    it('serialises parallel changes: five concurrent suspensions produce one change and one audit record', async () => {
      const customer = await loginWithOtp(api);
      const results = await Promise.all(
        Array.from({ length: 5 }, () =>
          patch(superAdmin, customer.userId, { status: 'SUSPENDED' }),
        ),
      );
      expect(results.every((r) => r.status === 200)).toBe(true);
      expect(
        await api.prisma.auditLog.count({
          where: { action: 'user.status_change', entityId: customer.userId },
        }),
      ).toBe(1);
    });

    it('does not let an admin change their own status', async () => {
      const res = await patch(superAdmin, superAdmin.userId, { status: 'SUSPENDED' });
      expect(res.status).toBe(409);
      expect(res.body.code).toBe('CANNOT_CHANGE_OWN_STATUS');
      await api.http().get('/api/v1/users/me').set('Authorization', bearer(superAdmin)).expect(200);
    });

    it('requires admin.manage_users in addition to user.status.manage to change an ADMIN account', async () => {
      const statusOnly = await loginAdminWithPermissions(api, ['user.status.manage']);
      const otherAdmin = await loginAdmin(api, AdminRoleCode.SUPPORT_EXECUTIVE);
      const customer = await loginWithOtp(api);

      const forbidden = await patch(statusOnly, otherAdmin.userId, { status: 'SUSPENDED' });
      expect(forbidden.status).toBe(403);
      await api.http().get('/api/v1/users/me').set('Authorization', bearer(otherAdmin)).expect(200);

      await patch(statusOnly, customer.userId, { status: 'SUSPENDED' }).expect(200);
      await patch(superAdmin, otherAdmin.userId, { status: 'SUSPENDED' }).expect(200);
      await api.http().get('/api/v1/users/me').set('Authorization', bearer(otherAdmin)).expect(401);
    });

    it('answers 404 for unknown users, 400 for bad bodies, 403 without the permission, 403 for non-admins', async () => {
      await patch(superAdmin, UNKNOWN_ID, { status: 'SUSPENDED' }).expect(404);
      await patch(superAdmin, UNKNOWN_ID, { status: 'BLOCKED' }).expect(400);
      await patch(superAdmin, 'bad-id', { status: 'ACTIVE' }).expect(400);
      const wrongPermission = await loginAdminWithPermissions(api, ['customer.view', 'user.view']);
      const customer = await loginWithOtp(api);
      await patch(wrongPermission, customer.userId, { status: 'SUSPENDED' }).expect(403);
      const other = await loginWithOtp(api);
      await patch(other, customer.userId, { status: 'SUSPENDED' }).expect(403);
      await api.http().get('/api/v1/users/me').set('Authorization', bearer(customer)).expect(200); // untouched
    });
  });

  describe('inactive and cross-role access', () => {
    it('stops a suspended admin from using any admin endpoint with an existing token', async () => {
      const admin = await loginAdmin(api);
      await api.prisma.user.update({ where: { id: admin.userId }, data: { status: 'SUSPENDED' } });
      const res = await api
        .http()
        .get(`/api/v1/admin/users/${UNKNOWN_ID}`)
        .set('Authorization', bearer(admin));
      expect(res.status).toBe(401);
    });

    it('keeps customers and workers out of every admin endpoint', async () => {
      const customer = await loginWithOtp(api);
      const worker = await loginWithOtp(api, { appType: 'WORKER' });
      for (const caller of [customer, worker]) {
        await api
          .http()
          .get(`/api/v1/admin/users/${customer.userId}`)
          .set('Authorization', bearer(caller))
          .expect(403);
        await api
          .http()
          .patch(`/api/v1/admin/users/${customer.userId}/status`)
          .set('Authorization', bearer(caller))
          .send({ status: 'SUSPENDED' })
          .expect(403);
        await api
          .http()
          .post('/api/v1/admin/users')
          .set('Authorization', bearer(caller))
          .send({})
          .expect(403);
      }
    });

    it('applies a role change on the very next request (permissions are read from the database)', async () => {
      const admin = await loginAdminWithPermissions(api, ['user.view']);
      const customer = await loginWithOtp(api);
      await api
        .http()
        .get(`/api/v1/admin/users/${customer.userId}`)
        .set('Authorization', bearer(admin))
        .expect(200);
      await api.prisma.userRole.deleteMany({ where: { userId: admin.userId } });
      await api
        .http()
        .get(`/api/v1/admin/users/${customer.userId}`)
        .set('Authorization', bearer(admin))
        .expect(403);
    });
  });

  describe('account creation and reference data', () => {
    it('creates exactly one account when many first-time verifications race for the same mobile', async () => {
      const mobile = randomMobile();
      const results = await Promise.all(
        Array.from({ length: 6 }, () => api.users.findOrCreateByMobile(mobile, 'CUSTOMER')),
      );
      expect(results.filter((r) => r.isNewUser)).toHaveLength(1);
      expect(new Set(results.map((r) => r.user.id)).size).toBe(1);
      expect(await api.prisma.user.count({ where: { mobile } })).toBe(1);
      expect(
        await api.prisma.auditLog.count({
          where: { action: 'user.register', entityId: results[0].user.id },
        }),
      ).toBe(1);
    });

    it('seeds RBAC reference data idempotently and only maps SUPER_ADMIN', async () => {
      const seed = api.app.get(RbacSeedService);
      const before = await Promise.all([
        api.prisma.role.count(),
        api.prisma.permission.count(),
        api.prisma.rolePermission.count(),
      ]);
      await seed.ensureReferenceData();
      await seed.ensureReferenceData();
      const after = await Promise.all([
        api.prisma.role.count(),
        api.prisma.permission.count(),
        api.prisma.rolePermission.count(),
      ]);
      expect(after).toEqual(before);

      const roles = await api.prisma.role.findMany({
        where: { code: { in: Object.values(AdminRoleCode) } },
        select: { code: true, permissions: { select: { permission: { select: { code: true } } } } },
      });
      expect(roles.map((r) => r.code).sort()).toEqual(Object.values(AdminRoleCode).sort());
      const byCode = Object.fromEntries(roles.map((r) => [r.code, r.permissions.length]));
      expect(byCode.SUPER_ADMIN).toBe(PERMISSION_CATALOG.length);
      // Everything else is an OPEN decision (Q-11): not mapped.
      expect(byCode.OPERATIONS_ADMIN).toBe(0);
      expect(byCode.VERIFICATION_EXECUTIVE).toBe(0);
      expect(byCode.SUPPORT_EXECUTIVE).toBe(0);
    });

    it('does not bootstrap a second Super Admin', async () => {
      const seed = api.app.get(RbacSeedService);
      expect(
        await seed.bootstrapSuperAdmin(`second.${unique()}@example.test`, ADMIN_PASSWORD),
      ).toBe(false);
    });
  });
});
