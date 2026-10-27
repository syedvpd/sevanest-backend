import type { ConfigService } from '@nestjs/config';
import { AppConfigService } from './app-config.service';
import type { EnvironmentVariables } from './env.validation';

const make = (values: Record<string, unknown>): AppConfigService =>
  new AppConfigService({
    get: (key: string) => values[key],
  } as unknown as ConfigService<EnvironmentVariables, true>);

describe('AppConfigService.testOtpCodeFor', () => {
  const base = {
    ALLOW_TEST_OTP: true,
    TEST_OTP_NUMBERS: '+919999900001, +919999900002',
    TEST_OTP_CODE: '123456',
  };

  it('returns the fixed code only for a listed number outside production', () => {
    const dev = make({ ...base, NODE_ENV: 'development' });
    expect(dev.testOtpCodeFor('+919999900002')).toBe('123456');
    expect(dev.testOtpCodeFor('+919999900099')).toBeNull();
  });

  it('never returns a code when the flag is off', () => {
    expect(
      make({ ...base, ALLOW_TEST_OTP: false, NODE_ENV: 'development' }).testOtpCodeFor(
        '+919999900001',
      ),
    ).toBeNull();
  });

  it('never returns a code in production, even if the flag somehow reached runtime', () => {
    expect(make({ ...base, NODE_ENV: 'production' }).testOtpCodeFor('+919999900001')).toBeNull();
  });
});

describe('AppConfigService.demoOtpAccepts', () => {
  const on = { NODE_ENV: 'development', DEMO_OTP_ACCEPT_ANY: true };

  it('accepts any number when no allow-list is set, or only listed ones when it is', () => {
    expect(make(on).demoOtpAccepts('+919000000001')).toBe(true);
    expect(make({ ...on, DEMO_OTP_NUMBERS: '' }).demoOtpAccepts('+919000000001')).toBe(true);
    const listed = make({ ...on, DEMO_OTP_NUMBERS: '+919123456789, +919876543210' });
    expect(listed.demoOtpAccepts('+919876543210')).toBe(true);
    expect(listed.demoOtpAccepts('+919000000001')).toBe(false);
  });

  it('never accepts when the flag is off or in production', () => {
    expect(make({ ...on, DEMO_OTP_ACCEPT_ANY: false }).demoOtpAccepts('+919000000001')).toBe(false);
    expect(make({ ...on, NODE_ENV: 'production' }).demoOtpAccepts('+919000000001')).toBe(false);
  });
});

describe('AppConfigService.appPolicy support contact', () => {
  it('passes configured values through trimmed', () => {
    const policy = make({
      SUPPORT_CONTACT_PHONE: ' +911234567890 ',
      SUPPORT_CONTACT_EMAIL: 'help@example.test',
    }).appPolicy;
    expect(policy.supportPhone).toBe('+911234567890');
    expect(policy.supportEmail).toBe('help@example.test');
  });

  it('leaves unset and blank values undefined (the API then answers null)', () => {
    expect(make({}).appPolicy).toMatchObject({
      supportPhone: undefined,
      supportEmail: undefined,
    });
    const blank = make({ SUPPORT_CONTACT_PHONE: '  ', SUPPORT_CONTACT_EMAIL: '' }).appPolicy;
    expect(blank.supportPhone).toBeUndefined();
    expect(blank.supportEmail).toBeUndefined();
  });
});

describe('AppConfigService.legal URLs', () => {
  it('passes configured URLs through trimmed and treats blank or unset as not configured', () => {
    const set = make({
      LEGAL_TERMS_URL: ' https://example.test/terms ',
      LEGAL_PRIVACY_URL: 'https://example.test/privacy',
    }).legal;
    expect(set.termsUrl).toBe('https://example.test/terms');
    expect(set.privacyUrl).toBe('https://example.test/privacy');
    const blank = make({ LEGAL_TERMS_URL: '  ', LEGAL_PRIVACY_URL: '' }).legal;
    expect(blank.termsUrl).toBeUndefined();
    expect(blank.privacyUrl).toBeUndefined();
    expect(make({}).legal.termsUrl).toBeUndefined();
  });
});

describe('AppConfigService.appPolicy store URL', () => {
  it('passes the https store URLs through and leaves blank ones undefined', () => {
    const policy = make({
      APP_STORE_URL_CUSTOMER: ' https://play.google.com/store/apps/details?id=x ',
      APP_STORE_URL_WORKER: ' ',
    }).appPolicy;
    expect(policy.storeUrlCustomer).toBe('https://play.google.com/store/apps/details?id=x');
    expect(policy.storeUrlWorker).toBeUndefined();
  });
});

describe('AppConfigService.policyContent', () => {
  it('returns only what is configured, trimmed, and nothing invented', () => {
    expect(make({}).policyContent).toEqual({
      cancellationText: undefined,
      cancellationUrl: undefined,
      refundText: undefined,
      refundUrl: undefined,
    });
    const set = make({
      POLICY_CANCELLATION_TEXT: '  Approved cancellation wording.  ',
      POLICY_REFUND_URL: 'https://example.test/refunds',
      POLICY_REFUND_TEXT: '   ',
    }).policyContent;
    expect(set.cancellationText).toBe('Approved cancellation wording.');
    expect(set.refundUrl).toBe('https://example.test/refunds');
    expect(set.refundText).toBeUndefined();
    expect(set.cancellationUrl).toBeUndefined();
  });
});
