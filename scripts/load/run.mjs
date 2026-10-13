// Local load driver for the SevaNest API. It talks HTTP to a server you started yourself and signs its own access tokens with the SAME
// JWT secret, using sessions it inserts into the (local, disposable) database. NEVER point it at Supabase or Render.
//
//   LOAD_DATABASE_URL=postgresql://...  JWT_ACCESS_SECRET=...  BASE_URL=http://localhost:3100  \
//   STAGES=50:30,200:30  node scripts/load/run.mjs
//
// STAGES is a comma list of concurrency:seconds. Output: per scenario count, errors, p50/p95/p99, plus overall requests per second.
import { createHmac, randomUUID, randomBytes } from 'node:crypto';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { Client } = require('pg');

const BASE = process.env.BASE_URL ?? 'http://localhost:3100';
const DB = process.env.LOAD_DATABASE_URL;
const SECRET = process.env.JWT_ACCESS_SECRET;
const STAGES = (process.env.STAGES ?? '50:30,200:30')
  .split(',')
  .map((s) => s.split(':').map(Number));
const TOKEN_USERS = Number(process.env.TOKEN_USERS ?? 3000);
const WORKER_TOKENS = Number(process.env.WORKER_TOKENS ?? 500);
if (!DB || !SECRET) throw new Error('LOAD_DATABASE_URL and JWT_ACCESS_SECRET are required');
if (/supabase|render\.com|amazonaws/i.test(DB))
  throw new Error('refusing to run against a hosted database');

const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
function sign(sub, sid) {
  const now = Math.floor(Date.now() / 1000);
  const head = b64({ alg: 'HS256', typ: 'JWT' });
  const body = b64({
    sub,
    sid,
    iss: 'sevanest-api',
    aud: 'sevanest-clients',
    iat: now,
    exp: now + 3600,
  });
  const sig = createHmac('sha256', SECRET).update(`${head}.${body}`).digest('base64url');
  return `${head}.${body}.${sig}`;
}

const db = new Client({ connectionString: DB });
await db.connect();
async function tokensFor(type, limit) {
  const users = (
    await db.query(
      `SELECT id FROM users WHERE type = $1 AND status = 'ACTIVE' ORDER BY id LIMIT $2`,
      [type, limit],
    )
  ).rows;
  const out = [];
  for (const u of users) {
    const sid = randomUUID();
    await db.query(
      `INSERT INTO sessions (id, user_id, refresh_token_hash, expires_at, created_at) VALUES ($1, $2, $3, now() + interval '1 day', now())`,
      [sid, u.id, randomBytes(24).toString('hex')],
    );
    out.push({ userId: u.id, token: sign(u.id, sid) });
  }
  return out;
}
const customers = await tokensFor('CUSTOMER', TOKEN_USERS);
const workers = await tokensFor('WORKER', WORKER_TOKENS);
const areas = (await db.query(`SELECT id FROM service_areas WHERE city = 'Hyderabad'`)).rows.map(
  (r) => r.id,
);
const workerIds = (
  await db.query(
    `SELECT wp.id FROM worker_profiles wp JOIN worker_verification_checks vc ON vc.worker_id = wp.id AND vc.status = 'APPROVED' ORDER BY wp.id LIMIT 500`,
  )
).rows.map((r) => r.id);
await db.end();

const pick = (a) => a[Math.floor(Math.random() * a.length)];
const ENG = ['PART_TIME', 'FULL_TIME', 'HOURLY', 'DAILY'];
const day = new Date(Date.now() + 2 * 86_400_000).toISOString().slice(0, 10);
const SCENARIOS = [
  {
    name: 'search',
    weight: 40,
    req: () => ({
      path: `/api/v1/search/workers?category=HOUSE_MAID&areaId=${pick(areas)}&engagement=${pick(ENG)}&availableFrom=09:00&availableTo=10:00&startDate=${day}&limit=20&page=${1 + Math.floor(Math.random() * 3)}&sort=${pick(['EXPERIENCE_DESC', 'RATING_DESC'])}`,
      as: pick(customers),
    }),
  },
  {
    name: 'worker-card',
    weight: 10,
    req: () => ({ path: `/api/v1/search/workers/${pick(workerIds)}`, as: pick(customers) }),
  },
  {
    name: 'my-bookings',
    weight: 15,
    req: () => ({ path: '/api/v1/bookings?limit=20', as: pick(customers) }),
  },
  {
    name: 'my-profile',
    weight: 10,
    req: () => ({ path: '/api/v1/customers/me', as: pick(customers) }),
  },
  {
    name: 'unread-count',
    weight: 10,
    req: () => ({ path: '/api/v1/notifications/unread-count', as: pick(customers) }),
  },
  {
    name: 'worker-feed',
    weight: 10,
    req: () => ({ path: '/api/v1/workers/me/opportunities', as: pick(workers) }),
  },
  { name: 'health', weight: 5, req: () => ({ path: '/health/ready', as: null }) },
];
// ONLY=name1,name2 restricts the mix to those scenarios (used to attribute cost to one endpoint).
const ONLY = (process.env.ONLY ?? '').split(',').filter(Boolean);
if (ONLY.length)
  for (let i = SCENARIOS.length - 1; i >= 0; i--)
    if (!ONLY.includes(SCENARIOS[i].name)) SCENARIOS.splice(i, 1);
const TOTAL = SCENARIOS.reduce((s, x) => s + x.weight, 0);
const choose = () => {
  let r = Math.random() * TOTAL;
  for (const s of SCENARIOS) if ((r -= s.weight) <= 0) return s;
  return SCENARIOS[0];
};
const pct = (sorted, p) =>
  sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))] : 0;

async function stage(concurrency, seconds) {
  const stats = new Map(SCENARIOS.map((s) => [s.name, { ms: [], errors: 0, statuses: new Map() }]));
  const end = Date.now() + seconds * 1000;
  let sent = 0;
  async function worker() {
    while (Date.now() < end) {
      const sc = choose();
      const { path, as } = sc.req();
      const t0 = performance.now();
      let status = 0;
      try {
        const res = await fetch(BASE + path, {
          headers: as
            ? {
                Authorization: `Bearer ${as.token}`,
                'X-Forwarded-For': `10.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}`,
              }
            : {},
          signal: AbortSignal.timeout(30_000),
        });
        status = res.status;
        await res.arrayBuffer();
      } catch {
        status = 0;
      }
      const s = stats.get(sc.name);
      s.ms.push(performance.now() - t0);
      s.statuses.set(status, (s.statuses.get(status) ?? 0) + 1);
      if (status < 200 || status >= 300) s.errors++;
      sent++;
    }
  }
  await Promise.all(Array.from({ length: concurrency }, worker));
  console.log(
    `\n== concurrency ${concurrency}, ${seconds}s: ${sent} requests, ${(sent / seconds).toFixed(1)} req/s`,
  );
  let all = [];
  let errs = 0;
  for (const [name, s] of stats) {
    const sorted = s.ms.slice().sort((a, b) => a - b);
    all = all.concat(sorted);
    errs += s.errors;
    console.log(
      `${name.padEnd(13)} n=${String(sorted.length).padStart(6)} err=${String(s.errors).padStart(5)} p50=${pct(sorted, 50).toFixed(0).padStart(5)}ms p95=${pct(sorted, 95).toFixed(0).padStart(5)}ms p99=${pct(sorted, 99).toFixed(0).padStart(5)}ms  statuses=${JSON.stringify(Object.fromEntries(s.statuses))}`,
    );
  }
  all.sort((a, b) => a - b);
  console.log(
    `ALL           n=${String(all.length).padStart(6)} err=${String(errs).padStart(5)} (${((errs / Math.max(1, all.length)) * 100).toFixed(2)}%) p50=${pct(all, 50).toFixed(0)}ms p95=${pct(all, 95).toFixed(0)}ms p99=${pct(all, 99).toFixed(0)}ms`,
  );
}

console.log(`target ${BASE}; ${customers.length} customer tokens, ${workers.length} worker tokens`);
for (const [c, s] of STAGES) await stage(c, s);
