// Must be imported FIRST by seed-demo.ts: loads .env, then pins the adapters the seeding run needs.
import 'dotenv/config';

Object.assign(process.env, {
  NODE_ENV: 'development',
  LOG_LEVEL: 'silent',
  SMS_PROVIDER: 'memory', // OTP logins for the demo accounts are captured in memory; no real SMS is sent
  PAYMENT_PROVIDER: 'fake', // payments in the demo data go through the fake gateway
  PAYMENT_FAKE_WEBHOOK_SECRET: 'demo-seed-webhook-secret-0123456789',
  PUSH_PROVIDER: 'memory',
  WHATSAPP_PROVIDER: 'memory',
  TRUST_PROXY_HOPS: '1',
  THROTTLE_LIMIT: '100000',
  OTP_MAX_REQUESTS_PER_IP_PER_WINDOW: '100000',
  OTP_MAX_SENDS_PER_MOBILE_PER_WINDOW: '100',
  SIGNED_URL_TTL_SECONDS: '900', // the local clock may lag the storage service
});

// Safety: demo data (known mobiles, fake gateway, memory OTP) must never be written to a shared or production database.
const databaseHost = (() => {
  try {
    return new URL(process.env.DATABASE_URL ?? '').hostname.replace(/^\[|\]$/g, '');
  } catch {
    return '';
  }
})();
if (!['localhost', '127.0.0.1', '::1'].includes(databaseHost)) {
  throw new Error(
    'seed-demo refuses to run: DATABASE_URL does not point at a local database. Override DATABASE_URL with a disposable local database.',
  );
}
