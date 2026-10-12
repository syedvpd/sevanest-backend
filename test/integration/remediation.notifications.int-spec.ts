import '../support/env-api-integration';
import {
  ApiApp,
  createApiApp,
  loginAdmin,
  loginAdminWithPermissions,
  loginWithOtp,
} from '../support/api-app';
import { as } from '../support/workforce';

const BASE = '/api/v1/admin/notifications';
const UNKNOWN_ID = '00000000-0000-7000-8000-000000000000';

/** Remediation: operator visibility and manual recovery for the notification outbox/queue, against the real database. */
describe('Notification health and manual retry (integration)', () => {
  let api: ApiApp;
  let admin: Awaited<ReturnType<typeof loginAdmin>>;
  let recipientId: string;

  beforeAll(async () => {
    api = await createApiApp();
    admin = await loginAdmin(api);
    recipientId = (await loginWithOtp(api, { appType: 'CUSTOMER' })).userId;
  });
  afterAll(async () => {
    await api.close();
  });

  async function notificationWith(status: 'FAILED' | 'SENT' | 'QUEUED'): Promise<string> {
    const event = await api.prisma.outboxEvent.create({
      data: { topic: 'notification', payload: { event: 'TEST', recipients: [], params: {} } },
    });
    const row = await api.prisma.notification.create({
      data: {
        outboxEventId: event.id,
        recipientUserId: recipientId,
        eventCode: 'TEST',
        channel: 'SMS',
        params: {},
        status,
        attempts: status === 'FAILED' ? 5 : 0,
        lastError: status === 'FAILED' ? 'PROVIDER_ERROR' : null,
        dedupeKey: `remediation:${event.id}`,
      },
    });
    // keep the dispatch loop out of the way: this event is already processed
    await api.prisma.outboxEvent.update({
      where: { id: event.id },
      data: { processedAt: new Date() },
    });
    return row.id;
  }

  describe('GET /admin/notifications/health', () => {
    it('reports counts, ages and queue depth without any message content', async () => {
      await notificationWith('FAILED');
      const res = await as(api, admin).get(`${BASE}/health`);
      const body = res.body as {
        notifications: { byStatus: Record<string, number> };
        outbox: { pending: number };
        queue: object | null;
      };
      expect(res.status).toBe(200);
      expect(Object.keys(body).sort()).toEqual(['notifications', 'outbox', 'queue']);
      expect(body.notifications.byStatus.FAILED).toBeGreaterThanOrEqual(1);
      expect(Object.keys(body.notifications.byStatus).sort()).toEqual([
        'FAILED',
        'QUEUED',
        'SENT',
        'SKIPPED',
      ]);
      expect(typeof body.outbox.pending).toBe('number');
      expect(body.queue).toEqual(
        expect.objectContaining({ waiting: expect.any(Number), failed: expect.any(Number) }),
      );
      expect(JSON.stringify(body)).not.toMatch(/params|payload|mobile|token/i);
    });

    it('needs notification.manage', async () => {
      const without = await loginAdminWithPermissions(api, ['report.view']);
      expect((await as(api, without).get(`${BASE}/health`)).status).toBe(403);
      const customer = await loginWithOtp(api, { appType: 'CUSTOMER' });
      expect((await as(api, customer).get(`${BASE}/health`)).status).toBe(403);
      expect((await api.http().get(`${BASE}/health`)).status).toBe(401);
    });
  });

  describe('POST /admin/notifications/:id/retry', () => {
    it('returns a FAILED notification to the queue, audited, exactly once', async () => {
      const id = await notificationWith('FAILED');
      const res = await as(api, admin).post(`${BASE}/${id}/retry`);
      expect(res.status).toBe(204);
      const after = await api.prisma.notification.findUniqueOrThrow({ where: { id } });
      expect(after.status).toBe('QUEUED');
      expect(after.lastError).toBeNull();
      expect(
        await api.prisma.auditLog.count({
          where: { action: 'notification.retry', entityId: id, actorId: admin.userId },
        }),
      ).toBe(1);
      // a second retry (status is no longer FAILED) is refused and writes nothing
      const again = await as(api, admin).post(`${BASE}/${id}/retry`);
      expect(again.status).toBe(409);
      expect(again.body.code).toBe('NOTIFICATION_NOT_FAILED');
    });

    it('refuses to retry a SENT or QUEUED notification (nothing is sent twice)', async () => {
      for (const status of ['SENT', 'QUEUED'] as const) {
        const id = await notificationWith(status);
        const res = await as(api, admin).post(`${BASE}/${id}/retry`);
        expect(res.status).toBe(409);
        expect((await api.prisma.notification.findUniqueOrThrow({ where: { id } })).status).toBe(
          status,
        );
      }
    });

    it('answers 404 for an unknown id, 400 for a malformed id, and enforces authorization', async () => {
      expect((await as(api, admin).post(`${BASE}/${UNKNOWN_ID}/retry`)).status).toBe(404);
      expect((await as(api, admin).post(`${BASE}/not-a-uuid/retry`)).status).toBe(400);
      const id = await notificationWith('FAILED');
      const without = await loginAdminWithPermissions(api, ['notification.view']);
      expect((await as(api, without).post(`${BASE}/${id}/retry`)).status).toBe(403);
      const customer = await loginWithOtp(api, { appType: 'CUSTOMER' });
      expect((await as(api, customer).post(`${BASE}/${id}/retry`)).status).toBe(403);
      expect((await api.http().post(`${BASE}/${id}/retry`)).status).toBe(401);
      expect((await api.prisma.notification.findUniqueOrThrow({ where: { id } })).status).toBe(
        'FAILED',
      );
    });
  });
});
