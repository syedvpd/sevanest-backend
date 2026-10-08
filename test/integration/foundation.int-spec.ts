// Loads .env into process.env (existing variables, e.g. NODE_ENV=test from Jest, are not overridden). Must stay first.
import 'dotenv/config';
import { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { Queue } from 'bullmq';
import request from 'supertest';
import { AppModule } from '../../src/app.module';
import { configureApp } from '../../src/app.setup';
import { AuditRepository } from '../../src/common/audit/audit.repository';
import { AuditService } from '../../src/common/audit/audit.service';
import { AppConfigService } from '../../src/config/app-config.service';
import type { Prisma } from '../../src/generated/prisma/client';
import { RedisService } from '../../src/infrastructure/cache/redis.service';
import { PrismaService } from '../../src/infrastructure/database/prisma.service';
import { DEFAULT_JOB_OPTIONS } from '../../src/infrastructure/queue/queue.constants';
import { redisConnectionFromUrl } from '../../src/infrastructure/queue/redis-connection';
import { AuthRepository } from '../../src/modules/auth/auth.repository';
import { WorkerModule } from '../../src/worker.module';

/**
 * Integration tests against the REAL local PostgreSQL + Redis (docker compose) with the foundation migration applied.
 * Non-destructive by construction: every database write happens inside a transaction that is always rolled back.
 */
class Rollback extends Error {}

async function inRollback(
  prisma: PrismaService,
  work: (tx: Prisma.TransactionClient) => Promise<void>,
): Promise<void> {
  await prisma
    .$transaction(async (tx) => {
      await work(tx);
      throw new Rollback();
    })
    .catch((error: unknown) => {
      if (!(error instanceof Rollback)) throw error;
    });
}

const unique = () => `${Date.now()}${Math.floor(Math.random() * 1e6)}`;

describe('Foundation integration (real PostgreSQL + Redis)', () => {
  let app: NestExpressApplication;
  let prisma: PrismaService;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication<NestExpressApplication>({ rawBody: true, logger: false });
    configureApp(app, app.get(AppConfigService));
    await app.init();
    prisma = app.get(PrismaService);
  });
  afterAll(async () => {
    await app.close();
  });

  describe('connectivity', () => {
    it('PostgreSQL answers and the foundation migration is applied', async () => {
      const tables = await prisma.$queryRaw<{ table_name: string }[]>`
        SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'`;
      const names = tables.map((t) => t.table_name);
      expect(names).toEqual(
        expect.arrayContaining([
          'users',
          'roles',
          'permissions',
          'role_permissions',
          'user_roles',
          'sessions',
          'audit_logs',
        ]),
      );
    });

    it('Redis answers PING', async () => {
      await expect(app.get(RedisService).ping()).resolves.toBeUndefined();
    });

    it('GET /health/ready (real app, real infrastructure) is 200 with database and redis up', async () => {
      const res = await request(app.getHttpServer()).get('/health/ready').expect(200);
      expect(res.body.info).toMatchObject({ database: { status: 'up' }, redis: { status: 'up' } });
    });

    it('GET /health/live and an unknown /api/v1 route behave per the API conventions', async () => {
      await request(app.getHttpServer()).get('/health/live').expect(200);
      const res = await request(app.getHttpServer()).get('/api/v1/nope').expect(404);
      expect(res.body).toMatchObject({ code: 'NOT_FOUND' });
      expect(res.headers['x-request-id']).toBeDefined();
    });
  });

  describe('schema guarantees', () => {
    it('audit_logs is append-only: UPDATE and DELETE are rejected by the database', async () => {
      await inRollback(prisma, async (tx) => {
        const audit = new AuditService(new AuditRepository(prisma));
        await audit.record(
          { action: 'int.test', entityType: 'IntegrationTest', entityId: unique() },
          tx,
        );
        const [row] = await tx.$queryRaw<{ id: string }[]>`
          SELECT id::text AS id FROM audit_logs WHERE action = 'int.test' ORDER BY created_at DESC LIMIT 1`;
        expect(row).toBeDefined();
        await expect(
          tx.$executeRaw`UPDATE audit_logs SET action = 'tampered' WHERE id = ${row.id}::uuid`,
        ).rejects.toThrow(/append-only/);
      });
      await inRollback(prisma, async (tx) => {
        await new AuditService(new AuditRepository(prisma)).record(
          { action: 'int.test.delete', entityType: 'IntegrationTest' },
          tx,
        );
        await expect(
          tx.$executeRaw`DELETE FROM audit_logs WHERE action = 'int.test.delete'`,
        ).rejects.toThrow(/append-only/);
      });
    });

    it('the audit trigger that blocks TRUNCATE exists (checked via catalog, TRUNCATE itself is never executed)', async () => {
      const triggers = await prisma.$queryRaw<{ tgname: string }[]>`
        SELECT tgname FROM pg_trigger WHERE tgrelid = 'audit_logs'::regclass AND NOT tgisinternal`;
      expect(triggers.map((t) => t.tgname)).toEqual(
        expect.arrayContaining(['audit_logs_no_update_delete', 'audit_logs_no_truncate']),
      );
    });

    it('a user must have at least one login identifier', async () => {
      await inRollback(prisma, async (tx) => {
        await expect(tx.user.create({ data: { type: 'CUSTOMER' } })).rejects.toThrow();
      });
    });

    it('mobile numbers are unique', async () => {
      await inRollback(prisma, async (tx) => {
        const mobile = `+91${unique()}`;
        await tx.user.create({ data: { type: 'CUSTOMER', mobile } });
        await expect(tx.user.create({ data: { type: 'WORKER', mobile } })).rejects.toThrow();
      });
    });
  });

  describe('auth repository against the real schema', () => {
    it('finds only active sessions and resolves the union of role permissions', async () => {
      await inRollback(prisma, async (tx) => {
        const repo = new AuthRepository(tx as unknown as PrismaService);
        const user = await tx.user.create({
          data: { type: 'ADMIN', email: `a${unique()}@example.test` },
        });
        const suspended = await tx.user.create({
          data: { type: 'ADMIN', email: `s${unique()}@example.test`, status: 'SUSPENDED' },
        });
        const future = new Date(Date.now() + 3_600_000);
        const past = new Date(Date.now() - 3_600_000);
        const active = await tx.session.create({
          data: { userId: user.id, refreshTokenHash: `h-${unique()}-1`, expiresAt: future },
        });
        const revoked = await tx.session.create({
          data: {
            userId: user.id,
            refreshTokenHash: `h-${unique()}-2`,
            expiresAt: future,
            revokedAt: new Date(),
          },
        });
        const expired = await tx.session.create({
          data: { userId: user.id, refreshTokenHash: `h-${unique()}-3`, expiresAt: past },
        });
        const ofSuspended = await tx.session.create({
          data: { userId: suspended.id, refreshTokenHash: `h-${unique()}-4`, expiresAt: future },
        });

        const now = new Date();
        await expect(repo.findActiveSession(active.id, now)).resolves.toMatchObject({
          userId: user.id,
          userType: 'ADMIN',
          userStatus: 'ACTIVE',
        });
        await expect(repo.findActiveSession(revoked.id, now)).resolves.toBeNull();
        await expect(repo.findActiveSession(expired.id, now)).resolves.toBeNull();
        // The repository returns the status; the guard is what rejects non-ACTIVE users.
        await expect(repo.findActiveSession(ofSuspended.id, now)).resolves.toMatchObject({
          userStatus: 'SUSPENDED',
        });

        const p1 = await tx.permission.create({ data: { code: `t.read.${unique()}` } });
        const p2 = await tx.permission.create({ data: { code: `t.write.${unique()}` } });
        const r1 = await tx.role.create({ data: { code: `r1.${unique()}`, name: 'R1' } });
        const r2 = await tx.role.create({ data: { code: `r2.${unique()}`, name: 'R2' } });
        await tx.rolePermission.createMany({
          data: [
            { roleId: r1.id, permissionId: p1.id },
            { roleId: r2.id, permissionId: p1.id },
            { roleId: r2.id, permissionId: p2.id },
          ],
        });
        await tx.userRole.createMany({
          data: [
            { userId: user.id, roleId: r1.id },
            { userId: user.id, roleId: r2.id },
          ],
        });

        const resolved = await repo.getRoleAndPermissionCodes(user.id);
        expect(resolved.roles.sort()).toEqual([r1.code, r2.code].sort());
        expect(resolved.permissions.sort()).toEqual([p1.code, p2.code].sort());
        await expect(repo.getRoleAndPermissionCodes(suspended.id)).resolves.toEqual({
          roles: [],
          permissions: [],
        });
      });
    });
  });

  describe('BullMQ infrastructure', () => {
    it('platform job defaults apply (retries, exponential backoff, failed jobs retained) on the real Redis', async () => {
      const queue = new Queue(`int-test-${unique()}`, {
        connection: redisConnectionFromUrl(process.env.REDIS_URL as string),
        defaultJobOptions: DEFAULT_JOB_OPTIONS,
      });
      try {
        const job = await queue.add('probe', { n: 1 });
        expect(job.opts.attempts).toBe(5);
        expect(job.opts.backoff).toMatchObject({ type: 'exponential', delay: 2000 });
        expect(job.opts.removeOnFail).toBe(false);
        await job.remove();
      } finally {
        await queue.close();
      }
    });
  });
});

describe('Worker process module (real infrastructure)', () => {
  it('starts, connects to PostgreSQL/Redis/BullMQ configuration, and shuts down cleanly', async () => {
    const worker = await Test.createTestingModule({ imports: [WorkerModule] }).compile();
    const context = worker.createNestApplication({ logger: false });
    await context.init();
    await expect(context.get(PrismaService).$queryRaw`SELECT 1 AS ok`).resolves.toBeDefined();
    await expect(context.get(RedisService).ping()).resolves.toBeUndefined();
    await context.close(); // runs OnModuleDestroy hooks: Prisma disconnect, Redis quit
  });
});
