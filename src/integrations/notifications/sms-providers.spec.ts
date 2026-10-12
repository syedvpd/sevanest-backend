import { ProviderError } from '../provider-error';
import { Msg91SmsProvider } from './msg91-sms.provider';
import { TwilioSmsProvider, TwilioWhatsAppProvider } from './twilio.provider';

type Call = { url: string; init: RequestInit };
let calls: Call[];
let reply: () => { status: number; body?: unknown } | Error | DOMException;

beforeEach(() => {
  calls = [];
  reply = () => ({ status: 200, body: {} });
  jest.spyOn(globalThis, 'fetch').mockImplementation((url, init) => {
    calls.push({
      url: typeof url === 'string' ? url : url instanceof URL ? url.href : url.url,
      init: init ?? {},
    });
    const outcome = reply();
    if (!('status' in outcome)) return Promise.reject(outcome);
    return Promise.resolve(
      new Response(outcome.body === undefined ? '' : JSON.stringify(outcome.body), {
        status: outcome.status,
      }),
    );
  });
});
afterEach(() => jest.restoreAllMocks());

const twilio = {
  accountSid: `AC${'a'.repeat(32)}`,
  authToken: 'auth-token-0123456789',
  smsFrom: '+14155550100',
  whatsappFrom: 'whatsapp:+14155238886',
  timeoutMs: 2000,
  baseUrl: 'https://twilio.test',
};

describe('TwilioSmsProvider', () => {
  it('posts a form-encoded message with Basic auth and returns the message SID', async () => {
    reply = () => ({ status: 201, body: { sid: 'SM123', status: 'queued' } });
    const result = await new TwilioSmsProvider(twilio).sendSms({
      to: '+919876543210',
      body: '123456 is your code',
    });
    expect(result).toEqual({ providerMessageId: 'SM123' });
    expect(calls[0].url).toBe(
      `https://twilio.test/2010-04-01/Accounts/${twilio.accountSid}/Messages.json`,
    );
    const params = new URLSearchParams(calls[0].init.body as string);
    expect(params.get('To')).toBe('+919876543210');
    expect(params.get('From')).toBe('+14155550100');
    expect(params.get('MessagingServiceSid')).toBeNull();
  });

  it('prefers a Messaging Service when configured', async () => {
    reply = () => ({ status: 201, body: { sid: 'SM1', status: 'queued' } });
    await new TwilioSmsProvider({ ...twilio, messagingServiceSid: `MG${'b'.repeat(32)}` }).sendSms({
      to: '+919876543210',
      body: 'x',
    });
    const params = new URLSearchParams(calls[0].init.body as string);
    expect(params.get('MessagingServiceSid')).toBe(`MG${'b'.repeat(32)}`);
    expect(params.get('From')).toBeNull();
  });

  it('does not report delivery for a 2xx without a SID or with a failed status', async () => {
    reply = () => ({ status: 200, body: {} });
    await expect(
      new TwilioSmsProvider(twilio).sendSms({ to: '+919876543210', body: 'x' }),
    ).rejects.toBeInstanceOf(ProviderError);
    reply = () => ({ status: 201, body: { sid: 'SM1', status: 'failed' } });
    await expect(
      new TwilioSmsProvider(twilio).sendSms({ to: '+919876543210', body: 'x' }),
    ).rejects.toThrow('did not accept');
  });

  it('classifies provider errors and never puts the OTP, number or token in the message', async () => {
    for (const [make, retryable] of [
      [() => ({ status: 503 }), true],
      [() => ({ status: 429 }), true],
      [() => new DOMException('slow', 'TimeoutError'), true],
      [() => ({ status: 400, body: { message: 'bad number 919876543210' } }), false],
      [() => ({ status: 401 }), false],
    ] as Array<[typeof reply, boolean]>) {
      reply = make;
      const error = (await new TwilioSmsProvider(twilio)
        .sendSms({ to: '+919876543210', body: '654321 is your code' })
        .catch((e: unknown) => e)) as ProviderError;
      expect(error).toBeInstanceOf(ProviderError);
      expect(error.retryable).toBe(retryable);
      for (const secret of ['654321', '919876543210', twilio.authToken]) {
        expect(error.message).not.toContain(secret);
      }
    }
  });
});

describe('TwilioWhatsAppProvider', () => {
  it('prefixes both numbers with whatsapp:', async () => {
    reply = () => ({ status: 201, body: { sid: 'SMwa', status: 'queued' } });
    await new TwilioWhatsAppProvider({ ...twilio, whatsappFrom: '+14155238886' }).sendWhatsApp({
      to: '+919876543210',
      body: 'hello',
    });
    const params = new URLSearchParams(calls[0].init.body as string);
    expect(params.get('To')).toBe('whatsapp:+919876543210');
    expect(params.get('From')).toBe('whatsapp:+14155238886');
  });
});

describe('Msg91SmsProvider', () => {
  const settings = {
    authKey: 'authkey-0123456789',
    otpTemplateId: 'tpl-12345678',
    otpVariable: 'OTP',
    timeoutMs: 2000,
    baseUrl: 'https://msg91.test',
  };
  const otp = { key: 'OTP' as const, variables: { code: '482913' } };

  it('sends the registered template with the code in the configured variable', async () => {
    reply = () => ({ status: 200, body: { type: 'success', message: 'req-id-1' } });
    const result = await new Msg91SmsProvider(settings).sendSms({
      to: '+919876543210',
      body: 'ignored',
      template: otp,
    });
    expect(result).toEqual({ providerMessageId: 'req-id-1' });
    expect(calls[0].url).toBe('https://msg91.test/api/v5/flow');
    expect((calls[0].init.headers as Record<string, string>).authkey).toBe(settings.authKey);
    expect(JSON.parse(calls[0].init.body as string)).toEqual({
      template_id: 'tpl-12345678',
      short_url: '0',
      recipients: [{ mobiles: '919876543210', OTP: '482913' }],
    });
  });

  it('treats an HTTP-200 {"type":"error"} answer as a failed delivery', async () => {
    reply = () => ({ status: 200, body: { type: 'error', message: 'template mismatch' } });
    const error = (await new Msg91SmsProvider(settings)
      .sendSms({ to: '+919876543210', body: 'x', template: otp })
      .catch((e: unknown) => e)) as ProviderError;
    expect(error).toBeInstanceOf(ProviderError);
    expect(error.retryable).toBe(false);
    expect(error.message).not.toContain('482913');
  });

  it('refuses free text: only DLT-registered templates may be sent', async () => {
    await expect(
      new Msg91SmsProvider(settings).sendSms({ to: '+919876543210', body: 'free text' }),
    ).rejects.toThrow('no DLT template');
    expect(calls).toHaveLength(0);
  });

  it('retries on provider outages but not on rejections', async () => {
    reply = () => ({ status: 500 });
    expect(
      (
        (await new Msg91SmsProvider(settings)
          .sendSms({ to: '+919876543210', body: 'x', template: otp })
          .catch((e: unknown) => e)) as ProviderError
      ).retryable,
    ).toBe(true);
    reply = () => ({ status: 401 });
    expect(
      (
        (await new Msg91SmsProvider(settings)
          .sendSms({ to: '+919876543210', body: 'x', template: otp })
          .catch((e: unknown) => e)) as ProviderError
      ).retryable,
    ).toBe(false);
  });
});
