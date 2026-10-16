import '../support/env-api-integration';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  ApiApp,
  createApiApp,
  loginAdmin,
  loginAdminWithPermissions,
  loginWithOtp,
} from '../support/api-app';
import { SecurityEventService } from '../../src/common/audit/security-events.service';
import { AuditService } from '../../src/common/audit/audit.service';
import { RedisService } from '../../src/infrastructure/cache/redis.service';
import { as } from '../support/workforce';

const AUDIT = '/api/v1/admin/audit-logs';

interface PageBody {
  data: Array<{ id: string }>;
  meta: { nextCursor: string | null; total?: number };
}

/** WP-13: keyset paging of the audit viewer, collapsed refusal rows, the worker health probe. */
describe('Operations hardening (integration)', () => {
  let api: ApiApp;
  let admin: Awaited<ReturnType<typeof loginAdmin>>;
  let events: SecurityEventService;

  beforeAll(async () => {
    api = await createApiApp();
    admin = await loginAdmin(api);
    events = api.app.get(SecurityEventService);
  });
  afterAll(async () => {
    await api.close();
  });

  describe('audit log keyset paging', () => {
    it('walks the whole log newest first with no gaps or repeats, and stops with a null cursor', async () => {
      const tag = `ops.walk_${randomUUID().slice(0, 8)}`.replace(/[^a-z_.]/g, 'x');
      const audit = api.app.get(AuditService);
      for (let i = 0; i < 7; i++) {
        await audit.record({ action: tag, entityType: 'test', metadata: { i } });
      }
      const first = (await as(api, admin).get(`${AUDIT}?action=${tag}&limit=3`).expect(200))
        .body as PageBody;
      expect(first.meta.total).toBe(7); // offset mode still counts
      const seen = first.data.map((d) => d.id);
      let cursor = first.meta.nextCursor;
      let pages = 1;
      while (cursor && pages < 10) {
        const res = (
          await as(api, admin).get(`${AUDIT}?action=${tag}&limit=3&cursor=${cursor}`).expect(200)
        ).body as PageBody;
        expect(res.meta.total).toBeUndefined(); // keyset mode never counts
        seen.push(...res.data.map((d) => d.id));
        cursor = res.meta.nextCursor;
        pages++;
      }
      expect(pages).toBe(3);
      expect(cursor).toBeNull();
      expect(new Set(seen).size).toBe(7);
      const ordered = await api.prisma.auditLog.findMany({
        where: { action: tag },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        select: { id: true },
      });
      expect(seen).toEqual(ordered.map((r) => r.id));
    });

    it('rejects a malformed cursor and is for the Super Admin only', async () => {
      for (const bad of [
        '!!!',
        'bm90LWEtY3Vyc29y',
        Buffer.from('2026-01-01|not-a-uuid').toString('base64url'),
      ]) {
        expect((await as(api, admin).get(`${AUDIT}?cursor=${bad}`)).status).toBe(400);
      }
      const other = await loginAdminWithPermissions(api, ['report.view']);
      expect((await as(api, other).get(`${AUDIT}?cursor=abc`)).status).toBe(403);
      expect((await api.http().get(`${AUDIT}?cursor=abc`)).status).toBe(401);
    });
  });

  describe('refused requests are collapsed', () => {
    const asRequest = (userId: string, route: string) => ({
      method: 'GET',
      route: { path: route },
      user: { userId, type: 'CUSTOMER', sessionId: 's' } as never,
    });
    const rowsFor = (userId: string, action: string) =>
      api.prisma.auditLog.findMany({
        where: { actorId: userId, action },
        orderBy: { createdAt: 'asc' },
      });
    const newUser = async () => (await loginWithOtp(api, { appType: 'CUSTOMER' })).userId;

    it('writes the first refusal in full, counts the repeats, and writes one summary row after the minute', async () => {
      const userId = await newUser();
      const req = asRequest(userId, `/api/v1/admin/ops-${randomUUID().slice(0, 6)}`);
      for (let i = 0; i < 6; i++) await events.accessDenied(req, 'USER_TYPE');
      expect(await rowsFor(userId, 'security.access_denied')).toHaveLength(1);
      expect(await rowsFor(userId, 'security.access_denied_repeated')).toHaveLength(0);

      // the minute is not over yet: nothing to write
      expect(await events.flushSuppressed(Date.now())).toBe(0);
      const written = await events.flushSuppressed(Date.now() + 5 * 60_000);
      expect(written).toBeGreaterThanOrEqual(1);
      const [summary] = await rowsFor(userId, 'security.access_denied_repeated');
      expect(summary.metadata).toMatchObject({
        route: req.route.path,
        method: 'GET',
        reason: 'USER_TYPE',
        suppressed: 5,
      });
      // flushing again writes nothing (each count is claimed once)
      expect(await events.flushSuppressed(Date.now() + 10 * 60_000)).toBe(0);
      expect(await rowsFor(userId, 'security.access_denied_repeated')).toHaveLength(1);
    });

    it('does not mix callers, routes or checks, and still records everything when Redis is unreachable', async () => {
      const userA = await newUser();
      const userB = await newUser();
      const a = asRequest(userA, '/api/v1/admin/ops-a');
      const b = asRequest(userB, '/api/v1/admin/ops-a');
      await events.accessDenied(a, 'ROLE');
      await events.accessDenied(a, 'PERMISSION'); // a different check
      await events.accessDenied({ ...a, route: { path: '/api/v1/admin/ops-b' } }, 'ROLE'); // another route
      await events.accessDenied(b, 'ROLE'); // another caller
      expect(await rowsFor(userA, 'security.access_denied')).toHaveLength(3);
      expect(await rowsFor(userB, 'security.access_denied')).toHaveLength(1);

      const spy = jest
        .spyOn(api.app.get(RedisService), 'ensureConnected')
        .mockRejectedValue(new Error('redis down'));
      try {
        await events.accessDenied(a, 'ROLE');
        await events.accessDenied(a, 'ROLE');
      } finally {
        spy.mockRestore();
      }
      expect(await rowsFor(userA, 'security.access_denied')).toHaveLength(5);
    });

    it('the real guard path leaves one row for a hammered route in a minute', async () => {
      const customer = await loginWithOtp(api, { appType: 'CUSTOMER' });
      for (let i = 0; i < 4; i++) {
        await as(api, customer).get('/api/v1/admin/dashboard').expect(403);
      }
      expect(await rowsFor(customer.userId, 'security.access_denied')).toHaveLength(1);
      await events.flushSuppressed(Date.now() + 5 * 60_000);
      const [summary] = await rowsFor(customer.userId, 'security.access_denied_repeated');
      expect(summary.metadata).toMatchObject({ suppressed: 3 });
    });
  });

  describe('worker health probe', () => {
    const probe = (redisUrl: string): number => {
      try {
        execFileSync(process.execPath, ['dist/worker-healthcheck.js'], {
          env: { ...process.env, REDIS_URL: redisUrl },
          stdio: 'ignore',
          timeout: 15_000,
        });
        return 0;
      } catch (error) {
        return (error as { status?: number }).status ?? 1;
      }
    };

    it('passes while the notification loop has a heartbeat and fails without one or without Redis', async () => {
      const redisUrl = process.env.REDIS_URL ?? 'redis://localhost:6379';
      await api.redis.client.del('worker:heartbeat:notifications');
      expect(probe(redisUrl)).toBe(1);
      await api.redis.client.set(
        'worker:heartbeat:notifications',
        new Date().toISOString(),
        'EX',
        60,
      );
      expect(probe(redisUrl)).toBe(0);
      expect(probe('redis://127.0.0.1:1')).toBe(1);
      expect(probe('')).toBe(1);
      await api.redis.client.del('worker:heartbeat:notifications');
    });
  });
});
