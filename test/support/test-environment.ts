/** Hermetic environment for e2e specs. No real PostgreSQL/Redis is contacted (both are stubbed by createTestApp). */
export function applyTestEnvironment(overrides: Record<string, string> = {}): void {
  Object.assign(process.env, {
    NODE_ENV: 'test',
    PORT: '3000', // never bound: e2e uses supertest on an in-memory server
    LOG_LEVEL: 'silent',
    SWAGGER_ENABLED: 'true',
    DATABASE_URL: 'postgresql://test:test@localhost:5432/test',
    REDIS_URL: 'redis://localhost:6379',
    JWT_ACCESS_SECRET: 'e2e-secret-e2e-secret-e2e-secret-0123456789',
    JWT_ACCESS_TTL_SECONDS: '900',
    REFRESH_TOKEN_TTL_SECONDS: '86400',
    THROTTLE_TTL_SECONDS: '60',
    THROTTLE_LIMIT: '1000',
    ...overrides,
  });
}
