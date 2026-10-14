import '../support/env-api-integration';
import {
  ApiApp,
  bearer,
  createApiApp,
  loginAdmin,
  loginAdminWithPermissions,
  loginWithOtp,
} from '../support/api-app';
import {
  AdminRoleCode,
  DEFAULT_ROLE_PERMISSIONS,
  PERMISSION_CATALOG,
} from '../../src/modules/users/rbac.constants';
import { RbacSeedService } from '../../src/modules/users/rbac-seed.service';

const UNKNOWN_ID = '00000000-0000-7000-8000-000000000000';
const OTHER_ROLES = [
  AdminRoleCode.OPERATIONS_ADMIN,
  AdminRoleCode.VERIFICATION_EXECUTIVE,
  AdminRoleCode.SUPPORT_EXECUTIVE,
];

/**
 * Admin session restoration: the permission set must be the same, and authoritative, at login, at refresh and at
 * GET /users/me (the three calls the admin portal uses), and the server must enforce it on every route.
 */
describe('Admin session and permission consistency (integration)', () => {
  let api: ApiApp;

  const emptyRoles = (): Promise<unknown> =>
    api.prisma.rolePermission.deleteMany({ where: { role: { code: { in: OTHER_ROLES } } } });
  const me = (who: { accessToken: string }) =>
    api.http().get('/api/v1/users/me').set('Authorization', bearer(who));
  const get = (who: { accessToken: string }, path: string) =>
    api.http().get(path).set('Authorization', bearer(who));
  const refresh = (refreshToken: unknown) =>
    api
      .http()
      .post('/api/v1/auth/token/refresh')
      .send({ refreshToken: refreshToken as string });
  const login = (email: string, password: string) =>
    api
      .http()
      .post('/api/v1/auth/admin/login')
      .set('X-Forwarded-For', `10.9.${Math.floor(Math.random() * 250)}.${Date.now() % 250}`)
      .send({ email, password });
  const sorted = (codes: unknown): string[] => [...(codes as string[])].sort();

  beforeAll(async () => {
    api = await createApiApp();
    // The shared test database keeps the three roles empty for other suites; give them the D-71 set for this suite only.
    await emptyRoles();
    await api.app.get(RbacSeedService).ensureReferenceData();
  });
  afterAll(async () => {
    await emptyRoles();
    await api.close();
  });

  describe('Verification Executive: login -> refresh -> /users/me', () => {
    it('returns the same identity, role and permission set at every stage, using the catalog codes', async () => {
      const session = await loginAdmin(api, AdminRoleCode.VERIFICATION_EXECUTIVE);
      const loginRes = await login(session.email!, session.password);
      expect(loginRes.status).toBe(200);
      const expected = sorted([...DEFAULT_ROLE_PERMISSIONS[AdminRoleCode.VERIFICATION_EXECUTIVE]]);

      expect(loginRes.body.user).toMatchObject({
        id: session.userId,
        type: 'ADMIN',
        roles: ['VERIFICATION_EXECUTIVE'],
      });
      expect(sorted(loginRes.body.user.permissions)).toEqual(expected);

      const refreshed = await refresh(loginRes.body.refreshToken);
      expect(refreshed.status).toBe(200);
      expect(refreshed.body.user).toMatchObject({
        id: session.userId,
        type: 'ADMIN',
        roles: ['VERIFICATION_EXECUTIVE'],
      });
      expect(sorted(refreshed.body.user.permissions)).toEqual(expected);

      const restored = await me({ accessToken: refreshed.body.accessToken });
      expect(restored.status).toBe(200);
      expect(restored.body).toMatchObject({
        id: session.userId,
        type: 'ADMIN',
        roles: ['VERIFICATION_EXECUTIVE'],
      });
      expect(sorted(restored.body.permissions)).toEqual(expected);

      // The catalog codes are singular: `worker.view` is granted, `workers.view` does not exist.
      expect(restored.body.permissions).toEqual(
        expect.arrayContaining(['verification.review', 'worker.view']),
      );
      expect(restored.body.permissions).not.toContain('workers.view');
      expect(PERMISSION_CATALOG.map((p) => p.code)).not.toContain('workers.view');

      // Neither response carries a token claim list or secret beyond the existing contract.
      expect(JSON.stringify(refreshed.body.user)).not.toMatch(/passwordHash|scrypt|token/i);
    });

    it('does not put roles or permissions on a customer or worker refresh', async () => {
      const customer = await loginWithOtp(api);
      const res = await refresh(customer.refreshToken);
      expect(res.status).toBe(200);
      expect(res.body.user.type).toBe('CUSTOMER');
      expect(res.body.user.roles).toBeUndefined();
      expect(res.body.user.permissions).toBeUndefined();
    });

    it('refresh rotates the token, rejects the old one and keeps /users/me working with the new access token', async () => {
      const session = await loginAdmin(api, AdminRoleCode.VERIFICATION_EXECUTIVE);
      const first = await refresh(session.refreshToken);
      expect(first.status).toBe(200);
      expect(first.body.refreshToken).not.toBe(session.refreshToken);
      const second = await refresh(first.body.refreshToken);
      expect(second.status).toBe(200);
      await me({ accessToken: second.body.accessToken }).expect(200);
      // the very first refresh token was rotated twice ago: refused
      expect((await refresh(session.refreshToken)).status).toBe(401);
    });
  });

  describe('role-permission changes follow the documented strategy (database read on every request)', () => {
    it('removing worker.view is seen at once by an old token and by the next refresh and /users/me', async () => {
      const admin = await loginAdminWithPermissions(api, ['worker.view', 'verification.review']);
      const roleCode = (await me(admin)).body.roles[0] as string;
      await get(admin, '/api/v1/admin/workers').expect(200);

      const superAdmin = await loginAdmin(api);
      await api
        .http()
        .put(`/api/v1/admin/roles/${roleCode}/permissions`)
        .set('Authorization', bearer(superAdmin))
        .send({ permissionCodes: ['verification.review'] })
        .expect(200);

      // same access token, no new login: the change applies on the very next request
      await get(admin, '/api/v1/admin/workers').expect(403);
      await get(admin, '/api/v1/admin/verification/queue').expect(200);

      const refreshed = await refresh(admin.refreshToken);
      expect(refreshed.status).toBe(200);
      expect(refreshed.body.user.permissions).toEqual(['verification.review']);
      const restored = await me({ accessToken: refreshed.body.accessToken });
      expect(restored.body.permissions).toEqual(['verification.review']);
    });

    it('never grants a permission that the role does not hold (no wildcard for a role with none)', async () => {
      const none = await loginAdminWithPermissions(api, []);
      expect((await me(none)).body.permissions).toEqual([]);
      for (const path of [
        '/api/v1/admin/workers',
        '/api/v1/admin/verification/queue',
        `/api/v1/admin/verification/documents/${UNKNOWN_ID}/link`,
        '/api/v1/admin/users',
      ]) {
        expect((await get(none, path)).status).toBe(403);
      }
      // the dashboard shell needs no permission, so a successful login does not imply module access
      await get(none, '/api/v1/admin/dashboard').expect(200);
    });
  });

  describe('enforcement is independent of the frontend', () => {
    it('worker endpoints: worker.view allows reads, its absence is 403, no token is 401, unknown id is 404 not 403', async () => {
      const viewer = await loginAdminWithPermissions(api, ['worker.view']);
      const reviewer = await loginAdminWithPermissions(api, ['verification.review']);
      await get(viewer, '/api/v1/admin/workers').expect(200);
      await get(viewer, `/api/v1/admin/workers/${UNKNOWN_ID}`).expect(404);
      await get(reviewer, '/api/v1/admin/workers').expect(403);
      await get(reviewer, `/api/v1/admin/workers/${UNKNOWN_ID}`).expect(403);
      await api.http().get('/api/v1/admin/workers').expect(401);
      // worker.view does not allow worker edits
      await api
        .http()
        .patch(`/api/v1/admin/workers/${UNKNOWN_ID}`)
        .set('Authorization', bearer(viewer))
        .send({})
        .expect(403);
    });

    it('verification queue and KYC documents are separate permissions', async () => {
      const reviewOnly = await loginAdminWithPermissions(api, ['verification.review']);
      const docOnly = await loginAdminWithPermissions(api, ['verification.document.view']);
      await get(reviewOnly, '/api/v1/admin/verification/queue').expect(200);
      await get(docOnly, '/api/v1/admin/verification/queue').expect(403);
      await get(reviewOnly, `/api/v1/admin/verification/documents/${UNKNOWN_ID}/link`).expect(403);
      await get(docOnly, `/api/v1/admin/verification/documents/${UNKNOWN_ID}/link`).expect(404);
      await api.http().get(`/api/v1/admin/verification/documents/${UNKNOWN_ID}/link`).expect(401);
    });

    it('a customer or worker token is 403 on admin routes, an admin token is 403 on customer routes', async () => {
      const customer = await loginWithOtp(api);
      const worker = await loginWithOtp(api, { appType: 'WORKER' });
      await get(customer, '/api/v1/admin/workers').expect(403);
      await get(worker, '/api/v1/admin/verification/queue').expect(403);
      const admin = await loginAdmin(api);
      await get(admin, '/api/v1/customers/me').expect(403);
    });

    it('client-side tampering with the token or request cannot add permissions', async () => {
      const reviewer = await loginAdminWithPermissions(api, ['verification.review']);
      // rewrite the payload (add claims, keep the signature): signature check fails
      const [header, payload, signature] = reviewer.accessToken.split('.');
      const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as object;
      const forgedPayload = Buffer.from(
        JSON.stringify({ ...claims, roles: ['SUPER_ADMIN'], permissions: ['worker.view'] }),
      ).toString('base64url');
      const forged = `${header}.${forgedPayload}.${signature}`;
      await api
        .http()
        .get('/api/v1/admin/workers')
        .set('Authorization', `Bearer ${forged}`)
        .expect(401);
      // unsigned token
      const unsigned = `${Buffer.from('{"alg":"none","typ":"JWT"}').toString('base64url')}.${forgedPayload}.`;
      await api
        .http()
        .get('/api/v1/admin/workers')
        .set('Authorization', `Bearer ${unsigned}`)
        .expect(401);
      // role / permission hints in headers, query or body are ignored
      await api
        .http()
        .get('/api/v1/admin/workers?permissions=worker.view&role=SUPER_ADMIN')
        .set('Authorization', bearer(reviewer))
        .set('X-Roles', 'SUPER_ADMIN')
        .set('X-Permissions', 'worker.view')
        .expect(403);
    });
  });

  describe('token and session lifecycle', () => {
    it('rejects missing, malformed and garbage tokens with 401', async () => {
      await api.http().get('/api/v1/users/me').expect(401);
      for (const value of ['Bearer', 'Bearer not-a-jwt', 'Basic abc', 'Bearer a.b.c', 'Bearer ']) {
        await api.http().get('/api/v1/users/me').set('Authorization', value).expect(401);
      }
      expect((await refresh('not-a-real-refresh-token')).status).toBe(401);
    });

    it('logout revokes the session: access token and refresh token both stop working', async () => {
      const session = await loginAdmin(api, AdminRoleCode.VERIFICATION_EXECUTIVE);
      await api
        .http()
        .post('/api/v1/auth/logout')
        .set('Authorization', bearer(session))
        .expect(204);
      await me(session).expect(401);
      expect((await refresh(session.refreshToken)).status).toBe(401);
    });

    it('a revoked or expired session is rejected (access and refresh)', async () => {
      const revoked = await loginAdmin(api, AdminRoleCode.VERIFICATION_EXECUTIVE);
      await api.prisma.session.update({
        where: { id: revoked.sessionId },
        data: { revokedAt: new Date() },
      });
      await me(revoked).expect(401);
      expect((await refresh(revoked.refreshToken)).status).toBe(401);

      const expired = await loginAdmin(api, AdminRoleCode.VERIFICATION_EXECUTIVE);
      await api.prisma.session.update({
        where: { id: expired.sessionId },
        data: { expiresAt: new Date(Date.now() - 1000) },
      });
      await me(expired).expect(401);
      expect((await refresh(expired.refreshToken)).status).toBe(401);
    });

    it('two parallel refreshes with one token: exactly one wins, the replay revokes the session (documented, deterministic)', async () => {
      const session = await loginAdmin(api, AdminRoleCode.VERIFICATION_EXECUTIVE);
      const results = await Promise.all([
        refresh(session.refreshToken),
        refresh(session.refreshToken),
      ]);
      const statuses = results.map((r) => r.status).sort();
      expect(statuses).toEqual([200, 401]);
      const winner = results.find((r) => r.status === 200)!;
      // the loser's replay detection revoked the session: even the winner's new pair is dead
      // (a client must therefore serialize its session restoration to one refresh call)
      await me({ accessToken: winner.body.accessToken }).expect(401);
      expect((await refresh(winner.body.refreshToken)).status).toBe(401);
    });
  });

  describe('permission matrix for the four administrative roles', () => {
    it('Super Admin holds the whole catalog; the other three hold exactly their D-71 sets', async () => {
      const superAdmin = await loginAdmin(api);
      const body = (await me(superAdmin)).body;
      expect(sorted(body.permissions)).toEqual(sorted(PERMISSION_CATALOG.map((p) => p.code)));

      for (const code of OTHER_ROLES) {
        const admin = await loginAdmin(api, code);
        const res = await me(admin);
        expect(res.body.roles).toEqual([code]);
        expect(sorted(res.body.permissions)).toEqual(sorted([...DEFAULT_ROLE_PERMISSIONS[code]]));
      }
    });

    it('only the Super Admin can open role, audit and admin-account endpoints', async () => {
      for (const code of OTHER_ROLES) {
        const admin = await loginAdmin(api, code);
        await get(admin, '/api/v1/admin/roles').expect(403);
        await get(admin, '/api/v1/admin/audit-logs').expect(403);
      }
    });

    it('Support Executive can read workers but not verify; Operations Admin cannot decide KYC', async () => {
      const support = await loginAdmin(api, AdminRoleCode.SUPPORT_EXECUTIVE);
      await get(support, '/api/v1/admin/workers').expect(200);
      await get(support, '/api/v1/admin/verification/queue').expect(403);
      const ops = await loginAdmin(api, AdminRoleCode.OPERATIONS_ADMIN);
      await get(ops, '/api/v1/admin/workers').expect(200);
      await get(ops, '/api/v1/admin/verification/queue').expect(403);
      const verifier = await loginAdmin(api, AdminRoleCode.VERIFICATION_EXECUTIVE);
      await get(verifier, '/api/v1/admin/workers').expect(200);
      await get(verifier, '/api/v1/admin/verification/queue').expect(200);
      await get(verifier, '/api/v1/admin/payments').expect(403);
    });
  });
});
