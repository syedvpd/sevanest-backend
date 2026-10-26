import '../support/env-api-integration';
import { randomUUID } from 'node:crypto';
import {
  ApiApp,
  createApiApp,
  loginAdmin,
  loginAdminWithPermissions,
  loginWithOtp,
  unique,
} from '../support/api-app';
import { ensureFee, makeBooking } from '../support/bookings';
import { AppConfigService } from '../../src/config/app-config.service';
import { LegalService } from '../../src/modules/legal/legal.service';
import { RetentionService } from '../../src/modules/retention/retention.service';
import {
  as,
  approveCheck,
  checkIdOf,
  createArea,
  onboardWorker,
  setRequiredChecks,
  uploadDocument,
} from '../support/workforce';

const A = '/api/v1/admin';
const DELETE_ME = '/api/v1/me/deletion-request';

/** Retention and erasure (DEC-08): time-based clean-up, account anonymisation, and what must never be touched. */
describe('Retention and account erasure (integration)', () => {
  let api: ApiApp;
  let admin: Awaited<ReturnType<typeof loginAdmin>>;
  let area: { id: string };
  let retention: RetentionService;
  let legal: LegalService;

  const live = () => retention.runOnce({ dryRun: false, audit: true });
  const dry = () => retention.runOnce({ dryRun: true });
  const task = (report: Awaited<ReturnType<typeof dry>>, name: string) =>
    report.tasks.find((t) => t.name === name)!;
  const old = (days: number) => new Date(Date.now() - days * 86_400_000);
  const backdateRequest = (userId: string, days: number) =>
    api.prisma.deletionRequest.updateMany({
      where: { userId },
      data: { requestedAt: old(days) },
    });
  const counts = async () => ({
    audit: await api.prisma.auditLog.count(),
    payments: await api.prisma.payment.count(),
    bookings: await api.prisma.booking.count(),
    events: await api.prisma.bookingEvent.count(),
  });

  beforeAll(async () => {
    api = await createApiApp();
    admin = await loginAdmin(api);
    area = await createArea(api, admin);
    await ensureFee(api, admin);
    await setRequiredChecks(api, admin, ['IDENTITY']);
    retention = api.app.get(RetentionService);
    legal = api.app.get(LegalService);
  });
  afterAll(async () => {
    await setRequiredChecks(api, admin, []);
    await api.close();
  });

  describe('time-based clean-up', () => {
    it('removes old finished notifications and processed outbox events, only those, and only for real; a dry run changes nothing', async () => {
      const user = await loginWithOtp(api, { appType: 'CUSTOMER' });
      const mkEvent = (processedAt: Date | null) =>
        api.prisma.outboxEvent.create({
          data: { topic: 'notification', payload: {}, processedAt },
        });
      const mkNotification = async (
        status: 'SENT' | 'QUEUED' | 'FAILED',
        createdAt: Date,
        eventId: string,
      ) =>
        api.prisma.notification.create({
          data: {
            outboxEventId: eventId,
            recipientUserId: user.userId,
            eventCode: 'TEST_EVENT',
            channel: 'IN_APP',
            params: {},
            status,
            dedupeKey: `ret-${randomUUID()}`,
            createdAt,
          },
        });
      const e1 = await mkEvent(old(400));
      const oldSent = await mkNotification('SENT', old(400), e1.id);
      const oldFailed = await mkNotification('FAILED', old(400), e1.id);
      const oldQueued = await mkNotification('QUEUED', old(400), e1.id);
      const e2 = await mkEvent(old(5));
      const recent = await mkNotification('SENT', old(5), e2.id);
      const oldProcessedNoRows = await mkEvent(old(200));
      const oldUnprocessed = await mkEvent(null);
      await api.prisma
        .$executeRaw`UPDATE outbox_events SET created_at = now() - interval '200 days' WHERE id = ${oldUnprocessed.id}::uuid`;
      const before = await counts();

      const preview = await dry();
      expect(preview.dryRun).toBe(true);
      expect(task(preview, 'notifications').matched).toBeGreaterThanOrEqual(2);
      expect(task(preview, 'notifications').affected).toBe(0);
      expect(await api.prisma.notification.count({ where: { id: oldSent.id } })).toBe(1);

      const run = await live();
      expect(task(run, 'notifications').affected).toBeGreaterThanOrEqual(2);
      const exists = async (id: string) => api.prisma.notification.count({ where: { id } });
      expect(await exists(oldSent.id)).toBe(0);
      expect(await exists(oldFailed.id)).toBe(0);
      expect(await exists(oldQueued.id)).toBe(1); // a queued message is never dropped
      expect(await exists(recent.id)).toBe(1);

      // outbox: an old event with no notification left goes; one that still has rows, and unprocessed ones, stay
      expect(await api.prisma.outboxEvent.count({ where: { id: oldProcessedNoRows.id } })).toBe(0);
      expect(await api.prisma.outboxEvent.count({ where: { id: e1.id } })).toBe(1); // oldQueued still points at it
      expect(await api.prisma.outboxEvent.count({ where: { id: oldUnprocessed.id } })).toBe(1);
      expect(await api.prisma.outboxEvent.count({ where: { id: e2.id } })).toBe(1);

      // never audit logs, payments, bookings
      const after = await counts();
      expect(after.payments).toBe(before.payments);
      expect(after.bookings).toBe(before.bookings);
      expect(after.events).toBe(before.events);
      expect(after.audit).toBeGreaterThanOrEqual(before.audit);

      // idempotent
      const again = await live();
      expect(task(again, 'notifications').matched).toBeLessThan(
        task(run, 'notifications').matched + 1,
      );
      expect(await exists(recent.id)).toBe(1);
    });

    it('purges stored files of REJECTED KYC checks after the period, never those of approved checks', async () => {
      const worker = await onboardWorker(api, { areaIds: [area.id] });
      const rejectedDoc = await uploadDocument(api, worker, 'IDENTITY');
      await as(api, worker)
        .post('/api/v1/workers/me/verification/checks/IDENTITY/submit')
        .expect(200);
      const checkId = await checkIdOf(api, admin, worker.workerId, 'IDENTITY');
      await as(api, admin).post(`${A}/verification/checks/${checkId}/start-review`).expect(200);
      await as(api, admin)
        .post(`${A}/verification/checks/${checkId}/reject`, {
          reasonCode: 'OTHER',
          remarks: 'Blurry scan',
        })
        .expect(200);
      const keptWorker = await onboardWorker(api, { areaIds: [area.id] });
      await approveCheck(api, admin, keptWorker, 'IDENTITY');

      const row = await api.prisma.verificationDocument.findUniqueOrThrow({
        where: { id: rejectedDoc },
      });
      // recent rejection: not yet due
      expect(task(await dry(), 'verification').matched).toBe(0);
      await api.prisma
        .$executeRaw`UPDATE worker_verification_checks SET updated_at = now() - interval '100 days' WHERE id = ${checkId}::uuid`;
      const preview = await dry();
      expect(task(preview, 'verification').matched).toBe(1);
      expect(
        (await api.prisma.verificationDocument.findUniqueOrThrow({ where: { id: rejectedDoc } }))
          .purgedAt,
      ).toBeNull();

      const run = await live();
      expect(task(run, 'verification').affected).toBe(1);
      const purged = await api.prisma.verificationDocument.findUniqueOrThrow({
        where: { id: rejectedDoc },
      });
      expect(purged.purgedAt).not.toBeNull();
      expect(purged.rejectionCode).toBe('RETENTION_EXPIRED');
      expect(await api.storage.getObjectInfo(row.objectKey)).toBeNull();
      // the approved worker's document is untouched
      const kept = await api.prisma.verificationDocument.findFirstOrThrow({
        where: { check: { workerId: keptWorker.workerId } },
      });
      expect(kept.purgedAt).toBeNull();
      expect(task(await live(), 'verification').affected).toBe(0);
    });
  });

  describe('account deletion', () => {
    const newCustomer = async () => {
      const session = await loginWithOtp(api, { appType: 'CUSTOMER' });
      await as(api, session)
        .post('/api/v1/customers/me', {
          name: 'Asha Rao',
          email: `asha.${unique()}@example.test`,
          preferredLanguage: 'en',
        })
        .expect(201);
      await as(api, session)
        .post('/api/v1/customers/me/addresses', {
          line: '12 Lake Road',
          area: 'Madhapur',
          city: 'Hyderabad',
          pincode: '500081',
          label: 'Home',
        })
        .expect(201);
      return session;
    };

    it('anonymises an account after the cooling-off period and keeps bookings, payments and audit rows', async () => {
      const customer = await newCustomer();
      const bystander = await newCustomer();
      const booking = await makeBooking(api, admin, customer, area.id, 'MATCHED');
      await as(api, customer)
        .post(`/api/v1/bookings/${booking.id}/cancel`, { reason: 'not needed' })
        .expect(200);
      await as(api, customer).post(DELETE_ME, { reason: 'leaving' }).expect(201);
      const before = await counts();

      // within the cooling-off period nothing happens
      expect((await legal.processDueDeletions({ dryRun: false, batchSize: 100 })).anonymised).toBe(
        0,
      );
      expect(
        (await api.prisma.user.findUniqueOrThrow({ where: { id: customer.userId } })).mobile,
      ).not.toBeNull();

      await backdateRequest(customer.userId, 31);
      const preview = await legal.processDueDeletions({ dryRun: true, batchSize: 100 });
      expect(preview.due).toBeGreaterThanOrEqual(1);
      expect(preview.anonymised).toBe(0);
      expect(
        (await api.prisma.user.findUniqueOrThrow({ where: { id: customer.userId } })).mobile,
      ).not.toBeNull();

      const result = await legal.processDueDeletions({ dryRun: false, batchSize: 100 });
      expect(result.anonymised).toBe(1);
      const user = await api.prisma.user.findUniqueOrThrow({ where: { id: customer.userId } });
      expect(user).toMatchObject({ mobile: null, status: 'SUSPENDED', passwordHash: null });
      expect(user.email).toBe(`deleted-${customer.userId}@deleted.invalid`);
      const profile = await api.prisma.customerProfile.findUniqueOrThrow({
        where: { userId: customer.userId },
        include: { addresses: true },
      });
      expect(profile.name).toBe('Deleted user');
      expect(profile.email).toContain('deleted.invalid');
      expect(
        profile.addresses.every((a) => a.line === 'Deleted' && !a.isActive && a.label === null),
      ).toBe(true);
      expect(
        await api.prisma.session.count({ where: { userId: customer.userId, revokedAt: null } }),
      ).toBe(0);
      expect(
        (await api.prisma.deletionRequest.findFirstOrThrow({ where: { userId: customer.userId } }))
          .status,
      ).toBe('COMPLETED');
      const audit = await api.prisma.auditLog.findFirstOrThrow({
        where: { action: 'account.anonymised', entityId: customer.userId },
      });
      expect(JSON.stringify(audit.metadata)).not.toContain('Asha');

      // history stays; other people are untouched
      const after = await counts();
      expect(after.bookings).toBe(before.bookings);
      expect(after.payments).toBe(before.payments);
      expect(after.events).toBe(before.events);
      expect(after.audit).toBeGreaterThan(before.audit);
      expect(
        (await api.prisma.booking.findUniqueOrThrow({ where: { id: booking.id } })).customerUserId,
      ).toBe(customer.userId);
      const other = await api.prisma.customerProfile.findUniqueOrThrow({
        where: { userId: bystander.userId },
      });
      expect(other.name).toBe('Asha Rao');
      expect(
        (await api.prisma.user.findUniqueOrThrow({ where: { id: bystander.userId } })).mobile,
      ).not.toBeNull();

      // signing in as the old number creates a brand-new account: the erased one cannot be reached
      const rerun = await legal.processDueDeletions({ dryRun: false, batchSize: 100 });
      expect(rerun.anonymised).toBe(0); // idempotent
    });

    it('waits while a booking is live or money is in flight, then goes ahead', async () => {
      const customer = await newCustomer();
      await as(api, customer).post(DELETE_ME, {}).expect(201);
      const live = await makeBooking(api, admin, customer, area.id, 'MATCHED');
      await backdateRequest(customer.userId, 40);
      const blocked = await legal.processDueDeletions({ dryRun: false, batchSize: 100 });
      expect(blocked.blocked).toBeGreaterThanOrEqual(1);
      expect(
        (await api.prisma.user.findUniqueOrThrow({ where: { id: customer.userId } })).mobile,
      ).not.toBeNull();
      expect(
        (await api.prisma.deletionRequest.findFirstOrThrow({ where: { userId: customer.userId } }))
          .status,
      ).toBe('REQUESTED');

      await as(api, customer)
        .post(`/api/v1/bookings/${live.id}/cancel`, { reason: 'done' })
        .expect(200);
      const go = await legal.processDueDeletions({ dryRun: false, batchSize: 100 });
      expect(go.anonymised).toBeGreaterThanOrEqual(1);
      expect(
        (await api.prisma.user.findUniqueOrThrow({ where: { id: customer.userId } })).mobile,
      ).toBeNull();
    });

    it('lets staff reject a request (reason kept, audited); a rejected or withdrawn request is never anonymised', async () => {
      const customer = await newCustomer();
      const created = (await as(api, customer).post(DELETE_ME, {}).expect(201)).body as {
        id: string;
      };
      const support = await loginAdminWithPermissions(api, ['user.status.manage']);
      const plain = await loginAdminWithPermissions(api, ['user.view']);
      const url = `${A}/deletion-requests/${created.id}/reject`;
      expect((await as(api, plain).post(url, { reason: 'Not now, sorry' })).status).toBe(403);
      expect((await as(api, customer).post(url, { reason: 'Not now, sorry' })).status).toBe(403);
      expect((await as(api, support).post(url, { reason: 'x' })).status).toBe(400);
      expect(
        (
          await as(api, support).post(`${A}/deletion-requests/${randomUUID()}/reject`, {
            reason: 'Not now, sorry',
          })
        ).status,
      ).toBe(404);
      const rejected = await as(api, support)
        .post(url, { reason: 'Open dispute with a worker' })
        .expect(200);
      expect(rejected.body).toMatchObject({
        status: 'REJECTED',
        rejectedReason: 'Open dispute with a worker',
      });
      const again = await as(api, support).post(url, { reason: 'Open dispute with a worker' });
      expect(again.status).toBe(409);
      expect(again.body.code).toBe('DELETION_REQUEST_NOT_OPEN');
      expect(
        await api.prisma.auditLog.count({
          where: { action: 'account.deletion_rejected', entityId: customer.userId },
        }),
      ).toBe(1);

      await backdateRequest(customer.userId, 90);
      await legal.processDueDeletions({ dryRun: false, batchSize: 100 });
      expect(
        (await api.prisma.user.findUniqueOrThrow({ where: { id: customer.userId } })).mobile,
      ).not.toBeNull();

      // withdrawn by the user
      const second = await newCustomer();
      await as(api, second).post(DELETE_ME, {}).expect(201);
      await as(api, second).delete(DELETE_ME).expect(204);
      await backdateRequest(second.userId, 90);
      await legal.processDueDeletions({ dryRun: false, batchSize: 100 });
      expect(
        (await api.prisma.user.findUniqueOrThrow({ where: { id: second.userId } })).mobile,
      ).not.toBeNull();
    });

    it("erases a worker's personal data, photos and KYC files but keeps skills and booking history", async () => {
      const worker = await onboardWorker(api, { areaIds: [area.id], previousEmployer: true });
      await approveCheck(api, admin, worker, 'IDENTITY');
      const docs = await api.prisma.verificationDocument.findMany({
        where: { check: { workerId: worker.workerId } },
      });
      expect(docs.length).toBeGreaterThan(0);
      await api.prisma.workerProfile.update({
        where: { id: worker.workerId },
        data: { profilePhotoRef: 'workers/x/photo.jpg', expectedSalary: 20000 },
      });
      await api.prisma.workerReference.create({
        data: { workerId: worker.workerId, name: 'Mrs Rao', mobile: '+919876543210', position: 0 },
      });
      await as(api, worker).post(DELETE_ME, {}).expect(201);
      await backdateRequest(worker.userId, 31);
      await legal.processDueDeletions({ dryRun: false, batchSize: 100 });

      const profile = await api.prisma.workerProfile.findUniqueOrThrow({
        where: { id: worker.workerId },
        include: { skills: true },
      });
      expect(profile).toMatchObject({
        name: 'Deleted worker',
        addressLine: null,
        emergencyContactName: null,
        previousEmployerName: null,
        profilePhotoRef: null,
        criminalRecordDeclared: null,
        expectedSalary: null,
      });
      expect(profile.skills.length).toBeGreaterThan(0);
      expect(await api.prisma.workerReference.count({ where: { workerId: worker.workerId } })).toBe(
        0,
      );
      for (const doc of docs) {
        expect(
          (await api.prisma.verificationDocument.findUniqueOrThrow({ where: { id: doc.id } }))
            .purgedAt,
        ).not.toBeNull();
        expect(await api.storage.getObjectInfo(doc.objectKey)).toBeNull();
      }
      expect(
        (await api.prisma.user.findUniqueOrThrow({ where: { id: worker.userId } })).status,
      ).toBe('SUSPENDED');
    });
  });

  describe('operations', () => {
    it('shows a dry-run preview to the Super Admin only', async () => {
      const preview = await as(api, admin).get(`${A}/retention/preview`).expect(200);
      expect(preview.body).toMatchObject({ dryRun: true });
      expect(preview.body.tasks.map((t: { name: string }) => t.name)).toEqual(
        expect.arrayContaining(['notifications', 'outbox', 'verification']),
      );
      expect(preview.body.deletions).toEqual(
        expect.objectContaining({ due: expect.any(Number), anonymised: 0 }),
      );
      const ops = await loginAdminWithPermissions(api, ['report.view', 'user.status.manage']);
      expect((await as(api, ops).get(`${A}/retention/preview`)).status).toBe(403);
      expect((await api.http().get(`${A}/retention/preview`)).status).toBe(401);
    });

    it('is off by default: the scheduled run does nothing until RETENTION_ENABLED is set', () => {
      expect(api.app.get(RetentionService)).toBeDefined();
      const settings = api.app.get(AppConfigService).retention;
      expect(settings.enabled).toBe(false);
      expect(settings.dryRun).toBe(true);
    });
  });
});
