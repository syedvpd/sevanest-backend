import '../support/env-api-integration';
import { randomUUID } from 'node:crypto';
import {
  ApiApp,
  createApiApp,
  loginAdmin,
  loginAdminWithPermissions,
  loginWithOtp,
} from '../support/api-app';
import { ensureFee, makeBooking } from '../support/bookings';
import {
  approveCheck,
  as,
  createArea,
  onboardWorker,
  OnboardedWorker,
  setRequiredChecks,
} from '../support/workforce';

const A = '/api/v1/admin/workers';

/** Worker blacklist (DEC-06) and emergency-contact reveal (DEC-09), against the real database and the HTTP API. */
describe('Worker blacklist and emergency contact reveal (integration)', () => {
  let api: ApiApp;
  let admin: Awaited<ReturnType<typeof loginAdmin>>;
  let ops: Awaited<ReturnType<typeof loginAdminWithPermissions>>;
  let viewer: Awaited<ReturnType<typeof loginAdminWithPermissions>>;
  let revealer: Awaited<ReturnType<typeof loginAdminWithPermissions>>;
  let area: { id: string };
  let customer: Awaited<ReturnType<typeof loginWithOtp>> & { userId: string };

  const verifiedWorker = async (): Promise<OnboardedWorker> => {
    const worker = await onboardWorker(api, { areaIds: [area.id] });
    await approveCheck(api, admin, worker, 'IDENTITY');
    return worker;
  };
  const searchIds = async (): Promise<string[]> => {
    const res = await as(api, customer)
      .get(`/api/v1/search/workers?category=HOUSE_MAID&areaId=${area.id}&limit=100`)
      .expect(200);
    return (res.body.data as Array<{ workerId: string }>).map((w) => w.workerId);
  };

  beforeAll(async () => {
    api = await createApiApp();
    admin = await loginAdmin(api);
    area = await createArea(api, admin);
    await ensureFee(api, admin);
    customer = await loginWithOtp(api, { appType: 'CUSTOMER' });
    await setRequiredChecks(api, admin, ['IDENTITY']);
    ops = await loginAdminWithPermissions(api, ['worker.view', 'worker.blacklist']);
    viewer = await loginAdminWithPermissions(api, ['worker.view', 'worker.manage']);
    revealer = await loginAdminWithPermissions(api, [
      'worker.view',
      'worker.reveal_emergency_contact',
    ]);
  });

  afterAll(async () => {
    await setRequiredChecks(api, admin, []);
    await api.close();
  });

  describe('blacklist', () => {
    it('removes the worker from search, matching and booking, ends their sessions, flags open bookings, and is audited', async () => {
      const worker = await verifiedWorker();
      expect(await searchIds()).toContain(worker.workerId);
      const held = await makeBooking(api, admin, customer, area.id, 'ACTIVE', worker);

      const res = await as(api, ops)
        .post(`${A}/${worker.workerId}/blacklist`, { reason: 'Theft reported by two customers' })
        .expect(200);
      expect(res.body.blacklist).toMatchObject({
        reason: 'Theft reported by two customers',
        byUserId: ops.userId,
      });
      expect(res.body.accountStatus).toBe('SUSPENDED');

      // gone from search, the public card and booking
      expect(await searchIds()).not.toContain(worker.workerId);
      expect(
        (await as(api, customer).get(`/api/v1/search/workers/${worker.workerId}`)).status,
      ).toBe(404);
      const booking = await as(api, customer).post('/api/v1/bookings', {
        category: 'HOUSE_MAID',
        areaId: area.id,
        engagement: 'PART_TIME',
        availableFrom: '09:00',
        availableTo: '12:00',
        workerId: worker.workerId,
      });
      expect(booking.status).toBe(422);
      expect(booking.body.code).toBe('WORKER_NOT_ELIGIBLE');
      const candidates = await as(api, admin).post('/api/v1/admin/matching/candidates', {
        category: 'HOUSE_MAID',
        areaId: area.id,
        engagement: 'PART_TIME',
        availableFrom: '09:00',
        availableTo: '12:00',
      });
      expect(JSON.stringify(candidates.body)).not.toContain(worker.workerId);

      // sessions are over and sign-in is closed
      expect(
        (
          await api
            .http()
            .post('/api/v1/auth/token/refresh')
            .send({ refreshToken: worker.refreshToken })
        ).status,
      ).toBe(401);
      expect((await as(api, worker).get('/api/v1/workers/me')).status).toBe(403);

      // the open booking is flagged to staff, once
      const alerts = await api.prisma.adminAlert.findMany({
        where: { type: 'WORKER_BLACKLISTED_BOOKING', entityId: held.id },
      });
      expect(alerts).toHaveLength(1);
      expect(alerts[0]).toMatchObject({
        severity: 'CRITICAL',
        requiredPermission: 'booking.manage',
      });

      const audit = await api.prisma.auditLog.findFirstOrThrow({
        where: { entityId: worker.workerId, action: 'worker.blacklist' },
      });
      expect(audit.actorId).toBe(ops.userId);
      expect(audit.metadata).toMatchObject({ reason: 'Theft reported by two customers' });

      // repeating is safe: one audit row, one alert
      await as(api, ops)
        .post(`${A}/${worker.workerId}/blacklist`, { reason: 'Theft reported by two customers' })
        .expect(200);
      expect(
        await api.prisma.auditLog.count({
          where: { entityId: worker.workerId, action: 'worker.blacklist' },
        }),
      ).toBe(1);
      expect(
        await api.prisma.adminAlert.count({
          where: { type: 'WORKER_BLACKLISTED_BOOKING', entityId: held.id },
        }),
      ).toBe(1);
    });

    it('refuses everyone without worker.blacklist, a missing reason and an unknown worker', async () => {
      const worker = await verifiedWorker();
      const url = `${A}/${worker.workerId}/blacklist`;
      const body = { reason: 'Serious misconduct' };
      expect((await as(api, customer).post(url, body)).status).toBe(403);
      expect((await as(api, worker).post(url, body)).status).toBe(403);
      expect((await as(api, viewer).post(url, body)).status).toBe(403);
      expect((await api.http().post(url).send(body)).status).toBe(401);
      expect((await as(api, ops).post(url, {})).status).toBe(400);
      expect((await as(api, ops).post(url, { reason: 'x' })).status).toBe(400);
      expect((await as(api, ops).post(`${A}/${randomUUID()}/blacklist`, body)).status).toBe(404);
      // nothing happened to the worker
      expect(await searchIds()).toContain(worker.workerId);
      expect((await as(api, worker).get('/api/v1/workers/me')).status).toBe(200);
    });

    it('can be lifted only by a Super Admin; the worker is reactivated and searchable again', async () => {
      const worker = await verifiedWorker();
      await as(api, ops)
        .post(`${A}/${worker.workerId}/blacklist`, { reason: 'Misconduct case 14' })
        .expect(200);
      const url = `${A}/${worker.workerId}/blacklist/lift`;
      const body = { reason: 'Cleared after review' };
      // an Operations role that may blacklist still cannot lift
      expect((await as(api, ops).post(url, body)).status).toBe(403);
      expect((await as(api, viewer).post(url, body)).status).toBe(403);
      expect(await searchIds()).not.toContain(worker.workerId);

      const lifted = await as(api, admin).post(url, body).expect(200);
      expect(lifted.body.blacklist).toBeNull();
      expect(lifted.body.accountStatus).toBe('ACTIVE');
      expect(await searchIds()).toContain(worker.workerId);
      const audit = await api.prisma.auditLog.findFirstOrThrow({
        where: { entityId: worker.workerId, action: 'worker.blacklist_lift' },
      });
      expect(audit.actorId).toBe(admin.userId);
      expect(audit.metadata).toMatchObject({
        reason: 'Cleared after review',
        previousReason: 'Misconduct case 14',
      });
    });

    it('the lift permission cannot be given to a role other than the Super Admin', async () => {
      const res = await as(api, admin).put('/api/v1/admin/roles/OPERATIONS_ADMIN/permissions', {
        permissionCodes: ['worker.view', 'worker.blacklist.lift'],
      });
      expect(res.status).toBe(422);
    });
  });

  describe('emergency contact reveal', () => {
    it('is redacted in the staff profile and revealed only with permission AND a reason, every time audited', async () => {
      const worker = await verifiedWorker();
      const detail = await as(api, viewer).get(`${A}/${worker.workerId}`).expect(200);
      expect(detail.body.emergencyContact).toBeNull();
      expect(detail.body.hasEmergencyContact).toBe(true);
      expect(JSON.stringify(detail.body)).not.toContain('Lakshmi Devi');
      expect(JSON.stringify(detail.body)).not.toContain('9876543210');

      const url = `${A}/${worker.workerId}/emergency-contact/reveal`;
      const reason = 'Worker unreachable after incident INC-204';
      expect((await as(api, customer).post(url, { reason })).status).toBe(403);
      expect((await as(api, worker).post(url, { reason })).status).toBe(403);
      expect((await as(api, viewer).post(url, { reason })).status).toBe(403);
      expect((await api.http().post(url).send({ reason })).status).toBe(401);

      for (const bad of [{}, { reason: '' }, { reason: 'abc' }, { reason: '   ' }]) {
        const refused = await as(api, revealer).post(url, bad);
        expect(refused.status).toBe(422);
        expect(refused.body.code).toBe('REASON_REQUIRED');
      }
      expect(
        await api.prisma.auditLog.count({
          where: { entityId: worker.workerId, action: 'worker.emergency_contact_reveal' },
        }),
      ).toBe(0);

      const shown = await as(api, revealer).post(url, { reason }).expect(200);
      expect(shown.body).toEqual({ name: 'Lakshmi Devi', mobile: '+919876543210' });
      await as(api, revealer).post(url, { reason }).expect(200);
      const rows = await api.prisma.auditLog.findMany({
        where: { entityId: worker.workerId, action: 'worker.emergency_contact_reveal' },
      });
      expect(rows).toHaveLength(2);
      expect(rows[0].actorId).toBe(revealer.userId);
      expect(rows[0].metadata).toMatchObject({ reason });

      // the worker still sees their own contact; the customer-facing worker card has none
      const own = await as(api, worker).get('/api/v1/workers/me').expect(200);
      expect(own.body.emergencyContact).toEqual({ name: 'Lakshmi Devi', mobile: '+919876543210' });
      const card = await as(api, customer)
        .get(`/api/v1/search/workers/${worker.workerId}`)
        .expect(200);
      expect(JSON.stringify(card.body)).not.toContain('Lakshmi');
      expect(JSON.stringify(card.body)).not.toContain('9876543210');
    });

    it('answers 404 for an unknown worker and for a worker with no emergency contact', async () => {
      const url = (id: string) => `${A}/${id}/emergency-contact/reveal`;
      const reason = 'Checking contact for the safety file';
      expect((await as(api, revealer).post(url(randomUUID()), { reason })).status).toBe(404);
      const bare = await onboardWorker(api, { submit: false });
      await api.prisma.workerProfile.update({
        where: { id: bare.workerId },
        data: { emergencyContactName: null, emergencyContactMobile: null },
      });
      const none = await as(api, revealer).post(url(bare.workerId), { reason });
      expect(none.status).toBe(404);
      expect(none.body.code).toBe('EMERGENCY_CONTACT_NOT_FOUND');
    });
  });
});
