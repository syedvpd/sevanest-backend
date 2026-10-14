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
