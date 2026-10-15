#!/usr/bin/env node
/**
 * Builds the Postman collection and environment from the live OpenAPI document (every operation, grouped by module, each module in
 * lifecycle order: create -> list -> read -> update -> state change -> delete).
 * Usage: node scripts/perf/generate-postman.mjs [openapi.json=test/perf/out/openapi.json] [outDir=postman]
 * Get a fresh openapi.json from a running API:  curl http://localhost:3000/docs/openapi.json -o openapi.json   (SWAGGER_ENABLED=true)
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const specPath = process.argv[2] ?? 'test/perf/out/openapi.json';
const outDir = process.argv[3] ?? 'postman';
const spec = JSON.parse(readFileSync(specPath, 'utf8'));
mkdirSync(outDir, { recursive: true });

// ------------------------------------------------------------------------------------------------ helpers
const resolve = (schema) => {
  if (!schema) return {};
  if (schema.$ref) {
    const name = schema.$ref.split('/').pop();
    return resolve(spec.components.schemas[name]);
  }
  return schema;
};

// path-parameter and body-field names that are ids we capture into collection variables
const ID_FIELDS = new Set(['bookingId', 'workerId', 'areaId', 'categoryId', 'addressId', 'customerId', 'requestId', 'interviewId', 'paymentId', 'ratingId', 'ticketId', 'templateId', 'notificationId', 'blockId', 'documentId', 'checkId', 'attendanceId', 'userId', 'sessionId', 'alertId', 'exceptionId', 'eventId', 'photoId']);
const FIELD_VARS = { areaId: 'areaId', categoryId: 'categoryId', workerId: 'workerId', bookingId: 'bookingId', addressId: 'addressId', customerId: 'customerId' };

// Realistic sample values for well-known field names. {{uniqueSuffix}} and {{uniqueMobile}} are regenerated before every request
// (collection pre-request script), so repeated runs never collide on unique fields.
const REAL_VALUES = {
  name: 'Anita Sharma {{uniqueSuffix}}',
  fullName: 'Anita Sharma',
  line: '12-3-45, Road No. 7, Banjara Hills',
  line2: 'Near City Park',
  label: 'Home',
  area: 'Banjara Hills',
  city: 'Hyderabad',
  state: 'Telangana',
  pincode: '500034',
  preferredLanguage: 'en',
  language: 'en',
  reason: 'Postman test {{uniqueSuffix}}',
  note: 'Postman test note {{uniqueSuffix}}',
  description: 'Postman test: the worker did not arrive on time today ({{uniqueSuffix}}).',
  subject: 'Postman test {{uniqueSuffix}}',
  review: 'Punctual and polite.',
  requirementNote: 'Need a part-time cook for two meals a day.',
  outcomeNote: 'Interview went well.',
  contentType: 'image/jpeg',
  category: 'HOUSE_MAID',
  scheduleType: 'INTERVIEW',
  engagement: 'PART_TIME',
  availableFrom: '09:00',
  availableTo: '12:00',
  title: 'Postman test {{uniqueSuffix}}',
  fcmToken: 'postman-device-token-{{uniqueSuffix}}',
  token: 'postman-device-token-{{uniqueSuffix}}',
};
const REAL_NUMBERS = { latitude: 17.4126, longitude: 78.4482, score: 4, sizeBytes: 150000, budgetMinMinor: 600000, budgetMaxMinor: 1000000, amountMinor: 50000 };

const sample = (schema, name = '', depth = 0) => {
  const s = resolve(schema);
  // values that must be unique per run beat the static OpenAPI example
  if (s.type === 'string' || s.type === undefined) {
    if (/email/i.test(name)) return 'tester.{{uniqueSuffix}}@example.test';
    if (/mobile/i.test(name)) return '{{uniqueMobile}}';
    if (name === 'name') return REAL_VALUES.name;
  }
  if (s.example !== undefined) return s.example;
  if (s.enum) return s.enum[0];
  if (s.oneOf || s.anyOf) return sample((s.oneOf ?? s.anyOf)[0], name, depth);
  if (s.allOf) return Object.assign({}, ...s.allOf.map((x) => sample(x, name, depth)));
  switch (s.type) {
    case 'object': {
      if (depth > 4) return {};
      const out = {};
      const required = new Set(s.required ?? []);
      for (const [k, v] of Object.entries(s.properties ?? {})) {
        if (required.has(k) || (depth === 0 && FIELD_VARS[k] && resolve(v).type === 'string')) out[k] = sample(v, k, depth + 1);
      }
      return out;
    }
    case 'array':
      return [sample(s.items, name, depth + 1)];
    case 'integer':
    case 'number':
      return REAL_NUMBERS[name] ?? s.minimum ?? 1;
    case 'boolean':
      return true;
    default: {
      if (FIELD_VARS[name]) return `{{${FIELD_VARS[name]}}}`;
      if (s.format === 'uuid') return `{{${name || 'id'}}}`;
      if (s.format === 'date-time' || /At$/.test(name) || /^(preferredAt|proposedAt|scheduledAt)$/.test(name)) return '{{futureIso}}';
      if (s.format === 'date' || /^(date|startDate|from|to)$/.test(name)) return '{{today}}';
      const real = REAL_VALUES[name];
      if (real !== undefined) return real;
      if (/mobile/i.test(name)) return '{{uniqueMobile}}';
      if (/email/i.test(name)) return 'tester.{{uniqueSuffix}}@example.test';
      if (name === 'password' || /password/i.test(name)) return 'a-long-enough-password-1!';
      if (/^(code|eventCode)$/.test(name)) return 'POSTMAN_{{$randomInt}}';
      return s.minLength && s.minLength > 10 ? 'x'.repeat(s.minLength) : `Postman ${name || 'text'}`;
    }
  }
};

const tokenFor = (path, tags) => {
  if (path.startsWith('/health') || path === '/app-config' || path === '/reference-data' || path.startsWith('/webhooks')) return null;
  if (path.startsWith('/auth/otp') || path === '/auth/admin/login' || path === '/auth/token/refresh') return null;
  if (path.startsWith('/admin')) return 'adminToken';
  if (path.startsWith('/workers/me')) return 'workerToken';
  return 'customerToken';
};

const MODULE_ORDER = ['health', 'App', 'Auth', 'Legal', 'Users', 'Account', 'Admin account', 'Admin - Users', 'Admin - Roles', 'Admin - Service Areas', 'Admin - Service Categories', 'Admin - Verification', 'Admin - Support', 'Admin - Notifications', 'Admin - Payments', 'Customers', 'Worker onboarding', 'Workers', 'Worker photo', 'Worker Availability', 'Verification', 'Admin - Workers', 'Admin - Worker Availability', 'Admin - Customers', 'Service Areas', 'Service Categories', 'Pricing', 'Search', 'Shortlist', 'Bookings', 'Worker bookings', 'Interviews and trials', 'Worker interviews and trials', 'Payments', 'Attendance', 'Admin - Bookings', 'Admin - Interviews and trials', 'Admin - Matching', 'Admin - Attendance', 'Ratings', 'Admin - Ratings', 'Replacements', 'Admin - Replacements', 'Support', 'Safety', 'Admin - Safety', 'Notifications', 'Customer', 'Admin - Alerts', 'Admin - Audit', 'Admin - Account deletion', 'Admin - Reports', 'Admin - Dashboard', 'Admin - System'];
const METHOD_ORDER = { POST: 0, GET: 1, PUT: 2, PATCH: 3, DELETE: 4 };

// the item id a collection path produces, e.g. /bookings -> bookingId (from /bookings/{bookingId})
const paths = Object.keys(spec.paths);
const itemVar = new Map();
for (const p of paths) {
  const m = p.match(/^(.*)\/\{(\w+)\}$/);
  if (m) itemVar.set(m[1], m[2]);
}

const orderKey = (p, method) => `${(p.match(/\{/g) ?? []).length}${p.includes('/{') ? '1' : '0'}${METHOD_ORDER[method]}${p}`;

// ------------------------------------------------------------------------------------------------ requests
const collectionTest = (op, method, path, successCodes) => {
  const capture = [];
  const base = path.replace('/api/v1', '');
  if (itemVar.has(base) && (method === 'POST' || method === 'GET') && !/\{/.test(base)) {
    const v = itemVar.get(base);
    capture.push(`if (json && (json.id || (json.data && json.data[0] && json.data[0].id))) { pm.collectionVariables.set('${v}', json.id || json.data[0].id); }`);
  }
  if (/\/auth\/otp\/verify$/.test(base)) capture.push(`/* tokens are set by the login requests in the Auth folder */`);
  return [
    `const slow = Number(pm.environment.get('slowMs') || 500);`,
    `pm.test('no server error (status ' + pm.response.code + ')', () => pm.expect(pm.response.code).to.be.below(500));`,
    `pm.test('status is a documented success or a business-state answer', () => pm.expect(pm.response.code).to.be.oneOf([${[...successCodes, 400, 401, 403, 404, 409, 422].join(', ')}]));`,
    `pm.test('responds within ' + slow + ' ms', () => pm.expect(pm.response.responseTime).to.be.below(slow));`,
    `let json = null; try { json = pm.response.json(); } catch (e) {}`,
    `pm.test('JSON bodies use the standard envelope', () => { if (json && pm.response.code >= 400) { pm.expect(json).to.have.property('code'); pm.expect(json).to.have.property('requestId'); } });`,
    ...capture,
  ].join('\n');
};

const buildRequest = (path, method, op) => {
  const token = tokenFor(path.replace('/api/v1', ''), op.tags);
  const rel = path.replace('/api/v1', '').replace(/\{(\w+)\}/g, (_m, k) => `{{${k === 'id' ? 'pricingBandId' : k}}}`);
  const query = (op.parameters ?? []).filter((p) => p.in === 'query' && p.required).map((p) => ({ key: p.name, value: String(sample(p.schema, p.name)) }));
  for (const p of op.parameters ?? []) if (p.in === 'query' && !p.required && ['limit'].includes(p.name)) query.push({ key: 'limit', value: '20' });
  const prefix = path.startsWith('/health') ? '' : '/api/v1';
  const request = {
    method,
    header: [
      ...(token ? [{ key: 'Authorization', value: `Bearer {{${token}}}` }] : []),
      ...(method !== 'GET' && method !== 'DELETE' ? [{ key: 'Content-Type', value: 'application/json' }] : []),
      ...(/^(\/bookings|\/payments|\/ratings)/.test(path.replace('/api/v1', '')) && method === 'POST' ? [{ key: 'Idempotency-Key', value: '{{$guid}}' }] : []),
    ],
    url: { raw: `{{baseUrl}}${prefix}${rel}${query.length ? '?' + query.map((q) => `${q.key}=${q.value}`).join('&') : ''}`, host: ['{{baseUrl}}'], path: [...prefix.split('/').filter(Boolean), ...rel.split('/').filter(Boolean)], query },
    description: [op.summary, op.description].filter(Boolean).join('\n\n'),
  };
  const content = op.requestBody?.content?.['application/json'];
  if (content) request.body = { mode: 'raw', raw: JSON.stringify(sample(content.schema), null, 2), options: { raw: { language: 'json' } } };
  const codes = Object.keys(op.responses ?? {}).filter((c) => /^2/.test(c)).map(Number);
  return { name: `${method} ${path.replace('/api/v1', '')}`, event: [{ listen: 'test', script: { type: 'text/javascript', exec: collectionTest(op, method, path, codes.length ? codes : [200]).split('\n') } }], request };
};

const ops = [];
for (const [path, item] of Object.entries(spec.paths)) {
  for (const [method, op] of Object.entries(item)) {
    if (METHOD_ORDER[method.toUpperCase()] === undefined) continue;
    ops.push({ path, method: method.toUpperCase(), op, tag: (op.tags ?? ['Other'])[0] });
  }
}
const folders = new Map();
for (const o of ops) {
  if (!folders.has(o.tag)) folders.set(o.tag, []);
  folders.get(o.tag).push(o);
}
const tagOrder = [...MODULE_ORDER.filter((t) => folders.has(t)), ...[...folders.keys()].filter((t) => !MODULE_ORDER.includes(t))];

// ------------------------------------------------------------------------------------------------ sign-in requests (variables for everything else)
const login = (name, path, body, exec) => ({
  name,
  event: [{ listen: 'test', script: { type: 'text/javascript', exec } }],
  request: { method: 'POST', header: [{ key: 'Content-Type', value: 'application/json' }, { key: 'X-Forwarded-For', value: '10.{{$randomInt}}.{{$randomInt}}.{{$randomInt}}' }], url: { raw: `{{baseUrl}}/api/v1${path}`, host: ['{{baseUrl}}'], path: ['api', 'v1', ...path.split('/').filter(Boolean)] }, body: { mode: 'raw', raw: JSON.stringify(body, null, 2), options: { raw: { language: 'json' } } } },
});
const otpVerify = (who, mobileVar, tokenVar) =>
  login(`POST /auth/otp/verify (${who})`, '/auth/otp/verify', { mobile: `{{${mobileVar}}}`, appType: who.toUpperCase(), otp: '{{testOtpCode}}' }, [
    `pm.test('signed in', () => pm.expect(pm.response.code).to.equal(200));`,
    `const j = pm.response.json(); pm.collectionVariables.set('${tokenVar}', j.accessToken); pm.collectionVariables.set('${tokenVar.replace('Token', 'RefreshToken')}', j.refreshToken);`,
  ]);
const otpRequest = (who, mobileVar) =>
  login(`POST /auth/otp/request (${who})`, '/auth/otp/request', { mobile: `{{${mobileVar}}}`, appType: who.toUpperCase() }, [`pm.test('OTP accepted (staging/dev test login)', () => pm.expect(pm.response.code).to.be.oneOf([200, 429]));`]);

const start = {
  name: '00 Start here: sign in and variables',
  description: 'Run this folder first. It sets customerToken, workerToken and adminToken. OTP login uses the staging/dev test login (ALLOW_TEST_OTP): put your own test numbers and code in the environment. Admin login needs adminEmail and adminPassword in the environment.',
  item: [
    {
      name: 'Pre-request: dates',
      event: [{ listen: 'prerequest', script: { type: 'text/javascript', exec: ["const d = new Date(); pm.collectionVariables.set('today', d.toISOString().slice(0, 10)); pm.collectionVariables.set('futureIso', new Date(Date.now() + 2 * 86400000).toISOString());"] } }],
      request: { method: 'GET', url: { raw: '{{baseUrl}}/health/live', host: ['{{baseUrl}}'], path: ['health', 'live'] } },
    },
    otpRequest('customer', 'customerMobile'),
    otpVerify('customer', 'customerMobile', 'customerToken'),
    otpRequest('worker', 'workerMobile'),
    otpVerify('worker', 'workerMobile', 'workerToken'),
    login('POST /auth/admin/login', '/auth/admin/login', { email: '{{adminEmail}}', password: '{{adminPassword}}' }, [`pm.test('admin signed in', () => pm.expect(pm.response.code).to.equal(200));`, `pm.collectionVariables.set('adminToken', pm.response.json().accessToken);`]),
  ],
};

const collection = {
  info: { name: 'SevaNest Backend API', description: `All ${ops.length} operations of the SevaNest API (OpenAPI generated). Folders follow the module lifecycle (create, list, read, update, state change, delete). Ids are captured into collection variables by the tests of create/list requests. Each request checks: no 5xx, a documented status or a business-state answer (404/409/422), response time under slowMs, the standard error envelope.\n\nOrder: run "00 Start here" first, then the module folders from top to bottom. Some operations only succeed once earlier state exists (for example a booking must be ACTIVE before attendance); a 409/422 there is an accepted answer.`, schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json' },
  event: [
    {
      listen: 'prerequest',
      script: {
        type: 'text/javascript',
        exec: [
          "const d = new Date(); const c = pm.collectionVariables;",
          "c.set('today', d.toISOString().slice(0, 10));",
          "c.set('futureIso', new Date(Date.now() + 2 * 86400000).toISOString());",
          "c.set('uniqueSuffix', Date.now().toString(36) + Math.floor(Math.random() * 1e4));",
          "c.set('uniqueMobile', '9' + String(Math.floor(Math.random() * 1e9)).padStart(9, '0'));",
        ],
      },
    },
  ],
  variable: [{ key: 'today', value: '' }, { key: 'futureIso', value: '' }, { key: 'uniqueSuffix', value: '' }, { key: 'uniqueMobile', value: '' }],
  item: [start, ...tagOrder.map((tag) => ({ name: tag, item: folders.get(tag).sort((a, b) => orderKey(a.path, a.method).localeCompare(orderKey(b.path, b.method))).map((o) => buildRequest(o.path, o.method, o.op)) }))],
};

const makeEnvironment = (name, baseUrl, slowMs) => ({
  name,
  values: [
    ['baseUrl', baseUrl],
    ['customerMobile', '+919999900001'],
    ['workerMobile', '+919999900002'],
    ['testOtpCode', '123456'],
    ['adminEmail', ''],
    ['adminPassword', ''],
    ['slowMs', slowMs],
  ].map(([key, value]) => ({ key, value, type: key === 'adminPassword' ? 'secret' : 'default', enabled: true })),
  _postman_variable_scope: 'environment',
});

writeFileSync(join(outDir, 'SevaNest.postman_collection.json'), JSON.stringify(collection, null, 2));
writeFileSync(join(outDir, 'SevaNest.local.postman_environment.json'), JSON.stringify(makeEnvironment('SevaNest local', 'http://localhost:3000', '500'), null, 2));
// Render staging: a free instance sleeps and answers slowly after idle, so the time limit is generous.
writeFileSync(join(outDir, 'SevaNest.render.postman_environment.json'), JSON.stringify(makeEnvironment('SevaNest Render', 'https://sevanest-backend.onrender.com', '8000'), null, 2));
console.log(`postman: ${ops.length} operations in ${tagOrder.length} folders`);
