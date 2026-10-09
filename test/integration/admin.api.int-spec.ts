import '../support/env-api-integration';
import {
  adminLogin,
  ApiApp,
  createAdmin,
  createApiApp,
  loginAdmin,
  loginAdminWithPermissions,
  loginWithOtp,
} from '../support/api-app';
import { makeBooking } from '../support/bookings';
import { as, createArea, setRequiredChecks } from '../support/workforce';
import { PERMISSION_CATALOG } from '../../src/modules/users/rbac.constants';

const UNKNOWN_ID = '00000000-0000-7000-8000-000000000000';
const ROLES = '/api/v1/admin/roles';
const USERS = '/api/v1/admin/users';

/** Admin operations against the REAL PostgreSQL + Redis (dedicated test database), through the HTTP API. */
describe('Admin API (integration)', () => {
  let api: ApiApp;
  let superAdmin: Awaited<ReturnType<typeof loginAdmin>>;

  const setPermissions = (
    roleCode: string,
    permissionCodes: string[],
    caller: { accessToken: string } = superAdmin,
  ) => as(api, caller).put(`${ROLES}/${roleCode}/permissions`, { permissionCodes });
  const rolePermissions = async (roleCode: string): Promise<string[]> =>
    (await as(api, superAdmin).get(`${ROLES}/${roleCode}`).expect(200)).body
      .permissionCodes as string[];
  const login = async (roleCode: Parameters<typeof createAdmin>[1]) => {
    const created = await createAdmin(api, roleCode);
    const res = await adminLogin(api, created);
    return {
      ...created,
      userId: created.id,
      accessToken: (res.body as { accessToken: string }).accessToken,
    };
  };

  beforeAll(async () => {
    api = await createApiApp();
    superAdmin = await loginAdmin(api);
  });

  afterAll(async () => {
    // leave the shared role mapping as the seed defines it (empty for the three non-Super roles)
    for (const code of ['OPERATIONS_ADMIN', 'VERIFICATION_EXECUTIVE', 'SUPPORT_EXECUTIVE']) {
      await setPermissions(code, []);
    }
    await api.close();
  });

  describe('roles and permissions', () => {
    it('are visible only to a holder of role.manage', async () => {
      const manageUsersOnly = await loginAdminWithPermissions(api, [
        'admin.manage_users',
        'user.view',
      ]);
      for (const caller of [manageUsersOnly, await login('OPERATIONS_ADMIN')]) {
        expect((await as(api, caller).get(ROLES)).status).toBe(403);
        expect((await as(api, caller).get(`${ROLES}/SUPER_ADMIN`)).status).toBe(403);
        expect((await as(api, caller).get('/api/v1/admin/permissions')).status).toBe(403);
        expect((await setPermissions('SUPPORT_EXECUTIVE', ['support.view'], caller)).status).toBe(
          403,
        );
      }
      const customer = await loginWithOtp(api, { appType: 'CUSTOMER' });
      expect((await as(api, customer).get(ROLES)).status).toBe(403);
      expect((await api.http().get(ROLES)).status).toBe(401);
    });

    it('lists the four admin roles and the full catalog, marking what only the Super Admin may hold', async () => {
      const roles = (await as(api, superAdmin).get(ROLES).expect(200)).body as Array<{
        code: string;
        permissionCodes: string[];
        userCount: number;
      }>;
      for (const code of [
        'SUPER_ADMIN',
        'OPERATIONS_ADMIN',
        'VERIFICATION_EXECUTIVE',
        'SUPPORT_EXECUTIVE',
      ]) {
        expect(roles.map((r) => r.code)).toContain(code);
      }
      const superRole = roles.find((r) => r.code === 'SUPER_ADMIN')!;
      expect(superRole.permissionCodes.sort()).toEqual(
        PERMISSION_CATALOG.map((p) => p.code).sort(),
      );
      expect(superRole.userCount).toBeGreaterThanOrEqual(1);
      expect(Object.keys(roles[0]).sort()).toEqual([
        'code',
        'name',
        'permissionCodes',
        'userCount',
      ]);
      const permissions = (await as(api, superAdmin).get('/api/v1/admin/permissions').expect(200))
        .body as Array<{
        code: string;
        superAdminOnly: boolean;
      }>;
      expect(
        permissions
          .filter((p) => p.superAdminOnly)
          .map((p) => p.code)
          .sort(),
      ).toEqual(['admin.manage_users', 'audit.view', 'role.manage']);
      expect((await as(api, superAdmin).get(`${ROLES}/NO_SUCH_ROLE`)).status).toBe(404);
    });

    it('sets a role permission set; the change applies to the very next request and is audited', async () => {
      const supportExec = await login('SUPPORT_EXECUTIVE');
      expect((await as(api, supportExec).get('/api/v1/admin/support/tickets')).status).toBe(403);

      const res = await setPermissions('SUPPORT_EXECUTIVE', ['support.view', 'support.manage']);
      expect(res.status).toBe(200);
      expect(res.body.permissionCodes).toEqual(['support.manage', 'support.view']);
      // same token, no re-login
      expect((await as(api, supportExec).get('/api/v1/admin/support/tickets')).status).toBe(200);

      expect((await setPermissions('SUPPORT_EXECUTIVE', ['support.view'])).status).toBe(200);
      expect(await rolePermissions('SUPPORT_EXECUTIVE')).toEqual(['support.view']);
      expect(
        (
          await as(api, supportExec).post(`/api/v1/admin/support/tickets/${UNKNOWN_ID}/close`, {
            resolution: 'x',
          })
        ).status,
      ).toBe(403);

      const role = await api.prisma.role.findUniqueOrThrow({
        where: { code: 'SUPPORT_EXECUTIVE' },
      });
      const audit = await api.prisma.auditLog.findMany({
        where: { action: 'role.permissions_set', entityId: role.id, actorId: superAdmin.userId },
        orderBy: { createdAt: 'desc' },
        take: 2,
      });
      expect(audit[0].metadata).toMatchObject({
        roleCode: 'SUPPORT_EXECUTIVE',
        added: [],
        removed: ['support.manage'],
      });
      expect(audit[1].metadata).toMatchObject({ added: ['support.manage', 'support.view'] });
    });

    it('changes nothing and writes no audit record when the same set is sent again', async () => {
      await setPermissions('OPERATIONS_ADMIN', ['booking.view']).then((r) =>
        expect(r.status).toBe(200),
      );
      const role = await api.prisma.role.findUniqueOrThrow({ where: { code: 'OPERATIONS_ADMIN' } });
      const before = await api.prisma.auditLog.count({
        where: { action: 'role.permissions_set', entityId: role.id },
      });
      expect((await setPermissions('OPERATIONS_ADMIN', ['booking.view'])).status).toBe(200);
      expect(
        await api.prisma.auditLog.count({
          where: { action: 'role.permissions_set', entityId: role.id },
        }),
      ).toBe(before);
    });

    it('refuses privilege escalation: the Super Admin role is immutable and administration permissions stay with it', async () => {
      const locked = await setPermissions('SUPER_ADMIN', ['booking.view']);
      expect(locked.status).toBe(409);
      expect(locked.body.code).toBe('ROLE_IMMUTABLE');
      expect(await rolePermissions('SUPER_ADMIN')).toHaveLength(PERMISSION_CATALOG.length);

      for (const restricted of ['role.manage', 'audit.view', 'admin.manage_users']) {
        const res = await setPermissions('OPERATIONS_ADMIN', ['booking.view', restricted]);
        expect(res.status).toBe(422);
        expect(res.body.code).toBe('PERMISSION_RESTRICTED');
      }
      expect(await rolePermissions('OPERATIONS_ADMIN')).toEqual(['booking.view']);
    });

    it('validates the request', async () => {
      const unknown = await setPermissions('OPERATIONS_ADMIN', ['booking.view', 'nothing.here']);
      expect(unknown.status).toBe(422);
      expect(unknown.body.code).toBe('PERMISSION_UNKNOWN');
      expect((await setPermissions('NO_SUCH_ROLE', ['booking.view'])).status).toBe(404);
      expect(
        (await as(api, superAdmin).put(`${ROLES}/OPERATIONS_ADMIN/permissions`, {})).status,
      ).toBe(400);
      expect(
        (
          await as(api, superAdmin).put(`${ROLES}/OPERATIONS_ADMIN/permissions`, {
            permissionCodes: 'booking.view',
          })
        ).status,
      ).toBe(400);
      expect(
        (await setPermissions('OPERATIONS_ADMIN', ['booking.view', 'booking.view'])).status,
      ).toBe(400);
      expect((await setPermissions('OPERATIONS_ADMIN', ['Bad Code!'])).status).toBe(400);
      expect(await rolePermissions('OPERATIONS_ADMIN')).toEqual(['booking.view']);
    });

    it('can clear a role completely', async () => {
      expect((await setPermissions('VERIFICATION_EXECUTIVE', ['verification.review'])).status).toBe(
        200,
      );
      const cleared = await setPermissions('VERIFICATION_EXECUTIVE', []);
      expect(cleared.status).toBe(200);
      expect(cleared.body.permissionCodes).toEqual([]);
    });

    it('serialises concurrent edits of one role: the end state is exactly one of the requests', async () => {
      const sets = [
        ['booking.view'],
        ['payment.view'],
        ['worker.view'],
        ['rating.view'],
        ['report.view'],
      ];
      const results = await Promise.all(sets.map((s) => setPermissions('OPERATIONS_ADMIN', s)));
      expect(results.every((r) => r.status === 200)).toBe(true);
      const final = await rolePermissions('OPERATIONS_ADMIN');
      expect(sets.map((s) => s.join())).toContain(final.join());
    });
  });

  describe('admin accounts', () => {
    it('lists accounts with filters, pagination, masked mobile and roles', async () => {
      const viewer = await loginAdminWithPermissions(api, ['user.view']);
      const customer = await loginWithOtp(api, { appType: 'CUSTOMER' });
      const admins = await as(api, viewer).get(`${USERS}?type=ADMIN&limit=5&page=1`).expect(200);
      expect(admins.body.data.length).toBeGreaterThan(0);
      expect(
        admins.body.data.every(
          (u: { type: string; roles: string[] }) => u.type === 'ADMIN' && Array.isArray(u.roles),
        ),
      ).toBe(true);
      expect(admins.body.meta).toMatchObject({ page: 1, limit: 5 });
      const customers = await as(api, viewer)
        .get(`${USERS}?type=CUSTOMER&status=ACTIVE&limit=100`)
        .expect(200);
      const mine = customers.body.data.find((u: { id: string }) => u.id === customer.userId);
      expect(mine.mobile).toMatch(/\*/);
      expect(JSON.stringify(customers.body)).not.toMatch(/passwordHash|password_hash|refresh/i);
      expect((await as(api, viewer).get(`${USERS}?type=ROBOT`)).status).toBe(400);
      expect((await as(api, viewer).get(`${USERS}?limit=1000`)).status).toBe(400);
      const nobody = await loginAdminWithPermissions(api, ['booking.view']);
      expect((await as(api, nobody).get(USERS)).status).toBe(403);
      expect((await as(api, customer).get(USERS)).status).toBe(403);
    });

    it('lets only a Super Admin create a Super Admin', async () => {
      const delegate = await loginAdminWithPermissions(api, ['admin.manage_users']);
      const body = (roleCode: string) => ({
        email: `new.${Date.now()}.${Math.random().toString(36).slice(2)}@example.test`,
        password: 'a-long-enough-password-1!',
        roleCode,
      });
      const denied = await as(api, delegate).post(USERS, body('SUPER_ADMIN'));
      expect(denied.status).toBe(403);
      expect((await as(api, delegate).post(USERS, body('SUPPORT_EXECUTIVE'))).status).toBe(201);
      expect((await as(api, superAdmin).post(USERS, body('SUPER_ADMIN'))).status).toBe(201);
    });

    it('changes an admin role, audited, and takes effect immediately', async () => {
      const target = await login('SUPPORT_EXECUTIVE');
      await setPermissions('OPERATIONS_ADMIN', ['report.view']);
      expect((await as(api, target).get('/api/v1/admin/reports')).status).toBe(403);
      const res = await as(api, superAdmin).put(`${USERS}/${target.userId}/role`, {
        roleCode: 'OPERATIONS_ADMIN',
        reason: 'Moved to operations',
      });
      expect(res.status).toBe(200);
      expect(res.body.roles).toEqual(['OPERATIONS_ADMIN']);
      expect((await as(api, target).get('/api/v1/admin/reports')).status).toBe(200);
      expect(await api.prisma.userRole.count({ where: { userId: target.userId } })).toBe(1);
      const audit = await api.prisma.auditLog.findFirstOrThrow({
        where: { action: 'admin.role_change', entityId: target.userId },
      });
      expect(audit).toMatchObject({ actorId: superAdmin.userId });
      expect(audit.metadata).toMatchObject({
        from: ['SUPPORT_EXECUTIVE'],
        to: ['OPERATIONS_ADMIN'],
        reason: 'Moved to operations',
      });
      // repeating is a no-op without a second audit record
      await as(api, superAdmin)
        .put(`${USERS}/${target.userId}/role`, { roleCode: 'OPERATIONS_ADMIN' })
        .expect(200);
      expect(
        await api.prisma.auditLog.count({
          where: { action: 'admin.role_change', entityId: target.userId },
        }),
      ).toBe(1);
    });

    it('refuses the wrong caller, own role, non-admin targets and unknown targets or roles', async () => {
      const target = await login('SUPPORT_EXECUTIVE');
      const delegate = await loginAdminWithPermissions(api, ['admin.manage_users']);
      const customer = await loginWithOtp(api, { appType: 'CUSTOMER' });
      const put = (id: string, body: object, caller = superAdmin) =>
        as(api, caller).put(`${USERS}/${id}/role`, body);

      expect(
        (
          await put(
            target.userId,
            { roleCode: 'OPERATIONS_ADMIN' },
            await loginAdminWithPermissions(api, ['user.view']),
          )
        ).status,
      ).toBe(403);
      expect(
        (await put(target.userId, { roleCode: 'OPERATIONS_ADMIN' }, customer as never)).status,
      ).toBe(403);
      expect(
        (
          await api
            .http()
            .put(`${USERS}/${target.userId}/role`)
            .send({ roleCode: 'OPERATIONS_ADMIN' })
        ).status,
      ).toBe(401);

      const self = await put(superAdmin.userId, { roleCode: 'OPERATIONS_ADMIN' });
      expect(self.status).toBe(409);
      expect(self.body.code).toBe('CANNOT_CHANGE_OWN_ROLE');

      // a delegate may reassign ordinary roles but can neither grant nor take away Super Admin
      expect((await put(target.userId, { roleCode: 'SUPER_ADMIN' }, delegate)).status).toBe(403);
      const otherSuper = await login('SUPER_ADMIN');
      expect(
        (await put(otherSuper.userId, { roleCode: 'SUPPORT_EXECUTIVE' }, delegate)).status,
      ).toBe(403);
      expect(
        (await put(otherSuper.userId, { roleCode: 'SUPPORT_EXECUTIVE' }, superAdmin)).status,
      ).toBe(200);
      expect((await put(target.userId, { roleCode: 'OPERATIONS_ADMIN' }, delegate)).status).toBe(
        200,
      );

      const wrongType = await put(customer.userId, { roleCode: 'OPERATIONS_ADMIN' });
      expect(wrongType.status).toBe(422);
      expect(wrongType.body.code).toBe('NOT_AN_ADMIN');
      expect((await put(UNKNOWN_ID, { roleCode: 'OPERATIONS_ADMIN' })).status).toBe(404);
      expect((await put(target.userId, { roleCode: 'ROOT' })).status).toBe(400);
      expect((await put(target.userId, {})).status).toBe(400);
      expect((await put('not-a-uuid', { roleCode: 'OPERATIONS_ADMIN' })).status).toBe(400);
    });

    it('never leaves the system without an active Super Admin, even when two Super Admins demote each other at once', async () => {
      const others = await api.prisma.user.findMany({
        where: {
          type: 'ADMIN',
          status: 'ACTIVE',
          roles: { some: { role: { code: 'SUPER_ADMIN' } } },
        },
        select: { id: true },
      });
      const a = await login('SUPER_ADMIN');
      const b = await login('SUPER_ADMIN');
      const keep = others.map((o) => o.id).filter((id) => id !== a.userId && id !== b.userId);
      // isolate the pair: park every other Super Admin for the duration of this test
      await api.prisma.user.updateMany({
        where: { id: { in: keep } },
        data: { status: 'SUSPENDED' },
      });
      try {
        const [one, two] = await Promise.all([
          as(api, a).put(`${USERS}/${b.userId}/role`, { roleCode: 'SUPPORT_EXECUTIVE' }),
          as(api, b).put(`${USERS}/${a.userId}/role`, { roleCode: 'SUPPORT_EXECUTIVE' }),
        ]);
        expect([one.status, two.status].sort()).toEqual([200, 403]);
        const remaining = await api.prisma.userRole.count({
          where: { role: { code: 'SUPER_ADMIN' }, userId: { in: [a.userId, b.userId] } },
        });
        expect(remaining).toBe(1);
      } finally {
        await api.prisma.user.updateMany({
          where: { id: { in: keep } },
          data: { status: 'ACTIVE' },
        });
      }
    });
  });

  describe('dashboard', () => {
    it('shows every section to a Super Admin, matching the database', async () => {
      const res = await as(api, superAdmin).get('/api/v1/admin/dashboard').expect(200);
      expect(Object.keys(res.body.sections as object).sort()).toEqual([
        'bookings',
        'collections',
        'complaints',
        'pendingKyc',
        'replacements',
        'workers',
      ]);
      const total = res.body.sections.bookings.byStatus.reduce(
        (s: number, r: { count: number }) => s + r.count,
        0,
      );
      expect(total).toBe(await api.prisma.booking.count());
      expect(res.body.sections.workers.registered).toBe(await api.prisma.workerProfile.count());
      expect(res.body.sections.complaints.unassigned).toBe(
        await api.prisma.supportTicket.count({
          where: { status: { not: 'CLOSED' }, assignedToUserId: null },
        }),
      );
      expect(res.body.sections.pendingKyc.submitted).toBe(
        await api.prisma.workerVerificationCheck.count({ where: { status: 'SUBMITTED' } }),
      );
    });

    it('shows each role only the slice its permissions already allow', async () => {
      const kyc = await loginAdminWithPermissions(api, ['verification.review']);
      expect(
        Object.keys(
          (await as(api, kyc).get('/api/v1/admin/dashboard').expect(200)).body.sections as object,
        ),
      ).toEqual(['pendingKyc']);
      const support = await loginAdminWithPermissions(api, ['support.view', 'replacement.view']);
      expect(
        Object.keys(
          (await as(api, support).get('/api/v1/admin/dashboard').expect(200)).body
            .sections as object,
        ).sort(),
      ).toEqual(['complaints', 'replacements']);
      const nothing = await loginAdminWithPermissions(api, []);
      expect(
        (await as(api, nothing).get('/api/v1/admin/dashboard').expect(200)).body.sections,
      ).toEqual({});
      const customer = await loginWithOtp(api, { appType: 'CUSTOMER' });
      expect((await as(api, customer).get('/api/v1/admin/dashboard')).status).toBe(403);
      expect((await api.http().get('/api/v1/admin/dashboard')).status).toBe(401);
    });

    it('counts collections in the smallest currency unit', async () => {
      const finance = await loginAdminWithPermissions(api, ['payment.view']);
      const res = await as(api, finance).get('/api/v1/admin/dashboard').expect(200);
      for (const row of res.body.sections.collections as Array<{
        todayMinor: number;
        monthToDateMinor: number;
      }>) {
        expect(Number.isInteger(row.todayMinor)).toBe(true);
        expect(row.monthToDateMinor).toBeGreaterThanOrEqual(row.todayMinor);
      }
    });
  });

  describe('audit log viewer', () => {
    it('finds entries by action, entity, actor, request and day; newest first', async () => {
      const customer = await loginWithOtp(api, { appType: 'CUSTOMER' });
      const changed = await as(api, superAdmin)
        .patch(`${USERS}/${customer.userId}/status`, { status: 'SUSPENDED', reason: 'audit probe' })
        .expect(200);
      const requestId = changed.headers['x-request-id'];
      expect(requestId).toBeTruthy();

      const byRequest = await as(api, superAdmin)
        .get(`/api/v1/admin/audit-logs?requestId=${requestId}`)
        .expect(200);
      expect(byRequest.body.data).toHaveLength(1);
      expect(byRequest.body.data[0]).toMatchObject({
        action: 'user.status_change',
        entityType: 'user',
        entityId: customer.userId,
        actorId: superAdmin.userId,
        requestId,
      });
      expect(byRequest.body.data[0].metadata).toMatchObject({
        from: 'ACTIVE',
        to: 'SUSPENDED',
        reason: 'audit probe',
      });

      const q = (s: string) => as(api, superAdmin).get(`/api/v1/admin/audit-logs?${s}`);
      expect(
        (await q(`entityType=user&entityId=${customer.userId}&action=user.status_change`)).body.meta
          .total,
      ).toBe(1);
      expect(
        (await q(`actorId=${superAdmin.userId}&actionPrefix=user.`)).body.data.length,
      ).toBeGreaterThan(0);
      const day = new Date().toISOString().slice(0, 10);
      const dated = await q(`from=${day}&to=${day}&limit=100`);
      expect(dated.status).toBe(200);
      const times = dated.body.data.map((r: { createdAt: string }) => Date.parse(r.createdAt));
      expect([...times].sort((x, y) => y - x)).toEqual(times);
      expect((await q('from=2020-01-01&to=2020-01-02')).body.meta.total).toBe(0);
    });

    it('validates input and caps the page size', async () => {
      const q = (s: string) => as(api, superAdmin).get(`/api/v1/admin/audit-logs?${s}`);
      expect((await q('from=2026-13-40')).status).toBe(400);
      expect((await q('from=2026-10-05&to=2026-10-01')).status).toBe(400);
      expect((await q('limit=101')).status).toBe(400);
      expect((await q('actorId=nope')).status).toBe(400);
      expect((await q('actionPrefix=DROP%20TABLE')).status).toBe(400);
    });

    it('is closed to everyone without audit.view and has no way to write', async () => {
      const ops = await loginAdminWithPermissions(api, ['report.view', 'user.view']);
      const customer = await loginWithOtp(api, { appType: 'CUSTOMER' });
      for (const caller of [ops, customer]) {
        expect((await as(api, caller).get('/api/v1/admin/audit-logs')).status).toBe(403);
      }
      expect((await api.http().get('/api/v1/admin/audit-logs')).status).toBe(401);
      for (const method of ['post', 'put', 'patch', 'delete'] as const) {
        const res = await api
          .http()
          [method]('/api/v1/admin/audit-logs')
          .set('Authorization', `Bearer ${superAdmin.accessToken}`)
          .send({});
        expect(res.status).toBe(404);
      }
      await expect(
        api.prisma.auditLog.deleteMany({ where: { actorId: superAdmin.userId } }),
      ).rejects.toThrow();
    });

    it('redacts secret-looking metadata on the way out, even from rows written earlier', async () => {
      const row = await api.prisma.auditLog.create({
        data: {
          action: 'probe.legacy_row',
          entityType: 'probe',
          actorId: superAdmin.userId,
          metadata: {
            note: 'ok',
            mobile: '+919876543210',
            nested: { cardNumber: '4111', token: 'abc', jwt: 'x' },
            pasted: 'Bearer abcdefghijklmnop',
          },
        },
      });
      const res = await as(api, superAdmin)
        .get(`/api/v1/admin/audit-logs?action=probe.legacy_row`)
        .expect(200);
      const seen = JSON.stringify(res.body.data.find((r: { id: string }) => r.id === row.id));
      expect(seen).toContain('"note":"ok"');
      for (const leaked of ['+919876543210', '4111', 'abcdefghijklmnop']) {
        expect(seen).not.toContain(leaked);
      }
    });
  });

  describe('existing admin endpoints stay compatible', () => {
    it('still serves the module endpoints with their original permissions', async () => {
      const area = await createArea(api, superAdmin);
      await setRequiredChecks(api, superAdmin, ['IDENTITY']);
      const customer = await loginWithOtp(api, { appType: 'CUSTOMER' });
      const b = await makeBooking(api, superAdmin, customer, area.id, 'MATCHED');
      await setRequiredChecks(api, superAdmin, []);
      for (const path of [
        `/api/v1/admin/bookings/${b.id}`,
        '/api/v1/admin/bookings',
        '/api/v1/admin/payments',
        '/api/v1/admin/customers',
        '/api/v1/admin/replacement-requests',
        '/api/v1/admin/attendance/bookings/' + b.id,
        `/api/v1/admin/users/${customer.userId}`,
      ]) {
        const res = await as(api, superAdmin).get(path);
        expect([path, res.status]).toEqual([path, 200]);
      }
    });
  });
});
