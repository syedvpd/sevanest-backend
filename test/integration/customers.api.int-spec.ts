import '../support/env-api-integration';
import {
  ApiApp,
  bearer,
  createApiApp,
  loginAdmin,
  loginAdminWithPermissions,
  loginWithOtp,
  randomMobile,
  unique,
} from '../support/api-app';

const UNKNOWN_ID = '00000000-0000-7000-8000-000000000000';

interface Customer {
  accessToken: string;
  refreshToken: string;
  userId: string;
  mobile: string;
  customerId: string;
}

const address = (extra: object = {}) => ({
  line: '12-3-45, Lotus Apartments',
  area: 'Madhapur',
  city: 'Hyderabad',
  pincode: '500081',
  ...extra,
});

/** Customers module against the REAL PostgreSQL + Redis (dedicated test database), through the HTTP API. */
describe('Customers API (integration)', () => {
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
    delete: (url: string) => api.http().delete(url).set('Authorization', bearer(caller)),
  });

  async function newCustomer(withProfile = true): Promise<Customer> {
    const session = await loginWithOtp(api);
    let customerId = '';
    if (withProfile) {
      const res = await as(session).post('/api/v1/customers/me', {
        name: 'Asha Rao',
        email: `asha.${unique()}@example.test`,
        preferredLanguage: 'en',
      });
      expect(res.status).toBe(201);
      customerId = (res.body as { id: string }).id;
    }
    return { ...session, mobile: session.mobile!, customerId };
  }

  async function addAddress(customer: Customer, extra: object = {}): Promise<string> {
    const res = await as(customer).post('/api/v1/customers/me/addresses', address(extra));
    expect(res.status).toBe(201);
    return (res.body as { id: string }).id;
  }

  async function defaultCount(customerId: string): Promise<number> {
    return api.prisma.customerAddress.count({
      where: { customerId, isDefault: true },
    });
  }

  beforeAll(async () => {
    api = await createApiApp();
    superAdmin = await loginAdmin(api);
  });
  afterAll(async () => {
    await api.close();
  });

  describe('profile', () => {
    it('answers 404 until the profile exists', async () => {
      const customer = await newCustomer(false);
      const res = await as(customer).get('/api/v1/customers/me');
      expect(res.status).toBe(404);
      expect(res.body.code).toBe('CUSTOMER_PROFILE_NOT_FOUND');
    });

    it('creates the profile: PENDING, mobile from the verified identity, audited without personal data', async () => {
      const customer = await newCustomer(false);
      const email = `Asha.Rao.${unique()}@Example.TEST `;
      const res = await as(customer).post('/api/v1/customers/me', {
        name: '  Asha Rao  ',
        email,
        preferredLanguage: 'en',
      });
      expect(res.status).toBe(201);
      expect(res.body).toMatchObject({
        name: 'Asha Rao',
        email: email.trim().toLowerCase(),
        preferredLanguage: 'en',
        mobile: customer.mobile,
        verificationStatus: 'PENDING',
      });
      expect(Object.keys(res.body as object).sort()).toEqual([
        'createdAt',
        'email',
        'id',
        'mobile',
        'name',
        'preferredLanguage',
        'updatedAt',
        'verificationStatus',
      ]);

      const audit = await api.prisma.auditLog.findMany({
        where: { action: 'customer.profile_create', actorId: customer.userId },
      });
      expect(audit).toHaveLength(1);
      expect(JSON.stringify(audit[0])).not.toMatch(/Asha|example\.test/i);

      const read = await as(customer).get('/api/v1/customers/me');
      expect(read.body).toMatchObject({ id: res.body.id, mobile: customer.mobile });
    });

    it('accepts international names and common name punctuation', async () => {
      for (const name of ["Ramón O'Brien-Smith Jr.", 'आशा राव', 'José Núñez']) {
        const customer = await newCustomer(false);
        const res = await as(customer).post('/api/v1/customers/me', {
          name,
          email: `n.${unique()}@example.test`,
          preferredLanguage: 'en',
        });
        expect(res.status).toBe(201);
      }
    });

    it.each([
      ['empty name', { name: '' }],
      ['digits in name', { name: 'Asha123' }],
      ['symbols in name', { name: '<script>' }],
      ['name too long', { name: 'A'.repeat(201) }],
      ['bad email', { email: 'not-an-email' }],
      ['missing email', { email: undefined }],
      ['bad language format', { preferredLanguage: 'English!' }],
      ['missing language', { preferredLanguage: undefined }],
    ])('rejects %s with field-level VALIDATION_FAILED and saves nothing', async (_n, bad) => {
      const customer = await newCustomer(false);
      const res = await as(customer).post('/api/v1/customers/me', {
        name: 'Asha Rao',
        email: `v.${unique()}@example.test`,
        preferredLanguage: 'en',
        ...bad,
      });
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('VALIDATION_FAILED');
      expect(res.body.details.length).toBeGreaterThan(0);
      expect(await api.prisma.customerProfile.count({ where: { userId: customer.userId } })).toBe(
        0,
      );
    });

    it('rejects a second profile (409) and creates exactly one under parallel requests', async () => {
      const customer = await newCustomer(false);
      const body = {
        name: 'Asha Rao',
        email: `p.${unique()}@example.test`,
        preferredLanguage: 'en',
      };
      const results = await Promise.all(
        Array.from({ length: 5 }, () => as(customer).post('/api/v1/customers/me', body)),
      );
      expect(results.filter((r) => r.status === 201)).toHaveLength(1);
      const conflicts = results.filter((r) => r.status === 409);
      expect(conflicts).toHaveLength(4);
      expect(conflicts.every((r) => r.body.code === 'CUSTOMER_PROFILE_EXISTS')).toBe(true);
      expect(await api.prisma.customerProfile.count({ where: { userId: customer.userId } })).toBe(
        1,
      );
      expect(
        await api.prisma.auditLog.count({
          where: { action: 'customer.profile_create', actorId: customer.userId },
        }),
      ).toBe(1);
    });

    it('ignores server-controlled fields on create and update (mass assignment)', async () => {
      const victim = await newCustomer();
      const attacker = await newCustomer(false);
      const created = await as(attacker).post('/api/v1/customers/me', {
        name: 'Asha Rao',
        email: `m.${unique()}@example.test`,
        preferredLanguage: 'en',
        id: UNKNOWN_ID,
        userId: victim.userId,
        mobile: victim.mobile,
        verificationStatus: 'VERIFIED',
        createdAt: '2000-01-01T00:00:00Z',
      });
      expect(created.status).toBe(201);
      const row = await api.prisma.customerProfile.findUniqueOrThrow({
        where: { userId: attacker.userId },
      });
      expect(row.id).not.toBe(UNKNOWN_ID);
      expect(row.userId).toBe(attacker.userId);
      expect(row.verificationStatus).toBe('PENDING');
      expect(created.body.mobile).toBe(attacker.mobile);

      const patched = await as(attacker).patch('/api/v1/customers/me', {
        name: 'Changed Name',
        verificationStatus: 'VERIFIED',
        mobile: '+919999999999',
        userId: victim.userId,
      });
      expect(patched.status).toBe(200);
      const after = await api.prisma.customerProfile.findUniqueOrThrow({ where: { id: row.id } });
      expect(after).toMatchObject({
        name: 'Changed Name',
        verificationStatus: 'PENDING',
        userId: attacker.userId,
      });
      expect(
        (await api.prisma.user.findUniqueOrThrow({ where: { id: attacker.userId } })).mobile,
      ).toBe(attacker.mobile);
      // The victim is untouched.
      expect((await as(victim).get('/api/v1/customers/me')).body.name).toBe('Asha Rao');
    });

    it('updates profile fields, audits field names only, and rejects empty updates', async () => {
      const customer = await newCustomer();
      const res = await as(customer).patch('/api/v1/customers/me', {
        email: `New.${unique()}@Example.test`,
        preferredLanguage: 'hi',
      });
      expect(res.status).toBe(200);
      expect(res.body.email).toBe(res.body.email.toLowerCase());
      expect(res.body.preferredLanguage).toBe('hi');
      expect(res.body.name).toBe('Asha Rao');

      const audit = await api.prisma.auditLog.findMany({
        where: { action: 'customer.profile_update', actorId: customer.userId },
      });
      expect(audit).toHaveLength(1);
      expect(audit[0].metadata).toEqual({ changedFields: ['email', 'preferredLanguage'] });

      for (const body of [{}, { verificationStatus: 'VERIFIED' }]) {
        const empty = await as(customer).patch('/api/v1/customers/me', body);
        expect(empty.status).toBe(400);
        expect(empty.body.code).toBe('VALIDATION_FAILED');
      }
      const invalid = await as(customer).patch('/api/v1/customers/me', { email: 'nope' });
      expect(invalid.status).toBe(400);
    });

    it('cannot update a profile that does not exist', async () => {
      const customer = await newCustomer(false);
      const res = await as(customer).patch('/api/v1/customers/me', { name: 'Asha Rao' });
      expect(res.status).toBe(404);
    });

    it("keeps each customer's data separate", async () => {
      const a = await newCustomer();
      const b = await newCustomer();
      await as(a).patch('/api/v1/customers/me', { name: 'Customer A' });
      await as(b).patch('/api/v1/customers/me', { name: 'Customer B' });
      expect((await as(a).get('/api/v1/customers/me')).body).toMatchObject({
        id: a.customerId,
        name: 'Customer A',
        mobile: a.mobile,
      });
      expect((await as(b).get('/api/v1/customers/me')).body).toMatchObject({
        id: b.customerId,
        name: 'Customer B',
        mobile: b.mobile,
      });
    });

    it('is reserved for customers: workers, admins and anonymous callers are refused', async () => {
      const worker = await loginWithOtp(api, { appType: 'WORKER' });
      for (const caller of [worker, superAdmin]) {
        for (const [method, url] of [
          ['get', '/api/v1/customers/me'],
          ['get', '/api/v1/customers/me/addresses'],
        ] as const) {
          const res = await as(caller)[method](url);
          expect(res.status).toBe(403);
          expect(res.body.code).toBe('FORBIDDEN');
        }
        expect((await as(caller).post('/api/v1/customers/me', { name: 'X' })).status).toBe(403);
      }
      await api.http().get('/api/v1/customers/me').expect(401);
      await api.http().get('/api/v1/customers/me/addresses').expect(401);
    });

    it('stops a suspended customer at once, across every customer endpoint', async () => {
      const customer = await newCustomer();
      const addressId = await addAddress(customer);
      await as(superAdmin)
        .patch(`/api/v1/admin/users/${customer.userId}/status`, { status: 'SUSPENDED' })
        .expect(200);
      for (const [method, url] of [
        ['get', '/api/v1/customers/me'],
        ['get', '/api/v1/customers/me/addresses'],
        ['get', `/api/v1/customers/me/addresses/${addressId}`],
        ['delete', `/api/v1/customers/me/addresses/${addressId}`],
      ] as const) {
        expect((await as(customer)[method](url)).status).toBe(401);
      }
      expect((await as(customer).post('/api/v1/customers/me/addresses', address())).status).toBe(
        401,
      );
      expect((await as(customer).patch('/api/v1/customers/me', { name: 'Hacker' })).status).toBe(
        401,
      );
      // Nothing was changed behind the rejected requests.
      const row = await api.prisma.customerProfile.findUniqueOrThrow({
        where: { id: customer.customerId },
      });
      expect(row.name).toBe('Asha Rao');
      expect(
        await api.prisma.customerAddress.count({
          where: { customerId: customer.customerId, isActive: true },
        }),
      ).toBe(1);
    });
  });

  describe('addresses', () => {
    it('requires a profile first (409)', async () => {
      const customer = await newCustomer(false);
      for (const res of [
        await as(customer).get('/api/v1/customers/me/addresses'),
        await as(customer).post('/api/v1/customers/me/addresses', address()),
      ]) {
        expect(res.status).toBe(409);
        expect(res.body.code).toBe('CUSTOMER_PROFILE_REQUIRED');
      }
    });

    it('saves several addresses with optional map coordinates and lists them (own only)', async () => {
      const customer = await newCustomer();
      const other = await newCustomer();
      const home = await as(customer).post(
        '/api/v1/customers/me/addresses',
        address({ latitude: 17.448294, longitude: 78.391487 }),
      );
      expect(home.status).toBe(201);
      expect(home.body).toMatchObject({
        line: '12-3-45, Lotus Apartments',
        area: 'Madhapur',
        city: 'Hyderabad',
        pincode: '500081',
        latitude: 17.448294,
        longitude: 78.391487,
        isDefault: false,
      });
      expect(Object.keys(home.body as object)).not.toContain('customerId');
      expect(Object.keys(home.body as object)).not.toContain('isActive');
      await addAddress(customer, { line: 'Office, Hitech City', pincode: '500081' });
      await addAddress(other);

      const list = await as(customer).get('/api/v1/customers/me/addresses');
      expect(list.status).toBe(200);
      expect(list.body).toHaveLength(2);
      const otherList = await as(other).get('/api/v1/customers/me/addresses');
      expect(otherList.body).toHaveLength(1);
      const ids = (list.body as Array<{ id: string }>).map((a) => a.id);
      expect(ids).not.toContain(otherList.body[0].id);
    });

    it.each([
      ['bad pincode', { pincode: '12345' }],
      ['pincode with letters', { pincode: '50008A' }],
      ['pincode starting 0', { pincode: '012345' }],
      ['missing line', { line: undefined }],
      ['missing area', { area: undefined }],
      ['missing city', { city: undefined }],
      ['blank city', { city: '   ' }],
      ['latitude only', { latitude: 17.4 }],
      ['longitude only', { longitude: 78.3 }],
      ['latitude out of range', { latitude: 91, longitude: 78.3 }],
      ['longitude out of range', { latitude: 17.4, longitude: 181 }],
      ['too many decimals', { latitude: 17.4123456789, longitude: 78.3 }],
      ['non-numeric coordinates', { latitude: 'north', longitude: 'east' }],
      ['isDefault not boolean', { isDefault: 'yes' }],
    ])('rejects %s without saving anything', async (_n, bad) => {
      const customer = await newCustomer();
      const res = await as(customer).post('/api/v1/customers/me/addresses', address(bad));
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('VALIDATION_FAILED');
      expect(
        await api.prisma.customerAddress.count({ where: { customerId: customer.customerId } }),
      ).toBe(0);
    });

    it('has no default until one is chosen, then keeps exactly one default', async () => {
      const customer = await newCustomer();
      const a = await addAddress(customer);
      const b = await addAddress(customer, { isDefault: true });
      expect(await defaultCount(customer.customerId)).toBe(1);
      const c = await addAddress(customer, { isDefault: true });
      expect(await defaultCount(customer.customerId)).toBe(1);

      let list = (await as(customer).get('/api/v1/customers/me/addresses')).body as Array<{
        id: string;
        isDefault: boolean;
      }>;
      expect(list[0]).toMatchObject({ id: c, isDefault: true }); // default first
      expect(list.filter((x) => x.isDefault)).toHaveLength(1);

      const promoted = await as(customer).put(`/api/v1/customers/me/addresses/${a}/default`);
      expect(promoted.status).toBe(200);
      expect(promoted.body).toMatchObject({ id: a, isDefault: true });
      list = (await as(customer).get('/api/v1/customers/me/addresses')).body as typeof list;
      expect(list.find((x) => x.id === b)?.isDefault).toBe(false);
      expect(list.find((x) => x.id === c)?.isDefault).toBe(false);
      expect(await defaultCount(customer.customerId)).toBe(1);
    });

    it('is idempotent when the current default is chosen again (no extra audit)', async () => {
      const customer = await newCustomer();
      const a = await addAddress(customer);
      await as(customer).put(`/api/v1/customers/me/addresses/${a}/default`).expect(200);
      await as(customer).put(`/api/v1/customers/me/addresses/${a}/default`).expect(200);
      expect(
        await api.prisma.auditLog.count({
          where: { action: 'customer.address_set_default', entityId: a },
        }),
      ).toBe(1);
    });

    it('never ends with two defaults when default changes race', async () => {
      const customer = await newCustomer();
      const ids = await Promise.all(Array.from({ length: 5 }, () => addAddress(customer)));
      const results = await Promise.all(
        ids.map((id) => as(customer).put(`/api/v1/customers/me/addresses/${id}/default`)),
      );
      expect(results.every((r) => r.status === 200)).toBe(true);
      expect(await defaultCount(customer.customerId)).toBe(1);
    });

    it('never ends with two defaults when creations with isDefault race', async () => {
      const customer = await newCustomer();
      const results = await Promise.all(
        Array.from({ length: 6 }, () =>
          as(customer).post('/api/v1/customers/me/addresses', address({ isDefault: true })),
        ),
      );
      expect(results.every((r) => r.status === 201)).toBe(true);
      expect(await defaultCount(customer.customerId)).toBe(1);
      expect(
        await api.prisma.customerAddress.count({ where: { customerId: customer.customerId } }),
      ).toBe(6);
    });

    it('edits address fields, supports clearing the map location, and keeps coordinates paired', async () => {
      const customer = await newCustomer();
      const id = await addAddress(customer, { latitude: 17.4, longitude: 78.3 });
      const edited = await as(customer).patch(`/api/v1/customers/me/addresses/${id}`, {
        line: 'New line',
        pincode: '500034',
      });
      expect(edited.status).toBe(200);
      expect(edited.body).toMatchObject({
        line: 'New line',
        pincode: '500034',
        area: 'Madhapur',
        latitude: 17.4,
        longitude: 78.3,
      });

      const half = await as(customer).patch(`/api/v1/customers/me/addresses/${id}`, {
        latitude: null,
      });
      expect(half.status).toBe(400);
      expect((await as(customer).get(`/api/v1/customers/me/addresses/${id}`)).body.latitude).toBe(
        17.4,
      );

      const cleared = await as(customer).patch(`/api/v1/customers/me/addresses/${id}`, {
        latitude: null,
        longitude: null,
      });
      expect(cleared.status).toBe(200);
      expect(cleared.body).toMatchObject({ latitude: null, longitude: null });

      const audit = await api.prisma.auditLog.findMany({
        where: { action: 'customer.address_update', entityId: id },
      });
      expect(audit).toHaveLength(2);
      expect(JSON.stringify(audit)).not.toContain('New line');
    });

    it('does not let a client flip server-controlled address fields (mass assignment)', async () => {
      const customer = await newCustomer();
      const stranger = await newCustomer();
      const id = await addAddress(customer);
      const res = await as(customer).patch(`/api/v1/customers/me/addresses/${id}`, {
        line: 'Edited line',
        isDefault: true,
        isActive: false,
        customerId: stranger.customerId,
        id: UNKNOWN_ID,
      });
      expect(res.status).toBe(200);
      const row = await api.prisma.customerAddress.findUniqueOrThrow({ where: { id } });
      expect(row).toMatchObject({
        line: 'Edited line',
        isDefault: false,
        isActive: true,
        customerId: customer.customerId,
      });
      const bodyOnlyForbidden = await as(customer).patch(`/api/v1/customers/me/addresses/${id}`, {
        isDefault: true,
      });
      expect(bodyOnlyForbidden.status).toBe(400); // stripped to nothing, so "at least one field"
      expect(
        (await api.prisma.customerAddress.findUniqueOrThrow({ where: { id } })).isDefault,
      ).toBe(false);
    });

    it('removes an address softly: hidden from the customer, kept in the database, default cleared', async () => {
      const customer = await newCustomer();
      const keep = await addAddress(customer);
      const removed = await addAddress(customer, { isDefault: true });
      await as(customer).delete(`/api/v1/customers/me/addresses/${removed}`).expect(204);

      expect((await as(customer).get(`/api/v1/customers/me/addresses/${removed}`)).status).toBe(
        404,
      );
      const list = (await as(customer).get('/api/v1/customers/me/addresses')).body as Array<{
        id: string;
      }>;
      expect(list.map((a) => a.id)).toEqual([keep]);
      const row = await api.prisma.customerAddress.findUniqueOrThrow({ where: { id: removed } });
      expect(row).toMatchObject({ isActive: false, isDefault: false });
      expect(await defaultCount(customer.customerId)).toBe(0); // no auto-promotion (open product decision)

      // A removed address cannot be edited, made default or removed again.
      expect(
        (await as(customer).patch(`/api/v1/customers/me/addresses/${removed}`, { line: 'x' }))
          .status,
      ).toBe(404);
      expect(
        (await as(customer).put(`/api/v1/customers/me/addresses/${removed}/default`)).status,
      ).toBe(404);
      expect((await as(customer).delete(`/api/v1/customers/me/addresses/${removed}`)).status).toBe(
        404,
      );
      const audit = await api.prisma.auditLog.findMany({
        where: { action: 'customer.address_deactivate', entityId: removed },
      });
      expect(audit).toHaveLength(1);
      expect(audit[0].metadata).toEqual({ wasDefault: true });
    });

    it("treats another customer's address id as not found for every operation (IDOR)", async () => {
      const owner = await newCustomer();
      const attacker = await newCustomer();
      const id = await addAddress(owner, { isDefault: true });
      const base = `/api/v1/customers/me/addresses/${id}`;

      const responses = [
        await as(attacker).get(base),
        await as(attacker).patch(base, { line: 'hijacked' }),
        await as(attacker).put(`${base}/default`),
        await as(attacker).delete(base),
      ];
      for (const res of responses) {
        expect(res.status).toBe(404);
        expect(res.body.code).toBe('ADDRESS_NOT_FOUND');
      }
      const unknown = await as(attacker).get(`/api/v1/customers/me/addresses/${UNKNOWN_ID}`);
      expect(unknown.status).toBe(404);
      expect(unknown.body).toMatchObject({
        code: unknown.body.code,
        message: responses[0].body.message,
      });

      const row = await api.prisma.customerAddress.findUniqueOrThrow({ where: { id } });
      expect(row).toMatchObject({
        line: '12-3-45, Lotus Apartments',
        isActive: true,
        isDefault: true,
        customerId: owner.customerId,
      });
      expect(
        await api.prisma.auditLog.count({ where: { entityId: id, actorId: attacker.userId } }),
      ).toBe(0);
      expect((await as(attacker).get('/api/v1/customers/me/addresses')).body).toHaveLength(0);
    });

    it('rejects malformed address ids', async () => {
      const customer = await newCustomer();
      expect((await as(customer).get('/api/v1/customers/me/addresses/not-a-uuid')).status).toBe(
        400,
      );
      expect((await as(customer).delete('/api/v1/customers/me/addresses/123')).status).toBe(400);
    });

    it('lets the database itself refuse states the application must never produce', async () => {
      const customer = await newCustomer();
      const first = await addAddress(customer, { isDefault: true });
      const second = await addAddress(customer);
      const make = (data: object) =>
        api.prisma.customerAddress.create({
          data: {
            customerId: customer.customerId,
            line: 'l',
            area: 'a',
            city: 'c',
            pincode: '500001',
            ...data,
          },
        });
      await expect(make({ isDefault: true })).rejects.toThrow(); // second default
      await expect(make({ isDefault: true, isActive: false })).rejects.toThrow(); // inactive default
      await expect(make({ latitude: 10 })).rejects.toThrow(); // half coordinates
      await expect(make({ latitude: 91, longitude: 10 })).rejects.toThrow(); // range
      await expect(
        api.prisma.customerAddress.update({ where: { id: second }, data: { isDefault: true } }),
      ).rejects.toThrow();
      expect(await defaultCount(customer.customerId)).toBe(1);
      expect(
        (await api.prisma.customerAddress.findUniqueOrThrow({ where: { id: first } })).isDefault,
      ).toBe(true);
    });
  });

  describe('admin customer management', () => {
    const base = '/api/v1/admin/customers';

    it('lists customers with pagination, filters and masked mobiles', async () => {
      const customers = [await newCustomer(), await newCustomer(), await newCustomer()];
      const page = await as(superAdmin).get(`${base}?page=1&limit=2`);
      expect(page.status).toBe(200);
      expect(page.body.data).toHaveLength(2);
      expect(page.body.meta).toMatchObject({ page: 1, limit: 2 });
      expect(page.body.meta.total).toBeGreaterThanOrEqual(3);
      for (const row of page.body.data as Array<Record<string, string>>) {
        expect(row.mobile).toMatch(/^\+91\*{6}\d{4}$/);
        expect(Object.keys(row).sort()).toEqual([
          'accountStatus',
          'createdAt',
          'email',
          'id',
          'mobile',
          'name',
          'preferredLanguage',
          'userId',
          'verificationStatus',
        ]);
      }

      // Newest first and stable across pages.
      const second = await as(superAdmin).get(`${base}?page=2&limit=2`);
      const seen = new Set(
        [...page.body.data, ...second.body.data].map((r: { id: string }) => r.id),
      );
      expect(seen.size).toBe(page.body.data.length + second.body.data.length);

      // Filter by exact mobile in different formats.
      const ten = customers[0].mobile.slice(3);
      for (const form of [customers[0].mobile, ten, `0${ten}`]) {
        const found = await as(superAdmin).get(`${base}?mobile=${encodeURIComponent(form)}`);
        expect(found.status).toBe(200);
        expect(found.body.data.map((r: { id: string }) => r.id)).toEqual([customers[0].customerId]);
      }
      const none = await as(superAdmin).get(`${base}?mobile=${randomMobile().slice(3)}`);
      expect(none.body).toEqual({ data: [], meta: { page: 1, limit: 20, total: 0 } });
    });

    it('filters by verification status', async () => {
      const customer = await newCustomer();
      await as(superAdmin)
        .patch(`${base}/${customer.customerId}/verification-status`, { status: 'VERIFIED' })
        .expect(200);
      const verified = await as(superAdmin).get(`${base}?verificationStatus=VERIFIED&limit=100`);
      const pending = await as(superAdmin).get(`${base}?verificationStatus=PENDING&limit=100`);
      expect(
        verified.body.data.every(
          (r: { verificationStatus: string }) => r.verificationStatus === 'VERIFIED',
        ),
      ).toBe(true);
      expect(verified.body.data.map((r: { id: string }) => r.id)).toContain(customer.customerId);
      expect(pending.body.data.map((r: { id: string }) => r.id)).not.toContain(customer.customerId);
    });

    it.each([
      ['page 0', 'page=0'],
      ['negative page', 'page=-1'],
      ['limit above the ceiling', 'limit=101'],
      ['limit 0', 'limit=0'],
      ['non-numeric page', 'page=abc'],
      ['unknown status', 'verificationStatus=BLOCKED'],
    ])('rejects %s', async (_n, query) => {
      const res = await as(superAdmin).get(`${base}?${query}`);
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('VALIDATION_FAILED');
    });

    it('shows full detail: unmasked mobile, account status, and inactive addresses flagged', async () => {
      const customer = await newCustomer();
      const keep = await addAddress(customer, { isDefault: true });
      const gone = await addAddress(customer);
      await as(customer).delete(`/api/v1/customers/me/addresses/${gone}`).expect(204);
      const res = await as(superAdmin).get(`${base}/${customer.customerId}`);
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({
        id: customer.customerId,
        userId: customer.userId,
        mobile: customer.mobile,
        accountStatus: 'ACTIVE',
        verificationStatus: 'PENDING',
      });
      const byId = Object.fromEntries(
        (res.body.addresses as Array<{ id: string; isActive: boolean; isDefault: boolean }>).map(
          (a) => [a.id, a],
        ),
      );
      expect(byId[keep]).toMatchObject({ isActive: true, isDefault: true });
      expect(byId[gone]).toMatchObject({ isActive: false, isDefault: false });

      await as(superAdmin)
        .patch(`/api/v1/admin/users/${customer.userId}/status`, { status: 'SUSPENDED' })
        .expect(200);
      expect((await as(superAdmin).get(`${base}/${customer.customerId}`)).body.accountStatus).toBe(
        'SUSPENDED',
      );
    });

    it('answers 404 for unknown customers and 400 for malformed ids', async () => {
      expect((await as(superAdmin).get(`${base}/${UNKNOWN_ID}`)).status).toBe(404);
      expect((await as(superAdmin).get(`${base}/nope`)).status).toBe(400);
      expect(
        (
          await as(superAdmin).patch(`${base}/${UNKNOWN_ID}/verification-status`, {
            status: 'VERIFIED',
          })
        ).status,
      ).toBe(404);
      expect((await as(superAdmin).post(`${base}/${UNKNOWN_ID}/notes`, { note: 'x' })).status).toBe(
        404,
      );
      expect((await as(superAdmin).get(`${base}/${UNKNOWN_ID}/notes`)).status).toBe(404);
    });

    it('changes verification status with an audited before/after, idempotently and safely under concurrency', async () => {
      const customer = await newCustomer();
      const results = await Promise.all(
        Array.from({ length: 5 }, () =>
          as(superAdmin).patch(`${base}/${customer.customerId}/verification-status`, {
            status: 'VERIFIED',
            note: 'docs checked',
          }),
        ),
      );
      expect(
        results.every((r) => r.status === 200 && r.body.verificationStatus === 'VERIFIED'),
      ).toBe(true);
      const audit = await api.prisma.auditLog.findMany({
        where: { action: 'customer.verification_status_change', entityId: customer.customerId },
      });
      expect(audit).toHaveLength(1);
      expect(audit[0]).toMatchObject({ actorId: superAdmin.userId, actorRole: 'SUPER_ADMIN' });
      expect(audit[0].metadata).toEqual({ from: 'PENDING', to: 'VERIFIED', note: 'docs checked' });
      expect((await as(customer).get('/api/v1/customers/me')).body.verificationStatus).toBe(
        'VERIFIED',
      );

      await as(superAdmin)
        .patch(`${base}/${customer.customerId}/verification-status`, { status: 'PENDING' })
        .expect(200);
      expect(
        await api.prisma.auditLog.count({
          where: { action: 'customer.verification_status_change', entityId: customer.customerId },
        }),
      ).toBe(2);
      for (const bad of [
        { status: 'REJECTED' },
        { status: 'VERIFIED', note: 'x'.repeat(501) },
        {},
      ]) {
        expect(
          (await as(superAdmin).patch(`${base}/${customer.customerId}/verification-status`, bad))
            .status,
        ).toBe(400);
      }
    });

    it('adds and lists notes newest first, auditing the note id but never its text', async () => {
      const customer = await newCustomer();
      const first = await as(superAdmin).post(`${base}/${customer.customerId}/notes`, {
        note: 'Called customer, confirmed address',
      });
      expect(first.status).toBe(201);
      expect(first.body).toMatchObject({
        authorId: superAdmin.userId,
        note: 'Called customer, confirmed address',
      });
      await as(superAdmin)
        .post(`${base}/${customer.customerId}/notes`, { note: 'Second note' })
        .expect(201);

      const list = await as(superAdmin).get(`${base}/${customer.customerId}/notes?limit=1&page=1`);
      expect(list.status).toBe(200);
      expect(list.body.meta).toEqual({ page: 1, limit: 1, total: 2 });
      expect(list.body.data[0].note).toBe('Second note');
      const page2 = await as(superAdmin).get(`${base}/${customer.customerId}/notes?limit=1&page=2`);
      expect(page2.body.data[0].note).toBe('Called customer, confirmed address');

      const audit = await api.prisma.auditLog.findMany({
        where: { action: 'customer.note_add', entityId: customer.customerId },
      });
      expect(audit).toHaveLength(2);
      expect(JSON.stringify(audit)).not.toMatch(/Called customer|Second note/);

      for (const bad of [{ note: '' }, { note: '   ' }, { note: 'x'.repeat(2001) }, {}]) {
        expect(
          (await as(superAdmin).post(`${base}/${customer.customerId}/notes`, bad)).status,
        ).toBe(400);
      }
    });

    it('never exposes notes or admin data to the customer', async () => {
      const customer = await newCustomer();
      await as(superAdmin)
        .post(`${base}/${customer.customerId}/notes`, { note: 'internal remark' })
        .expect(201);
      const profile = await as(customer).get('/api/v1/customers/me');
      const addresses = await as(customer).get('/api/v1/customers/me/addresses');
      expect(JSON.stringify([profile.body, addresses.body])).not.toMatch(/internal remark|note/i);
      expect((await as(customer).get(`${base}/${customer.customerId}/notes`)).status).toBe(403);
    });

    it('enforces permissions per capability and refuses non-admins', async () => {
      const customer = await newCustomer();
      const viewer = await loginAdminWithPermissions(api, ['customer.view']);
      const manager = await loginAdminWithPermissions(api, ['customer.manage']);
      const nobody = await loginAdminWithPermissions(api, ['user.view']);
      const worker = await loginWithOtp(api, { appType: 'WORKER' });

      expect((await as(viewer).get(base)).status).toBe(200);
      expect((await as(viewer).get(`${base}/${customer.customerId}`)).status).toBe(200);
      expect((await as(viewer).get(`${base}/${customer.customerId}/notes`)).status).toBe(200);
      expect(
        (
          await as(viewer).patch(`${base}/${customer.customerId}/verification-status`, {
            status: 'VERIFIED',
          })
        ).status,
      ).toBe(403);
      expect(
        (await as(viewer).post(`${base}/${customer.customerId}/notes`, { note: 'x' })).status,
      ).toBe(403);

      expect(
        (
          await as(manager).patch(`${base}/${customer.customerId}/verification-status`, {
            status: 'VERIFIED',
          })
        ).status,
      ).toBe(200);
      expect(
        (await as(manager).post(`${base}/${customer.customerId}/notes`, { note: 'x' })).status,
      ).toBe(201);
      expect((await as(manager).get(base)).status).toBe(403); // manage does not imply view

      for (const caller of [nobody, customer, worker]) {
        expect((await as(caller).get(base)).status).toBe(403);
        expect((await as(caller).get(`${base}/${customer.customerId}`)).status).toBe(403);
        expect(
          (await as(caller).post(`${base}/${customer.customerId}/notes`, { note: 'x' })).status,
        ).toBe(403);
      }
      await api.http().get(base).expect(401);
    });
  });
});
