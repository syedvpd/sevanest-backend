import { NodeEnv, validateEnvironment } from './env.validation';

const valid = {
  DATABASE_URL: 'postgresql://u:p@localhost:5432/db',
  REDIS_URL: 'redis://localhost:6379',
  JWT_ACCESS_SECRET: 'x'.repeat(40),
  JWT_ACCESS_TTL_SECONDS: '900',
  REFRESH_TOKEN_TTL_SECONDS: '86400',
  THROTTLE_TTL_SECONDS: '60',
  THROTTLE_LIMIT: '100',
  OTP_HMAC_SECRET: 'y'.repeat(40),
  SMS_PROVIDER: 'memory',
  STORAGE_PROVIDER: 'memory',
  PAYMENT_PROVIDER: 'fake',
  PAYMENT_FAKE_WEBHOOK_SECRET: 'z'.repeat(20),
  PUSH_PROVIDER: 'memory',
  WHATSAPP_PROVIDER: 'memory',
  RATING_SCALE_MAX: '5',
  VERIFICATION_DOCUMENT_MAX_BYTES: '1048576',
  VERIFICATION_DOCUMENT_CONTENT_TYPES: 'application/pdf,image/png',
  SIGNED_URL_TTL_SECONDS: '120',
  OTP_LENGTH: '6',
  OTP_TTL_SECONDS: '300',
  OTP_MAX_VERIFY_ATTEMPTS: '3',
  OTP_RESEND_COOLDOWN_SECONDS: '30',
  OTP_SEND_WINDOW_SECONDS: '3600',
  OTP_MAX_SENDS_PER_MOBILE_PER_WINDOW: '5',
  OTP_MAX_REQUESTS_PER_IP_PER_WINDOW: '20',
  OTP_LOCKOUT_SECONDS: '900',
  ADMIN_LOGIN_MAX_FAILURES: '5',
  ADMIN_LOGIN_FAILURE_WINDOW_SECONDS: '900',
  ADMIN_LOGIN_LOCKOUT_SECONDS: '900',
  ADMIN_PASSWORD_MIN_LENGTH: '12',
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
    'OTP_LENGTH',
    'OTP_TTL_SECONDS',
    'OTP_HMAC_SECRET',
    'SMS_PROVIDER',
    'STORAGE_PROVIDER',
    'VERIFICATION_DOCUMENT_MAX_BYTES',
    'VERIFICATION_DOCUMENT_CONTENT_TYPES',
    'SIGNED_URL_TTL_SECONDS',
    'ADMIN_LOGIN_MAX_FAILURES',
    'ADMIN_PASSWORD_MIN_LENGTH',
    'DATABASE_URL',
    'REDIS_URL',
  ])('rejects a missing %s instead of defaulting it', (key) => {
    const { [key]: _omitted, ...rest } = valid as Record<string, string>;
    expect(() => validateEnvironment(rest)).toThrow(key);
  });

  describe('production safeguards for the open auth settings', () => {
    const production = {
      ...valid,
      NODE_ENV: 'production',
      JWT_ACCESS_SECRET: 'p'.repeat(48),
      OTP_HMAC_SECRET: 'q'.repeat(48),
      SMS_PROVIDER: 'disabled',
      STORAGE_PROVIDER: 'disabled',
      PAYMENT_PROVIDER: 'disabled',
      PUSH_PROVIDER: 'disabled',
      WHATSAPP_PROVIDER: 'disabled',
    };

    it('accepts an explicit, non-placeholder production configuration', () => {
      expect(() => validateEnvironment(production)).not.toThrow();
    });

    it('refuses the in-memory SMS adapter in production', () => {
      expect(() => validateEnvironment({ ...production, SMS_PROVIDER: 'memory' })).toThrow(
        'SMS_PROVIDER=memory',
      );
    });

    it('refuses the fake payment and in-memory messaging adapters in production', () => {
      expect(() => validateEnvironment({ ...production, PAYMENT_PROVIDER: 'fake' })).toThrow(
        'PAYMENT_PROVIDER=fake',
      );
      expect(() => validateEnvironment({ ...production, PUSH_PROVIDER: 'memory' })).toThrow(
        'PUSH_PROVIDER/WHATSAPP_PROVIDER=memory',
      );
    });

    it('needs the webhook secret only for the fake payment adapter', () => {
      const { PAYMENT_FAKE_WEBHOOK_SECRET: _omit, ...withoutSecret } = valid as Record<
        string,
        string
      >;
      expect(() => validateEnvironment(withoutSecret)).toThrow('PAYMENT_FAKE_WEBHOOK_SECRET');
      expect(() =>
        validateEnvironment({ ...withoutSecret, PAYMENT_PROVIDER: 'disabled' }),
      ).not.toThrow();
    });

    it('refuses the in-memory storage adapter in production', () => {
      expect(() => validateEnvironment({ ...production, STORAGE_PROVIDER: 'memory' })).toThrow(
        'STORAGE_PROVIDER=memory',
      );
    });

    it('requires the S3 settings when STORAGE_PROVIDER=s3', () => {
      expect(() => validateEnvironment({ ...production, STORAGE_PROVIDER: 's3' })).toThrow(
        'STORAGE_S3_BUCKET',
      );
      expect(() =>
        validateEnvironment({
          ...production,
          STORAGE_PROVIDER: 's3',
          STORAGE_S3_ENDPOINT: 'https://example.storage.supabase.co/storage/v1/s3',
          STORAGE_S3_REGION: 'ap-southeast-1',
          STORAGE_S3_BUCKET: 'kyc-documents',
          STORAGE_S3_ACCESS_KEY_ID: 'id',
          STORAGE_S3_SECRET_ACCESS_KEY: 'key',
        }),
      ).not.toThrow();
    });

    it('accepts only known document content types', () => {
      expect(() =>
        validateEnvironment({ ...production, VERIFICATION_DOCUMENT_CONTENT_TYPES: 'text/html' }),
      ).toThrow('VERIFICATION_DOCUMENT_CONTENT_TYPES');
    });

    it('refuses a placeholder OTP HMAC secret in production', () => {
      expect(() =>
        validateEnvironment({
          ...production,
          OTP_HMAC_SECRET: 'change-me-change-me-change-me-change-me',
        }),
      ).toThrow('OTP_HMAC_SECRET');
    });

    it.each([
      'OTP_MAX_VERIFY_ATTEMPTS',
      'OTP_RESEND_COOLDOWN_SECONDS',
      'OTP_SEND_WINDOW_SECONDS',
      'OTP_MAX_SENDS_PER_MOBILE_PER_WINDOW',
      'OTP_MAX_REQUESTS_PER_IP_PER_WINDOW',
      'OTP_LOCKOUT_SECONDS',
      'ADMIN_LOGIN_FAILURE_WINDOW_SECONDS',
      'ADMIN_LOGIN_LOCKOUT_SECONDS',
    ])('requires %s explicitly (nothing is silently defaulted)', (key) => {
      const { [key]: _omitted, ...rest } = production as Record<string, string>;
      expect(() => validateEnvironment(rest)).toThrow(key);
    });

    it('rejects an unknown SMS provider and an out-of-range OTP length', () => {
      expect(() => validateEnvironment({ ...production, SMS_PROVIDER: 'twilio' })).toThrow(
        'SMS_PROVIDER',
      );
      expect(() => validateEnvironment({ ...production, OTP_LENGTH: '2' })).toThrow('OTP_LENGTH');
    });

    it('treats the language allow-list as optional and validates it when set', () => {
      expect(validateEnvironment(production).SUPPORTED_LANGUAGES).toBeUndefined();
      expect(
        validateEnvironment({ ...production, SUPPORTED_LANGUAGES: 'en,hi' }).SUPPORTED_LANGUAGES,
      ).toBe('en,hi');
      expect(() => validateEnvironment({ ...production, SUPPORTED_LANGUAGES: 'English' })).toThrow(
        'SUPPORTED_LANGUAGES',
      );
    });
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
