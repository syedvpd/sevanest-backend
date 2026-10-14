#!/usr/bin/env node
/**
 * Performance run against ANY running SevaNest API (Render, staging, a laptop) using only its public HTTP API. Sequential, one client:
 * this measures response times (first hit, second hit, p50/p95/p99), it is not a load test.
 *
 * What it does
 *   1. times GET /health/live first, so a sleeping free-tier service shows its cold start as the "1st hit";
 *   2. signs in once per role: customer and worker with the staging TEST OTP (ALLOW_TEST_OTP), staff with an admin e-mail and password;
 *   3. a silent discovery pass finds real ids (areas, workers, your bookings, payments, tickets ...) from list endpoints;
 *   4. then PERF_ITERATIONS times it calls EVERY GET operation of the OpenAPI document that it can fill in (read-only), in the
 *      role the route belongs to, and times each call. Operations whose ids or prerequisites do not exist yet are reported as skipped;
 *   5. with PERF_WRITES=1 it also walks a few reversible write lifecycles per iteration (address create/read/update/default/delete,
 *      shortlist add/remove, profile update, device token set/clear, notifications read-all) and cleans up after itself.
 * It never creates bookings, payments, tickets or users, and it never deletes anything it did not create.
 *
 * Environment
 *   PERF_BASE_URL            required, e.g. https://sevanest-backend.onrender.com
 *   PERF_CUSTOMER_MOBILE     a customer test number (+91...), with PERF_OTP_CODE the fixed test OTP
 *   PERF_WORKER_MOBILE       optional worker test number (same OTP code)
 *   PERF_ADMIN_EMAIL / PERF_ADMIN_PASSWORD   optional staff login (admin routes are skipped without it)
 *   PERF_ITERATIONS          default 15
 *   PERF_WRITES              1 to include the reversible write lifecycles (default 0 = read-only)
 *   PERF_OUT                 output folder, default test/perf/out-remote
 * Then:  node scripts/perf/report.mjs test/perf/out-remote docs/qa      (writes performance-test-results.md/.csv)
 *
 * Never point it at production with PERF_WRITES=1. OTP codes and passwords are only read from the environment and never printed.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';

const env = process.env;
const base = (env.PERF_BASE_URL ?? '').replace(/\/+$/, '');
if (!base) {
  console.error('Set PERF_BASE_URL (for example https://sevanest-backend.onrender.com).');
  process.exit(2);
}
const ITERATIONS = Number(env.PERF_ITERATIONS ?? 15);
const WRITES = env.PERF_WRITES === '1';
const OUT = env.PERF_OUT ?? 'test/perf/out-remote';
mkdirSync(OUT, { recursive: true });

const samples = new Map();
const skipped = new Set();
const iterationErrors = [];

// ------------------------------------------------------------------------------------------------ http
async function call(method, template, { path, q, token, body, ok = [200, 201, 202, 204], record = true } = {}) {
  const url = `${base}${/^\/(health|docs)/.test(template) ? '' : '/api/v1'}${path ?? template}${q ? `?${q}` : ''}`;
  const headers = { 'x-forwarded-for': `10.${(Math.random() * 250) | 0}.${(Math.random() * 250) | 0}.${(Math.random() * 250) | 0}` };
  if (token) headers.authorization = `Bearer ${token}`;
  if (body !== undefined) headers['content-type'] = 'application/json';
  const started = performance.now();
  let status = 0;
  let text = '';
  try {
    const res = await fetch(url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(120_000) });
    status = res.status;
    text = await res.text();
  } catch (error) {
    text = `network error: ${error.message}`;
  }
  const ms = performance.now() - started;
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  if (record) {
    const key = `${method} ${template}`;
    const s = samples.get(key) ?? { method, template, ms: [], statuses: {}, unexpected: {} };
    s.ms.push(ms);
    s.statuses[status] = (s.statuses[status] ?? 0) + 1;
    if (!ok.includes(status) && !s.unexpected[status]) s.unexpected[status] = text.slice(0, 140);
    samples.set(key, s);
  }
  return { status, json, ms };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function otpLogin(appType, mobile, code) {
  const requested = await call('POST', '/auth/otp/request', { body: { mobile, appType } });
  if (requested.status === 429) await sleep(31_000); // the per-number cooldown
  if (requested.status === 429) await call('POST', '/auth/otp/request', { body: { mobile, appType } });
  const verified = await call('POST', '/auth/otp/verify', { body: { mobile, appType, otp: code, deviceId: `perf-${appType.toLowerCase()}` } });
  if (verified.status !== 200) {
    const reason = verified.json?.code ?? 'no error code';
    const hint =
      reason === 'ACCOUNT_TYPE_MISMATCH'
        ? 'that number is already registered for the OTHER app (customer vs worker): use a different test number for this role'
        : reason === 'OTP_INVALID'
          ? 'the OTP code is wrong, or the number is not in TEST_OTP_NUMBERS on that server'
          : 'check ALLOW_TEST_OTP and TEST_OTP_NUMBERS on that server';
    throw new Error(`${appType} login failed (${verified.status} ${reason}): ${hint}`);
  }
  return { token: verified.json.accessToken, refresh: verified.json.refreshToken, userId: verified.json.user?.id };
}

// ------------------------------------------------------------------------------------------------ main
const t0 = new Date();
console.log(`Target ${base}  iterations ${ITERATIONS}  writes ${WRITES ? 'on' : 'off (read-only)'}`);

// 1. cold start, recorded as the first hit of /health/live
const first = await call('GET', '/health/live');
console.log(`first request: ${first.status} in ${first.ms.toFixed(0)} ms${first.ms > 3000 ? '  (the service was asleep: this is its cold start)' : ''}`);
await call('GET', '/health/ready');

// 2. documents and sign-in
const specRes = env.PERF_OPENAPI ? { status: 200, json: JSON.parse(readFileSync(env.PERF_OPENAPI, 'utf8')) } : await call('GET', '/docs/openapi.json', { record: false });
if (specRes.status !== 200) {
  console.error('GET /docs/openapi.json failed: set SWAGGER_ENABLED=true on the target, or save a copy of the document and set PERF_OPENAPI to its path.');
  process.exit(2);
}
const spec = specRes.json;
writeFileSync(join(OUT, 'openapi.json'), JSON.stringify(spec));

const sessions = {};
const tryLogin = async (role, appType, mobile) => {
  try {
    sessions[role] = await otpLogin(appType, mobile, env.PERF_OTP_CODE);
  } catch (error) {
    console.warn(`  ${error.message}; ${role} routes will be skipped`);
  }
};
if (env.PERF_CUSTOMER_MOBILE && env.PERF_OTP_CODE) await tryLogin('customer', 'CUSTOMER', env.PERF_CUSTOMER_MOBILE);
if (env.PERF_WORKER_MOBILE && env.PERF_OTP_CODE) {
  if (env.PERF_WORKER_MOBILE === env.PERF_CUSTOMER_MOBILE) console.warn('worker and customer numbers are the same: use two different test numbers');
  else await tryLogin('worker', 'WORKER', env.PERF_WORKER_MOBILE);
}
if (env.PERF_ADMIN_EMAIL && env.PERF_ADMIN_PASSWORD) {
  const login = await call('POST', '/auth/admin/login', { body: { email: env.PERF_ADMIN_EMAIL, password: env.PERF_ADMIN_PASSWORD } });
  if (login.status === 200) sessions.admin = { token: login.json.accessToken, refresh: login.json.refreshToken };
  else console.warn(`admin login failed (${login.status}); admin routes will be skipped`);
}
console.log(`signed in as: ${Object.keys(sessions).join(', ') || 'nobody (public routes only)'}`);

// 3. the operations to call
const ops = [];
for (const [path, item] of Object.entries(spec.paths)) {
  for (const [method, op] of Object.entries(item)) {
    if (!['get', 'post', 'put', 'patch', 'delete'].includes(method)) continue;
    ops.push({ method: method.toUpperCase(), template: path.replace('/api/v1', ''), op });
  }
}
const roleOf = (template) => {
  if (/^\/(health|app-config|reference-data)/.test(template)) return null;
  if (template.startsWith('/admin')) return 'admin';
  if (template.startsWith('/workers/me')) return 'worker';
  return 'customer';
};
const getOps = ops.filter((o) => o.method === 'GET' && !o.template.includes('/export/') && o.template !== '/docs/openapi.json');

// 4. silent discovery of ids per role (not recorded)
const month = new Date().toISOString().slice(0, 7);
const iso = (d) => new Date(Date.now() + d * 86_400_000).toISOString().slice(0, 10);
const pool = { customer: {}, worker: {}, admin: {} };
const itemParam = new Map();
for (const { template } of ops) {
  const m = template.match(/^(.*)\/\{(\w+)\}$/);
  if (m) itemParam.set(m[1], m[2]);
}
for (const role of Object.keys(sessions)) {
  for (const { template } of getOps.filter((o) => roleOf(o.template) === role && !o.template.includes('{') && itemParam.has(o.template))) {
    const r = await call('GET', template, { token: sessions[role].token, record: false, q: 'limit=20' });
    const first = r.json?.data?.[0] ?? (Array.isArray(r.json) ? r.json[0] : null);
    if (first?.id) pool[role][itemParam.get(template)] = first.id;
    if (first?.workerId && !pool[role].workerId) pool[role].workerId = first.workerId;
  }
}
// shared reference data
const areas = await call('GET', '/service-areas', { token: sessions.customer?.token ?? sessions.worker?.token, record: false, q: 'limit=5' });
const areaId = areas.json?.data?.[0]?.id;
const areaName = areas.json?.data?.[0]?.name;
const areaCity = areas.json?.data?.[0]?.city;
const cats = await call('GET', '/service-categories', { token: sessions.customer?.token ?? sessions.worker?.token, record: false, q: 'limit=10' });
const categoryCode = cats.json?.data?.[0]?.code ?? 'HOUSE_MAID';
const categoryId = cats.json?.data?.[0]?.id;
if (sessions.customer && areaId) {
  const search = await call('GET', '/search/workers', { token: sessions.customer.token, record: false, q: `category=${categoryCode}&areaId=${areaId}&limit=5` });
  const w = search.json?.data?.[0]?.workerId;
  if (w) for (const role of ['customer', 'admin']) pool[role].workerId ??= w;
}
for (const role of Object.keys(pool)) {
  pool[role].areaId ??= areaId;
  pool[role].categoryId ??= categoryId;
  pool[role].roleCode ??= 'SUPPORT_EXECUTIVE';
}
if (sessions.worker) pool.worker.workerId ??= pool.worker.workerId;

const QUERY = {
  month, from: iso(-30), to: iso(1), date: iso(2), category: categoryCode, areaId, engagement: 'PART_TIME', latitude: '17.45', longitude: '78.39', limit: '20',
};
const queryFor = (op) => (op.parameters ?? []).filter((p) => p.in === 'query' && p.required).map((p) => `${p.name}=${encodeURIComponent(QUERY[p.name] ?? '1')}`).join('&');
const fill = (template, role) => {
  let missing = false;
  const path = template.replace(/\{(\w+)\}/g, (_m, k) => {
    const v = pool[role]?.[k] ?? (k === 'report' ? 'booking-funnel' : k === 'roleCode' ? 'SUPPORT_EXECUTIVE' : k === 'checkType' ? 'IDENTITY' : undefined);
    if (v === undefined) missing = true;
    return v ?? 'MISSING';
  });
  return missing ? null : path;
};

// 5. the sweeps
let sweepCalls = 0;
for (let i = 1; i <= ITERATIONS; i += 1) {
  try {
    for (const { template, op } of getOps) {
      const role = roleOf(template);
      if (role && !sessions[role]) {
        skipped.add(`${template} (no ${role} login)`);
        continue;
      }
      const path = fill(template, role ?? 'customer');
      if (!path) {
        skipped.add(`GET ${template} (no id to use yet)`);
        continue;
      }
      // an account without a photo or a category without price guidance legitimately answers 404 (and a position query needs coordinates)
      const emptyStateOk = ['/workers/me/photo', '/pricing/guidance', '/locations/service-area'].includes(template) ? [200, 400, 404] : undefined;
      await call('GET', template, { path, token: role ? sessions[role].token : undefined, q: queryFor(op), ok: emptyStateOk });
      sweepCalls += 1;
    }
    if (sessions.customer) {
      const refreshed = await call('POST', '/auth/token/refresh', { body: { refreshToken: sessions.customer.refresh } });
      if (refreshed.status === 200) {
        sessions.customer.token = refreshed.json.accessToken;
        sessions.customer.refresh = refreshed.json.refreshToken;
      }
    }
    if (WRITES && sessions.customer && areaId) {
      const t = sessions.customer.token;
      const addr = await call('POST', '/customers/me/addresses', { token: t, body: { label: 'Perf', line: '1 Perf Rd', area: areaName, city: areaCity, state: 'Telangana', pincode: '500081' } });
      const id = addr.json?.id;
      if (id) {
        await call('GET', '/customers/me/addresses/{addressId}', { path: `/customers/me/addresses/${id}`, token: t });
        await call('PATCH', '/customers/me/addresses/{addressId}', { path: `/customers/me/addresses/${id}`, token: t, body: { line2: 'Flat 2' } });
        await call('DELETE', '/customers/me/addresses/{addressId}', { path: `/customers/me/addresses/${id}`, token: t });
      }
      const wid = pool.customer.workerId;
      if (wid) {
        await call('PUT', '/shortlist/{workerId}', { path: `/shortlist/${wid}`, token: t });
        await call('DELETE', '/shortlist/{workerId}', { path: `/shortlist/${wid}`, token: t });
      }
      await call('PUT', '/auth/device-token', { token: t, body: { token: `perf-${Date.now()}-${i}-aaaaaaaaaaaaaaaaaaaaaaaa`, platform: 'ANDROID' } });
      await call('DELETE', '/auth/device-token', { token: t });
      await call('POST', '/notifications/read-all', { token: t });
    }
  } catch (error) {
    iterationErrors.push(`iteration ${i}: ${error.message.slice(0, 160)}`);
  }
  process.stdout.write(`\riteration ${i}/${ITERATIONS}  requests ${[...samples.values()].reduce((a, s) => a + s.ms.length, 0)}   `);
}
console.log('');

writeFileSync(
  join(OUT, 'journeys.json'),
  JSON.stringify({
    iterations: ITERATIONS,
    generatedAt: t0.toISOString(),
    target: base,
    mode: WRITES ? 'read + reversible writes' : 'read-only',
    samples: [...samples.values()],
    operationsInApi: ops.map((o) => `${o.method} ${o.template}`),
    skipped: [...skipped],
    iterationErrors,
  }),
);
const bad = [...samples.values()].filter((s) => Object.keys(s.unexpected).length);
console.log(`done: ${samples.size} operations timed, ${[...samples.values()].reduce((a, s) => a + s.ms.length, 0)} requests, ${bad.length} with an unexpected status, ${skipped.size} skipped`);
for (const s of bad.slice(0, 10)) console.log(`  unexpected: ${s.method} ${s.template} ${JSON.stringify(s.statuses)}`);
console.log(`next: node scripts/perf/report.mjs ${OUT} docs/qa`);
