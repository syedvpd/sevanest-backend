import '../support/env-api-integration';
import {
  ApiApp,
  adminLogin,
  clearAdminLockout,
  createAdmin,
  createApiApp,
  loginAdmin,
  loginAdminWithPermissions,
  loginWithOtp,
  randomIp,
  randomMobile,
} from '../support/api-app';
import { NotificationsService } from '../../src/modules/notifications/notifications.service';
import { VerificationService } from '../../src/modules/verification/verification.service';
import {
  approveCheck,
  as,
  createArea,
  onboardWorker,
  setRequiredChecks,
} from '../support/workforce';

const BASE = '/api/v1/admin';
const UNKNOWN_ID = '00000000-0000-7000-8000-000000000000';

/** Phase 2: outbox dead-lettering, re-check reminders and fail-closed behaviour when Redis is unavailable. */
describe('Outbox recovery, re-check reminders and Redis failure (integration)', () => {
  let api: ApiApp;
  let admin: Awaited<ReturnType<typeof loginAdmin>>;
  let notifications: NotificationsService;

  beforeAll(async () => {
    api = await createApiApp();
    admin = await loginAdmin(api);
    notifications = api.app.get(NotificationsService);
  });
  afterAll(async () => {
    await api.close();
  });

  describe('poison outbox event', () => {
    async function insertEvent(payloadSql: 'poison' | 'good'): Promise<string> {
      const rows =
        payloadSql === 'poison'
          ? await api.prisma.$queryRaw<Array<{ id: string }>>`
              INSERT INTO outbox_events (id, topic, payload) VALUES (gen_random_uuid(), 'notification', 'null'::jsonb) RETURNING id`
          : await api.prisma.$queryRaw<Array<{ id: string }>>`
              INSERT INTO outbox_events (id, topic, payload)
              VALUES (gen_random_uuid(), 'notification', '{"event":"TICKET_UPDATE","recipients":[],"params":{}}'::jsonb) RETURNING id`;
      return rows[0].id;
    }
    const row = (id: string) => api.prisma.outboxEvent.findUniqueOrThrow({ where: { id } });

    it('does not block the events behind it; is retried with backoff, dead-lettered, visible and recoverable', async () => {
      // clear leftovers from other suites so the assertions below are about these two events
      await api.prisma
        .$executeRaw`UPDATE outbox_events SET processed_at = now() WHERE processed_at IS NULL`;
      const poison = await insertEvent('poison');
      const good = await insertEvent('good');

      // First run: the poison event fails, the event behind it is still processed.
      await notifications.dispatchOutbox();
      expect((await row(good)).processedAt).not.toBeNull();
      let p = await row(poison);
      expect(p.processedAt).toBeNull();
      expect(p.attempts).toBe(1);
      expect(p.lastError).toBe('DISPATCH_ERROR');
      expect(p.failedAt).toBeNull();
      expect(p.nextAttemptAt!.getTime()).toBeGreaterThan(Date.now()); // backoff

      // While backing off it is not claimed again.
      await notifications.dispatchOutbox();
      expect((await row(poison)).attempts).toBe(1);

      // Four more failures (backoff skipped) dead-letter it.
      for (let i = 0; i < 4; i += 1) {
        await api.prisma
          .$executeRaw`UPDATE outbox_events SET next_attempt_at = NULL WHERE id = ${poison}::uuid`;
        await notifications.dispatchOutbox();
      }
      p = await row(poison);
      expect(p.attempts).toBe(5);
      expect(p.failedAt).not.toBeNull();
      // Dead-lettered events are never claimed again.
      await notifications.dispatchOutbox();
      expect((await row(poison)).attempts).toBe(5);

      // Operators can see it ...
      const health = await as(api, admin).get(`${BASE}/notifications/health`);
      expect(
        (health.body as { outbox: { deadLettered: number } }).outbox.deadLettered,
      ).toBeGreaterThanOrEqual(1);
      expect(JSON.stringify(health.body)).not.toMatch(/DISPATCH_ERROR|payload/);

      // ... and recover it, once, with an audit row.
      const retry = await as(api, admin).post(`${BASE}/outbox-events/${poison}/retry`);
      expect(retry.status).toBe(204);
      p = await row(poison);
      expect(p.failedAt).toBeNull();
      expect(p.attempts).toBe(0);
      expect(
        await api.prisma.auditLog.count({
          where: { action: 'outbox.retry', entityId: poison, actorId: admin.userId },
        }),
      ).toBe(1);
      const again = await as(api, admin).post(`${BASE}/outbox-events/${poison}/retry`);
      expect(again.status).toBe(409);
      expect((again.body as { code: string }).code).toBe('OUTBOX_EVENT_NOT_DEAD_LETTERED');

      // cleanup so the poison event cannot disturb other suites
      await api.prisma
        .$executeRaw`UPDATE outbox_events SET processed_at = now() WHERE id = ${poison}::uuid`;
    });

    it('retry needs notification.manage and a valid id', async () => {
      const id = await insertEvent('poison');
      await api.prisma
        .$executeRaw`UPDATE outbox_events SET failed_at = now(), attempts = 5 WHERE id = ${id}::uuid`;
      const without = await loginAdminWithPermissions(api, ['report.view']);
      expect((await as(api, without).post(`${BASE}/outbox-events/${id}/retry`)).status).toBe(403);
      const customer = await loginWithOtp(api, { appType: 'CUSTOMER' });
      expect((await as(api, customer).post(`${BASE}/outbox-events/${id}/retry`)).status).toBe(403);
      expect((await api.http().post(`${BASE}/outbox-events/${id}/retry`)).status).toBe(401);
      expect((await as(api, admin).post(`${BASE}/outbox-events/not-a-uuid/retry`)).status).toBe(
        400,
      );
      expect((await as(api, admin).post(`${BASE}/outbox-events/${UNKNOWN_ID}/retry`)).status).toBe(
        409,
      );
      expect(
        (await api.prisma.outboxEvent.findUniqueOrThrow({ where: { id } })).failedAt,
      ).not.toBeNull();
      await api.prisma
        .$executeRaw`UPDATE outbox_events SET processed_at = now() WHERE id = ${id}::uuid`;
    });
  });

  describe('re-check due reminder', () => {
    it('reminds once per due date, never changes a verification and never makes anyone verified', async () => {
      const verification = api.app.get(VerificationService);
      const area = await createArea(api, admin);
      await setRequiredChecks(api, admin, ['IDENTITY']);
      try {
        const due = await onboardWorker(api, { areaIds: [area.id] });
        const later = await onboardWorker(api, { areaIds: [area.id] });
        const rejected = await onboardWorker(api, { areaIds: [area.id] });
        for (const w of [due, later, rejected]) await approveCheck(api, admin, w, 'IDENTITY');
        const today = `((now() AT TIME ZONE 'Asia/Kolkata')::date)`;
        await api.prisma.$executeRawUnsafe(
          `UPDATE worker_verification_checks SET recheck_at = ${today} WHERE worker_id = '${due.workerId}'::uuid`,
        );
        await api.prisma.$executeRawUnsafe(
          `UPDATE worker_verification_checks SET recheck_at = ${today} + 5 WHERE worker_id = '${later.workerId}'::uuid`,
        );
        await api.prisma.$executeRawUnsafe(
          `UPDATE worker_verification_checks SET recheck_at = NULL, status = 'REJECTED', remarks = 'fixture' WHERE worker_id = '${rejected.workerId}'::uuid`,
        );
        const reminders = (userId: string) =>
          api.prisma.$queryRaw<Array<{ n: bigint }>>`
            SELECT count(*) AS n FROM outbox_events
            WHERE payload->>'event' = 'RECHECK_DUE' AND payload->'recipients' ? ${userId}`.then(
            (r) => Number(r[0].n),
          );
        const before = await api.prisma.workerVerificationCheck.findMany({
          where: { workerId: { in: [due.workerId, later.workerId, rejected.workerId] } },
          select: { workerId: true, status: true, recheckAt: true },
          orderBy: { workerId: 'asc' },
        });

        // concurrent runs together remind exactly once
        const runs = await Promise.all([
          verification.notifyRecheckDue(),
          verification.notifyRecheckDue(),
          verification.notifyRecheckDue(),
        ]);
        expect(runs.reduce((a, b) => a + b, 0)).toBeGreaterThanOrEqual(1);
        expect(await reminders(due.userId)).toBe(1);
        expect(await reminders(later.userId)).toBe(0); // not due yet
        expect(await reminders(rejected.userId)).toBe(0); // not an approved check

        // repeating never repeats the reminder for the same date
        await verification.notifyRecheckDue();
        expect(await reminders(due.userId)).toBe(1);

        // a NEW due date is a new reminder
        await api.prisma.$executeRawUnsafe(
          `UPDATE worker_verification_checks SET recheck_at = ${today} - 1 WHERE worker_id = '${due.workerId}'::uuid`,
        );
        await verification.notifyRecheckDue();
        expect(await reminders(due.userId)).toBe(2);

        // the loop only notifies: no status was touched, and the worker whose date was reached is NOT visible to customers
        const after = await api.prisma.workerVerificationCheck.findMany({
          where: { workerId: { in: [due.workerId, later.workerId, rejected.workerId] } },
          select: { workerId: true, status: true },
          orderBy: { workerId: 'asc' },
        });
        expect(after.map((a) => a.status)).toEqual(before.map((b) => b.status));
        const customer = await loginWithOtp(api, { appType: 'CUSTOMER' });
        expect((await as(api, customer).get(`/api/v1/search/workers/${due.workerId}`)).status).toBe(
          404,
        );
        expect(
          (await as(api, customer).get(`/api/v1/search/workers/${later.workerId}`)).status,
        ).toBe(200);
      } finally {
        await setRequiredChecks(api, admin, []);
        await api.prisma
          .$executeRaw`UPDATE outbox_events SET processed_at = now() WHERE processed_at IS NULL`;
      }
    });
  });

  describe('Redis unavailable', () => {
    it('OTP requests fail closed: no SMS is sent and no limit is skipped', async () => {
      const mobile = randomMobile();
      const spy = jest
        .spyOn(api.redis, 'ensureConnected')
        .mockRejectedValue(new Error('redis down'));
      try {
        const res = await api
          .http()
          .post('/api/v1/auth/otp/request')
          .set('X-Forwarded-For', randomIp())
          .send({ mobile, appType: 'CUSTOMER' });
        expect(res.status).toBeGreaterThanOrEqual(500);
        expect(api.sms.lastTo(mobile)).toBeUndefined();
      } finally {
        spy.mockRestore();
      }
    });

    it('admin login does not succeed without its lockout store', async () => {
      const target = await createAdmin(api);
      await clearAdminLockout(api, target.email);
      const spy = jest
        .spyOn(api.redis, 'ensureConnected')
        .mockRejectedValue(new Error('redis down'));
      try {
        const res = await adminLogin(api, target);
        expect(res.status).toBeGreaterThanOrEqual(500);
        expect((res.body as { accessToken?: string }).accessToken).toBeUndefined();
      } finally {
        spy.mockRestore();
      }
      expect((await adminLogin(api, target)).status).toBe(200);
    });
  });
});
