import { createVerify, generateKeyPairSync } from 'node:crypto';
import {
  DEFAULT_IN_APP_TEMPLATES,
  DEFAULT_PUSH_TEMPLATES,
} from '../../modules/notifications/default-templates';
import { EVENT_PARAMS } from '../../common/outbox/notification-events';
import { placeholdersOf } from '../../modules/notifications/notifications.service';
import { ProviderError } from '../provider-error';
import { InvalidDeviceTokenError } from './notification-providers.interface';
import {
  DEFAULT_FIREBASE_PROJECT_ID,
  FcmPushProvider,
  isInvalidTokenRejection,
  parseFcmServiceAccount,
  resolveFcmServiceAccount,
} from './fcm.provider';

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
      android: {
        priority: 'HIGH',
        notification: {
          channel_id: 'sevanest_high_importance',
          priority: 'PRIORITY_MAX',
          default_sound: true,
          default_vibrate_timings: true,
        },
      },
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

  it.each([
    [404, { error: { status: 'NOT_FOUND', details: [{ errorCode: 'UNREGISTERED' }] } }],
    [404, { error: { status: 'NOT_FOUND' } }],
    [
      400,
      {
        error: {
          status: 'INVALID_ARGUMENT',
          message: 'The registration token is not a valid FCM registration token',
        },
      },
    ],
  ])('classifies HTTP %s %j as a dead device token without echoing it', async (status, body) => {
    replies = [
      { status: 200, body: { access_token: 'ya29.token', expires_in: 3600 } },
      { status, body },
    ];
    const error = (await new FcmPushProvider(settings)
      .sendPush(push)
      .catch((e: unknown) => e)) as ProviderError;
    expect(error).toBeInstanceOf(InvalidDeviceTokenError);
    expect(error.retryable).toBe(false);
    expect(JSON.stringify(error.cause)).not.toContain('device-token-1');
    expect(error.message).not.toContain('device-token-1');
  });

  it('does not call a token dead for other rejections (bad payload, wrong credentials, outage)', async () => {
    for (const [status, body] of [
      [400, { error: { status: 'INVALID_ARGUMENT', message: 'Invalid JSON payload' } }],
      [403, { error: { status: 'PERMISSION_DENIED' } }],
      [503, {}],
    ] as const) {
      replies = [
        { status: 200, body: { access_token: 'ya29.token', expires_in: 3600 } },
        { status, body },
      ];
      const error = (await new FcmPushProvider(settings)
        .sendPush(push)
        .catch((e: unknown) => e)) as ProviderError;
      expect(error).toBeInstanceOf(ProviderError);
      expect(error).not.toBeInstanceOf(InvalidDeviceTokenError);
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

  it('verifies credentials by exchanging the JWT only, without sending a message or exposing secrets', async () => {
    replies = [{ status: 200, body: { access_token: 'ya29.verify', expires_in: 3599 } }];
    const provider = new FcmPushProvider(settings);

    await expect(provider.verifyCredentials()).resolves.toEqual({
      projectId: 'sevanest-test',
      expiresInSeconds: 3599,
    });
    expect(calls.map((c) => c.url)).toEqual(['https://oauth.test/token']);
    expect(JSON.stringify(calls)).not.toContain('PRIVATE KEY');
    expect(JSON.stringify(calls)).not.toContain('ya29.verify');
  });

  it('verifies credentials with a fresh exchange even when a token is already cached', async () => {
    replies = [
      { status: 200, body: { access_token: 'ya29.first', expires_in: 3600 } },
      { status: 200, body: { name: 'projects/sevanest-test/messages/m1' } },
      { status: 200, body: { access_token: 'ya29.second', expires_in: 1200 } },
    ];
    const provider = new FcmPushProvider(settings);
    await provider.sendPush(push);
    await expect(provider.verifyCredentials()).resolves.toEqual({
      projectId: 'sevanest-test',
      expiresInSeconds: 1200,
    });
    expect(calls.filter((c) => c.url === 'https://oauth.test/token')).toHaveLength(2);
    expect(calls.some((c) => c.url.includes('messages:send'))).toBe(true);
  });

  it('reports bad credentials without leaking the key or the token in the error', async () => {
    replies = [
      {
        status: 400,
        body: { error: 'invalid_grant', error_description: 'Invalid JWT Signature.' },
      },
    ];
    const error = (await new FcmPushProvider(settings)
      .verifyCredentials()
      .catch((e: unknown) => e)) as ProviderError;
    expect(error).toBeInstanceOf(ProviderError);
    expect(error.retryable).toBe(false);
    expect(error.message).not.toContain('PRIVATE KEY');
    expect(error.message).not.toContain('ya29');
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

  it('resolves discrete Firebase credentials defaulting to sevanest-47cef and replaces escaped newlines', () => {
    const escapedKey = account.private_key.replace(/\n/g, '\\n');
    const resolved = resolveFcmServiceAccount({
      clientEmail: account.client_email,
      privateKey: escapedKey,
    });
    expect(resolved.project_id).toBe(DEFAULT_FIREBASE_PROJECT_ID);
    expect(resolved.project_id).toBe('sevanest-47cef');
    expect(resolved.client_email).toBe(account.client_email);
    expect(resolved.private_key).toBe(account.private_key);

    const explicit = resolveFcmServiceAccount({
      projectId: 'my-custom-project',
      clientEmail: account.client_email,
      privateKey: account.private_key,
    });
    expect(explicit.project_id).toBe('my-custom-project');

    expect(() => resolveFcmServiceAccount({})).toThrow('FCM configuration requires');
  });

  it('identifies registration token error codes as invalid token rejections for dead token cleanup', () => {
    const errUnregistered = new ProviderError('fcm', 'failed', false, {
      status: 400,
      json: {
        error: {
          status: 'INVALID_ARGUMENT',
          message: 'The registration token is not a valid FCM registration token',
          details: [{ errorCode: 'messaging/registration-token-not-registered' }],
        },
      },
    });
    expect(isInvalidTokenRejection(errUnregistered)).toBe(true);

    const errInvalidToken = new ProviderError('fcm', 'failed', false, {
      status: 400,
      json: {
        error: {
          status: 'INVALID_ARGUMENT',
          message: 'messaging/invalid-registration-token',
        },
      },
    });
    expect(isInvalidTokenRejection(errInvalidToken)).toBe(true);
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

describe('default push templates (D-104)', () => {
  it('cover confirmed core workflows, use only allowed placeholders, and never repeat an event', () => {
    const seen = new Set<string>();
    for (const t of DEFAULT_PUSH_TEMPLATES) {
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
});
