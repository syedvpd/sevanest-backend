import '../support/env-api-integration';
import {
  ApiApp,
  bearer,
  createApiApp,
  loginAdmin,
  loginWithOtp,
  otpKeyId,
  unique,
} from '../support/api-app';

/**
 * Cross-module journey (Auth -> Users -> Customers) and the published API contract, against the real PostgreSQL +
 * Redis, through HTTP only.
 */
describe('Auth -> Users -> Customers journey and OpenAPI contract (integration)', () => {
  let api: ApiApp;
  let admin: Awaited<ReturnType<typeof loginAdmin>>;

  beforeAll(async () => {
    api = await createApiApp();
    admin = await loginAdmin(api);
  });
  afterAll(async () => {
    await api.close();
  });

  it('walks a new customer from OTP registration to a managed, then suspended, account', async () => {
    // 1. Auth: OTP registration creates the account (Users) and a session.
    const session = await loginWithOtp(api);
    expect(session.isNewUser).toBe(true);

    // 2. Users: the server knows who this is and what they may do.
    const me = await api.http().get('/api/v1/users/me').set('Authorization', bearer(session));
    expect(me.body).toMatchObject({
      type: 'CUSTOMER',
      status: 'ACTIVE',
      roles: [],
      permissions: [],
    });

    // 3. Customers: no profile yet -> create -> address -> default.
    await api.http().get('/api/v1/customers/me').set('Authorization', bearer(session)).expect(404);
    const profile = await api
      .http()
      .post('/api/v1/customers/me')
      .set('Authorization', bearer(session))
      .send({ name: 'Asha Rao', email: `j.${unique()}@example.test`, preferredLanguage: 'en' });
    expect(profile.status).toBe(201);
    const address = await api
      .http()
      .post('/api/v1/customers/me/addresses')
      .set('Authorization', bearer(session))
      .send({
        line: '1 Main Rd',
        area: 'Madhapur',
        city: 'Hyderabad',
        pincode: '500081',
        isDefault: true,
      });
    expect(address.status).toBe(201);

    // 4. Refresh keeps the same user and session working, with a rotated token.
    const refreshed = await api
      .http()
      .post('/api/v1/auth/token/refresh')
      .send({ refreshToken: session.refreshToken });
    expect(refreshed.status).toBe(200);
    const withNewToken = `Bearer ${refreshed.body.accessToken}`;
    expect(
      (await api.http().get('/api/v1/customers/me/addresses').set('Authorization', withNewToken))
        .body,
    ).toHaveLength(1);

    // 5. Admin sees the customer (mobile masked in the list) and manages them.
    const found = await api
      .http()
      .get(`/api/v1/admin/customers?mobile=${encodeURIComponent(session.mobile!)}`)
      .set('Authorization', bearer(admin));
    expect(found.body.data).toHaveLength(1);
    expect(found.body.data[0]).toMatchObject({
      id: profile.body.id,
      verificationStatus: 'PENDING',
      accountStatus: 'ACTIVE',
    });
    expect(found.body.data[0].mobile).not.toBe(session.mobile);
    await api
      .http()
      .patch(`/api/v1/admin/customers/${profile.body.id}/verification-status`)
      .set('Authorization', bearer(admin))
      .send({ status: 'VERIFIED' })
      .expect(200);
    expect(
      (await api.http().get('/api/v1/customers/me').set('Authorization', withNewToken)).body
        .verificationStatus,
    ).toBe('VERIFIED');

    // 6. Suspension (Users) ends access everywhere, including OTP login (Auth), and leaves the data intact.
    await api
      .http()
      .patch(`/api/v1/admin/users/${session.userId}/status`)
      .set('Authorization', bearer(admin))
      .send({ status: 'SUSPENDED', reason: 'journey test' })
      .expect(200);
    await api.http().get('/api/v1/customers/me').set('Authorization', withNewToken).expect(401);
    await api.redis.client.del(`auth:otp:cooldown:${otpKeyId(session.mobile!)}`);
    const relogin = await api
      .http()
      .post('/api/v1/auth/otp/request')
      .send({ mobile: session.mobile, appType: 'CUSTOMER' });
    expect(relogin.status).toBe(403);
    expect(relogin.body.code).toBe('ACCOUNT_SUSPENDED');
    const stillThere = await api
      .http()
      .get(`/api/v1/admin/customers/${profile.body.id}`)
      .set('Authorization', bearer(admin));
    expect(stillThere.body.addresses).toHaveLength(1);

    // 7. One audit trail across the three modules.
    const actions = (
      await api.prisma.auditLog.findMany({
        where: {
          OR: [
            { actorId: session.userId },
            { entityId: session.userId },
            { entityId: profile.body.id },
          ],
        },
        select: { action: true },
      })
    ).map((a) => a.action);
    expect(actions).toEqual(
      expect.arrayContaining([
        'user.register',
        'auth.login',
        'customer.profile_create',
        'customer.address_create',
        'customer.verification_status_change',
        'user.status_change',
      ]),
    );
  });

  it('keeps a worker out of customer-private data and customers out of worker accounts', async () => {
    const customer = await loginWithOtp(api);
    await api
      .http()
      .post('/api/v1/customers/me')
      .set('Authorization', bearer(customer))
      .send({
        name: 'Private Person',
        email: `pp.${unique()}@example.test`,
        preferredLanguage: 'en',
      })
      .expect(201);
    const worker = await loginWithOtp(api, { appType: 'WORKER' });
    for (const path of [
      '/api/v1/customers/me',
      '/api/v1/customers/me/addresses',
      '/api/v1/admin/customers',
    ]) {
      expect((await api.http().get(path).set('Authorization', bearer(worker))).status).toBe(403);
    }
    // The customer's number cannot be claimed by the Worker app.
    await api.redis.client.del(`auth:otp:cooldown:${otpKeyId(customer.mobile!)}`);
    const claim = await api
      .http()
      .post('/api/v1/auth/otp/request')
      .send({ mobile: customer.mobile, appType: 'WORKER' });
    expect(claim.status).toBe(409);
    expect(claim.body.code).toBe('ACCOUNT_TYPE_MISMATCH');
    expect(await api.prisma.user.count({ where: { mobile: customer.mobile } })).toBe(1);
  });

  it('never returns secrets or internal fields from any module', async () => {
    const customer = await loginWithOtp(api);
    const responses = [
      await api.http().get('/api/v1/users/me').set('Authorization', bearer(customer)),
      await api.http().get('/api/v1/auth/sessions').set('Authorization', bearer(customer)),
      await api
        .http()
        .get(`/api/v1/admin/users/${customer.userId}`)
        .set('Authorization', bearer(admin)),
      await api.http().get('/api/v1/admin/customers?limit=100').set('Authorization', bearer(admin)),
    ];
    for (const res of responses) {
      expect(res.status).toBe(200);
      expect(JSON.stringify(res.body)).not.toMatch(
        /passwordHash|password_hash|refreshTokenHash|previousRefreshToken|"otp"|scrypt|secret/i,
      );
    }
  });

  describe('OpenAPI', () => {
    let spec: {
      paths: Record<
        string,
        Record<string, { security?: unknown[]; tags?: string[]; responses?: object }>
      >;
      components: {
        schemas: Record<string, { properties?: Record<string, { writeOnly?: boolean }> }>;
        securitySchemes: object;
      };
    };

    beforeAll(async () => {
      const res = await api.http().get('/docs/openapi.json');
      expect(res.status).toBe(200);
      spec = res.body as typeof spec;
    });

    it('documents every Auth, Users and Customers endpoint under /api/v1', () => {
      const expected: Array<[string, string]> = [
        ['post', '/api/v1/auth/otp/request'],
        ['post', '/api/v1/auth/otp/verify'],
        ['post', '/api/v1/auth/admin/login'],
        ['post', '/api/v1/auth/token/refresh'],
        ['post', '/api/v1/auth/logout'],
        ['get', '/api/v1/auth/sessions'],
        ['delete', '/api/v1/auth/sessions/{sessionId}'],
        ['put', '/api/v1/auth/device-token'],
        ['get', '/api/v1/users/me'],
        ['post', '/api/v1/admin/users'],
        ['get', '/api/v1/admin/users/{userId}'],
        ['patch', '/api/v1/admin/users/{userId}/status'],
        ['post', '/api/v1/customers/me'],
        ['get', '/api/v1/customers/me'],
        ['patch', '/api/v1/customers/me'],
        ['get', '/api/v1/customers/me/addresses'],
        ['post', '/api/v1/customers/me/addresses'],
        ['get', '/api/v1/customers/me/addresses/{addressId}'],
        ['patch', '/api/v1/customers/me/addresses/{addressId}'],
        ['put', '/api/v1/customers/me/addresses/{addressId}/default'],
        ['delete', '/api/v1/customers/me/addresses/{addressId}'],
        ['get', '/api/v1/admin/customers'],
        ['get', '/api/v1/admin/customers/{customerId}'],
        ['patch', '/api/v1/admin/customers/{customerId}/verification-status'],
        ['post', '/api/v1/admin/customers/{customerId}/notes'],
        ['get', '/api/v1/admin/customers/{customerId}/notes'],
      ];
      for (const [method, path] of expected) {
        expect(spec.paths[path]?.[method]).toBeDefined();
      }
    });

    it('marks protected operations with bearer auth and leaves the login/OTP/refresh operations open', () => {
      const open = [
        '/api/v1/auth/otp/request',
        '/api/v1/auth/otp/verify',
        '/api/v1/auth/admin/login',
        '/api/v1/auth/token/refresh',
      ];
      for (const path of open) {
        const operation = Object.values(spec.paths[path])[0];
        expect(operation.security ?? []).toHaveLength(0);
      }
      for (const [path, method] of [
        ['/api/v1/users/me', 'get'],
        ['/api/v1/customers/me', 'get'],
        ['/api/v1/admin/customers', 'get'],
        ['/api/v1/auth/logout', 'post'],
      ] as const) {
        expect(spec.paths[path][method].security).toEqual([{ bearer: [] }]);
      }
    });

    it('keeps passwords write-only and exposes no credential fields in response schemas', () => {
      expect(spec.components.schemas.CreateAdminDto.properties?.password.writeOnly).toBe(true);
      expect(spec.components.schemas.AdminLoginDto.properties?.password.writeOnly).toBe(true);
      const names = Object.keys(spec.components.schemas);
      for (const name of names.filter((n) => /Response|Summary|Detail/.test(n))) {
        const props = Object.keys(spec.components.schemas[name].properties ?? {});
        expect(props.filter((p) => /password|hash|otp/i.test(p))).toEqual([]);
      }
    });

    it('does not accept client-controlled server fields in request schemas', () => {
      const writable = (name: string): string[] =>
        Object.keys(spec.components.schemas[name].properties ?? {});
      expect(writable('CreateCustomerProfileDto').sort()).toEqual([
        'email',
        'name',
        'preferredLanguage',
      ]);
      expect(writable('UpdateCustomerProfileDto').sort()).toEqual([
        'email',
        'name',
        'preferredLanguage',
      ]);
      expect(writable('UpdateAddressDto')).not.toEqual(expect.arrayContaining(['isDefault']));
      expect(writable('UpdateAddressDto')).not.toEqual(expect.arrayContaining(['isActive']));
      expect(writable('UpdateUserStatusDto').sort()).toEqual(['reason', 'status']);
    });
  });
});
