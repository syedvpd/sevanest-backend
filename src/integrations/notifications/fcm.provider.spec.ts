import { createVerify, generateKeyPairSync } from 'node:crypto';
import { DEFAULT_IN_APP_TEMPLATES } from '../../modules/notifications/default-templates';
import { EVENT_PARAMS } from '../../common/outbox/notification-events';
import { placeholdersOf } from '../../modules/notifications/notifications.service';
import { ProviderError } from '../provider-error';
import { FcmPushProvider, parseFcmServiceAccount } from './fcm.provider';

const { privateKey, publicKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  publicKeyEncoding: { type: 'spki', format: 'pem' },
});
const account = {
  project_id: 'sevanest-test',
  client_email: 'svc@sevanest-test.iam.gserviceaccount.com',
  private_key: privateKey,
};
const settings = {
  serviceAccount: account,
  timeoutMs: 2000,
  fcmBaseUrl: 'https://fcm.test',
  tokenUrl: 'https://oauth.test/token',
};

type Call = { url: string; init: RequestInit };
let calls: Call[];
let replies: Array<{ status: number; body?: unknown }>;

beforeEach(() => {
  calls = [];
  replies = [];
  jest.spyOn(globalThis, 'fetch').mockImplementation((url, init) => {
    calls.push({
      url: typeof url === 'string' ? url : url instanceof URL ? url.href : url.url,
      init: init ?? {},
    });
    const reply = replies.shift() ?? { status: 200, body: {} };
    return Promise.resolve(
      new Response(JSON.stringify(reply.body ?? {}), { status: reply.status }),
    );
  });
});
afterEach(() => jest.restoreAllMocks());

const push = {
  deviceToken: 'device-token-1',
  title: 'Hi',
  body: 'There',
  data: { route: 'booking' },
};

describe('FcmPushProvider', () => {
  it('exchanges a signed JWT for an access token, caches it, and posts the message', async () => {
    replies = [
      { status: 200, body: { access_token: 'ya29.token', expires_in: 3600 } },
      { status: 200, body: { name: 'projects/sevanest-test/messages/m1' } },
      { status: 200, body: { name: 'projects/sevanest-test/messages/m2' } },
    ];
    const provider = new FcmPushProvider(settings);
    expect(await provider.sendPush(push)).toEqual({
      providerMessageId: 'projects/sevanest-test/messages/m1',
    });
    await provider.sendPush(push);
    expect(calls.map((c) => c.url)).toEqual([
      'https://oauth.test/token',
      'https://fcm.test/v1/projects/sevanest-test/messages:send',
      'https://fcm.test/v1/projects/sevanest-test/messages:send',
    ]); // the token request happened once

    const assertion = new URLSearchParams(calls[0].init.body as string).get('assertion')!;
    const [header, claims, signature] = assertion.split('.');
    expect(JSON.parse(Buffer.from(header, 'base64url').toString())).toEqual({
      alg: 'RS256',
      typ: 'JWT',
    });
    expect(JSON.parse(Buffer.from(claims, 'base64url').toString())).toMatchObject({
      iss: account.client_email,
      scope: 'https://www.googleapis.com/auth/firebase.messaging',
      aud: 'https://oauth.test/token',
    });
    const valid = createVerify('RSA-SHA256')
      .update(`${header}.${claims}`)
      .verify(publicKey, Buffer.from(signature, 'base64url'));
    expect(valid).toBe(true);

    const sent = JSON.parse(calls[1].init.body as string) as { message: Record<string, unknown> };
    expect(sent.message).toEqual({
      token: 'device-token-1',
      notification: { title: 'Hi', body: 'There' },
      data: { route: 'booking' },
    });
    expect((calls[1].init.headers as Record<string, string>).Authorization).toBe(
      'Bearer ya29.token',
    );
  });

  it('treats an unknown device token as a permanent rejection and never leaks the key or token', async () => {
    replies = [
      { status: 200, body: { access_token: 'ya29.token', expires_in: 3600 } },
      {
        status: 404,
        body: { error: { status: 'NOT_FOUND', message: 'UNREGISTERED device-token-1' } },
      },
    ];
    const error = (await new FcmPushProvider(settings)
      .sendPush(push)
      .catch((e: unknown) => e)) as ProviderError;
    expect(error).toBeInstanceOf(ProviderError);
    expect(error.retryable).toBe(false);
    for (const secret of ['device-token-1', 'ya29.token', 'PRIVATE KEY']) {
      expect(error.message).not.toContain(secret);
    }
  });

  it('retries on outages, refreshes the token once after a 401, and refuses a message FCM did not name', async () => {
    replies = [{ status: 200, body: { access_token: 'old', expires_in: 3600 } }, { status: 503 }];
    const outage = (await new FcmPushProvider(settings)
      .sendPush(push)
      .catch((e: unknown) => e)) as ProviderError;
    expect(outage.retryable).toBe(true);

    calls = [];
    replies = [
      { status: 200, body: { access_token: 'old', expires_in: 3600 } },
      { status: 401 },
      { status: 200, body: { access_token: 'fresh', expires_in: 3600 } },
      { status: 200, body: { name: 'projects/sevanest-test/messages/m9' } },
    ];
    const result = await new FcmPushProvider(settings).sendPush(push);
    expect(result.providerMessageId).toContain('m9');
    expect((calls[3].init.headers as Record<string, string>).Authorization).toBe('Bearer fresh');

    replies = [
      { status: 200, body: { access_token: 'ok', expires_in: 3600 } },
      { status: 200, body: {} },
    ];
    await expect(new FcmPushProvider(settings).sendPush(push)).rejects.toThrow('did not accept');
  });

  it('validates the service account JSON without echoing it', () => {
    expect(parseFcmServiceAccount(JSON.stringify(account)).project_id).toBe('sevanest-test');
    expect(() => parseFcmServiceAccount('not json')).toThrow('not valid JSON');
    expect(() => parseFcmServiceAccount(JSON.stringify({ project_id: 'x' }))).toThrow(
      'must contain',
    );
    try {
      parseFcmServiceAccount(JSON.stringify({ ...account, client_email: '' }));
    } catch (error) {
      expect((error as Error).message).not.toContain('PRIVATE KEY');
    }
  });
});

describe('default in-app templates', () => {
  it('cover real events, use only placeholders the event provides, and never repeat an event', () => {
    const seen = new Set<string>();
    for (const t of DEFAULT_IN_APP_TEMPLATES) {
      expect(Object.keys(EVENT_PARAMS)).toContain(t.event);
      expect(seen.has(t.event)).toBe(false);
      seen.add(t.event);
      const allowed = EVENT_PARAMS[t.event];
      for (const placeholder of [...placeholdersOf(t.body), ...placeholdersOf(t.title)]) {
        expect(allowed).toContain(placeholder);
      }
      expect(t.body.length).toBeLessThanOrEqual(1000);
    }
  });

  it('exist for every customer- or worker-facing event (staff alerts use the alert inbox instead)', () => {
    const covered = new Set(DEFAULT_IN_APP_TEMPLATES.map((t) => t.event));
    const staffOnly = new Set(['PAYMENT_EXCEPTION_ALERT']);
    for (const event of Object.keys(EVENT_PARAMS)) {
      if (!staffOnly.has(event)) expect(covered.has(event as never)).toBe(true);
    }
  });
});
