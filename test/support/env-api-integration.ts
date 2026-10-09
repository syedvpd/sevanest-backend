// Loads .env (real PostgreSQL/Redis settings), then applies the test configuration. Must be imported FIRST in a spec.
import 'dotenv/config';
import { applyTestEnvironment } from './test-environment';

const databaseUrl = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL ?? '';

function databaseName(url: string): string {
  try {
    return new URL(url).pathname.replace(/^\//, '');
  } catch {
    return '';
  }
}

// These specs COMMIT rows. They may only ever run against a dedicated database.
if (!/(_test|_ci)$/.test(databaseName(databaseUrl))) {
  throw new Error(
    `Refusing to run committing integration tests against database "${databaseName(databaseUrl)}". ` +
      'Set TEST_DATABASE_URL to a dedicated database whose name ends in _test or _ci.',
  );
}

applyTestEnvironment({
  DATABASE_URL: databaseUrl,
  REDIS_URL: process.env.REDIS_URL ?? 'redis://localhost:6379',
  // Tests present distinct client IPs through X-Forwarded-For so per-IP limits do not leak between tests.
  TRUST_PROXY_HOPS: '1',
  THROTTLE_LIMIT: '100000',
});
