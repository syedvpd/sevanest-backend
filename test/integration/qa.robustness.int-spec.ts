import '../support/env-api-integration';
import { ApiApp, bearer, createApiApp, loginAdmin, loginWithOtp } from '../support/api-app';
import { setRequiredChecks } from '../support/workforce';

type Json = Record<string, unknown>;
type Method = 'get' | 'post' | 'put' | 'patch' | 'delete';

const UNKNOWN_ID = '00000000-0000-7000-8000-00000000dead';
const METHODS: Method[] = ['get', 'post', 'put', 'patch', 'delete'];

/**
 * Negative-first sweep over EVERY published route (PRD 13 "graceful failure"): for each caller kind (admin, customer and worker
 * without a profile, anonymous) it sends unknown ids, malformed ids, unusable bodies and abusive paging, and requires that the API
 * never answers 5xx, always answers errors in the standard envelope, and never returns more than the page cap. Every id is
 * random, so no record can be changed; the callers have no profiles, so this also covers "signed in but not onboarded".
 */
describe('Route robustness sweep (integration)', () => {
  let api: ApiApp;
  let admin: Awaited<ReturnType<typeof loginAdmin>>;
  let spec: Json;

  beforeAll(async () => {
    api = await createApiApp();
    admin = await loginAdmin(api);
    spec = (await api.http().get('/docs/openapi.json')).body as Json;
  });
  afterAll(async () => {
    await setRequiredChecks(api, admin, []);
    await api.close();
  });

  it('answers every malformed request with a 4xx in the standard error envelope, for every caller', async () => {
    const customer = await loginWithOtp(api, { appType: 'CUSTOMER' });
    const worker = await loginWithOtp(api, { appType: 'WORKER' });
    const callers: Array<{ name: string; token?: string }> = [
      { name: 'admin', token: bearer(admin) },
      { name: 'customer', token: bearer(customer) },
      { name: 'worker', token: bearer(worker) },
      { name: 'anonymous' },
    ];
    const failures: string[] = [];
    let sent = 0;

    for (const [template, item] of Object.entries(spec.paths as Record<string, Json>)) {
      // Sessions and tokens of the callers must survive the sweep; the OTP routes send messages.
      if (template.includes('/auth/')) continue;
      for (const method of METHODS) {
        const op = item[method] as Json | undefined;
        if (!op) continue;
        const params = ((op.parameters ?? []) as Array<Json>).filter((p) => p.in === 'path');
        const fill = (value: (name: string, enumValues?: string[]) => string): string =>
          template.replace(/\{(\w+)\}/g, (_all, name: string) => {
            const schema = params.find((p) => p.name === name)?.schema as Json | undefined;
            return value(name, schema?.enum as string[] | undefined);
          });
        const urls = [
          fill((_n, e) => e?.[0] ?? UNKNOWN_ID),
          ...(params.length > 0 ? [fill(() => 'not-a-valid-id'), fill(() => '%00')] : []),
        ];
        const bodies: Array<unknown> =
          method === 'get' || method === 'delete' ? [undefined] : [{}, { __probe: 1 }, [], 'text'];

        for (const url of urls) {
          for (const body of bodies) {
            const queries =
              method === 'get' ? ['', '?page=0&limit=100000', '?limit=abc&page=-3'] : [''];
            for (const query of queries) {
              for (const caller of callers) {
                const target = `${url}${query}`;
                let req = api.http()[method](target);
                if (caller.token) req = req.set('Authorization', caller.token);
                if (body !== undefined) {
                  req = req.set('Content-Type', 'application/json');
                  req = req.send(
                    typeof body === 'string' ? JSON.stringify(body) : (body as object),
                  );
                }
                const res = await req;
                sent += 1;
                const label = `${caller.name} ${method.toUpperCase()} ${target} ${body === undefined ? '' : JSON.stringify(body)}`;
                if (res.status >= 500) {
                  failures.push(
                    `5xx ${res.status}: ${label} -> ${JSON.stringify(res.body).slice(0, 160)}`,
                  );
                  continue;
                }
                if (res.status >= 400) {
                  const err = res.body as Json;
                  const type = String(res.headers['content-type'] ?? '');
                  if (!type.startsWith('application/json') || res.headers['content-disposition']) {
                    failures.push(
                      `error content type: ${label} -> ${res.status} ${type} ${String(res.headers['content-disposition'] ?? '')}`,
                    );
                  }
                  if (typeof err.code !== 'string' || typeof err.message !== 'string') {
                    failures.push(
                      `error envelope: ${label} -> ${res.status} ${JSON.stringify(err).slice(0, 160)}`,
                    );
                  }
                } else if (method === 'get' && res.status === 200) {
                  const data = (res.body as Json).data;
                  if (Array.isArray(data) && data.length > 100) {
                    failures.push(`page cap: ${label} returned ${data.length} rows`);
                  }
                }
              }
            }
          }
        }
      }
    }

    expect(sent).toBeGreaterThan(1000);
    expect(failures).toEqual([]);
  }, 900_000);
});
