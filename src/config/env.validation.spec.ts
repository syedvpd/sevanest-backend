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

  describe('operational timers (DEC-01/02/03)', () => {
    it('are ON by default', () => {
      const env = validateEnvironment(valid);
      expect(env.PENDING_PAYMENT_ALERT_HOURS).toBe(1);
      expect(env.PENDING_PAYMENT_AUTO_CANCEL_HOURS).toBe(12);
      expect(env.WORKER_RESPONSE_HOURS).toBe(4);
      expect(env.WORKER_REASSIGN_HOURS).toBe(24);
      expect([
        env.SUPPORT_SLA_HOURS_HIGH,
        env.SUPPORT_SLA_HOURS_MEDIUM,
        env.SUPPORT_SLA_HOURS_LOW,
      ]).toEqual([24, 48, 72]);
      expect(env.SUPPORT_SLA_HOURS_DEFAULT).toBe(48);
    });
    it('0 switches a timer off explicitly, even with a larger counterpart', () => {
      const env = validateEnvironment({
        ...valid,
        PENDING_PAYMENT_AUTO_CANCEL_HOURS: '0',
        PENDING_PAYMENT_ALERT_HOURS: '5',
      });
      expect(env.PENDING_PAYMENT_AUTO_CANCEL_HOURS).toBe(0);
    });
    it('rejects negative values and auto-cancel not greater than the alert', () => {
      expect(() => validateEnvironment({ ...valid, WORKER_RESPONSE_HOURS: '-1' })).toThrow(
        'WORKER_RESPONSE_HOURS',
      );
      expect(() =>
        validateEnvironment({
          ...valid,
          PENDING_PAYMENT_ALERT_HOURS: '5',
          PENDING_PAYMENT_AUTO_CANCEL_HOURS: '5',
        }),
      ).toThrow('PENDING_PAYMENT_AUTO_CANCEL_HOURS');
    });
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
      TRUST_PROXY_HOPS: '1',
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

    it('warns when the gateway is set under PAYMENT_GATEWAY or Razorpay keys are set without PAYMENT_PROVIDER=razorpay', () => {
      const warn = jest.spyOn(process, 'emitWarning').mockImplementation(() => undefined);
      try {
        validateEnvironment({
          ...valid,
          PAYMENT_PROVIDER: 'disabled',
          PAYMENT_GATEWAY: 'razorpay',
          RAZORPAY_KEY_ID: 'rzp_test_abcdefgh',
          RAZORPAY_KEY_SECRET: 's'.repeat(24),
        });
        const messages = warn.mock.calls.map((c) => String(c[0]));
        expect(messages.some((m) => m.includes('Set PAYMENT_PROVIDER=razorpay'))).toBe(true);
        expect(messages.some((m) => m.startsWith('PAYMENT_GATEWAY is not read'))).toBe(true);
        expect(messages.some((m) => m.startsWith('Razorpay keys are set'))).toBe(true);
        warn.mockClear();
        validateEnvironment(valid);
        expect(
          warn.mock.calls
            .map((c) => String(c[0]))
            .some((m) => /PAYMENT_GATEWAY|Razorpay keys/.test(m)),
        ).toBe(false);
      } finally {
        warn.mockRestore();
      }
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

    it('refuses to start in production without an explicit TRUST_PROXY_HOPS (0 is allowed when stated)', () => {
      const { TRUST_PROXY_HOPS: _omit, ...unset } = production;
      expect(() => validateEnvironment(unset)).toThrow('TRUST_PROXY_HOPS must be set explicitly');
      expect(() => validateEnvironment({ ...unset, TRUST_PROXY_HOPS: '' })).toThrow(
        'TRUST_PROXY_HOPS must be set explicitly',
      );
      expect(validateEnvironment({ ...production, TRUST_PROXY_HOPS: '0' }).TRUST_PROXY_HOPS).toBe(
        0,
      );
      expect(validateEnvironment({ ...production, TRUST_PROXY_HOPS: '2' }).TRUST_PROXY_HOPS).toBe(
        2,
      );
    });

    it('validates THROTTLE_STORAGE and warns about per-process limits and an untrusted proxy in production', () => {
      expect(validateEnvironment(valid).THROTTLE_STORAGE).toBe('memory');
      // production: unset means the shared Redis store; an explicit choice is respected
      expect(validateEnvironment(production).THROTTLE_STORAGE).toBe('redis');
      expect(
        validateEnvironment({ ...production, THROTTLE_STORAGE: 'memory' }).THROTTLE_STORAGE,
      ).toBe('memory');
      expect(() => validateEnvironment({ ...valid, THROTTLE_STORAGE: 'file' })).toThrow(
        'THROTTLE_STORAGE',
      );
      const warn = jest.spyOn(process, 'emitWarning').mockImplementation(() => undefined);
      try {
        validateEnvironment({ ...production, THROTTLE_STORAGE: 'memory' });
        const messages = warn.mock.calls.map((c) => String(c[0]));
        expect(messages.some((m) => m.includes('THROTTLE_STORAGE=memory'))).toBe(true);
        // a production setup with no SMS / payment provider is allowed but loudly flagged, never silent
        expect(messages.some((m) => m.includes('SMS_PROVIDER=disabled'))).toBe(true);
        expect(messages.some((m) => m.includes('PAYMENT_PROVIDER=disabled'))).toBe(true);
      } finally {
        warn.mockRestore();
      }
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

    describe('real providers', () => {
      const twilioSid = `AC${'a'.repeat(32)}`;
      const twilio = {
        ...production,
        SMS_PROVIDER: 'twilio',
        TWILIO_ACCOUNT_SID: twilioSid,
        TWILIO_AUTH_TOKEN: 't'.repeat(32),
        TWILIO_SMS_FROM: '+14155550100',
      };
      const msg91 = {
        ...production,
        SMS_PROVIDER: 'msg91',
        MSG91_AUTH_KEY: 'k'.repeat(20),
        MSG91_OTP_TEMPLATE_ID: 'tpl-12345678',
      };
      const razorpay = {
        ...production,
        PAYMENT_PROVIDER: 'razorpay',
        RAZORPAY_KEY_ID: 'rzp_test_abcdefgh12',
        RAZORPAY_KEY_SECRET: 's'.repeat(24),
        RAZORPAY_WEBHOOK_SECRET: 'w'.repeat(12),
      };

      it('accepts a complete Twilio, MSG91 or Razorpay configuration in production', () => {
        expect(validateEnvironment(twilio).SMS_PROVIDER).toBe('twilio');
        expect(
          validateEnvironment({
            ...twilio,
            TWILIO_SMS_FROM: undefined,
            TWILIO_MESSAGING_SERVICE_SID: `MG${'b'.repeat(32)}`,
          }).SMS_PROVIDER,
        ).toBe('twilio');
        expect(validateEnvironment(msg91).MSG91_OTP_VARIABLE).toBe('OTP');
        expect(validateEnvironment(razorpay).PAYMENT_PROVIDER).toBe('razorpay');
      });

      it.each([
        ['twilio', 'TWILIO_ACCOUNT_SID', twilio],
        ['twilio', 'TWILIO_AUTH_TOKEN', twilio],
        ['msg91', 'MSG91_AUTH_KEY', msg91],
        ['msg91', 'MSG91_OTP_TEMPLATE_ID', msg91],
        ['razorpay', 'RAZORPAY_KEY_ID', razorpay],
        ['razorpay', 'RAZORPAY_KEY_SECRET', razorpay],
      ])('%s: refuses to start without %s (no silent fallback)', (_name, key, config) => {
        const { [key]: _omitted, ...rest } = config as Record<string, string>;
        expect(() => validateEnvironment(rest)).toThrow(key);
      });

      it('twilio needs a sender (messaging service or from number)', () => {
        expect(() => validateEnvironment({ ...twilio, TWILIO_SMS_FROM: undefined })).toThrow(
          'TWILIO_MESSAGING_SERVICE_SID or TWILIO_SMS_FROM',
        );
      });

      it('rejects malformed credentials and warns on a test key in production', () => {
        expect(() => validateEnvironment({ ...razorpay, RAZORPAY_KEY_ID: 'key_123' })).toThrow(
          'RAZORPAY_KEY_ID',
        );
        expect(() => validateEnvironment({ ...twilio, TWILIO_ACCOUNT_SID: 'nope' })).toThrow(
          'TWILIO_ACCOUNT_SID',
        );
        const warn = jest.spyOn(process, 'emitWarning').mockImplementation(() => undefined);
        try {
          validateEnvironment(razorpay);
          expect(warn.mock.calls.some((c) => String(c[0]).includes('TEST key'))).toBe(true);
        } finally {
          warn.mockRestore();
        }
      });

      it('twilio WhatsApp needs the account credentials and a sender', () => {
        const { TWILIO_ACCOUNT_SID: _a, TWILIO_AUTH_TOKEN: _b, ...base } = twilio;
        expect(() =>
          validateEnvironment({ ...base, SMS_PROVIDER: 'disabled', WHATSAPP_PROVIDER: 'twilio' }),
        ).toThrow('TWILIO_ACCOUNT_SID');
        expect(
          validateEnvironment({
            ...twilio,
            SMS_PROVIDER: 'disabled',
            WHATSAPP_PROVIDER: 'twilio',
            TWILIO_WHATSAPP_FROM: 'whatsapp:+14155238886',
          }).WHATSAPP_PROVIDER,
        ).toBe('twilio');
      });
    });

    describe('staging accept-any demo OTP', () => {
      it('is off by default, works outside production and is refused in production', () => {
        expect(validateEnvironment(production).DEMO_OTP_ACCEPT_ANY).toBe(false);
        const warn = jest.spyOn(process, 'emitWarning').mockImplementation(() => undefined);
        try {
          expect(
            validateEnvironment({ ...valid, DEMO_OTP_ACCEPT_ANY: 'true' }).DEMO_OTP_ACCEPT_ANY,
          ).toBe(true);
        } finally {
          warn.mockRestore();
        }
        for (const flag of ['true', '1', 'yes', true]) {
          expect(() =>
            validateEnvironment({
              ...production,
              NODE_ENV: 'production',
              DEMO_OTP_ACCEPT_ANY: flag,
            }),
          ).toThrow();
        }
      });
    });

    describe('staging test OTP', () => {
      const on = {
        ...valid,
        ALLOW_TEST_OTP: 'true',
        TEST_OTP_NUMBERS: '+919999900001, +919999900002',
        TEST_OTP_CODE: '123456',
      };

      it('is off by default and needs numbers and a code when switched on (no default code)', () => {
        expect(validateEnvironment(production).ALLOW_TEST_OTP).toBe(false);
        expect(() => validateEnvironment({ ...on, TEST_OTP_CODE: undefined })).toThrow(
          'TEST_OTP_CODE',
        );
        expect(() => validateEnvironment({ ...on, TEST_OTP_NUMBERS: undefined })).toThrow(
          'TEST_OTP_NUMBERS',
        );
        expect(() => validateEnvironment({ ...on, TEST_OTP_NUMBERS: '9999900001' })).toThrow(
          'TEST_OTP_NUMBERS',
        );
        expect(() => validateEnvironment({ ...on, TEST_OTP_CODE: '12345' })).toThrow('OTP_LENGTH');
      });

      it('refuses to start in production (fail closed, D-70)', () => {
        expect(() => validateEnvironment({ ...production, ...on, NODE_ENV: 'production' })).toThrow(
          'ALLOW_TEST_OTP=true is not allowed with NODE_ENV=production',
        );
      });

      it('no spelling of the flag turns test login on in production', () => {
        for (const flag of ['true', 'TRUE', 'True', '1', 'yes', 'on', true]) {
          expect(() =>
            validateEnvironment({
              ...production,
              ...on,
              NODE_ENV: 'production',
              ALLOW_TEST_OTP: flag,
            }),
          ).toThrow();
        }
        // production with the flag off or absent starts, and leaves no fixed code active
        const env = validateEnvironment({
          ...production,
          TEST_OTP_NUMBERS: '+919999900001',
          TEST_OTP_CODE: '123456',
        });
        expect(env.ALLOW_TEST_OTP).toBe(false);
      });

      it('warns loudly when on', () => {
        const warn = jest.spyOn(process, 'emitWarning').mockImplementation(() => undefined);
        try {
          expect(validateEnvironment(on).ALLOW_TEST_OTP).toBe(true);
          expect(warn.mock.calls.some((c) => String(c[0]).includes('ALLOW_TEST_OTP'))).toBe(true);
        } finally {
          warn.mockRestore();
        }
      });
    });

    it('accepts only major.minor.patch minimum versions and https store URLs', () => {
      const ok = validateEnvironment({
        ...production,
        APP_MIN_VERSION_CUSTOMER: '1.2.0',
        APP_STORE_URL_CUSTOMER: 'https://play.google.com/store/apps/details?id=x',
      });
      expect(ok.APP_STORE_URL_CUSTOMER).toContain('https://');
      for (const bad of ['v1.2', '1.2', '1.2.0+45']) {
        expect(() => validateEnvironment({ ...production, APP_MIN_VERSION_CUSTOMER: bad })).toThrow(
          'APP_MIN_VERSION_CUSTOMER',
        );
      }
      for (const bad of ['http://play.google.com/x', 'play.google.com', 'https://a b']) {
        expect(() => validateEnvironment({ ...production, APP_STORE_URL_CUSTOMER: bad })).toThrow(
          'APP_STORE_URL_CUSTOMER',
        );
      }
    });

    it('rejects an unknown SMS provider and an out-of-range OTP length', () => {
      expect(() => validateEnvironment({ ...production, SMS_PROVIDER: 'carrier-pigeon' })).toThrow(
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
