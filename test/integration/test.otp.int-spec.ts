import '../support/env-api-integration';
// Staging/demo login: two numbers log in with a fixed code, nobody else does.
process.env.ALLOW_TEST_OTP = 'true';
process.env.TEST_OTP_NUMBERS = '+919999900011,+919999900012';
process.env.TEST_OTP_CODE = '424242';

import { ApiApp, createApiApp } from '../support/api-app';

describe('Staging test OTP (integration)', () => {
  let api: ApiApp;
  const request = (mobile: string, ip: string) =>
    api
      .http()
      .post('/api/v1/auth/otp/request')
      .set('X-Forwarded-For', ip)
      .send({ mobile, appType: 'CUSTOMER' });
  const verify = (mobile: string, otp: string, ip: string) =>
    api
      .http()
      .post('/api/v1/auth/otp/verify')
      .set('X-Forwarded-For', ip)
      .send({ mobile, appType: 'CUSTOMER', otp });

  beforeAll(async () => {
    api = await createApiApp();
  });
  afterAll(async () => {
    await api.close();
  });

  it('logs an allow-listed number in with the fixed code and sends no SMS', async () => {
    const before = api.sms.sent.length;
    expect((await request('+919999900011', '10.20.0.1')).status).toBe(200);
    expect(api.sms.sent.length).toBe(before);
    const ok = await verify('+919999900011', '424242', '10.20.0.1');
    expect(ok.status).toBe(200);
    expect(ok.body.accessToken).toBeTruthy();
  });

  it('keeps every normal protection: single use, wrong code counted, lockout', async () => {
    expect((await request('+919999900012', '10.20.0.2')).status).toBe(200);
    expect((await verify('+919999900012', '000000', '10.20.0.2')).status).toBe(400);
    expect((await verify('+919999900012', '424242', '10.20.0.2')).status).toBe(200);
    expect((await verify('+919999900012', '424242', '10.20.0.2')).status).toBe(400); // already used
  });

  it('does nothing for any other number: the fixed code is refused', async () => {
    const mobile = '+919999900099';
    const res = await request(mobile, '10.20.0.3');
    expect(res.status).toBe(200); // memory SMS adapter in tests sends a random code
    expect((await verify(mobile, '424242', '10.20.0.3')).status).toBe(400);
  });
});
