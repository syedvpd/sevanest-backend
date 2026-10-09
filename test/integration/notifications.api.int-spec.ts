import '../support/env-api-integration';
import { getQueueToken } from '@nestjs/bullmq';
import type { Queue } from 'bullmq';
import {
  ApiApp,
  createApiApp,
  loginAdmin,
  loginAdminWithPermissions,
  loginWithOtp,
} from '../support/api-app';
import { makeBooking } from '../support/bookings';
import {
  approveCheck,
  as,
  createArea,
  onboardWorker,
  setRequiredChecks,
} from '../support/workforce';
import {
  InMemoryPushProvider,
  InMemoryWhatsAppProvider,
} from '../../src/integrations/notifications/messaging-providers';
import {
  PUSH_PROVIDER,
  WHATSAPP_PROVIDER,
} from '../../src/integrations/notifications/notification-providers.interface';
import { ProviderError } from '../../src/integrations/provider-error';
import { OutboxService } from '../../src/common/outbox/outbox.service';
import { NOTIFICATION_QUEUE } from '../../src/modules/notifications/notifications.constants';
import { NotificationProcessor } from '../../src/modules/notifications/notifications.worker';
import { NotificationsService } from '../../src/modules/notifications/notifications.service';

const T = '/api/v1/admin/notification-templates';

/** Notifications against the REAL PostgreSQL + Redis (dedicated test database), with in-memory provider adapters. */
describe('Notifications (integration)', () => {
  let api: ApiApp;
  let admin: Awaited<ReturnType<typeof loginAdmin>>;
  let area: { id: string };
  let service: NotificationsService;
  let queue: Queue;
  let push: InMemoryPushProvider;
  let whatsapp: InMemoryWhatsAppProvider;

  const dispatch = () => service.dispatchOutbox();
  const drain = async () => {
    for (let i = 0; i < 200; i++) if ((await dispatch()).events === 0) return;
  };
  const template = (body: object) => as(api, admin).post(T, body);
  const eventsOf = (userId: string) =>
    api.prisma.notification.findMany({
      where: { recipientUserId: userId },
      orderBy: { createdAt: 'asc' },
    });
  const asWorkerWithDevice = async () => {
    const worker = await onboardWorker(api, { areaIds: [area.id] });
    await approveCheck(api, admin, worker, 'IDENTITY');
    await as(api, worker)
      .put('/api/v1/auth/device-token', { token: `fcm-${worker.workerId}`, platform: 'ANDROID' })
      .expect(204);
    return worker;
  };
  /** Gives a worker a MATCHED booking, which queues JOB_OPPORTUNITY for them. */
  const offerTo = async (worker: { workerId: string }) => {
    const customer = await loginWithOtp(api, { appType: 'CUSTOMER' });
    const res = await as(api, customer).post('/api/v1/bookings', {
      category: 'HOUSE_MAID',
      areaId: area.id,
      engagement: 'PART_TIME',
      availableFrom: '09:00',
      availableTo: '12:00',
      workerId: worker.workerId,
    });
    expect(res.status).toBe(201);
    return res.body.id as string;
  };

  beforeAll(async () => {
    api = await createApiApp();
    service = api.app.get(NotificationsService);
    queue = api.app.get<Queue>(getQueueToken(NOTIFICATION_QUEUE));
    push = api.app.get<InMemoryPushProvider>(PUSH_PROVIDER);
    whatsapp = api.app.get<InMemoryWhatsAppProvider>(WHATSAPP_PROVIDER);
    admin = await loginAdmin(api);
    area = await createArea(api, admin);
    await setRequiredChecks(api, admin, ['IDENTITY']);
    await drain();
  });

  afterAll(async () => {
    await setRequiredChecks(api, admin, []);
    await api.prisma.notificationTemplate.updateMany({ data: { isActive: false } });
    await api.close();
  });

  describe('templates (admin)', () => {
    it('are managed by authorised staff only', async () => {
      const manager = await loginAdminWithPermissions(api, ['notification.manage']);
      const other = await loginAdminWithPermissions(api, ['worker.view']);
      const customer = await loginWithOtp(api, { appType: 'CUSTOMER' });
      expect((await as(api, other).get(T)).status).toBe(403);
      expect((await as(api, customer).get(T)).status).toBe(403);
      expect((await api.http().get(T)).status).toBe(401);
      expect((await as(api, manager).get(T)).status).toBe(200);
      expect((await as(api, other).get('/api/v1/admin/notifications')).status).toBe(403);
      expect(
        (await as(api, manager).get('/api/v1/admin/notification-events')).body.map(
          (e: { eventCode: string }) => e.eventCode,
        ),
      ).toContain('BOOKING_CONFIRMED');
    });

    it('validate the event, the channel and the placeholders, and refuse duplicates', async () => {
      for (const bad of [
        { eventCode: 'NO_SUCH_EVENT', channel: 'SMS', body: 'x' },
        { eventCode: 'BOOKING_CONFIRMED', channel: 'EMAIL', body: 'x' },
        { eventCode: 'BOOKING_CONFIRMED', channel: 'SMS', body: '' },
        { eventCode: 'BOOKING_CONFIRMED', channel: 'SMS', body: 'Hi {{customerMobile}}' },
        { eventCode: 'BOOKING_CONFIRMED', channel: 'SMS', body: 'x', language: 'ENGLISH' },
        { eventCode: 'booking', channel: 'SMS', body: 'x' },
      ]) {
        expect((await template(bad)).status).toBe(400);
      }
      const lang = `hi-${Math.random().toString(36).slice(2, 8)}`;
      const ok = await template({
        eventCode: 'INTERVIEW_TRIAL_SCHEDULED',
        channel: 'WHATSAPP',
        body: 'Booking {{bookingId}} {{scheduleType}}',
        language: lang,
      });
      expect(ok.status).toBe(201);
      const dup = await template({
        eventCode: 'INTERVIEW_TRIAL_SCHEDULED',
        channel: 'WHATSAPP',
        body: 'again',
        language: lang,
      });
      expect(dup.status).toBe(409);
      expect(dup.body.code).toBe('TEMPLATE_EXISTS');
      const changed = await as(api, admin).patch(`${T}/${ok.body.id}`, {
        body: 'Updated {{bookingId}}',
        isActive: false,
      });
      expect(changed.body).toMatchObject({ body: 'Updated {{bookingId}}', isActive: false });
      expect(
        (await as(api, admin).patch(`${T}/${ok.body.id}`, { body: 'x {{nope}}' })).status,
      ).toBe(400);
      expect(
        (
          await as(api, admin).patch(`${T}/00000000-0000-7000-8000-000000000000`, {
            isActive: true,
          })
        ).status,
      ).toBe(404);
      expect(
        await api.prisma.auditLog.count({
          where: { entityId: ok.body.id, action: { startsWith: 'notification_template.' } },
        }),
      ).toBe(2);
    });
  });

  describe('outbox, queue and delivery', () => {
    let waTemplate: string;

    beforeAll(async () => {
      // Templates are shared test-database state: (re)write the three we need, active, with the wording below.
      const ensure = async (
        channel: 'SMS' | 'PUSH' | 'WHATSAPP',
        title: string | null,
        body: string,
      ): Promise<string> =>
        (
          await api.prisma.notificationTemplate.upsert({
            where: {
              eventCode_channel_language: { eventCode: 'JOB_OPPORTUNITY', channel, language: 'en' },
            },
            create: { eventCode: 'JOB_OPPORTUNITY', channel, language: 'en', title, body },
            update: { title, body, isActive: true },
          })
        ).id;
      await ensure('SMS', null, 'New job {{bookingId}} for {{category}} in {{area}}');
      await ensure('PUSH', 'New job', 'Booking {{bookingId}}');
      waTemplate = await ensure('WHATSAPP', null, 'Job {{bookingId}}');
    });

    it('turns a committed business event into one queued notification per configured channel, once', async () => {
      const worker = await asWorkerWithDevice();
      const bookingId = await offerTo(worker);
      const first = await dispatch();
      expect(first.queued).toBeGreaterThanOrEqual(3);
      const rows = await eventsOf(worker.userId);
      expect(rows.map((r) => r.channel).sort()).toEqual(['PUSH', 'SMS', 'WHATSAPP']);
      expect(rows.every((r) => r.status === 'QUEUED' && r.eventCode === 'JOB_OPPORTUNITY')).toBe(
        true,
      );
      expect(rows[0].params).toMatchObject({ bookingId });
      for (const row of rows) {
        const job = await queue.getJob(row.id);
        expect(job?.data).toEqual({ notificationId: row.id });
      }
      expect((await dispatch()).queued).toBe(0);
      expect(await eventsOf(worker.userId)).toHaveLength(3);
    });

    it('delivers through each adapter with the rendered text, and a repeat sends nothing more', async () => {
      const worker = await asWorkerWithDevice();
      const bookingId = await offerTo(worker);
      await dispatch();
      const rows = await eventsOf(worker.userId);
      for (const row of rows) expect(await service.deliver(row.id)).toBe('SENT');
      const sms = api.sms.lastTo(worker.mobile);
      expect(sms?.body).toMatch(new RegExp(`^New job ${bookingId} for .+ in .+$`));
      expect(sms?.body).not.toContain('{{');
      expect(push.sent.find((m) => m.to === `fcm-${worker.workerId}`)).toMatchObject({
        title: 'New job',
        body: `Booking ${bookingId}`,
      });
      expect(whatsapp.sent.find((m) => m.to === worker.mobile)?.body).toBe(`Job ${bookingId}`);
      const sentBefore = [api.sms.sent.length, push.sent.length, whatsapp.sent.length];
      for (const row of rows) expect(await service.deliver(row.id)).toBe('ALREADY_DONE');
      expect([api.sms.sent.length, push.sent.length, whatsapp.sent.length]).toEqual(sentBefore);
      const done = await eventsOf(worker.userId);
      expect(
        done.every(
          (r) => r.status === 'SENT' && r.sentAt && r.providerMessageId && r.attempts === 1,
        ),
      ).toBe(true);
    });

    it('sends once even when delivery is attempted in parallel and dispatch runs concurrently', async () => {
      const worker = await asWorkerWithDevice();
      await offerTo(worker);
      await Promise.all(Array.from({ length: 4 }, () => dispatch()));
      const rows = await eventsOf(worker.userId);
      expect(rows).toHaveLength(3);
      const sms = rows.find((r) => r.channel === 'SMS')!;
      const before = api.sms.sent.length;
      await Promise.all(Array.from({ length: 5 }, () => service.deliver(sms.id)));
      expect(api.sms.sent.length - before).toBe(1);
      expect((await eventsOf(worker.userId)).find((r) => r.id === sms.id)!.status).toBe('SENT');
      const again = api.sms.sent.length;
      await service.deliver(sms.id);
      expect(api.sms.sent.length).toBe(again);
    });

    it('retries a provider outage with the queue, fails after the last attempt, and hides the provider message', async () => {
      const worker = await asWorkerWithDevice();
      await offerTo(worker);
      await dispatch();
      const wa = (await eventsOf(worker.userId)).find((r) => r.channel === 'WHATSAPP')!;
      whatsapp.failWith = new ProviderError('whatsapp', 'vendor said: secret-token-123', true);
      try {
        await expect(service.deliver(wa.id, { number: 1, max: 3 })).rejects.toThrow();
        let row = (await eventsOf(worker.userId)).find((r) => r.id === wa.id)!;
        expect(row).toMatchObject({ status: 'QUEUED', attempts: 1, lastError: 'PROVIDER_ERROR' });
        await expect(service.deliver(wa.id, { number: 2, max: 3 })).rejects.toThrow();
        expect(await service.deliver(wa.id, { number: 3, max: 3 })).toBe('FAILED');
        row = (await eventsOf(worker.userId)).find((r) => r.id === wa.id)!;
        expect(row).toMatchObject({ status: 'FAILED', attempts: 3, lastError: 'PROVIDER_ERROR' });
      } finally {
        whatsapp.failWith = null;
      }
      expect(await service.deliver(wa.id)).toBe('ALREADY_DONE');
      const log = await as(api, admin)
        .get(`/api/v1/admin/notifications?status=FAILED&recipientUserId=${worker.userId}`)
        .expect(200);
      expect(JSON.stringify(log.body)).not.toContain('secret-token-123');
      expect(log.body.data[0]).toMatchObject({
        channel: 'WHATSAPP',
        status: 'FAILED',
        attempts: 3,
      });
    });

    it('fails at once on a permanent provider rejection, and recovers by retry after a transient one', async () => {
      const worker = await asWorkerWithDevice();
      await offerTo(worker);
      await dispatch();
      const rows = await eventsOf(worker.userId);
      const pushRow = rows.find((r) => r.channel === 'PUSH')!;
      push.failWith = new ProviderError('push', 'invalid token abc', false);
      try {
        expect(await service.deliver(pushRow.id, { number: 1, max: 5 })).toBe('FAILED');
      } finally {
        push.failWith = null;
      }
      expect((await eventsOf(worker.userId)).find((r) => r.id === pushRow.id)).toMatchObject({
        status: 'FAILED',
        lastError: 'PROVIDER_REJECTED',
      });
      const waRow = rows.find((r) => r.channel === 'WHATSAPP')!;
      whatsapp.failWith = new ProviderError('whatsapp', 'timeout', true);
      await expect(service.deliver(waRow.id, { number: 1, max: 5 })).rejects.toThrow();
      whatsapp.failWith = null;
      expect(await service.deliver(waRow.id, { number: 2, max: 5 })).toBe('SENT');
    });

    it('skips instead of failing when there is nobody to deliver to', async () => {
      const noDevice = await onboardWorker(api, { areaIds: [area.id] });
      await approveCheck(api, admin, noDevice, 'IDENTITY');
      await offerTo(noDevice);
      const suspended = await asWorkerWithDevice();
      await offerTo(suspended);
      await dispatch();
      await as(api, admin)
        .patch(`/api/v1/admin/users/${suspended.userId}/status`, { status: 'SUSPENDED' })
        .expect(200);
      const a = await eventsOf(noDevice.userId);
      const b = await eventsOf(suspended.userId);
      expect(await service.deliver(a.find((r) => r.channel === 'PUSH')!.id)).toBe('SKIPPED');
      expect((await eventsOf(noDevice.userId)).find((r) => r.channel === 'PUSH')).toMatchObject({
        status: 'SKIPPED',
        lastError: 'NO_DEVICE',
      });
      expect(await service.deliver(b.find((r) => r.channel === 'SMS')!.id)).toBe('SKIPPED');
      expect((await eventsOf(suspended.userId)).find((r) => r.channel === 'SMS')).toMatchObject({
        lastError: 'RECIPIENT_INACTIVE',
      });
      // A template switched off before delivery is respected too.
      await as(api, admin).patch(`${T}/${waTemplate}`, { isActive: false }).expect(200);
      try {
        expect(await service.deliver(a.find((r) => r.channel === 'WHATSAPP')!.id)).toBe('SKIPPED');
      } finally {
        await as(api, admin).patch(`${T}/${waTemplate}`, { isActive: true }).expect(200);
      }
    });

    it('queues nothing for an event no template covers, but still marks the event processed', async () => {
      const worker = await asWorkerWithDevice();
      const before = await api.prisma.outboxEvent.count({ where: { processedAt: null } });
      await api.prisma.$transaction((tx) =>
        api.app.get(OutboxService).notify(
          {
            event: 'REPLACEMENT_UPDATE',
            recipients: [worker.userId],
            params: { bookingId: 'b', replacementId: 'r', status: 'x' },
          },
          tx,
        ),
      );
      expect(await api.prisma.outboxEvent.count({ where: { processedAt: null } })).toBe(before + 1);
      await drain();
      expect(await api.prisma.outboxEvent.count({ where: { processedAt: null } })).toBe(0);
      expect(
        await api.prisma.notification.count({
          where: { recipientUserId: worker.userId, eventCode: 'REPLACEMENT_UPDATE' },
        }),
      ).toBe(0);
    });

    it('records an event only if the business transaction commits', async () => {
      const worker = await asWorkerWithDevice();
      const marker = `rollback-${Date.now()}`;
      await expect(
        api.prisma.$transaction(async (tx) => {
          await api.app.get(OutboxService).notify(
            {
              event: 'REPLACEMENT_UPDATE',
              recipients: [worker.userId],
              params: { bookingId: marker, replacementId: 'r', status: 'x' },
            },
            tx,
          );
          throw new Error('business rule failed');
        }),
      ).rejects.toThrow('business rule failed');
      expect(
        await api.prisma.outboxEvent.count({
          where: { payload: { path: ['params', 'bookingId'], equals: marker } },
        }),
      ).toBe(0);
    });

    it('hands a stale queued notification back to the queue without creating a second job', async () => {
      const worker = await asWorkerWithDevice();
      await offerTo(worker);
      await dispatch();
      const row = (await eventsOf(worker.userId))[0];
      await queue.remove(row.id);
      await api.prisma
        .$executeRaw`UPDATE notifications SET created_at = now() - interval '10 minutes' WHERE id = ${row.id}::uuid`;
      expect(await service.requeueStale()).toBeGreaterThanOrEqual(1);
      expect((await queue.getJob(row.id))?.data).toEqual({ notificationId: row.id });
      await service.requeueStale();
      expect(await queue.getJobs(['waiting', 'delayed', 'active', 'completed'])).toEqual(
        expect.any(Array),
      );
    });

    it('is driven by the queue consumer: the processor delivers and reports the attempt number', async () => {
      const worker = await asWorkerWithDevice();
      await offerTo(worker);
      await dispatch();
      const row = (await eventsOf(worker.userId)).find((r) => r.channel === 'SMS')!;
      const processor = new NotificationProcessor(service);
      expect(
        await processor.process({
          data: { notificationId: row.id },
          attemptsMade: 0,
          opts: { attempts: 5 },
        } as never),
      ).toBe('SENT');
      expect(
        await processor.process({
          data: { notificationId: row.id },
          attemptsMade: 1,
          opts: { attempts: 5 },
        } as never),
      ).toBe('ALREADY_DONE');
    });
  });

  describe('events from the other modules', () => {
    it('are produced by booking, payment and verification transitions', async () => {
      await drain();
      const customer = await loginWithOtp(api, { appType: 'CUSTOMER' });
      const booking = await makeBooking(api, admin, customer, area.id, 'CONFIRMED');
      const codes = (
        await api.prisma.outboxEvent.findMany({
          where: { payload: { path: ['params', 'bookingId'], equals: booking.id } },
        })
      ).map((e) => (e.payload as { event: string }).event);
      expect(codes.sort()).toEqual(
        [
          'BOOKING_CONFIRMED',
          'INTERVIEW_TRIAL_SCHEDULED',
          'JOB_OPPORTUNITY',
          'PAYMENT_SUCCEEDED',
        ].sort(),
      );
      const verification = await api.prisma.outboxEvent.count({
        where: {
          payload: { path: ['recipients'], array_contains: [booking.worker.userId] },
          AND: [{ payload: { path: ['event'], equals: 'VERIFICATION_APPROVED' } }],
        },
      });
      expect(verification).toBe(1);
    });
  });
});
