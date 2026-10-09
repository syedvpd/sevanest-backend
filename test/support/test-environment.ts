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
    // Test-only values. They are NOT approved business values (OTP/lockout limits are open decisions, Q-12).
    OTP_HMAC_SECRET: 'test-only-otp-hmac-key-0123456789-abcdefghij',
    SMS_PROVIDER: 'memory',
    // Test-only KYC document settings (Q-12 is open).
    STORAGE_PROVIDER: 'memory',
    PAYMENT_PROVIDER: 'fake',
    PAYMENT_FAKE_WEBHOOK_SECRET: 'test-only-webhook-secret-0123456789',
    PUSH_PROVIDER: 'memory',
    WHATSAPP_PROVIDER: 'memory',
    RATING_SCALE_MAX: '5',
    VERIFICATION_DOCUMENT_MAX_BYTES: '1048576',
    VERIFICATION_DOCUMENT_CONTENT_TYPES: 'application/pdf,image/jpeg,image/png',
    SIGNED_URL_TTL_SECONDS: '120',
    OTP_LENGTH: '6',
    OTP_TTL_SECONDS: '300',
    OTP_MAX_VERIFY_ATTEMPTS: '3',
    OTP_RESEND_COOLDOWN_SECONDS: '30',
    OTP_SEND_WINDOW_SECONDS: '3600',
    OTP_MAX_SENDS_PER_MOBILE_PER_WINDOW: '5',
    OTP_MAX_REQUESTS_PER_IP_PER_WINDOW: '20',
    OTP_LOCKOUT_SECONDS: '900',
    ADMIN_LOGIN_MAX_FAILURES: '3',
    ADMIN_LOGIN_FAILURE_WINDOW_SECONDS: '900',
    ADMIN_LOGIN_LOCKOUT_SECONDS: '900',
    ADMIN_PASSWORD_MIN_LENGTH: '12',
    ...overrides,
  });
}
