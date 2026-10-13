// Signs a token for one seeded LOCAL customer and calls a few routes (production-mode container check). Never use against a hosted database.
import { createHmac, randomUUID, randomBytes } from 'node:crypto';
import { createRequire } from 'node:module';
const { Client } = createRequire(import.meta.url)('pg');
const DB = process.env.LOAD_DATABASE_URL;
if (!DB || /supabase|render\.com|amazonaws/i.test(DB)) throw new Error('local LOAD_DATABASE_URL required');
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
const db = new Client({ connectionString: DB });
await db.connect();
const user = (await db.query(`SELECT id FROM users WHERE type='CUSTOMER' AND status='ACTIVE' LIMIT 1`)).rows[0];
const sid = randomUUID();
await db.query(`INSERT INTO sessions (id,user_id,refresh_token_hash,expires_at,created_at) VALUES ($1,$2,$3,now()+interval '1 hour',now())`, [sid, user.id, randomBytes(16).toString('hex')]);
await db.end();
const now = Math.floor(Date.now() / 1000);
const head = b64({ alg: 'HS256', typ: 'JWT' });
const body = b64({ sub: user.id, sid, iss: 'sevanest-api', aud: 'sevanest-clients', iat: now, exp: now + 600 });
const token = `${head}.${body}.${createHmac('sha256', process.env.JWT_ACCESS_SECRET).update(`${head}.${body}`).digest('base64url')}`;
for (const p of ['/api/v1/customers/me/home', '/api/v1/customers/me', '/api/v1/pricing/guidance?category=HOUSE_MAID&engagement=PART_TIME', '/api/v1/interviews', '/api/v1/service-categories?limit=2', '/api/v1/admin/pricing-guidance']) {
  const r = await fetch(`http://127.0.0.1:3200${p}`, { headers: { Authorization: `Bearer ${token}` } });
  console.log(r.status, p, (await r.text()).slice(0, 110).replace(/\s+/g, ' '));
}
