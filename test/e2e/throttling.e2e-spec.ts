import '../support/env-throttled';
import request from 'supertest';
import { TestApp, createTestApp } from '../support/test-app';

// Own file => own module registry; env-throttled is imported first so AppModule loads with THROTTLE_LIMIT=3.
describe('Throttling (e2e)', () => {
  let t: TestApp;

  beforeAll(async () => {
    t = await createTestApp();
  });
  afterAll(async () => {
    await t.app.close();
  });

  it('answers 429 RATE_LIMITED in the standard envelope with Retry-After after the limit, but never throttles health probes', async () => {
    const http = () => request(t.app.getHttpServer());
    for (let i = 0; i < 3; i++) await http().get('/api/v1/test/public').expect(200);

    const res = await http()
      .get('/api/v1/test/public')
      .set('Origin', 'https://admin.sevanest.test')
      .expect(429);
    expect(res.body).toMatchObject({ code: 'RATE_LIMITED', message: expect.any(String) });
    expect(res.body.requestId).toBeDefined();
    expect(Number(res.headers['retry-after'])).toBeGreaterThanOrEqual(1);
    expect(res.headers['access-control-expose-headers']?.toLowerCase()).toContain('retry-after');

    for (let i = 0; i < 6; i++) await http().get('/health/live').expect(200);
  });

  it('uses isolated adminAuth rate-limit buckets for admin login and password change with standard Retry-After headers', async () => {
    const http = () => request(t.app.getHttpServer());
    // env-throttled configures ADMIN_AUTH_THROTTLE_LIMIT=2 independently of THROTTLE_LIMIT=3.
    // Exhausting /api/v1/test/public above does not touch the adminAuth bucket for /auth/admin/login.
    for (let i = 0; i < 2; i++) {
      const okQuota = await http()
        .post('/api/v1/auth/admin/login')
        .set('Origin', 'https://admin.sevanest.test')
        .send({})
        .expect(400);
      expect(okQuota.headers['x-ratelimit-limit']).toBe('2');
    }

    const blockedLogin = await http()
      .post('/api/v1/auth/admin/login')
      .set('Origin', 'https://admin.sevanest.test')
      .send({})
      .expect(429);
    expect(blockedLogin.body).toMatchObject({ code: 'RATE_LIMITED' });
    expect(Number(blockedLogin.headers['retry-after'])).toBeGreaterThanOrEqual(1);
    expect(blockedLogin.headers['retry-after-adminauth']).toBeUndefined();
    expect(blockedLogin.headers['access-control-expose-headers']?.toLowerCase()).toContain(
      'retry-after',
    );

    // /admin/account/password has its own per-handler bucket inside adminAuth as well.
    for (let i = 0; i < 2; i++) {
      await http().post('/api/v1/admin/account/password').send({}).expect(401);
    }
    const blockedPassword = await http()
      .post('/api/v1/admin/account/password')
      .send({})
      .expect(429);
    expect(Number(blockedPassword.headers['retry-after'])).toBeGreaterThanOrEqual(1);
  });
});
