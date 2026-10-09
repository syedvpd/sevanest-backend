import '../support/env-api-integration';
import { ProviderError } from '../../src/integrations/provider-error';
import { TokenService } from '../../src/modules/auth/token.service';
import type { SmsProvider } from '../../src/integrations/notifications/notification-providers.interface';
import {
  ADMIN_PASSWORD,
  ApiApp,
  adminLogin,
  bearer,
  clearAdminLockout,
  createAdmin,
  createApiApp,
  loginAdmin,
  loginWithOtp,
  otpFromSms,
  otpKeyId,
  randomIp,
  randomMobile,
  requestOtp,
  sessionIdFromToken,
} from '../support/api-app';

/**
 * Auth module against the REAL PostgreSQL + Redis (dedicated test database), through the HTTP API.
 * OTP limits in these tests come from test/support/test-environment.ts (test values, not approved business values):
 * 6-digit OTP, 3 verify attempts, 30 s resend cooldown, 5 sends/mobile/window, 20 requests/IP/window.
 */
describe('Auth API (integration)', () => {
  let api: ApiApp;

  beforeAll(async () => {
    api = await createApiApp();
  });
  afterAll(async () => {
    await api.close();
  });

  async function clearCooldown(mobile: string): Promise<void> {
    await api.redis.client.del(`auth:otp:cooldown:${otpKeyId(mobile)}`);
  }

  const wrongOtpFor = (real: string): string => (real === '000000' ? '111111' : '000000');
  const verifyBody = (mobile: string, otp: string, extra: object = {}) => ({
    mobile,
    appType: 'CUSTOMER',
    otp,
    ...extra,
  });

  describe('POST /auth/otp/request', () => {
    it('sends an OTP, reports expiry/resend timing and never returns the OTP', async () => {
      const mobile = randomMobile();
      const res = await requestOtp(api, mobile);
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ expiresInSeconds: 300, resendAfterSeconds: 30 });
      const otp = otpFromSms(api, mobile);
      expect(otp).toMatch(/^\d{6}$/);
      expect(JSON.stringify(res.body)).not.toContain(otp);
      expect(JSON.stringify(res.headers)).not.toContain(otp);
    });

    it('stores only a keyed hash with a TTL in Redis (no raw OTP)', async () => {
      const mobile = randomMobile();
      await requestOtp(api, mobile);
      const otp = otpFromSms(api, mobile);
      const key = `auth:otp:code:${otpKeyId(mobile)}`;
      const stored = await api.redis.client.hgetall(key);
      expect(stored.h).toMatch(/^[0-9a-f]{64}$/);
      expect(Object.values(stored)).not.toContain(otp);
      expect(Object.keys(stored).sort()).toEqual(['a', 'h']);
      const ttl = await api.redis.client.ttl(key);
      expect(ttl).toBeGreaterThan(0);
      expect(ttl).toBeLessThanOrEqual(300);
      // The mobile number itself is not part of any Redis key name.
      const keys = await api.redis.client.keys('auth:otp:*');
      expect(keys.some((k) => k.includes(mobile.slice(3)))).toBe(false);
    });

    it.each([
      ['letters', { mobile: 'not-a-number', appType: 'CUSTOMER' }],
      ['too short', { mobile: '98765', appType: 'CUSTOMER' }],
      ['non-Indian prefix', { mobile: '5123456789', appType: 'CUSTOMER' }],
      ['missing mobile', { appType: 'CUSTOMER' }],
      ['bad app type', { mobile: '9876543210', appType: 'ADMIN' }],
      ['missing app type', { mobile: '9876543210' }],
    ])('rejects %s with VALIDATION_FAILED', async (_name, body) => {
      const res = await api
        .http()
        .post('/api/v1/auth/otp/request')
        .set('X-Forwarded-For', randomIp())
        .send(body);
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('VALIDATION_FAILED');
      expect(res.body.requestId).toBeDefined();
    });

    it('treats +91 / 91 / 0 / bare 10-digit forms of the same number as one account', async () => {
      const mobile = randomMobile();
      const ten = mobile.slice(3);
      const first = await requestOtp(api, `0${ten}`);
      expect(first.status).toBe(200);
      expect(api.sms.lastTo(mobile)).toBeDefined(); // delivered to the canonical E.164 number
      await clearCooldown(mobile);
      const second = await requestOtp(api, `91${ten}`);
      expect(second.status).toBe(200);
    });

    it('enforces the resend cooldown (429 OTP_RESEND_COOLDOWN with retry hint)', async () => {
      const mobile = randomMobile();
      await requestOtp(api, mobile);
      const res = await requestOtp(api, mobile);
      expect(res.status).toBe(429);
      expect(res.body.code).toBe('OTP_RESEND_COOLDOWN');
      expect(Number(res.body.details[0].messages[0])).toBeGreaterThan(0);
    });

    it('enforces the per-mobile send limit per window', async () => {
      const mobile = randomMobile();
      for (let i = 0; i < 5; i++) {
        const ok = await requestOtp(api, mobile);
        expect(ok.status).toBe(200);
        await clearCooldown(mobile);
      }
      const res = await requestOtp(api, mobile);
      expect(res.status).toBe(429);
      expect(res.body.code).toBe('OTP_SEND_LIMIT');
    });

    it('enforces the per-IP request limit across different numbers', async () => {
      const ip = randomIp();
      for (let i = 0; i < 20; i++) {
        expect((await requestOtp(api, randomMobile(), 'CUSTOMER', ip)).status).toBe(200);
      }
      const res = await requestOtp(api, randomMobile(), 'CUSTOMER', ip);
      expect(res.status).toBe(429);
      expect(res.body.code).toBe('OTP_RATE_LIMITED');
    });

    it('refuses suspended accounts BEFORE sending anything', async () => {
      const session = await loginWithOtp(api);
      await api.prisma.user.update({
        where: { id: session.userId },
        data: { status: 'SUSPENDED' },
      });
      await clearCooldown(session.mobile!);
      const sentBefore = api.sms.sent.length;
      const res = await requestOtp(api, session.mobile!);
      expect(res.status).toBe(403);
      expect(res.body.code).toBe('ACCOUNT_SUSPENDED');
      expect(api.sms.sent.length).toBe(sentBefore);
    });

    it('refuses a number registered under the other account type (one mobile = one account)', async () => {
      const session = await loginWithOtp(api, { appType: 'CUSTOMER' });
      await clearCooldown(session.mobile!);
      const res = await requestOtp(api, session.mobile!, 'WORKER');
      expect(res.status).toBe(409);
      expect(res.body.code).toBe('ACCOUNT_TYPE_MISMATCH');
    });
  });

  describe('SMS provider failure', () => {
    it('answers 503 SMS_NOT_CONFIGURED for a non-retryable provider error and lets the user retry at once', async () => {
      const failing: SmsProvider = {
        sendSms: () => Promise.reject(new ProviderError('sms', 'not configured', false)),
      };
      const local = await createApiApp({ smsProvider: failing });
      try {
        const mobile = randomMobile();
        const first = await requestOtp(local, mobile);
        expect(first.status).toBe(503);
        expect(first.body.code).toBe('SMS_NOT_CONFIGURED');
        // No verifier is left behind and no cooldown blocks the retry.
        expect(await local.redis.client.exists(`auth:otp:code:${otpKeyId(mobile)}`)).toBe(0);
        const retry = await requestOtp(local, mobile);
        expect(retry.body.code).toBe('SMS_NOT_CONFIGURED');
      } finally {
        await local.close();
      }
    });

    it('answers 503 SMS_DELIVERY_FAILED for a transient provider error', async () => {
      const flaky: SmsProvider = {
        sendSms: () => Promise.reject(new ProviderError('sms', 'timeout', true)),
      };
      const local = await createApiApp({ smsProvider: flaky });
      try {
        const res = await requestOtp(local, randomMobile());
        expect(res.status).toBe(503);
        expect(res.body.code).toBe('SMS_DELIVERY_FAILED');
        expect(JSON.stringify(res.body)).not.toMatch(/timeout|stack/i);
      } finally {
        await local.close();
      }
    });
  });

  describe('POST /auth/otp/verify', () => {
    it('creates the account on first verification and starts a session', async () => {
      const session = await loginWithOtp(api);
      expect(session.isNewUser).toBe(true);
      expect(session.type).toBe('CUSTOMER');
      expect(session.accessToken.split('.')).toHaveLength(3);
      const user = await api.prisma.user.findUniqueOrThrow({ where: { id: session.userId } });
      expect(user.mobile).toBe(session.mobile);
      expect(user.status).toBe('ACTIVE');
      expect(user.passwordHash).toBeNull();
    });

    it('returns the standard token body without secrets and with a bounded access token', async () => {
      const mobile = randomMobile();
      await requestOtp(api, mobile);
      const otp = otpFromSms(api, mobile);
      const res = await api
        .http()
        .post('/api/v1/auth/otp/verify')
        .set('X-Forwarded-For', randomIp())
        .send(verifyBody(mobile, otp));
      expect(res.status).toBe(200);
      expect(Object.keys(res.body as object).sort()).toEqual([
        'accessToken',
        'expiresIn',
        'refreshToken',
        'tokenType',
        'user',
      ]);
      expect(res.body.tokenType).toBe('Bearer');
      expect(res.body.expiresIn).toBe(900);
      expect(JSON.stringify(res.body)).not.toContain(otp);
      const claims = JSON.parse(
        Buffer.from(
          (res.body as { accessToken: string }).accessToken.split('.')[1],
          'base64url',
        ).toString(),
      ) as object;
      expect(Object.keys(claims).sort()).toEqual(['aud', 'exp', 'iat', 'iss', 'sid', 'sub']);
    });

    it('logs an existing user in again with isNewUser=false', async () => {
      const first = await loginWithOtp(api);
      await clearCooldown(first.mobile!);
      const second = await loginWithOtp(api, { mobile: first.mobile });
      expect(second.isNewUser).toBe(false);
      expect(second.userId).toBe(first.userId);
      expect(second.sessionId).not.toBe(first.sessionId);
    });

    it('registers a worker when the Worker app signs in', async () => {
      const worker = await loginWithOtp(api, { appType: 'WORKER' });
      expect(worker.type).toBe('WORKER');
    });

    it('treats the OTP as single use', async () => {
      const mobile = randomMobile();
      await requestOtp(api, mobile);
      const otp = otpFromSms(api, mobile);
      await api
        .http()
        .post('/api/v1/auth/otp/verify')
        .set('X-Forwarded-For', randomIp())
        .send(verifyBody(mobile, otp))
        .expect(200);
      const replay = await api
        .http()
        .post('/api/v1/auth/otp/verify')
        .set('X-Forwarded-For', randomIp())
        .send(verifyBody(mobile, otp));
      expect(replay.status).toBe(400);
      expect(replay.body.code).toBe('OTP_EXPIRED');
    });

    it('rejects a wrong OTP, reports remaining attempts, and still accepts the right one afterwards', async () => {
      const mobile = randomMobile();
      await requestOtp(api, mobile);
      const otp = otpFromSms(api, mobile);
      const wrong = await api
        .http()
        .post('/api/v1/auth/otp/verify')
        .send(verifyBody(mobile, wrongOtpFor(otp)));
      expect(wrong.status).toBe(400);
      expect(wrong.body.code).toBe('OTP_INVALID');
      expect(wrong.body.message).toContain('2 attempt(s) remaining');
      await api.http().post('/api/v1/auth/otp/verify').send(verifyBody(mobile, otp)).expect(200);
    });

    it('rejects an expired or never-requested OTP', async () => {
      const mobile = randomMobile();
      const never = await api
        .http()
        .post('/api/v1/auth/otp/verify')
        .send(verifyBody(mobile, '123456'));
      expect(never.status).toBe(400);
      expect(never.body.code).toBe('OTP_EXPIRED');

      await requestOtp(api, mobile);
      const otp = otpFromSms(api, mobile);
      await api.redis.client.del(`auth:otp:code:${otpKeyId(mobile)}`); // what the TTL does when it elapses
      const expired = await api
        .http()
        .post('/api/v1/auth/otp/verify')
        .send(verifyBody(mobile, otp));
      expect(expired.status).toBe(400);
      expect(expired.body.code).toBe('OTP_EXPIRED');
    });

    it('locks the number after the attempt limit, even for the correct OTP and for new requests', async () => {
      const mobile = randomMobile();
      await requestOtp(api, mobile);
      const otp = otpFromSms(api, mobile);
      const bad = wrongOtpFor(otp);
      const post = (code: string) =>
        api.http().post('/api/v1/auth/otp/verify').send(verifyBody(mobile, code));
      expect((await post(bad)).body.code).toBe('OTP_INVALID');
      expect((await post(bad)).body.code).toBe('OTP_INVALID');
      const third = await post(bad);
      expect(third.status).toBe(429);
      expect(third.body.code).toBe('OTP_ATTEMPTS_EXCEEDED');

      const correctButLocked = await post(otp);
      expect(correctButLocked.status).toBe(429);
      expect(correctButLocked.body.code).toBe('OTP_LOCKED');

      await clearCooldown(mobile);
      const newRequest = await requestOtp(api, mobile);
      expect(newRequest.status).toBe(429);
      expect(newRequest.body.code).toBe('OTP_LOCKED');
      expect(await api.prisma.user.count({ where: { mobile } })).toBe(0); // nothing was created
    });

    it('cannot exceed the attempt limit with parallel guesses', async () => {
      const mobile = randomMobile();
      await requestOtp(api, mobile);
      const bad = wrongOtpFor(otpFromSms(api, mobile));
      const results = await Promise.all(
        Array.from({ length: 10 }, () =>
          api.http().post('/api/v1/auth/otp/verify').send(verifyBody(mobile, bad)),
        ),
      );
      const codes = results.map((r) => r.body.code as string);
      expect(results.every((r) => r.status !== 200)).toBe(true);
      expect(codes.filter((c) => c === 'OTP_INVALID').length).toBeLessThanOrEqual(2);
      expect(codes.filter((c) => c === 'OTP_ATTEMPTS_EXCEEDED')).toHaveLength(1);
    });

    it('lets exactly one of several parallel verifications of the same OTP succeed', async () => {
      const mobile = randomMobile();
      await requestOtp(api, mobile);
      const otp = otpFromSms(api, mobile);
      const results = await Promise.all(
        Array.from({ length: 6 }, () =>
          api.http().post('/api/v1/auth/otp/verify').send(verifyBody(mobile, otp)),
        ),
      );
      expect(results.filter((r) => r.status === 200)).toHaveLength(1);
      expect(results.filter((r) => r.status === 400 && r.body.code === 'OTP_EXPIRED')).toHaveLength(
        5,
      );
      expect(await api.prisma.user.count({ where: { mobile } })).toBe(1);
      const user = await api.prisma.user.findUniqueOrThrow({ where: { mobile } });
      expect(await api.prisma.session.count({ where: { userId: user.id } })).toBe(1);
    });

    it('rejects a valid OTP for an account suspended after the OTP was issued', async () => {
      const first = await loginWithOtp(api);
      await clearCooldown(first.mobile!);
      await requestOtp(api, first.mobile!);
      const otp = otpFromSms(api, first.mobile!);
      await api.prisma.user.update({ where: { id: first.userId }, data: { status: 'SUSPENDED' } });
      const res = await api
        .http()
        .post('/api/v1/auth/otp/verify')
        .send(verifyBody(first.mobile!, otp));
      expect(res.status).toBe(403);
      expect(res.body.code).toBe('ACCOUNT_SUSPENDED');
      expect(res.body).not.toHaveProperty('accessToken');
    });

    it('validates the OTP shape and device fields', async () => {
      const mobile = randomMobile();
      for (const body of [
        verifyBody(mobile, 'abcdef'),
        verifyBody(mobile, '12'),
        verifyBody(mobile, '123456', { deviceId: 'bad id with spaces' }),
        verifyBody(mobile, '123456', { deviceName: 'x'.repeat(101) }),
      ]) {
        const res = await api.http().post('/api/v1/auth/otp/verify').send(body);
        expect(res.status).toBe(400);
        expect(res.body.code).toBe('VALIDATION_FAILED');
      }
    });
  });

  describe('sessions and access tokens', () => {
    it('accepts a valid access token and exposes the caller identity', async () => {
      const session = await loginWithOtp(api);
      const res = await api.http().get('/api/v1/users/me').set('Authorization', bearer(session));
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({
        id: session.userId,
        type: 'CUSTOMER',
        status: 'ACTIVE',
        roles: [],
        permissions: [],
      });
      expect(JSON.stringify(res.body)).not.toMatch(/passwordHash|refresh|otp/i);
    });

    it.each([
      ['no header', undefined],
      ['not a bearer scheme', 'Basic abc'],
      ['garbage token', 'Bearer not.a.jwt'],
    ])('rejects %s with 401 UNAUTHENTICATED', async (_name, header) => {
      const req = api.http().get('/api/v1/users/me');
      if (header) req.set('Authorization', header);
      const res = await req;
      expect(res.status).toBe(401);
      expect(res.body.code).toBe('UNAUTHENTICATED');
    });

    it('rejects a tampered signature and a token for an unknown session', async () => {
      const session = await loginWithOtp(api);
      const tampered = `${session.accessToken.slice(0, -2)}xx`;
      await api
        .http()
        .get('/api/v1/users/me')
        .set('Authorization', `Bearer ${tampered}`)
        .expect(401);

      const forged = await api.app
        .get(TokenService)
        .signAccessToken({ sub: session.userId, sid: '00000000-0000-7000-8000-000000000000' });
      await api.http().get('/api/v1/users/me').set('Authorization', `Bearer ${forged}`).expect(401);
    });

    it('rejects an expired session (access and refresh)', async () => {
      const session = await loginWithOtp(api);
      await api.prisma.session.update({
        where: { id: session.sessionId },
        data: { expiresAt: new Date(Date.now() - 1000) },
      });
      await api.http().get('/api/v1/users/me').set('Authorization', bearer(session)).expect(401);
      const refresh = await api
        .http()
        .post('/api/v1/auth/token/refresh')
        .send({ refreshToken: session.refreshToken });
      expect(refresh.status).toBe(401);
      expect(refresh.body.code).toBe('REFRESH_TOKEN_INVALID');
    });

    it('lists my sessions, flags the current one and keeps one active session per device', async () => {
      const mobile = randomMobile();
      const first = await loginWithOtp(api, { mobile, deviceId: 'device-aaaa-1111' });
      await clearCooldown(mobile);
      const sameDevice = await loginWithOtp(api, { mobile, deviceId: 'device-aaaa-1111' });
      await clearCooldown(mobile);
      const otherDevice = await loginWithOtp(api, { mobile, deviceId: 'device-bbbb-2222' });

      // The first login on the same device was replaced.
      await api.http().get('/api/v1/users/me').set('Authorization', bearer(first)).expect(401);
      const list = await api
        .http()
        .get('/api/v1/auth/sessions')
        .set('Authorization', bearer(sameDevice));
      expect(list.status).toBe(200);
      expect(list.body).toHaveLength(2);
      expect(list.body.filter((s: { current: boolean }) => s.current)).toHaveLength(1);
      expect(list.body.map((s: { id: string }) => s.id).sort()).toEqual(
        [sameDevice.sessionId, otherDevice.sessionId].sort(),
      );
      expect(JSON.stringify(list.body)).not.toMatch(/refresh|hash|token/i);
    });

    it('lets a user revoke another of their own sessions, and revoked sessions stop working', async () => {
      const mobile = randomMobile();
      const a = await loginWithOtp(api, { mobile, deviceId: 'device-aaaa-1111' });
      await clearCooldown(mobile);
      const b = await loginWithOtp(api, { mobile, deviceId: 'device-bbbb-2222' });
      await api
        .http()
        .delete(`/api/v1/auth/sessions/${a.sessionId}`)
        .set('Authorization', bearer(b))
        .expect(204);
      await api.http().get('/api/v1/users/me').set('Authorization', bearer(a)).expect(401);
      const refresh = await api
        .http()
        .post('/api/v1/auth/token/refresh')
        .send({ refreshToken: a.refreshToken });
      expect(refresh.status).toBe(401);
      await api.http().get('/api/v1/users/me').set('Authorization', bearer(b)).expect(200);
    });

    it("does not let a user revoke (or learn about) another user's session", async () => {
      const victim = await loginWithOtp(api);
      const attacker = await loginWithOtp(api);
      const res = await api
        .http()
        .delete(`/api/v1/auth/sessions/${victim.sessionId}`)
        .set('Authorization', bearer(attacker));
      expect(res.status).toBe(404);
      expect(res.body.code).toBe('SESSION_NOT_FOUND');
      await api.http().get('/api/v1/users/me').set('Authorization', bearer(victim)).expect(200);
      const unknown = await api
        .http()
        .delete('/api/v1/auth/sessions/00000000-0000-7000-8000-000000000000')
        .set('Authorization', bearer(attacker));
      expect(unknown.status).toBe(404); // indistinguishable from "not yours"
    });

    it('validates the session id format', async () => {
      const session = await loginWithOtp(api);
      await api
        .http()
        .delete('/api/v1/auth/sessions/not-a-uuid')
        .set('Authorization', bearer(session))
        .expect(400);
    });

    it('requires authentication for session endpoints', async () => {
      await api.http().get('/api/v1/auth/sessions').expect(401);
      await api.http().post('/api/v1/auth/logout').expect(401);
    });
  });

  describe('POST /auth/token/refresh', () => {
    it('rotates the refresh token: the new pair works, the old token does not', async () => {
      const session = await loginWithOtp(api);
      const res = await api
        .http()
        .post('/api/v1/auth/token/refresh')
        .send({ refreshToken: session.refreshToken });
      expect(res.status).toBe(200);
      expect(res.body.refreshToken).not.toBe(session.refreshToken);
      expect(res.body.user).toMatchObject({
        id: session.userId,
        type: 'CUSTOMER',
        isNewUser: false,
      });
      await api
        .http()
        .get('/api/v1/users/me')
        .set('Authorization', `Bearer ${res.body.accessToken}`)
        .expect(200);
      expect(sessionIdFromToken((res.body as { accessToken: string }).accessToken)).toBe(
        session.sessionId,
      ); // same device session

      const stored = await api.prisma.session.findUniqueOrThrow({
        where: { id: session.sessionId },
      });
      expect(stored.refreshTokenHash).not.toContain(res.body.refreshToken); // only hashes are stored
      expect(stored.refreshTokenHash).toMatch(/^[0-9a-f]{64}$/);
      expect(stored.lastUsedAt).not.toBeNull();
    });

    it('treats replay of a rotated token as theft: revokes the session and audits the event', async () => {
      const session = await loginWithOtp(api);
      const rotated = await api
        .http()
        .post('/api/v1/auth/token/refresh')
        .send({ refreshToken: session.refreshToken });
      expect(rotated.status).toBe(200);

      const replay = await api
        .http()
        .post('/api/v1/auth/token/refresh')
        .send({ refreshToken: session.refreshToken });
      expect(replay.status).toBe(401);
      expect(replay.body.code).toBe('REFRESH_TOKEN_INVALID');

      // The whole session is gone, including the legitimate newest token and its access token.
      await api
        .http()
        .get('/api/v1/users/me')
        .set('Authorization', `Bearer ${rotated.body.accessToken}`)
        .expect(401);
      const newest = await api
        .http()
        .post('/api/v1/auth/token/refresh')
        .send({ refreshToken: rotated.body.refreshToken });
      expect(newest.status).toBe(401);

      const stored = await api.prisma.session.findUniqueOrThrow({
        where: { id: session.sessionId },
      });
      expect(stored.revokedAt).not.toBeNull();
      const audit = await api.prisma.auditLog.findMany({
        where: { action: 'auth.refresh_token_reuse', entityId: session.sessionId },
      });
      expect(audit).toHaveLength(1);
      expect(audit[0].actorId).toBe(session.userId);
      expect(JSON.stringify(audit[0].metadata)).not.toContain(session.refreshToken);
    });

    it('lets only one of several parallel refreshes with the same token win', async () => {
      const session = await loginWithOtp(api);
      const results = await Promise.all(
        Array.from({ length: 5 }, () =>
          api
            .http()
            .post('/api/v1/auth/token/refresh')
            .send({ refreshToken: session.refreshToken }),
        ),
      );
      expect(results.filter((r) => r.status === 200)).toHaveLength(1);
      expect(results.filter((r) => r.status === 401)).toHaveLength(4);
      // Deterministic policy: the losers replayed a rotated token, so the session ends revoked.
      const stored = await api.prisma.session.findUniqueOrThrow({
        where: { id: session.sessionId },
      });
      expect(stored.revokedAt).not.toBeNull();
    });

    it('rejects unknown, malformed and missing tokens without detail', async () => {
      const unknown = await api
        .http()
        .post('/api/v1/auth/token/refresh')
        .send({ refreshToken: 'x'.repeat(64) });
      expect(unknown.status).toBe(401);
      expect(unknown.body.code).toBe('REFRESH_TOKEN_INVALID');
      expect(
        (await api.http().post('/api/v1/auth/token/refresh').send({ refreshToken: 'short' }))
          .status,
      ).toBe(400);
      expect((await api.http().post('/api/v1/auth/token/refresh').send({})).status).toBe(400);
    });

    it('refuses to refresh for a suspended account and revokes the session', async () => {
      const session = await loginWithOtp(api);
      await api.prisma.user.update({
        where: { id: session.userId },
        data: { status: 'SUSPENDED' },
      });
      const res = await api
        .http()
        .post('/api/v1/auth/token/refresh')
        .send({ refreshToken: session.refreshToken });
      expect(res.status).toBe(403);
      expect(res.body.code).toBe('ACCOUNT_SUSPENDED');
      expect(
        (await api.prisma.session.findUniqueOrThrow({ where: { id: session.sessionId } }))
          .revokedAt,
      ).not.toBeNull();
    });
  });

  describe('POST /auth/logout and device tokens', () => {
    it('revokes the session: access and refresh tokens stop working', async () => {
      const session = await loginWithOtp(api);
      await api
        .http()
        .post('/api/v1/auth/logout')
        .set('Authorization', bearer(session))
        .expect(204);
      await api.http().get('/api/v1/users/me').set('Authorization', bearer(session)).expect(401);
      const refresh = await api
        .http()
        .post('/api/v1/auth/token/refresh')
        .send({ refreshToken: session.refreshToken });
      expect(refresh.status).toBe(401);
      await api
        .http()
        .post('/api/v1/auth/logout')
        .set('Authorization', bearer(session))
        .expect(401); // already revoked
      const audit = await api.prisma.auditLog.count({
        where: { action: 'auth.logout', entityId: session.sessionId },
      });
      expect(audit).toBe(1);
    });

    it('binds a push token to the session and removes it on logout', async () => {
      const session = await loginWithOtp(api);
      const token = `fcm-${randomMobile()}`;
      await api
        .http()
        .put('/api/v1/auth/device-token')
        .set('Authorization', bearer(session))
        .send({ token, platform: 'ANDROID' })
        .expect(204);
      const bound = await api.prisma.deviceToken.findUniqueOrThrow({
        where: { sessionId: session.sessionId },
      });
      expect(bound.token).toBe(token);
      expect(bound.userId).toBe(session.userId);

      await api
        .http()
        .post('/api/v1/auth/logout')
        .set('Authorization', bearer(session))
        .expect(204);
      expect(await api.prisma.deviceToken.count({ where: { sessionId: session.sessionId } })).toBe(
        0,
      );
    });

    it('moves a push token to the newest session that registers it (reinstall / shared device)', async () => {
      const token = `fcm-${randomMobile()}`;
      const first = await loginWithOtp(api);
      const second = await loginWithOtp(api);
      await api
        .http()
        .put('/api/v1/auth/device-token')
        .set('Authorization', bearer(first))
        .send({ token, platform: 'IOS' })
        .expect(204);
      await api
        .http()
        .put('/api/v1/auth/device-token')
        .set('Authorization', bearer(second))
        .send({ token, platform: 'IOS' })
        .expect(204);
      const rows = await api.prisma.deviceToken.findMany({ where: { token } });
      expect(rows).toHaveLength(1);
      expect(rows[0].sessionId).toBe(second.sessionId);
    });

    it('validates the device token body and refuses admins', async () => {
      const session = await loginWithOtp(api);
      await api
        .http()
        .put('/api/v1/auth/device-token')
        .set('Authorization', bearer(session))
        .send({ token: '', platform: 'ANDROID' })
        .expect(400);
      await api
        .http()
        .put('/api/v1/auth/device-token')
        .set('Authorization', bearer(session))
        .send({ token: 'abc', platform: 'WINDOWS' })
        .expect(400);
      const admin = await loginAdmin(api);
      await api
        .http()
        .put('/api/v1/auth/device-token')
        .set('Authorization', bearer(admin))
        .send({ token: 'abc', platform: 'ANDROID' })
        .expect(403);
    });
  });

  describe('admin credential login', () => {
    let admin: Awaited<ReturnType<typeof createAdmin>>;

    beforeAll(async () => {
      admin = await createAdmin(api);
    });

    it('logs in with email and password and returns roles, never the password or its hash', async () => {
      const res = await adminLogin(api, admin);
      expect(res.status).toBe(200);
      expect(res.body.user).toMatchObject({
        id: admin.id,
        type: 'ADMIN',
        roles: ['SUPER_ADMIN'],
        isNewUser: false,
      });
      expect(JSON.stringify(res.body)).not.toMatch(/password|scrypt/i);
      const me = await api
        .http()
        .get('/api/v1/users/me')
        .set('Authorization', `Bearer ${res.body.accessToken}`);
      expect(me.body.permissions).toEqual(
        expect.arrayContaining(['admin.manage_users', 'customer.view']),
      );
    });

    it('normalises the email (case/whitespace)', async () => {
      const res = await adminLogin(api, {
        email: `  ${admin.email.toUpperCase()} `,
        password: admin.password,
      });
      expect(res.status).toBe(200);
    });

    it('answers identically for a wrong password and for an unknown email', async () => {
      const wrong = await adminLogin(api, {
        email: admin.email,
        password: 'definitely-not-the-password',
      });
      const unknown = await adminLogin(api, {
        email: `nobody.${Date.now()}@example.test`,
        password: 'definitely-not-the-password',
      });
      for (const res of [wrong, unknown]) {
        expect(res.status).toBe(401);
        expect(res.body.code).toBe('INVALID_CREDENTIALS');
      }
      expect(wrong.body.message).toBe(unknown.body.message);
    });

    it('does not let customers or workers (no password) authenticate through the admin endpoint', async () => {
      const customer = await loginWithOtp(api);
      const row = await api.prisma.user.findUniqueOrThrow({ where: { id: customer.userId } });
      const res = await adminLogin(api, {
        email: row.email ?? 'none@example.test',
        password: 'whatever-whatever',
      });
      expect(res.status).toBe(401);
    });

    it('validates the payload', async () => {
      for (const body of [
        {},
        { email: 'not-an-email', password: 'x' },
        { email: 'a@example.test' },
        { email: 'a@example.test', password: 'x'.repeat(300) },
      ]) {
        const res = await api.http().post('/api/v1/auth/admin/login').send(body);
        expect(res.status).toBe(400);
        expect(res.body.code).toBe('VALIDATION_FAILED');
      }
    });

    it('locks the account after repeated failures, even for the right password, then recovers', async () => {
      const target = await createAdmin(api);
      const ip = randomIp();
      for (let i = 0; i < 3; i++) {
        expect(
          (await adminLogin(api, { email: target.email, password: `wrong-password-${i}` }, ip))
            .status,
        ).toBe(401);
      }
      const locked = await adminLogin(api, target, ip);
      expect(locked.status).toBe(429);
      expect(locked.body.code).toBe('ADMIN_LOGIN_LOCKED');
      expect(Number(locked.body.details[0].messages[0])).toBeGreaterThan(0);

      // The lock follows the account, not just the IP.
      const otherIp = await adminLogin(api, target, randomIp());
      expect(otherIp.status).toBe(429);

      await clearAdminLockout(api, target.email, ip);
      expect((await adminLogin(api, target, randomIp())).status).toBe(200);
    });

    it('locks an IP that keeps failing across different accounts', async () => {
      const ip = randomIp();
      for (let i = 0; i < 3; i++) {
        await adminLogin(
          api,
          { email: `ghost.${i}.${Date.now()}@example.test`, password: 'nope-nope-nope' },
          ip,
        );
      }
      const res = await adminLogin(api, admin, ip);
      expect(res.status).toBe(429);
      await clearAdminLockout(api, admin.email, ip);
    });

    it('counts parallel failures atomically (cannot out-run the limit)', async () => {
      const target = await createAdmin(api);
      const ip = randomIp();
      const results = await Promise.all(
        Array.from({ length: 6 }, () =>
          adminLogin(api, { email: target.email, password: 'wrong-wrong-wrong' }, ip),
        ),
      );
      expect(results.every((r) => r.status === 401 || r.status === 429)).toBe(true);
      expect((await adminLogin(api, target, ip)).status).toBe(429);
      await clearAdminLockout(api, target.email, ip);
    });

    it('refuses a suspended admin only after the correct password (no status leak to guessers)', async () => {
      const target = await createAdmin(api);
      await api.prisma.user.update({ where: { id: target.id }, data: { status: 'SUSPENDED' } });
      const guess = await adminLogin(api, { email: target.email, password: 'wrong-wrong-wrong' });
      expect(guess.status).toBe(401);
      expect(guess.body.code).toBe('INVALID_CREDENTIALS');
      const real = await adminLogin(api, target);
      expect(real.status).toBe(403);
      expect(real.body.code).toBe('ACCOUNT_SUSPENDED');
      expect(real.body).not.toHaveProperty('accessToken');
      await clearAdminLockout(api, target.email);
    });

    it('logs out and refreshes like any other session', async () => {
      const session = await loginAdmin(api);
      const refreshed = await api
        .http()
        .post('/api/v1/auth/token/refresh')
        .send({ refreshToken: session.refreshToken });
      expect(refreshed.status).toBe(200);
      expect(refreshed.body.user.type).toBe('ADMIN');
      await api
        .http()
        .post('/api/v1/auth/logout')
        .set('Authorization', `Bearer ${refreshed.body.accessToken}`)
        .expect(204);
      await api
        .http()
        .get('/api/v1/users/me')
        .set('Authorization', `Bearer ${refreshed.body.accessToken}`)
        .expect(401);
    });
  });

  describe('audit trail and data exposure', () => {
    it('records registration, login, failed admin login and lockout without secrets', async () => {
      const session = await loginWithOtp(api);
      const target = await createAdmin(api);
      const ip = randomIp();
      for (let i = 0; i < 3; i++) {
        await adminLogin(api, { email: target.email, password: `bad-password-${i}` }, ip);
      }
      await clearAdminLockout(api, target.email, ip);
      const adminSession = await adminLogin(api, target);
      expect(adminSession.status).toBe(200);

      const customerAudit = await api.prisma.auditLog.findMany({
        where: { actorId: session.userId },
      });
      expect(customerAudit.map((a) => a.action).sort()).toEqual(['auth.login', 'user.register']);
      expect(customerAudit.every((a) => a.requestId)).toBe(true);

      const adminAudit = await api.prisma.auditLog.findMany({ where: { actorId: target.id } });
      const actions = adminAudit.map((a) => a.action);
      expect(actions.filter((a) => a === 'auth.admin_login_failed')).toHaveLength(3);
      expect(actions).toContain('auth.login');
      const lockoutEvents = adminAudit.filter(
        (a) => (a.metadata as { lockedOut?: boolean } | null)?.lockedOut === true,
      );
      expect(lockoutEvents).toHaveLength(1);

      const everything = JSON.stringify([...customerAudit, ...adminAudit]);
      expect(everything).not.toContain(ADMIN_PASSWORD);
      expect(everything).not.toContain(session.refreshToken);
      expect(everything).not.toContain(session.accessToken);
      expect(everything).not.toContain(otpFromSms(api, session.mobile!));
      expect(everything).not.toContain(target.email); // PII-free metadata
    });
  });
});
