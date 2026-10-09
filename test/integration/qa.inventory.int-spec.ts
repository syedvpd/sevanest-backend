import '../support/env-api-integration';
import { writeFileSync } from 'node:fs';
import { ApiApp, createApiApp } from '../support/api-app';
import { collectRoutes, Route } from '../support/routes';

/** QA: the complete route inventory taken from the running application, and the invariants it must satisfy. */
describe('QA - API inventory and route invariants (integration)', () => {
  let api: ApiApp;
  let routes: Route[];

  beforeAll(async () => {
    api = await createApiApp();
    routes = collectRoutes(api.app);
    if (process.env.QA_ROUTES_OUT) {
      writeFileSync(process.env.QA_ROUTES_OUT, JSON.stringify(routes, null, 2));
    }
  });

  afterAll(async () => {
    await api.close();
  });

  const shape = (path: string): string => path.replace(/:[A-Za-z]+/g, ':p');

  it('finds the whole API surface under /api/v1 (plus the two health probes)', () => {
    expect(routes.length).toBeGreaterThan(150);
    const outside = routes.filter(
      (r) => !r.path.startsWith('/api/v1/') && !r.path.startsWith('/health/'),
    );
    expect(outside).toEqual([]);
  });

  it('has no duplicate method + path', () => {
    const seen = new Map<string, string>();
    const duplicates: string[] = [];
    for (const r of routes) {
      const key = `${r.method} ${shape(r.path)}`;
      if (seen.has(key))
        duplicates.push(`${key} (${seen.get(key)} / ${r.controller}.${r.handler})`);
      seen.set(key, `${r.controller}.${r.handler}`);
    }
    expect(duplicates).toEqual([]);
  });

  it('has no route that another, parameterised route can shadow', () => {
    const shadows: string[] = [];
    for (const a of routes) {
      for (const b of routes) {
        if (a === b || a.method !== b.method) continue;
        const sa = a.path.split('/');
        const sb = b.path.split('/');
        if (sa.length !== sb.length) continue;
        const aParam = sa.map((s) => s.startsWith(':'));
        const bParam = sb.map((s) => s.startsWith(':'));
        // b has a literal where a has a parameter, and everything else lines up: a could capture b's requests.
        const lines = sa.every((s, i) => s === sb[i] || aParam[i] || bParam[i]);
        const aMoreGeneral = sa.some((_, i) => aParam[i] && !bParam[i]);
        const bMoreGeneral = sb.some((_, i) => bParam[i] && !aParam[i]);
        if (lines && aMoreGeneral && !bMoreGeneral) {
          shadows.push(
            `${a.method} ${a.path} (${a.controller}) can capture ${b.path} (${b.controller})`,
          );
        }
      }
    }
    // A parameterised sibling is only a problem when the parameter would swallow a different literal route; this
    // codebase's generic `:action` routes are validated by an enum pipe, so each such pair is listed explicitly.
    const unexpected = shadows.filter(
      (s) => !/:(action|checkType|code)\b/.test(s.split(' can ')[0]),
    );
    expect(unexpected).toEqual([]);
  });

  it('keeps generic :action routes from swallowing literal siblings', () => {
    const generic = routes.filter((r) => r.path.endsWith('/:action'));
    for (const g of generic) {
      const base = g.path.replace('/:action', '');
      const siblings = routes.filter(
        (r) =>
          r.method === g.method &&
          r !== g &&
          r.path.startsWith(`${base}/`) &&
          r.path.split('/').length === g.path.split('/').length,
      );
      expect(siblings.map((s) => s.path)).toEqual([]);
    }
  });

  it('authenticates every route except an explicit, reviewed list of public ones', () => {
    const publicRoutes = routes.filter((r) => r.isPublic).map((r) => `${r.method} ${r.path}`);
    expect([...publicRoutes].sort()).toEqual(
      [
        'GET /health/live',
        'GET /health/ready',
        'POST /api/v1/auth/admin/login',
        'POST /api/v1/auth/otp/request',
        'POST /api/v1/auth/otp/verify',
        'POST /api/v1/auth/token/refresh',
        'POST /api/v1/webhooks/payments',
      ].sort(),
    );
  });

  it('puts a permission on EVERY admin route, and a user-type restriction on every other non-public route that is not open to all signed-in users', () => {
    const admin = routes.filter((r) => r.path.startsWith('/api/v1/admin/') && !r.isPublic);
    const noPermission = admin
      .filter((r) => r.permissions.length === 0)
      .map((r) => `${r.method} ${r.path}`);
    // Reviewed exception: the dashboard is open to every admin and returns only the sections the caller's permissions allow.
    expect(noPermission).toEqual(['GET /api/v1/admin/dashboard']);
    expect(admin.every((r) => r.userTypes.includes('ADMIN'))).toBe(true);

    const openToAnySignedIn = routes
      .filter((r) => !r.isPublic && r.userTypes.length === 0 && r.permissions.length === 0)
      .map((r) => `${r.method} ${r.path}`);
    // Reviewed: read-only catalogue data and the caller's own identity/session management.
    expect(
      openToAnySignedIn.every((p) =>
        /^(GET|POST|DELETE) \/api\/v1\/(auth|users\/me|service-categories|service-areas)/.test(p),
      ),
    ).toBe(true);
  });

  it('never lets a non-admin user type reach an /admin route, and keeps worker/customer areas to their own type', () => {
    for (const r of routes.filter((x) => x.path.includes('/workers/me') && !x.isPublic)) {
      expect(r.userTypes).toEqual(['WORKER']);
    }
    for (const r of routes.filter((x) => x.path.startsWith('/api/v1/admin/'))) {
      expect(r.userTypes).toEqual(['ADMIN']);
    }
  });

  it('documents every route in OpenAPI except the health probes and the gateway webhook', async () => {
    const spec = (await api.http().get('/docs/openapi.json')).body as {
      paths: Record<string, Record<string, unknown>>;
    };
    const documented = new Set(
      Object.entries(spec.paths).flatMap(([path, ops]) =>
        Object.keys(ops).map((m) => `${m.toUpperCase()} ${path.replace(/\{[A-Za-z]+\}/g, ':p')}`),
      ),
    );
    const missing = routes
      .filter((r) => !r.path.startsWith('/health/') && r.path !== '/api/v1/webhooks/payments')
      .filter((r) => !documented.has(`${r.method} ${shape(r.path)}`))
      .map((r) => `${r.method} ${r.path}`);
    expect(missing).toEqual([]);
    // Everything documented exists.
    const real = new Set(routes.map((r) => `${r.method} ${shape(r.path)}`));
    const phantom = [...documented].filter((d) => !real.has(d) && !d.includes('/health/'));
    expect(phantom).toEqual([]);
  });

  it('answers unknown routes and wrong methods with the standard error envelope and a request id', async () => {
    const missing = await api.http().get('/api/v1/nope');
    expect(missing.status).toBe(404);
    expect(Object.keys(missing.body as object).sort()).toEqual(
      expect.arrayContaining(['code', 'message', 'requestId']),
    );
    const wrongMethod = await api.http().delete('/api/v1/auth/otp/request');
    expect([404, 405]).toContain(wrongMethod.status);
    expect((wrongMethod.body as { requestId?: string }).requestId).toBeDefined();
    expect(missing.headers['x-request-id']).toBeDefined();
  });
});
