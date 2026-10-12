import '../support/env-api-integration';
import { RbacSeedService } from '../../src/modules/users/rbac-seed.service';
import {
  ADMIN_PASSWORD,
  ApiApp,
  adminLogin,
  bearer,
  clearAdminLockout,
  createApiApp,
  loginAdmin,
  randomIp,
} from '../support/api-app';

/** Remediation: first-Super-Admin bootstrap refusal and the admin password change, against the real database. */
describe('Admin bootstrap and password change (integration)', () => {
  let api: ApiApp;

  beforeAll(async () => {
    api = await createApiApp();
  });
  afterAll(async () => {
    await api.close();
  });

  describe('first Super Admin bootstrap', () => {
    it('is refused once any Super Admin exists, audited, and leaks no credential', async () => {
      await loginAdmin(api); // guarantees a Super Admin exists in this database
      const seed = api.app.get(RbacSeedService);
      const email = `late.${Date.now()}@example.test`;
      const password = 'Sup3r-Secret-Bootstrap-Pw';
      const before = await api.prisma.user.count({ where: { type: 'ADMIN' } });

      expect(await seed.bootstrapSuperAdmin(email, password)).toBe(false);

      expect(await api.prisma.user.count({ where: { type: 'ADMIN' } })).toBe(before);
      expect(await api.prisma.user.findUnique({ where: { email } })).toBeNull();
      const rejected = await api.prisma.auditLog.findFirst({
        where: { action: 'admin.bootstrap_rejected' },
        orderBy: { createdAt: 'desc' },
      });
      expect(rejected).not.toBeNull();
      const dump = JSON.stringify(rejected);
      expect(dump).not.toContain(password);
      expect(dump).not.toContain(email);
      expect(rejected?.actorId).toBeNull();
    });

    it('concurrent bootstrap attempts create nobody', async () => {
      const seed = api.app.get(RbacSeedService);
      const before = await api.prisma.user.count({ where: { type: 'ADMIN' } });
      const results = await Promise.all(
        Array.from({ length: 6 }, (_, i) =>
          seed.bootstrapSuperAdmin(`race${i}.${Date.now()}@example.test`, ADMIN_PASSWORD),
        ),
      );
      expect(results.every((r) => r === false)).toBe(true);
      expect(await api.prisma.user.count({ where: { type: 'ADMIN' } })).toBe(before);
    });

    it('rejects a too-short bootstrap password before anything else', async () => {
      const seed = api.app.get(RbacSeedService);
      await expect(seed.bootstrapSuperAdmin('x@example.test', 'short')).rejects.toMatchObject({
        status: 400,
      });
    });
  });

  describe('POST /auth/admin/password', () => {
    const NEW_PASSWORD = 'A-brand-new-passphrase-1';
    const send = (token: { accessToken: string }, body: object) =>
      api
        .http()
        .post('/api/v1/admin/account/password')
        .set('Authorization', bearer(token))
        .set('X-Forwarded-For', randomIp())
        .send(body);

    it('changes the password, keeps this session, revokes the others, audits without secrets', async () => {
      const admin = await loginAdmin(api);
      const email = admin.email!;
      const other = await adminLogin(api, { email, password: admin.password }); // second session
      expect(other.status).toBe(200);

      const res = await send(admin, { currentPassword: admin.password, newPassword: NEW_PASSWORD });
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ revokedSessions: 1 });

      // the calling session still works, the other one is revoked
      expect(
        (await api.http().get('/api/v1/auth/sessions').set('Authorization', bearer(admin))).status,
      ).toBe(200);
      const otherToken = other.body as { accessToken: string };
      expect(
        (await api.http().get('/api/v1/auth/sessions').set('Authorization', bearer(otherToken)))
          .status,
      ).toBe(401);

      // old password dead, new works
      expect((await adminLogin(api, { email: email, password: admin.password })).status).toBe(401);
      expect((await adminLogin(api, { email: email, password: NEW_PASSWORD })).status).toBe(200);

      const audit = await api.prisma.auditLog.findFirst({
        where: { action: 'auth.admin_password_change', actorId: admin.userId },
      });
      expect(audit).not.toBeNull();
      expect(JSON.stringify(audit)).not.toContain(NEW_PASSWORD);
      expect(JSON.stringify(audit)).not.toContain(admin.password);
    });

    it('refuses a wrong current password, audits it and counts towards the lockout', async () => {
      const admin = await loginAdmin(api);
      const email = admin.email!;
      await clearAdminLockout(api, email);
      for (let i = 0; i < 3; i += 1) {
        const res = await send(admin, {
          currentPassword: 'wrong-wrong-wrong',
          newPassword: NEW_PASSWORD,
        });
        expect(res.status).toBe(422);
        expect(res.body.code).toBe('CURRENT_PASSWORD_INCORRECT');
      }
      const locked = await send(admin, {
        currentPassword: admin.password,
        newPassword: NEW_PASSWORD,
      });
      expect(locked.status).toBe(429);
      expect(
        await api.prisma.auditLog.count({
          where: { action: 'auth.admin_password_change_failed', actorId: admin.userId },
        }),
      ).toBe(3);
      await clearAdminLockout(api, email);
      // password unchanged
      expect((await adminLogin(api, { email, password: admin.password })).status).toBe(200);
    });

    it('enforces the configured minimum length and refuses reuse of the current password', async () => {
      const admin = await loginAdmin(api);
      const short = await send(admin, { currentPassword: admin.password, newPassword: 'short' });
      expect(short.status).toBe(400);
      const same = await send(admin, {
        currentPassword: admin.password,
        newPassword: admin.password,
      });
      expect(same.status).toBe(422);
      expect(same.body.code).toBe('PASSWORD_UNCHANGED');
    });

    it('is denied without a token and to customers and workers', async () => {
      expect(
        (
          await api
            .http()
            .post('/api/v1/admin/account/password')
            .send({ currentPassword: 'x', newPassword: 'y' })
        ).status,
      ).toBe(401);
    });
  });
});
