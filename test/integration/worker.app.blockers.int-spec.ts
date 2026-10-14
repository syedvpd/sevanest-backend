import '../support/env-api-integration';
// Test login is deliberately OFF here, with a number list and code present, to prove the flag (not the list) decides.
process.env.ALLOW_TEST_OTP = 'false';
process.env.TEST_OTP_NUMBERS = '+919999900021';
process.env.TEST_OTP_CODE = '424242';

import { createHmac } from 'node:crypto';
import { JwtService } from '@nestjs/jwt';
import {
  ApiApp,
  createApiApp,
  loginAdmin,
  loginWithOtp,
  otpFromSms,
  randomIp,
  requestOtp,
} from '../support/api-app';
import { ProviderError } from '../../src/integrations/provider-error';
import type { SmsProvider } from '../../src/integrations/notifications/notification-providers.interface';
import { TOKEN_AUDIENCE, TOKEN_ISSUER } from '../../src/modules/auth/token.service';
import { makeBooking } from '../support/bookings';
import { as, createArea, onboardWorker, setRequiredChecks } from '../support/workforce';

const W = '/api/v1/workers/me';
const UNKNOWN_ID = '00000000-0000-7000-8000-000000000000';
const b64 = (value: object | string): string =>
  Buffer.from(typeof value === 'string' ? value : JSON.stringify(value)).toString('base64url');

/**
 * Worker-app backend blockers (2026-10-14): demo/test login can never become a server session, the worker flows behave
 * over HTTP with persistence, the opportunity detail route, category/area access and the support ticket subject.
 */
describe('Worker app blockers (integration)', () => {
  let api: ApiApp;
  let admin: Awaited<ReturnType<typeof loginAdmin>>;
  let area: { id: string; name: string };
  let customer: Awaited<ReturnType<typeof loginWithOtp>> & { userId: string };

  beforeAll(async () => {
    api = await createApiApp();
    admin = await loginAdmin(api);
    area = await createArea(api, admin);
    await setRequiredChecks(api, admin, ['IDENTITY']);
    customer = await loginWithOtp(api, { appType: 'CUSTOMER' });
  });
  afterAll(async () => {
    await setRequiredChecks(api, admin, []);
    await api.close();
  });

  describe('1. a demo or test session can never authenticate against the server', () => {
    const protectedRoutes = [
      `${W}`,
      '/api/v1/customers/me',
      '/api/v1/admin/users',
      `${W}/opportunities`,
    ];
    const secret = (): string => process.env.JWT_ACCESS_SECRET ?? '';
    const call = (token: string, path: string) =>
      api.http().get(path).set('Authorization', `Bearer ${token}`);

    it('refuses made-up demo tokens on worker, customer and admin routes', async () => {
      const demoTokens = [
        'demo-session',
        'DemoOtpSession',
        `demo.${b64({ userId: customer.userId, sid: 'demo' })}`,
        b64({ sub: customer.userId, sid: 'demo', demo: true }),
        'null',
        'undefined',
        '.',
        '..',
      ];
      for (const token of demoTokens) {
        for (const path of protectedRoutes) {
          expect((await call(token, path)).status).toBe(401);
        }
      }
    });

    it('refuses forged JWTs: no signature, wrong secret, wrong audience, expired, and a valid signature with no server session', async () => {
      const header = b64({ alg: 'none', typ: 'JWT' });
      const claims = {
        sub: customer.userId,
        sid: UNKNOWN_ID,
        iss: TOKEN_ISSUER,
        aud: TOKEN_AUDIENCE,
      };
      const none = `${header}.${b64(claims)}.`;
      const wrongSecret = await new JwtService({
        secret: 'not-the-server-secret-0123456789',
      }).signAsync(claims, { algorithm: 'HS256' });
      const forgedHs512 = ((): string => {
        const h = b64({ alg: 'HS512', typ: 'JWT' });
        const p = b64(claims);
        return `${h}.${p}.${createHmac('sha512', 'x').update(`${h}.${p}`).digest('base64url')}`;
      })();
      const real = new JwtService({ secret: secret() });
      const wrongAudience = await real.signAsync(
        { sub: customer.userId, sid: UNKNOWN_ID },
        { algorithm: 'HS256', issuer: TOKEN_ISSUER, audience: 'someone-else', expiresIn: 600 },
      );
      const expired = await real.signAsync(
        { sub: customer.userId, sid: UNKNOWN_ID, iat: Math.floor(Date.now() / 1000) - 3600 },
        { algorithm: 'HS256', issuer: TOKEN_ISSUER, audience: TOKEN_AUDIENCE, expiresIn: 60 },
      );
      // properly signed by the real secret, for a real user, but the session id was never created by the server
      const noSession = await real.signAsync(
        { sub: customer.userId, sid: UNKNOWN_ID },
        { algorithm: 'HS256', issuer: TOKEN_ISSUER, audience: TOKEN_AUDIENCE, expiresIn: 600 },
      );
      for (const token of [none, wrongSecret, forgedHs512, wrongAudience, expired, noSession]) {
        for (const path of protectedRoutes) {
          expect((await call(token, path)).status).toBe(401);
        }
      }
    });

    it('stops a real token once its server session is revoked (logout), and a refresh token is not an access token', async () => {
      const session = await loginWithOtp(api, { appType: 'WORKER' });
      expect((await as(api, session).get(W)).status).toBe(404); // signed in, no profile yet: reachable
      expect((await call(session.refreshToken, W)).status).toBe(401);
      expect((await as(api, session).post('/api/v1/auth/logout')).status).toBe(204);
      expect((await as(api, session).get(W)).status).toBe(401);
    });

    it('ignores the fixed test code while ALLOW_TEST_OTP is off, even for a listed number', async () => {
      const mobile = '+919999900021';
      const ip = randomIp();
      expect((await requestOtp(api, mobile, 'WORKER', ip)).status).toBe(200);
      expect(api.sms.sent.length).toBeGreaterThan(0); // a real SMS was queued: the fixed-code shortcut was not taken
      const real = otpFromSms(api, mobile);
      expect(real).not.toBe('424242');
      const fixed = await api
        .http()
        .post('/api/v1/auth/otp/verify')
        .set('X-Forwarded-For', ip)
        .send({ mobile, appType: 'WORKER', otp: '424242' });
      expect(fixed.status).toBe(400);
      expect(fixed.body.accessToken).toBeUndefined();
      const ok = await api
        .http()
        .post('/api/v1/auth/otp/verify')
        .set('X-Forwarded-For', ip)
        .send({ mobile, appType: 'WORKER', otp: real });
      expect(ok.status).toBe(200);
    });

    it('answers an OTP request honestly (503) when no SMS provider works: no session, no token, no fixed-code fallback', async () => {
      const failing: SmsProvider = {
        sendSms: () => Promise.reject(new ProviderError('sms', 'not configured', false)),
      };
      const local = await createApiApp({ smsProvider: failing });
      try {
        const before = await local.prisma.session.count();
        const mobile = '+919999900022';
        const res = await requestOtp(local, mobile, 'WORKER', randomIp());
        expect(res.status).toBe(503);
        expect(res.body.code).toBe('SMS_NOT_CONFIGURED');
        expect(JSON.stringify(res.body)).not.toMatch(/accessToken|refreshToken/);
        // nothing can be verified afterwards: there is no stored code to match, so any guess (incl. a demo code) fails
        for (const otp of ['123456', '000000', '424242']) {
          const verify = await local
            .http()
            .post('/api/v1/auth/otp/verify')
            .set('X-Forwarded-For', randomIp())
            .send({ mobile, appType: 'WORKER', otp });
          expect(verify.status).toBe(400);
          expect(verify.body.accessToken).toBeUndefined();
        }
        expect(await local.prisma.session.count()).toBe(before);
      } finally {
        await local.close();
      }
    });
  });

  describe('2. worker flows over HTTP: shape, persistence, ownership, errors', () => {
    it('profile, onboarding progress and availability persist and read back', async () => {
      const worker = await onboardWorker(api, { areaIds: [area.id], submit: false });
      const w = as(api, worker);

      const me = (await w.get(W).expect(200)).body as Record<string, unknown>;
      expect(me).toMatchObject({ id: worker.workerId, hasProfilePhoto: false });
      expect(JSON.stringify(me)).not.toMatch(/kyc|password|passwordHash|otp|objectKey/i);

      await w.patch(W, { experienceMonths: 61, expectedSalary: 21000 }).expect(200);
      expect((await w.get(W).expect(200)).body).toMatchObject({
        experienceMonths: 61,
        expectedSalary: 21000,
      });
      expect(
        (await api.prisma.workerProfile.findUniqueOrThrow({ where: { id: worker.workerId } }))
          .experienceMonths,
      ).toBe(61);
      expect((await w.patch(W, { experienceMonths: -1 })).status).toBe(400);
      expect((await w.patch(W, { unknownField: 1 })).status).toBe(400);

      const progress = (await w.get(`${W}/onboarding`).expect(200)).body as Record<string, unknown>;
      expect(progress).toBeTruthy();
      expect(JSON.stringify(progress)).not.toMatch(/objectKey|secret/i);

      await w
        .patch(`${W}/availability`, {
          engagementPreference: 'DAILY',
          areaIds: [area.id],
          timeWindows: [{ start: '07:00', end: '11:00' }],
        })
        .expect(200);
      expect((await w.get(`${W}/availability`).expect(200)).body).toMatchObject({
        engagementPreference: 'DAILY',
        timeWindows: [{ start: '07:00', end: '11:00' }],
      });
      expect(
        (
          await w.patch(`${W}/availability`, {
            timeWindows: [{ start: '12:00', end: '09:00' }],
          })
        ).status,
      ).toBe(400);
    });

    it('verification status shows only my own checks; ratings and attendance start empty and reject strangers', async () => {
      const worker = await onboardWorker(api, { areaIds: [area.id] });
      const other = await onboardWorker(api, { areaIds: [area.id] });
      const w = as(api, worker);
      const status = (await w.get(`${W}/verification`).expect(200)).body;
      expect(JSON.stringify(status)).not.toContain(other.workerId);
      const ratings = (await w.get(`${W}/ratings`).expect(200)).body as {
        data: unknown[];
        meta: { total: number };
      };
      expect(ratings).toMatchObject({ data: [], meta: { total: 0 } });
      await w.get(`${W}/ratings/summary`).expect(200);
      // someone else's booking has no attendance for me
      const b = await makeBooking(api, admin, customer, area.id, 'ACTIVE');
      expect((await w.get(`${W}/attendance/bookings/${b.id}`)).status).toBe(404);
      expect((await w.post(`${W}/attendance/bookings/${b.id}`, { status: 'PRESENT' })).status).toBe(
        404,
      );
      expect((await w.get(`${W}/attendance/bookings/${UNKNOWN_ID}`)).status).toBe(404);
    });

    it('attendance: the holder records today once, repeats safely, and reads it back', async () => {
      const b = await makeBooking(api, admin, customer, area.id, 'ACTIVE');
      const w = as(api, b.worker);
      const first = await w.post(`${W}/attendance/bookings/${b.id}`, { status: 'PRESENT' });
      expect(first.status).toBe(201);
      const again = await w.post(`${W}/attendance/bookings/${b.id}`, { status: 'PRESENT' });
      expect(again.status).toBe(201); // same answer, nothing recorded twice
      const conflicting = await w.post(`${W}/attendance/bookings/${b.id}`, { status: 'ABSENT' });
      expect(conflicting.status).toBe(409);
      const list = (await w.get(`${W}/attendance/bookings/${b.id}`).expect(200)).body;
      expect(JSON.stringify(list)).toContain('PRESENT');
      expect(await api.prisma.attendanceRecord.count({ where: { bookingId: b.id } })).toBe(1);
      const month = new Date().toISOString().slice(0, 7);
      const summary = (
        await w.get(`${W}/attendance/bookings/${b.id}/summary?month=${month}`).expect(200)
      ).body;
      expect(summary).toMatchObject({ bookingId: b.id });
      expect((await w.get(`${W}/attendance/bookings/${b.id}/summary`)).status).toBe(400);
      expect((await w.get(`${W}/attendance/bookings/${b.id}/summary?month=2026-13`)).status).toBe(
        400,
      );
    });

    it('interviews: the worker sees their own and can accept once; a stranger gets 404', async () => {
      const b = await makeBooking(api, admin, customer, area.id, 'MATCHED');
      const stranger = await onboardWorker(api, { areaIds: [area.id] });
      const mine = (await as(api, b.worker).get(`${W}/interviews`).expect(200)).body as {
        data: unknown[];
      };
      expect(Array.isArray(mine.data)).toBe(true);
      expect((await as(api, stranger).get(`${W}/interviews/${UNKNOWN_ID}`)).status).toBe(404);
      expect((await as(api, stranger).post(`${W}/interviews/${UNKNOWN_ID}/accept`)).status).toBe(
        404,
      );
    });
  });

  describe('3. worker opportunity detail: the canonical route is GET /workers/me/bookings/{id}', () => {
    it('an opportunity IS a booking offered to me: the list item and the detail carry the same id and fields', async () => {
      const b = await makeBooking(api, admin, customer, area.id, 'MATCHED');
      const w = as(api, b.worker);
      const list = (await w.get(`${W}/opportunities`).expect(200)).body as {
        data: Array<Record<string, unknown>>;
      };
      const item = list.data.find((o) => o.id === b.id)!;
      expect(item).toBeDefined();
      const detail = (await w.get(`${W}/bookings/${b.id}`).expect(200)).body as Record<
        string,
        unknown
      >;
      expect(detail).toEqual(item);
      expect(detail).toMatchObject({ id: b.id, status: 'MATCHED', workerRespondedAt: null });
      // the requirement summary only: no customer identity, address or contact
      expect(Object.keys(detail).join(',')).not.toMatch(/customer|address|mobile|phone|email/i);
      expect(JSON.stringify(detail)).not.toContain(customer.userId);
    });

    it('no separate /opportunities/{id} route exists (404), so there is one source of truth', async () => {
      const b = await makeBooking(api, admin, customer, area.id, 'MATCHED');
      expect((await as(api, b.worker).get(`${W}/opportunities/${b.id}`)).status).toBe(404);
    });

    it('another worker, an unknown id and a malformed id cannot read it', async () => {
      const b = await makeBooking(api, admin, customer, area.id, 'MATCHED');
      const stranger = await onboardWorker(api, { areaIds: [area.id] });
      for (const id of [b.id, UNKNOWN_ID]) {
        const res = await as(api, stranger).get(`${W}/bookings/${id}`);
        expect(res.status).toBe(404);
        expect(res.body.code).toBe('BOOKING_NOT_FOUND');
      }
      expect((await as(api, stranger).get(`${W}/bookings/not-a-uuid`)).status).toBe(400);
      expect((await as(api, customer).get(`${W}/bookings/${b.id}`)).status).toBe(403);
      expect((await api.http().get(`${W}/bookings/${b.id}`)).status).toBe(401);
    });

    it('accepting removes it from the feed but the detail stays; declining removes both for that worker', async () => {
      const accepted = await makeBooking(api, admin, customer, area.id, 'MATCHED');
      const wa = as(api, accepted.worker);
      const acceptRes = await wa.post(`${W}/bookings/${accepted.id}/accept`, {});
      expect(acceptRes.status).toBe(200);
      expect(acceptRes.body.workerRespondedAt).not.toBeNull();
      const feedA = (await wa.get(`${W}/opportunities`).expect(200)).body.data as Array<{
        id: string;
      }>;
      expect(feedA.map((o) => o.id)).not.toContain(accepted.id);
      expect((await wa.get(`${W}/bookings/${accepted.id}`).expect(200)).body.id).toBe(accepted.id);
      // a repeated accept does not corrupt the state
      expect((await wa.post(`${W}/bookings/${accepted.id}/accept`, {})).status).toBeLessThan(500);

      const declined = await makeBooking(api, admin, customer, area.id, 'MATCHED');
      const wd = as(api, declined.worker);
      expect(
        (await wd.post(`${W}/bookings/${declined.id}/decline`, { reason: 'Not available' })).status,
      ).toBe(200);
      const feedD = (await wd.get(`${W}/opportunities`).expect(200)).body.data as Array<{
        id: string;
      }>;
      expect(feedD.map((o) => o.id)).not.toContain(declined.id);
      expect((await wd.get(`${W}/bookings/${declined.id}`)).status).toBe(404);
    });

    it('a cancelled (withdrawn) offer leaves the feed; the detail reports CANCELLED instead of vanishing', async () => {
      const b = await makeBooking(api, admin, customer, area.id, 'MATCHED');
      await as(api, customer)
        .post(`/api/v1/bookings/${b.id}/cancel`, { reason: 'Plans changed' })
        .expect(200);
      const w = as(api, b.worker);
      const feed = (await w.get(`${W}/opportunities`).expect(200)).body.data as Array<{
        id: string;
      }>;
      expect(feed.map((o) => o.id)).not.toContain(b.id);
      expect((await w.get(`${W}/bookings/${b.id}`).expect(200)).body.status).toBe('CANCELLED');
      expect((await w.post(`${W}/bookings/${b.id}/accept`, {})).status).toBe(409);
    });
  });

  describe('4. service categories and areas need a signed-in user (onboarding happens after OTP)', () => {
    const C = '/api/v1/service-categories';
    const A = '/api/v1/service-areas';

    it('anonymous callers get 401; customer, worker and admin get the same read-only list', async () => {
      const worker = await onboardWorker(api, { submit: false });
      for (const path of [
        C,
        A,
        `${C}/${UNKNOWN_ID}`,
        `${A}/${UNKNOWN_ID}`,
        '/api/v1/locations/service-area',
      ]) {
        expect((await api.http().get(path)).status).toBe(401);
      }
      for (const who of [customer, worker, admin]) {
        const cats = await as(api, who).get(C);
        expect(cats.status).toBe(200);
        expect(cats.body.data.length).toBeGreaterThan(0);
        expect(Object.keys(cats.body.data[0] as object).sort()).toEqual(
          ['allowedEngagements', 'code', 'description', 'id', 'name'].sort(),
        );
        const areas = await as(api, who).get(A);
        expect(areas.status).toBe(200);
        expect(areas.body.data.map((a: { id: string }) => a.id)).toContain(area.id);
        expect(JSON.stringify(areas.body)).not.toMatch(/isEnabled|createdAt|updatedAt/);
      }
    });

    it('nobody but an admin with the permission can change them', async () => {
      const worker = await onboardWorker(api, { submit: false });
      for (const who of [customer, worker]) {
        expect(
          (await as(api, who).post('/api/v1/admin/service-areas', { name: 'x', city: 'y' })).status,
        ).toBe(403);
        expect(
          (
            await as(api, who).patch(`/api/v1/admin/service-categories/${UNKNOWN_ID}`, {
              isEnabled: false,
            })
          ).status,
        ).toBe(403);
      }
      expect((await api.http().post('/api/v1/admin/service-areas').send({})).status).toBe(401);
    });

    it('disabled categories and areas disappear from lists and answer 404 by id; restrictions are visible', async () => {
      const worker = await onboardWorker(api, { submit: false });
      const w = as(api, worker);
      const extraArea = await createArea(api, admin);
      await as(api, admin)
        .patch(`/api/v1/admin/service-areas/${extraArea.id}`, { isEnabled: false })
        .expect(200);
      expect((await w.get(A).expect(200)).body.data.map((a: { id: string }) => a.id)).not.toContain(
        extraArea.id,
      );
      expect((await w.get(`${A}/${extraArea.id}`)).status).toBe(404);

      const cats = (await w.get(C).expect(200)).body.data as Array<{ id: string; code: string }>;
      const cook = cats.find((c) => c.code === 'COOK')!;
      await as(api, admin)
        .put(`/api/v1/admin/service-categories/${cook.id}/engagements`, {
          engagements: ['FULL_TIME'],
        })
        .expect(200);
      try {
        const again = (await w.get(`${C}/${cook.id}`).expect(200)).body;
        expect(again.allowedEngagements).toEqual(['FULL_TIME']);
        await as(api, admin)
          .patch(`/api/v1/admin/service-categories/${cook.id}`, { isEnabled: false })
          .expect(200);
        expect((await w.get(`${C}/${cook.id}`)).status).toBe(404);
        expect(
          (await w.get(C).expect(200)).body.data.map((c: { id: string }) => c.id),
        ).not.toContain(cook.id);
      } finally {
        await as(api, admin).patch(`/api/v1/admin/service-categories/${cook.id}`, {
          isEnabled: true,
        });
        await as(api, admin).put(`/api/v1/admin/service-categories/${cook.id}/engagements`, {
          engagements: [],
        });
      }
    });
  });

  describe('5. a worker can raise a support ticket with a separate subject', () => {
    it("stores subject and description separately, only for the worker's own booking, and returns them in the history", async () => {
      const b = await makeBooking(api, admin, customer, area.id, 'MATCHED');
      const category = await as(api, admin)
        .post('/api/v1/admin/support/categories', {
          code: `WORKER_${Date.now()}`,
          name: 'Worker issue',
        })
        .expect(201);
      const w = as(api, b.worker);
      const created = await w
        .post('/api/v1/support/tickets', {
          categoryId: category.body.id,
          subject: 'Customer not at home',
          description: 'Nobody opened the door at the agreed time.',
          bookingId: b.id,
        })
        .expect(201);
      expect(created.body).toMatchObject({
        subject: 'Customer not at home',
        description: 'Nobody opened the door at the agreed time.',
        bookingId: b.id,
      });
      const listed = (await w.get('/api/v1/support/tickets').expect(200)).body.data as Array<{
        id: string;
        subject: string;
      }>;
      expect(listed.find((t) => t.id === created.body.id)?.subject).toBe('Customer not at home');
      const stranger = await onboardWorker(api, { areaIds: [area.id] });
      expect(
        (await as(api, stranger).get(`/api/v1/support/tickets/${created.body.id}`)).status,
      ).toBe(404);
      const foreign = await as(api, stranger).post('/api/v1/support/tickets', {
        categoryId: category.body.id,
        subject: 's',
        description: 'd',
        bookingId: b.id,
      });
      expect(foreign.status).toBe(404);
    });
  });
});
