import '../support/env-api-integration';
import { ApiApp, createApiApp, loginAdmin, loginWithOtp, unique } from '../support/api-app';
import { ensureFee, inDays, makeBooking } from '../support/bookings';
import { as, createArea, setRequiredChecks } from '../support/workforce';

type Json = Record<string, unknown>;

/**
 * Checks real response bodies against the PUBLISHED OpenAPI schema: every required property is present, no property is undocumented,
 * and each value has the documented type (null only where the schema says nullable). This is what the Flutter team parses against.
 */
function validate(
  schema: Json | undefined,
  value: unknown,
  spec: Json,
  at: string,
  errors: string[],
): void {
  if (!schema) {
    errors.push(`${at}: no schema`);
    return;
  }
  const ref = schema.$ref as string | undefined;
  if (ref) {
    const name = ref.split('/').pop() as string;
    const target = ((spec.components as Json).schemas as Record<string, Json>)[name];
    validate(target, value, spec, at, errors);
    return;
  }
  if (Array.isArray(schema.allOf)) {
    const parts = (schema.allOf as Json[]).map((part) => {
      const r = part.$ref as string | undefined;
      return r
        ? ((spec.components as Json).schemas as Record<string, Json>)[r.split('/').pop() as string]
        : part;
    });
    schema = {
      type: 'object',
      nullable: schema.nullable,
      required: parts.flatMap((p) => (p.required ?? []) as string[]),
      properties: Object.assign({}, ...parts.map((p) => p.properties ?? {})),
    };
  }
  if (value === null) {
    if (schema.nullable !== true) errors.push(`${at}: null but the schema is not nullable`);
    return;
  }
  const type = schema.type as string | undefined;
  if (type === 'array') {
    if (!Array.isArray(value)) return void errors.push(`${at}: expected array`);
    value.forEach((v, i) => validate(schema.items as Json, v, spec, `${at}[${i}]`, errors));
    return;
  }
  if (type === 'object' || schema.properties) {
    if (typeof value !== 'object' || Array.isArray(value))
      return void errors.push(`${at}: expected object`);
    const props = (schema.properties ?? {}) as Record<string, Json>;
    for (const key of (schema.required ?? []) as string[]) {
      if (!(key in (value as Json))) errors.push(`${at}.${key}: required but missing`);
    }
    for (const [key, v] of Object.entries(value as Json)) {
      if (v === undefined) continue;
      if (
        !(key in props) &&
        schema.additionalProperties &&
        typeof schema.additionalProperties === 'object'
      )
        validate(schema.additionalProperties as Json, v, spec, `${at}.${key}`, errors);
      else if (!(key in props)) errors.push(`${at}.${key}: not documented`);
      else validate(props[key], v, spec, `${at}.${key}`, errors);
    }
    return;
  }
  if (type === 'string' && typeof value !== 'string') errors.push(`${at}: expected string`);
  if ((type === 'number' || type === 'integer') && typeof value !== 'number')
    errors.push(`${at}: expected number`);
  if (type === 'boolean' && typeof value !== 'boolean') errors.push(`${at}: expected boolean`);
  const allowed = schema.enum as unknown[] | undefined;
  if (allowed && !allowed.includes(value))
    errors.push(`${at}: ${JSON.stringify(value)} not in enum`);
}

describe('Published OpenAPI matches the real success responses (integration)', () => {
  let api: ApiApp;
  let spec: Json;
  let admin: Awaited<ReturnType<typeof loginAdmin>>;

  beforeAll(async () => {
    api = await createApiApp();
    admin = await loginAdmin(api);
    spec = (await api.http().get('/docs/openapi.json')).body as Json;
  });
  afterAll(async () => {
    await setRequiredChecks(api, admin, []);
    await api.close();
  });

  const check = (template: string, method: string, status: number, body: unknown): string[] => {
    const op = ((spec.paths as Json)[template] as Json | undefined)?.[method] as Json | undefined;
    if (!op) return [`${method} ${template}: not in the OpenAPI document`];
    const response = (op.responses as Record<string, Json>)[String(status)];
    const schema = (
      (response?.content as Json | undefined)?.['application/json'] as Json | undefined
    )?.schema as Json | undefined;
    const errors: string[] = [];
    validate(schema, body, spec, `${method.toUpperCase()} ${template}`, errors);
    return errors;
  };

  it('every customer-app endpoint answers exactly what its schema promises', async () => {
    await setRequiredChecks(api, admin, ['IDENTITY']);
    await ensureFee(api, admin);
    const area = await createArea(api, admin, {
      centerLatitude: 17.45,
      centerLongitude: 78.39,
      radiusMeters: 1500,
    });
    const customer = await loginWithOtp(api, { appType: 'CUSTOMER' });
    const c = as(api, customer);
    const failures: string[] = [];
    const expectShape = async (
      template: string,
      path: string,
      status = 200,
      method: 'get' | 'post' | 'put' | 'patch' = 'get',
      body: object = {},
    ): Promise<Json> => {
      const res = await (method === 'get' ? c.get(path) : c[method](path, body));
      if (res.status !== status)
        failures.push(`${method} ${path}: ${res.status} ${JSON.stringify(res.body).slice(0, 200)}`);
      else failures.push(...check(template, method, status, res.body));
      return res.body as Json;
    };

    await expectShape('/api/v1/customers/me', '/api/v1/customers/me', 201, 'post', {
      name: 'Asha Rao',
      email: `c.${unique()}@example.test`,
      preferredLanguage: 'en',
    });
    await expectShape('/api/v1/customers/me', '/api/v1/customers/me');
    await expectShape(
      '/api/v1/customers/me/addresses',
      '/api/v1/customers/me/addresses',
      201,
      'post',
      {
        label: 'Home',
        line: '1 Main Rd',
        line2: 'Flat 4',
        area: area.name,
        city: area.city,
        state: 'Telangana',
        pincode: '500081',
        isDefault: true,
      },
    );
    await expectShape('/api/v1/customers/me/addresses', '/api/v1/customers/me/addresses');
    await expectShape('/api/v1/service-categories', '/api/v1/service-categories');
    await expectShape('/api/v1/service-areas', '/api/v1/service-areas');
    await expectShape(
      '/api/v1/locations/service-area',
      '/api/v1/locations/service-area?latitude=17.451&longitude=78.391',
    );
    await expectShape('/api/v1/reference-data', '/api/v1/reference-data');
    await expectShape('/api/v1/app-config', '/api/v1/app-config');

    await as(api, admin)
      .put('/api/v1/admin/pricing-guidance', {
        category: 'HOUSE_MAID',
        engagement: 'PART_TIME',
        minMinor: 600000,
        maxMinor: 1000000,
        period: 'MONTH',
        basis: 'Set by SevaNest',
      })
      .expect(200);
    await expectShape(
      '/api/v1/pricing/guidance',
      '/api/v1/pricing/guidance?category=HOUSE_MAID&engagement=PART_TIME',
    );

    const b = await makeBooking(api, admin, customer, area.id, 'MATCHED');
    const workerId = b.worker.workerId;
    await expectShape(
      '/api/v1/search/workers',
      `/api/v1/search/workers?category=HOUSE_MAID&areaId=${area.id}`,
    );
    await expectShape('/api/v1/search/workers/{workerId}', `/api/v1/search/workers/${workerId}`);
    await expectShape(
      '/api/v1/search/workers/{workerId}/ratings',
      `/api/v1/search/workers/${workerId}/ratings`,
    );
    await expectShape(
      '/api/v1/search/workers/{workerId}/slots',
      `/api/v1/search/workers/${workerId}/slots?date=${inDays(1)}`,
    );
    await c.put(`/api/v1/shortlist/${workerId}`).expect(204);
    await expectShape('/api/v1/shortlist', '/api/v1/shortlist');
    await expectShape('/api/v1/bookings', '/api/v1/bookings');
    await expectShape('/api/v1/bookings/{bookingId}', `/api/v1/bookings/${b.id}`);

    const at = new Date(Date.now() + 3 * 86_400_000).toISOString();
    const iv = await expectShape('/api/v1/interviews', '/api/v1/interviews', 201, 'post', {
      bookingId: b.id,
      type: 'INTERVIEW',
      preferredAt: at,
    });
    await expectShape('/api/v1/interviews', '/api/v1/interviews');
    await expectShape('/api/v1/interviews/{interviewId}', `/api/v1/interviews/${iv.id as string}`);
    await expectShape('/api/v1/customers/me/home', '/api/v1/customers/me/home');

    expect(failures).toEqual([]);
  });
});
