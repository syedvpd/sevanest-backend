import '../support/env-api-integration';
import {
  CategorySeedService,
  INITIAL_CATEGORIES,
} from '../../src/modules/service-categories/category-seed.service';
import {
  ApiApp,
  bearer,
  createApiApp,
  loginAdmin,
  loginAdminWithPermissions,
  loginWithOtp,
  unique,
} from '../support/api-app';

const UNKNOWN_ID = '00000000-0000-7000-8000-000000000000';

/** Service Categories against the REAL PostgreSQL + Redis (dedicated test database), through the HTTP API. */
describe('Service Categories API (integration)', () => {
  let api: ApiApp;
  let superAdmin: Awaited<ReturnType<typeof loginAdmin>>;

  const as = (caller: { accessToken: string }) => ({
    get: (url: string) => api.http().get(url).set('Authorization', bearer(caller)),
    post: (url: string, body: object = {}) =>
      api.http().post(url).set('Authorization', bearer(caller)).send(body),
    patch: (url: string, body: object = {}) =>
      api.http().patch(url).set('Authorization', bearer(caller)).send(body),
    put: (url: string, body: object = {}) =>
      api.http().put(url).set('Authorization', bearer(caller)).send(body),
  });

  const newCategory = (extra: object = {}) => ({
    code: `CAT_${unique().toUpperCase()}`,
    name: `Category ${unique()}`,
    ...extra,
  });

  async function create(extra: object = {}): Promise<{ id: string; code: string; name: string }> {
    const res = await as(superAdmin).post('/api/v1/admin/service-categories', newCategory(extra));
    expect(res.status).toBe(201);
    return res.body as { id: string; code: string; name: string };
  }

  beforeAll(async () => {
    api = await createApiApp();
    superAdmin = await loginAdmin(api);
  });
  afterAll(async () => {
    await api.close();
  });

  describe('reference data', () => {
    it('holds the categories defined by the project documents, stored in PostgreSQL', async () => {
      const rows = await api.prisma.serviceCategory.findMany({
        where: { code: { in: INITIAL_CATEGORIES.map((c) => c.code) } },
      });
      expect(rows.map((r) => r.name).sort()).toEqual(
        [
          'Babysitter',
          'Cleaning Helper',
          'Cook',
          'Driver',
          'Elderly Care Helper',
          'House Maid',
        ].sort(),
      );
      expect(rows.every((r) => r.isEnabled)).toBe(true);
    });

    it("never overwrites an admin's edits when the seed runs again", async () => {
      const driver = await api.prisma.serviceCategory.findUniqueOrThrow({
        where: { code: 'DRIVER' },
      });
      await as(superAdmin)
        .patch(`/api/v1/admin/service-categories/${driver.id}`, {
          description: 'Edited by an admin',
        })
        .expect(200);
      const created = await api.app.get(CategorySeedService).ensureInitialCategories();
      expect(created).toBe(0);
      const after = await api.prisma.serviceCategory.findUniqueOrThrow({
        where: { code: 'DRIVER' },
      });
      expect(after.description).toBe('Edited by an admin');
      await as(superAdmin).patch(`/api/v1/admin/service-categories/${driver.id}`, {
        description: driver.description,
      });
    });

    it('lets the database refuse duplicates, bad codes and deletion of referenced categories', async () => {
      const code = `DB_${unique().toUpperCase()}`;
      await api.prisma.serviceCategory.create({ data: { code, name: `DB Test ${code}` } });
      await expect(
        api.prisma.serviceCategory.create({ data: { code, name: 'Another name' } }),
      ).rejects.toThrow();
      await expect(
        api.prisma.serviceCategory.create({
          data: { code: `${code}_2`, name: `db test ${code.toLowerCase()}` },
        }),
      ).rejects.toThrow(); // case-insensitive name
      await expect(
        api.prisma.serviceCategory.create({ data: { code: 'lower_case', name: `Bad ${code}` } }),
      ).rejects.toThrow();
      await expect(
        api.prisma.serviceCategory.create({ data: { code: 'X', name: `Short ${code}` } }),
      ).rejects.toThrow();

      const worker = await loginWithOtp(api, { appType: 'WORKER' });
      await as(worker).post('/api/v1/workers/me', { name: 'Ramesh Kumar' }).expect(201);
      const cook = await api.prisma.serviceCategory.findUniqueOrThrow({ where: { code: 'COOK' } });
      await as(worker)
        .put('/api/v1/workers/me/categories', { categoryIds: [cook.id] })
        .expect(200);
      await expect(api.prisma.serviceCategory.delete({ where: { id: cook.id } })).rejects.toThrow(); // referenced
    });
  });

  describe('reading (customers, workers, admins)', () => {
    it('lists enabled categories, paginated and in a stable order, with only public fields', async () => {
      const customer = await loginWithOtp(api, { appType: 'CUSTOMER' });
      const res = await as(customer).get('/api/v1/service-categories?limit=100');
      expect(res.status).toBe(200);
      const names = (res.body.data as Array<{ name: string }>).map((c) => c.name);
      // Stable order: the same request returns the same sequence.
      const again = await as(customer).get('/api/v1/service-categories?limit=100');
      expect((again.body.data as Array<{ id: string }>).map((c) => c.id)).toEqual(
        (res.body.data as Array<{ id: string }>).map((c) => c.id),
      );
      expect(names).toEqual(
        expect.arrayContaining([
          'House Maid',
          'Driver',
          'Cook',
          'Babysitter',
          'Elderly Care Helper',
          'Cleaning Helper',
        ]),
      );
      expect(res.body.meta).toMatchObject({ page: 1, limit: 100 });
      for (const row of res.body.data as Array<Record<string, unknown>>) {
        expect(Object.keys(row).sort()).toEqual(['code', 'description', 'id', 'name']);
      }

      const page = await as(customer).get('/api/v1/service-categories?limit=2&page=2');
      expect(page.body.data).toHaveLength(2);
      expect(page.body.meta.total).toBeGreaterThanOrEqual(6);
      const first = await as(customer).get('/api/v1/service-categories?limit=2&page=1');
      expect(first.body.data.map((c: { id: string }) => c.id)).not.toEqual(
        page.body.data.map((c: { id: string }) => c.id),
      );
    });

    it('is readable by workers and admins too, and requires authentication', async () => {
      const worker = await loginWithOtp(api, { appType: 'WORKER' });
      expect((await as(worker).get('/api/v1/service-categories')).status).toBe(200);
      expect((await as(superAdmin).get('/api/v1/service-categories')).status).toBe(200);
      await api.http().get('/api/v1/service-categories').expect(401);
    });

    it('hides disabled categories from the public list and lookup', async () => {
      const category = await create();
      const customer = await loginWithOtp(api, { appType: 'CUSTOMER' });
      expect((await as(customer).get(`/api/v1/service-categories/${category.id}`)).status).toBe(
        200,
      );
      await as(superAdmin)
        .patch(`/api/v1/admin/service-categories/${category.id}`, { isEnabled: false })
        .expect(200);
      const list = await as(customer).get('/api/v1/service-categories?limit=100');
      expect(list.body.data.map((c: { id: string }) => c.id)).not.toContain(category.id);
      const lookup = await as(customer).get(`/api/v1/service-categories/${category.id}`);
      expect(lookup.status).toBe(404);
      expect(lookup.body.code).toBe('CATEGORY_NOT_FOUND');
    });

    it('answers 404 for unknown ids and 400 for malformed ids or paging', async () => {
      const customer = await loginWithOtp(api, { appType: 'CUSTOMER' });
      expect((await as(customer).get(`/api/v1/service-categories/${UNKNOWN_ID}`)).status).toBe(404);
      expect((await as(customer).get('/api/v1/service-categories/nope')).status).toBe(400);
      expect((await as(customer).get('/api/v1/service-categories?page=0')).status).toBe(400);
      expect((await as(customer).get('/api/v1/service-categories?limit=101')).status).toBe(400);
    });
  });

  describe('administration', () => {
    const base = '/api/v1/admin/service-categories';

    it('creates a category, audited, and shows it to customers', async () => {
      const payload = newCategory({ description: '  A new service  ' });
      const res = await as(superAdmin).post(base, payload);
      expect(res.status).toBe(201);
      expect(res.body).toMatchObject({
        code: payload.code,
        name: payload.name,
        description: 'A new service',
        isEnabled: true,
      });
      const audit = await api.prisma.auditLog.findMany({
        where: { action: 'service_category.create', entityId: res.body.id },
      });
      expect(audit).toHaveLength(1);
      expect(audit[0]).toMatchObject({ actorId: superAdmin.userId, actorRole: 'SUPER_ADMIN' });
      const customer = await loginWithOtp(api, { appType: 'CUSTOMER' });
      expect((await as(customer).get(`/api/v1/service-categories/${res.body.id}`)).status).toBe(
        200,
      );
    });

    it('prevents duplicate codes and names (names ignoring case)', async () => {
      const original = await create();
      const sameCode = await as(superAdmin).post(base, newCategory({ code: original.code }));
      expect(sameCode.status).toBe(409);
      expect(sameCode.body.code).toBe('CATEGORY_DUPLICATE');
      const sameName = await as(superAdmin).post(
        base,
        newCategory({ name: original.name.toUpperCase() }),
      );
      expect(sameName.status).toBe(409);
      expect(sameName.body.code).toBe('CATEGORY_DUPLICATE');
    });

    it('creates exactly one category when the same request is sent in parallel', async () => {
      const payload = newCategory();
      const results = await Promise.all(
        Array.from({ length: 5 }, () => as(superAdmin).post(base, payload)),
      );
      expect(results.filter((r) => r.status === 201)).toHaveLength(1);
      expect(results.filter((r) => r.status === 409)).toHaveLength(4);
      expect(await api.prisma.serviceCategory.count({ where: { code: payload.code } })).toBe(1);
    });

    it.each([
      ['lower-case code', { code: 'house_maid' }],
      ['code with spaces', { code: 'HOUSE MAID' }],
      ['one-letter code', { code: 'X' }],
      ['code starting with a digit', { code: '1ABC' }],
      ['name too short', { name: 'A' }],
      ['name too long', { name: 'N'.repeat(101) }],
      ['description too long', { description: 'D'.repeat(501) }],
      ['missing name', { name: undefined }],
      ['missing code', { code: undefined }],
    ])('rejects %s', async (_n, bad) => {
      const res = await as(superAdmin).post(base, newCategory(bad));
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('VALIDATION_FAILED');
    });

    it('ignores server-controlled fields on create (mass assignment)', async () => {
      const res = await as(superAdmin).post(
        base,
        newCategory({ id: UNKNOWN_ID, isEnabled: false, createdAt: '2000-01-01T00:00:00Z' }),
      );
      expect(res.status).toBe(201);
      expect(res.body.id).not.toBe(UNKNOWN_ID);
      expect(res.body.isEnabled).toBe(true);
      expect(new Date((res.body as { createdAt: string }).createdAt).getFullYear()).toBeGreaterThan(
        2020,
      );
    });

    it('updates name, description and enabled state; the code is immutable; before/after is audited', async () => {
      const category = await create({ description: 'old' });
      const newName = `Renamed ${unique()}`;
      const res = await as(superAdmin).patch(`${base}/${category.id}`, {
        name: newName,
        description: null,
        isEnabled: false,
        code: 'CHANGED_CODE',
      });
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({
        code: category.code,
        name: newName,
        description: null,
        isEnabled: false,
      });
      const audit = await api.prisma.auditLog.findMany({
        where: { action: 'service_category.update', entityId: category.id },
      });
      expect(audit).toHaveLength(1);
      expect(audit[0].metadata).toEqual({
        code: category.code,
        changes: {
          name: { from: category.name, to: newName },
          description: { from: 'old', to: null },
          isEnabled: { from: true, to: false },
        },
      });
      // Re-sending the same values changes nothing and writes no audit record.
      await as(superAdmin).patch(`${base}/${category.id}`, { name: newName }).expect(200);
      expect(
        await api.prisma.auditLog.count({
          where: { action: 'service_category.update', entityId: category.id },
        }),
      ).toBe(1);
    });

    it('rejects renaming onto an existing name, empty updates, unknown ids and bad input', async () => {
      const a = await create();
      const b = await create();
      const clash = await as(superAdmin).patch(`${base}/${b.id}`, { name: a.name.toLowerCase() });
      expect(clash.status).toBe(409);
      expect(clash.body.code).toBe('CATEGORY_DUPLICATE');
      expect((await as(superAdmin).patch(`${base}/${b.id}`, {})).status).toBe(400);
      expect((await as(superAdmin).patch(`${base}/${b.id}`, { code: 'ONLY_CODE' })).status).toBe(
        400,
      );
      expect((await as(superAdmin).patch(`${base}/${b.id}`, { name: 'X' })).status).toBe(400);
      expect((await as(superAdmin).patch(`${base}/${b.id}`, { isEnabled: 'no' })).status).toBe(400);
      expect(
        (await as(superAdmin).patch(`${base}/${UNKNOWN_ID}`, { name: 'Valid Name' })).status,
      ).toBe(404);
      expect((await as(superAdmin).patch(`${base}/nope`, { name: 'Valid Name' })).status).toBe(400);
    });

    it('serialises parallel edits of one category (the result is exactly one of the submitted values)', async () => {
      const category = await create();
      const names = Array.from({ length: 5 }, (_v, i) => `Parallel ${unique()} ${i}`);
      const results = await Promise.all(
        names.map((name) => as(superAdmin).patch(`${base}/${category.id}`, { name })),
      );
      expect(results.every((r) => r.status === 200)).toBe(true);
      const final = (
        await api.prisma.serviceCategory.findUniqueOrThrow({ where: { id: category.id } })
      ).name;
      expect(names).toContain(final);
      const audit = await api.prisma.auditLog.count({
        where: { action: 'service_category.update', entityId: category.id },
      });
      expect(audit).toBe(5); // each change is recorded once, none lost
    });

    it('lists everything for admins with filters and pagination, and reads one including disabled', async () => {
      const disabled = await create();
      await as(superAdmin).patch(`${base}/${disabled.id}`, { isEnabled: false }).expect(200);
      const all = await as(superAdmin).get(`${base}?limit=100`);
      expect(all.body.data.map((c: { id: string }) => c.id)).toContain(disabled.id);
      const onlyDisabled = await as(superAdmin).get(`${base}?isEnabled=false&limit=100`);
      expect(onlyDisabled.body.data.every((c: { isEnabled: boolean }) => !c.isEnabled)).toBe(true);
      expect(onlyDisabled.body.data.map((c: { id: string }) => c.id)).toContain(disabled.id);
      const onlyEnabled = await as(superAdmin).get(`${base}?isEnabled=true&limit=100`);
      expect(onlyEnabled.body.data.map((c: { id: string }) => c.id)).not.toContain(disabled.id);
      expect((await as(superAdmin).get(`${base}?isEnabled=maybe`)).status).toBe(400);
      const one = await as(superAdmin).get(`${base}/${disabled.id}`);
      expect(one.body).toMatchObject({ id: disabled.id, isEnabled: false });
      expect((await as(superAdmin).get(`${base}/${UNKNOWN_ID}`)).status).toBe(404);
    });
  });

  describe('authorization', () => {
    const base = '/api/v1/admin/service-categories';

    it('refuses every modification (and the admin list) to workers, customers and admins without category.manage', async () => {
      const category = await create();
      const worker = await loginWithOtp(api, { appType: 'WORKER' });
      const customer = await loginWithOtp(api, { appType: 'CUSTOMER' });
      const wrongPermission = await loginAdminWithPermissions(api, [
        'customer.manage',
        'worker.manage',
        'area.manage',
      ]);
      for (const caller of [worker, customer, wrongPermission]) {
        for (const res of [
          await as(caller).get(base),
          await as(caller).get(`${base}/${category.id}`),
          await as(caller).post(base, newCategory()),
          await as(caller).patch(`${base}/${category.id}`, { name: `Hijacked ${unique()}` }),
        ]) {
          expect(res.status).toBe(403);
          expect(res.body.code).toBe('FORBIDDEN');
        }
      }
      await api.http().post(base).send(newCategory()).expect(401);
      await api.http().patch(`${base}/${category.id}`).send({ name: 'Anonymous edit' }).expect(401);
      expect(
        (await api.prisma.serviceCategory.findUniqueOrThrow({ where: { id: category.id } })).name,
      ).toBe(category.name);
    });

    it('lets an admin holding category.manage (and nothing else) administer categories', async () => {
      const manager = await loginAdminWithPermissions(api, ['category.manage']);
      const res = await as(manager).post(base, newCategory());
      expect(res.status).toBe(201);
      expect((await as(manager).patch(`${base}/${res.body.id}`, { isEnabled: false })).status).toBe(
        200,
      );
      expect((await as(manager).get(base)).status).toBe(200);
      const audit = await api.prisma.auditLog.findFirst({
        where: { action: 'service_category.create', entityId: res.body.id },
      });
      expect(audit?.actorId).toBe(manager.userId);
    });

    it('applies a suspension or role removal on the very next request', async () => {
      const manager = await loginAdminWithPermissions(api, ['category.manage']);
      expect((await as(manager).get(base)).status).toBe(200);
      await api.prisma.userRole.deleteMany({ where: { userId: manager.userId } });
      expect((await as(manager).get(base)).status).toBe(403);
    });
  });
});
