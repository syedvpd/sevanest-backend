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

  it('answers 429 RATE_LIMITED in the standard envelope after the limit, but never throttles health probes', async () => {
    const http = () => request(t.app.getHttpServer());
    for (let i = 0; i < 3; i++) await http().get('/api/v1/test/public').expect(200);

    const res = await http().get('/api/v1/test/public').expect(429);
    expect(res.body).toMatchObject({ code: 'RATE_LIMITED', message: expect.any(String) });
    expect(res.body.requestId).toBeDefined();

    for (let i = 0; i < 6; i++) await http().get('/health/live').expect(200);
  });
});
