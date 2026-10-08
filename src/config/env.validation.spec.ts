import { NodeEnv, validateEnvironment } from './env.validation';

const valid = {
  DATABASE_URL: 'postgresql://u:p@localhost:5432/db',
  REDIS_URL: 'redis://localhost:6379',
  JWT_ACCESS_SECRET: 'x'.repeat(40),
  JWT_ACCESS_TTL_SECONDS: '900',
  REFRESH_TOKEN_TTL_SECONDS: '86400',
  THROTTLE_TTL_SECONDS: '60',
  THROTTLE_LIMIT: '100',
};

describe('validateEnvironment', () => {
  it('accepts a complete environment and coerces numbers', () => {
    const env = validateEnvironment({ ...valid, PORT: '4000' });
    expect(env.PORT).toBe(4000);
    expect(env.JWT_ACCESS_TTL_SECONDS).toBe(900);
  });

  it('applies engineering defaults only where documented', () => {
    const env = validateEnvironment(valid);
    expect(env.NODE_ENV).toBe(NodeEnv.Development);
    expect(env.SWAGGER_ENABLED).toBe(false);
    expect(env.DATABASE_POOL_MAX).toBe(10);
    expect(env.TRUST_PROXY_HOPS).toBe(0);
  });

  it.each([
    'JWT_ACCESS_TTL_SECONDS',
    'REFRESH_TOKEN_TTL_SECONDS',
    'THROTTLE_LIMIT',
    'DATABASE_URL',
    'REDIS_URL',
  ])('rejects a missing %s instead of defaulting it', (key) => {
    const { [key]: _omitted, ...rest } = valid as Record<string, string>;
    expect(() => validateEnvironment(rest)).toThrow(key);
  });

  it('rejects a short JWT secret', () => {
    expect(() => validateEnvironment({ ...valid, JWT_ACCESS_SECRET: 'short' })).toThrow(
      'JWT_ACCESS_SECRET',
    );
  });

  it('rejects non-postgres database URLs', () => {
    expect(() => validateEnvironment({ ...valid, DATABASE_URL: 'mysql://x' })).toThrow(
      'DATABASE_URL',
    );
  });

  it('refuses a placeholder JWT secret in production', () => {
    expect(() =>
      validateEnvironment({
        ...valid,
        NODE_ENV: 'production',
        JWT_ACCESS_SECRET: 'change-me-generate-a-random-secret-of-32-chars-or-more',
      }),
    ).toThrow('placeholder');
  });

  it('parses SWAGGER_ENABLED from strings', () => {
    expect(validateEnvironment({ ...valid, SWAGGER_ENABLED: 'true' }).SWAGGER_ENABLED).toBe(true);
    expect(validateEnvironment({ ...valid, SWAGGER_ENABLED: 'false' }).SWAGGER_ENABLED).toBe(false);
  });
});
