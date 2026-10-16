import { ProviderError } from '../provider-error';
import {
  BrevoEmailProvider,
  DisabledEmailProvider,
  InMemoryEmailProvider,
} from './email-providers';

const settings = {
  apiKey: 'test-only-brevo-key',
  fromAddress: 'no-reply@example.test',
  fromName: 'SevaNest',
  timeoutMs: 1000,
  baseUrl: 'https://brevo.example.test',
};
const mail = {
  to: 'asha@example.test',
  subject: 'Booking confirmed',
  body: 'Your booking is confirmed.',
};

describe('Brevo e-mail adapter (mocked HTTP, DEC-17)', () => {
  let fetchMock: jest.SpyInstance;
  afterEach(() => fetchMock?.mockRestore());

  const reply = (status: number, body: unknown) =>
    (fetchMock = jest
      .spyOn(global, 'fetch')
      .mockResolvedValue(new Response(JSON.stringify(body), { status })));

  it('posts the message with the api-key header and returns the provider message id', async () => {
    reply(201, { messageId: '<abc@smtp-relay.brevo>' });
    const result = await new BrevoEmailProvider(settings).sendEmail(mail);
    expect(result).toEqual({ providerMessageId: '<abc@smtp-relay.brevo>' });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://brevo.example.test/v3/smtp/email');
    expect((init.headers as Record<string, string>)['api-key']).toBe('test-only-brevo-key');
    expect(JSON.parse(init.body as string)).toEqual({
      sender: { name: 'SevaNest', email: 'no-reply@example.test' },
      to: [{ email: 'asha@example.test' }],
      subject: 'Booking confirmed',
      textContent: 'Your booking is confirmed.',
    });
  });

  it.each([429, 500, 503])('treats HTTP %i as retryable', async (status) => {
    reply(status, {});
    await expect(new BrevoEmailProvider(settings).sendEmail(mail)).rejects.toMatchObject({
      retryable: true,
    });
  });

  it.each([400, 401, 403])(
    'treats HTTP %i as a permanent refusal without leaking the message',
    async (status) => {
      reply(status, { message: 'asha@example.test is blocked' });
      const error = await new BrevoEmailProvider(settings).sendEmail(mail).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(ProviderError);
      expect((error as ProviderError).retryable).toBe(false);
      expect((error as Error).message).not.toContain('asha@example.test');
      expect((error as Error).message).not.toContain('test-only-brevo-key');
    },
  );

  it('treats a timeout / network failure as retryable and a reply without a message id as permanent', async () => {
    fetchMock = jest.spyOn(global, 'fetch').mockRejectedValue(new Error('socket hang up'));
    await expect(new BrevoEmailProvider(settings).sendEmail(mail)).rejects.toMatchObject({
      retryable: true,
    });
    fetchMock.mockRestore();
    reply(201, {});
    await expect(new BrevoEmailProvider(settings).sendEmail(mail)).rejects.toMatchObject({
      retryable: false,
    });
  });
});

describe('disabled and memory e-mail adapters', () => {
  it('disabled refuses permanently', async () => {
    await expect(new DisabledEmailProvider().sendEmail()).rejects.toMatchObject({
      retryable: false,
    });
  });

  it('memory keeps what it was given and can be told to fail', async () => {
    const memory = new InMemoryEmailProvider();
    await memory.sendEmail(mail);
    expect(memory.sent).toHaveLength(1);
    memory.failWith = new ProviderError('email', 'down', true);
    await expect(memory.sendEmail(mail)).rejects.toMatchObject({ retryable: true });
    expect(memory.sent).toHaveLength(1);
  });
});
