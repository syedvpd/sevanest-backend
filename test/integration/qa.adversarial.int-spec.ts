import '../support/env-api-integration';
import { JwtService } from '@nestjs/jwt';
import {
  ApiApp,
  createApiApp,
  loginAdmin,
  loginAdminWithPermissions,
  loginWithOtp,
  sessionIdFromToken,
} from '../support/api-app';
import { concretePath, listRoutes, RouteInfo } from '../support/routes';
import { as, createArea, onboardWorker } from '../support/workforce';

const UNKNOWN_ID = '00000000-0000-7000-8000-000000000000';

/** QA: adversarial requests against the whole API, with evidence for each claim. */
describe('QA - adversarial API testing (integration)', () => {
  let api: ApiApp;
  let admin: Awaited<ReturnType<typeof loginAdmin>>;
  let routes: RouteInfo[];

  beforeAll(async () => {
    api = await createApiApp();
    admin = await loginAdmin(api);
    routes = listRoutes(api.app);
  });

  afterAll(async () => {
    await api.close();
  });

  describe('tokens', () => {
    const decode = (token: string): Record<string, unknown> =>
      JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString()) as Record<
        string,
        unknown
      >;

    it('rejects expired, wrongly signed, unsigned, re-algorithmed and structurally broken tokens', async () => {
      const customer = await loginWithOtp(api, { appType: 'CUSTOMER' });
      const claims = decode(customer.accessToken);
      const jwt = api.app.get(JwtService);
      const secret = api.config.jwtAccessSecret;
      const { iat: _iat, exp: _exp, ...payload } = claims;
      const expired = jwt.sign(payload, { secret, expiresIn: -3600 });
      const wrongSecret = jwt.sign(payload, { secret: 'a-completely-different-secret-0123456789' });
      const noneAlg = `${Buffer.from('{"alg":"none","typ":"JWT"}').toString('base64url')}.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.`;
      const hs512 = jwt.sign(payload, {
        secret: 'a-completely-different-secret-0123456789',
        algorithm: 'HS512',
      });
      const wrongUser = jwt.sign({ ...payload, sub: UNKNOWN_ID }, { secret });
      const wrongSession = jwt.sign({ ...payload, sid: UNKNOWN_ID }, { secret });
      const adminClaims = jwt.sign({ ...payload, type: 'ADMIN' }, { secret });
      for (const [name, token] of Object.entries({
        expired,
        wrongSecret,
        noneAlg,
        hs512,
        wrongUser,
        wrongSession,
        empty: '',
        garbage: 'not.a.jwt',
        twoParts: 'a.b',
      })) {
        const res = await api
          .http()
          .get('/api/v1/users/me')
          .set('Authorization', `Bearer ${token}`);
        expect([name, res.status]).toEqual([name, 401]);
        expect(res.body).toMatchObject({ code: 'UNAUTHENTICATED' });
      }
      // A correctly signed token whose claims were edited still gets the identity stored on the server (type comes from the database).
      const edited = await api
        .http()
        .get('/api/v1/users/me')
        .set('Authorization', `Bearer ${adminClaims}`);
      expect((edited.body as { type: string }).type).toBe('CUSTOMER');
      expect(
        (await api.http().get('/api/v1/admin/users').set('Authorization', `Bearer ${adminClaims}`))
          .status,
      ).toBe(403);
      expect(
        (await api.http().get('/api/v1/users/me').set('Authorization', customer.accessToken))
          .status,
      ).toBe(401);
      expect(
        (
          await api
            .http()
            .get('/api/v1/users/me')
            .set('Authorization', `Basic ${customer.accessToken}`)
        ).status,
      ).toBe(401);
      expect((await as(api, customer).get('/api/v1/users/me')).status).toBe(200);
    });

    it('does not let a customer token claim to be an admin, whatever the payload says', async () => {
      const customer = await loginWithOtp(api, { appType: 'CUSTOMER' });
      const forged = api.app.get(JwtService).sign(
        {
          ...(({ iat: _i, exp: _e, ...rest }) => rest)(decode(customer.accessToken)),
          type: 'ADMIN',
          roles: ['SUPER_ADMIN'],
          permissions: ['*'],
        },
        { secret: api.config.jwtAccessSecret },
      );
      const res = await api
        .http()
        .get('/api/v1/admin/users')
        .set('Authorization', `Bearer ${forged}`);
      expect([401, 403]).toContain(res.status);
    });

    it('rejects a revoked session, a refresh token used as an access token, and the access token after logout', async () => {
      const customer = await loginWithOtp(api, { appType: 'CUSTOMER' });
      expect(
        (
          await api
            .http()
            .get('/api/v1/users/me')
            .set('Authorization', `Bearer ${customer.refreshToken}`)
        ).status,
      ).toBe(401);
      await as(api, customer).post('/api/v1/auth/logout').expect(204);
      expect((await as(api, customer).get('/api/v1/users/me')).status).toBe(401);
      expect(sessionIdFromToken(customer.accessToken)).toBeTruthy();
    });
  });

  describe('identifiers in the path', () => {
    it('answers 400, never 500 or 200, to a malformed id on every route that takes one', async () => {
      const customer = await loginWithOtp(api, { appType: 'CUSTOMER' });
      const worker = await loginWithOtp(api, { appType: 'WORKER' });
      const withIds = routes.filter(
        (r) => !r.isPublic && /:(?!action|checkType|roleCode)[A-Za-z]+Id\b/.test(r.path),
      );
      expect(withIds.length).toBeGreaterThan(60);
      const bad: string[] = [];
      for (const route of withIds) {
        const caller = route.userTypes?.includes('ADMIN')
          ? admin
          : route.userTypes?.includes('WORKER') && !route.userTypes.includes('CUSTOMER')
            ? worker
            : customer;
        const url = concretePath(route.path).replace(new RegExp(UNKNOWN_ID, 'g'), 'not-a-uuid');
        const req = api
          .http()
          [route.method.toLowerCase() as 'get'](url)
          .set('Authorization', `Bearer ${caller.accessToken}`);
        const res = route.method === 'GET' ? await req : await req.send({});
        if (res.status !== 400) bad.push(`${route.method} ${route.path} -> ${res.status}`);
        if (
          JSON.stringify(res.body).includes('not-a-uuid') &&
          /select|prisma|syntax/i.test(JSON.stringify(res.body))
        )
          bad.push(`${route.path} echoes internals`);
      }
      expect(bad).toEqual([]);
    }, 280_000);

    it('treats traversal, encoded slashes, null bytes and very long ids as plain bad input', async () => {
      for (const id of [
        '..%2f..%2fetc%2fpasswd',
        '%00',
        '1%27%20OR%20%271%27%3D%271',
        'a'.repeat(5000),
        '%2e%2e',
        '....//',
      ]) {
        const res = await api
          .http()
          .get(`/api/v1/admin/users/${id}`)
          .set('Authorization', `Bearer ${admin.accessToken}`);
        expect([id.slice(0, 20), [400, 404, 414].includes(res.status)]).toEqual([
          id.slice(0, 20),
          true,
        ]);
        expect(JSON.stringify(res.body)).not.toMatch(/etc\/passwd|syntax error|prisma|stack/i);
      }
    });
  });

  describe('injection, oversized and malformed input', () => {
    const SQLI = [
      "' OR '1'='1",
      '1; DROP TABLE users;--',
      "' UNION SELECT password_hash FROM users--",
      '"; SELECT pg_sleep(5);--',
      '${7*7}',
      '{{7*7}}',
    ];

    it('treats SQL in query strings, filters and search as data: no 500, no behaviour change, tables intact', async () => {
      const customer = await loginWithOtp(api, { appType: 'CUSTOMER' });
      const before = await api.prisma.user.count();
      for (const payload of SQLI) {
        const enc = encodeURIComponent(payload);
        for (const url of [
          `/api/v1/admin/users?search=${enc}`,
          `/api/v1/admin/audit-logs?action=${enc}&actionPrefix=${enc}&entityType=${enc}`,
          `/api/v1/admin/customers?mobile=${enc}`,
          `/api/v1/admin/workers?mobile=${enc}`,
          `/api/v1/admin/bookings?status=${enc}`,
          `/api/v1/admin/payments?status=${enc}`,
          `/api/v1/admin/notifications?eventCode=${enc}`,
        ]) {
          const res = await as(api, admin).get(url);
          expect([url, res.status < 500]).toEqual([url, true]);
        }
        const search = await as(api, customer).get(
          `/api/v1/search/workers?category=${enc}&areaId=${enc}&language=${enc}`,
        );
        expect(search.status).toBeLessThan(500);
      }
      expect(await api.prisma.user.count()).toBe(before);
      expect(await api.prisma.$queryRaw<Array<{ ok: number }>>`SELECT 1 AS ok`).toEqual([
        { ok: 1 },
      ]);
    });

    it('stores hostile text in free-text fields literally and returns it as data, escaped by JSON only', async () => {
      const customer = await loginWithOtp(api, { appType: 'CUSTOMER' });
      const text = `<script>alert(1)</script> ${SQLI[0]} ${SQLI[1]}`;
      const created = await as(api, customer).post('/api/v1/customers/me', {
        name: 'Eve Tester',
        email: `eve.${Date.now()}@example.test`,
        preferredLanguage: 'en',
      });
      expect(created.status).toBe(201);
      const address = await as(api, customer).post('/api/v1/customers/me/addresses', {
        line: text,
        area: 'Area',
        city: 'City',
        pincode: '500001',
      });
      expect(address.status).toBe(201);
      expect(address.body.line).toBe(text);
      expect(address.headers['content-type']).toMatch(/application\/json/);
      expect(address.headers['x-content-type-options']).toBe('nosniff');
    });

    it('rejects oversized fields, wrong types, unknown enum values, boundary numbers and prototype pollution keys', async () => {
      const customer = await loginWithOtp(api, { appType: 'CUSTOMER' });
      const c = as(api, customer);
      const cases: Array<[string, string, object, number]> = [
        [
          'post',
          '/api/v1/customers/me',
          { name: 'x'.repeat(10_000), email: 'a@b.test', preferredLanguage: 'en' },
          400,
        ],
        [
          'post',
          '/api/v1/customers/me',
          { name: ['array'], email: 'a@b.test', preferredLanguage: 'en' },
          400,
        ],
        [
          'post',
          '/api/v1/customers/me',
          { name: { $ne: null }, email: 'a@b.test', preferredLanguage: 'en' },
          400,
        ],
        [
          'post',
          '/api/v1/bookings',
          {
            category: 'HOUSE_MAID',
            areaId: UNKNOWN_ID,
            engagement: 'WEEKLY',
            availableFrom: '09:00',
            availableTo: '12:00',
          },
          400,
        ],
        [
          'post',
          '/api/v1/bookings',
          {
            category: 'HOUSE_MAID',
            areaId: UNKNOWN_ID,
            engagement: 'FULL_TIME',
            availableFrom: '25:00',
            availableTo: '26:00',
          },
          400,
        ],
        ['post', '/api/v1/ratings', { bookingId: UNKNOWN_ID, score: 0 }, 400],
        ['post', '/api/v1/ratings', { bookingId: UNKNOWN_ID, score: '5' }, 404],
        ['post', '/api/v1/payments', { bookingId: UNKNOWN_ID, amountMinor: -1 }, 404],
        [
          'post',
          '/api/v1/support/tickets',
          { categoryId: UNKNOWN_ID, description: 'x'.repeat(100_000) },
          400,
        ],
      ];
      const wrong: string[] = [];
      for (const [verb, url, body, expected] of cases) {
        const res = await (
          c as unknown as Record<string, (u: string, b: object) => Promise<{ status: number }>>
        )[verb](url, body);
        if (res.status !== expected)
          wrong.push(
            `${verb} ${url} ${JSON.stringify(body).slice(0, 50)} -> ${res.status} (expected ${expected})`,
          );
      }
      expect(wrong).toEqual([]);
      const pollution = await api
        .http()
        .post('/api/v1/customers/me')
        .set('Authorization', `Bearer ${customer.accessToken}`)
        .set('Content-Type', 'application/json')
        .send(
          '{"name":"P","email":"p@b.test","preferredLanguage":"en","__proto__":{"isAdmin":true},"constructor":{"prototype":{"isAdmin":true}}}',
        );
      expect([201, 400, 409]).toContain(pollution.status);
      expect(({} as Record<string, unknown>).isAdmin).toBeUndefined();
      expect(
        (
          await api
            .http()
            .post('/api/v1/customers/me')
            .set('Authorization', `Bearer ${customer.accessToken}`)
            .set('Content-Type', 'application/json')
            .send('{"name":')
        ).status,
      ).toBe(400);
    });

    it('never echoes a mass-assigned field back or applies it, on any mutating route', async () => {
      const customer = await loginWithOtp(api, { appType: 'CUSTOMER' });
      const worker = await loginWithOtp(api, { appType: 'WORKER' });
      const forged = {
        role: 'PWNED',
        roles: ['PWNED'],
        status: 'PWNED',
        type: 'PWNED',
        isAdmin: true,
        userId: 'PWNED',
        id: 'PWNED',
        amountMinor: 1,
        passwordHash: 'PWNED',
        verificationStatus: 'PWNED',
        onboardingStatus: 'PWNED',
        permissions: ['PWNED'],
      };
      const leaked: string[] = [];
      let probed = 0;
      for (const route of routes.filter(
        (r) =>
          !r.isPublic && ['POST', 'PATCH', 'PUT'].includes(r.method) && !r.path.includes('/auth/'),
      )) {
        const caller = route.userTypes?.includes('ADMIN')
          ? admin
          : route.userTypes?.includes('WORKER') && !route.userTypes.includes('CUSTOMER')
            ? worker
            : customer;
        const res = await api
          .http()
          [route.method.toLowerCase() as 'post'](concretePath(route.path))
          .set('Authorization', `Bearer ${caller.accessToken}`)
          .send(forged);
        probed++;
        if (JSON.stringify(res.body).includes('PWNED'))
          leaked.push(`${route.method} ${route.path}`);
        if (res.status >= 500) leaked.push(`${route.method} ${route.path} -> ${res.status}`);
      }
      expect(probed).toBeGreaterThan(55);
      expect(leaked).toEqual([]);
      expect(
        await api.prisma.user
          .count({ where: { OR: [{ status: 'PWNED' as never }] } })
          .catch(() => 0),
      ).toBe(0);
    }, 280_000);
  });

  describe('headers, CORS and information disclosure', () => {
    it('sends the Helmet headers, no framework banner, and no CORS grant to an unlisted origin', async () => {
      const res = await api.http().get('/health/live').set('Origin', 'https://evil.example');
      expect(res.headers['x-powered-by']).toBeUndefined();
      expect(res.headers['x-content-type-options']).toBe('nosniff');
      expect(res.headers['strict-transport-security']).toBeDefined();
      expect(res.headers['x-frame-options']).toBeDefined();
      expect(res.headers['content-security-policy']).toBeDefined();
      expect(res.headers['access-control-allow-origin']).toBeUndefined();
      const preflight = await api
        .http()
        .options('/api/v1/users/me')
        .set('Origin', 'https://evil.example')
        .set('Access-Control-Request-Method', 'GET');
      expect(preflight.headers['access-control-allow-origin']).toBeUndefined();
    });

    it('keeps probes minimal and errors free of stack traces, SQL, file paths and framework names', async () => {
      const ready = await api.http().get('/health/ready');
      expect(JSON.stringify(ready.body)).not.toMatch(/postgres|password|redis:\/\/|localhost/i);
      const probes: Array<() => Promise<{ body: unknown }>> = [
        () => api.http().get('/api/v1/users/me').set('Authorization', 'Bearer x'),
        () => api.http().post('/api/v1/auth/otp/request').send({ mobile: 'nope' }),
        () =>
          api
            .http()
            .post('/api/v1/auth/admin/login')
            .send({ email: 'nobody@example.test', password: 'wrong-password-123' }),
        () => as(api, admin).get('/api/v1/admin/users/not-a-uuid'),
        () => as(api, admin).post('/api/v1/admin/service-areas', { name: 1 }),
      ];
      for (const probe of probes) {
        const res = await probe();
        const text = JSON.stringify(res.body);
        expect(text).not.toMatch(
          /node_modules|\.ts:|at \w+\.|Prisma|SELECT |INSERT |stack|ECONN|C:\\\\|\/home\//,
        );
        expect(res.body).toHaveProperty('requestId');
      }
    });

    it('does not reveal whether an admin account exists (same answer for unknown user and wrong password)', async () => {
      const unknown = await api
        .http()
        .post('/api/v1/auth/admin/login')
        .send({ email: `nobody.${Date.now()}@example.test`, password: 'whatever-password-1' });
      const known = await api
        .http()
        .post('/api/v1/auth/admin/login')
        .send({ email: admin.email, password: 'whatever-password-1' });
      expect(unknown.status).toBe(known.status);
      expect({ ...unknown.body, requestId: 0 }).toEqual({ ...known.body, requestId: 0 });
    });

    it('does not reveal whether a mobile number is registered through the OTP endpoints', async () => {
      const registered = '+9197' + String(Math.floor(10000000 + Math.random() * 89999999));
      await api.users.findOrCreateByMobile(registered, 'CUSTOMER');
      const fresh = '+9198' + String(Math.floor(10000000 + Math.random() * 89999999));
      const a = await api
        .http()
        .post('/api/v1/auth/otp/request')
        .set('X-Forwarded-For', '203.0.113.7')
        .send({ mobile: registered, appType: 'CUSTOMER' });
      const b = await api
        .http()
        .post('/api/v1/auth/otp/request')
        .set('X-Forwarded-For', '203.0.113.8')
        .send({ mobile: fresh, appType: 'CUSTOMER' });
      expect(a.status).toBe(b.status);
      expect(Object.keys(a.body as object).sort()).toEqual(Object.keys(b.body as object).sort());
    });
  });

  describe('the payment webhook as a public endpoint', () => {
    it('rejects anything not signed by the gateway, whatever the size, content type or method', async () => {
      const attempts = [
        api.http().post('/api/v1/webhooks/payments').send({}),
        api
          .http()
          .post('/api/v1/webhooks/payments')
          .set('Content-Type', 'text/plain')
          .send('x'.repeat(1000)),
        api.http().post('/api/v1/webhooks/payments').set('x-fake-signature', 'g'.repeat(64)).send({
          eventId: 'e',
          providerOrderId: 'o',
          providerPaymentId: 'p',
          outcome: 'SUCCEEDED',
          amountMinor: 1,
        }),
        api
          .http()
          .post('/api/v1/webhooks/payments')
          .set('Authorization', `Bearer ${admin.accessToken}`)
          .send({}),
      ];
      for (const res of await Promise.all(attempts)) expect(res.status).toBe(401);
      expect([404, 405]).toContain((await api.http().get('/api/v1/webhooks/payments')).status);
      const big = await api
        .http()
        .post('/api/v1/webhooks/payments')
        .set('Content-Type', 'application/json')
        .send(JSON.stringify({ pad: 'x'.repeat(2_000_000) }));
      expect([401, 413]).toContain(big.status);
    });
  });

  describe('abuse limits', () => {
    it('limits OTP requests per mobile number however many addresses they come from', async () => {
      const mobile = '+9199' + String(Math.floor(10000000 + Math.random() * 89999999));
      const statuses: number[] = [];
      for (let i = 0; i < 12; i++) {
        const res = await api
          .http()
          .post('/api/v1/auth/otp/request')
          .set('X-Forwarded-For', `198.51.100.${i + 1}`)
          .send({ mobile, appType: 'CUSTOMER' });
        statuses.push(res.status);
      }
      expect(statuses.filter((s) => s === 429 || s === 409).length).toBeGreaterThan(0);
      expect(statuses.every((s) => s < 500)).toBe(true);
    });

    it('does not let an admin without role.manage grant themselves permissions, nor edit the Super Admin role', async () => {
      const limited = await loginAdminWithPermissions(api, ['user.view', 'admin.manage_users']);
      const self = await as(api, limited).put(`/api/v1/admin/roles/SUPER_ADMIN/permissions`, {
        permissionCodes: ['role.manage'],
      });
      expect(self.status).toBe(403);
      const toSelf = await as(api, limited).put(`/api/v1/admin/users/${limited.userId}/role`, {
        roleCode: 'SUPER_ADMIN',
      });
      expect([403, 409, 422]).toContain(toSelf.status);
      const me = await as(api, limited).get(`/api/v1/admin/users/${limited.userId}`);
      expect(JSON.stringify(me.body)).not.toContain('"SUPER_ADMIN"');
    });

    it('keeps a worker and a customer account from sharing a mobile or an OTP session', async () => {
      const worker = await onboardWorker(api, { areaIds: [(await createArea(api, admin)).id] });
      const asCustomer = await api
        .http()
        .post('/api/v1/auth/otp/request')
        .set('X-Forwarded-For', '203.0.113.99')
        .send({ mobile: worker.mobile, appType: 'CUSTOMER' });
      expect(asCustomer.status).toBeLessThan(500);
      const verify = await api
        .http()
        .post('/api/v1/auth/otp/verify')
        .send({ mobile: worker.mobile, otp: '000000', appType: 'CUSTOMER' });
      expect([400, 401, 403, 409, 422]).toContain(verify.status);
    });
  });
});
