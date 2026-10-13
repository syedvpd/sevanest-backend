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
import { ensureFee, inDays } from '../support/bookings';
import {
  approveCheck,
  as,
  createArea,
  OnboardedWorker,
  onboardWorker,
  setRequiredChecks,
} from '../support/workforce';

const B = '/api/v1/bookings';
const W = '/api/v1/workers/me/bookings';
const A = '/api/v1/admin';
const UNKNOWN = '00000000-0000-7000-8000-000000000000';

type Session = Awaited<ReturnType<typeof loginWithOtp>>;

/** Worker references, interview/trial time proposals, replacement chains and customer edit versioning. */
describe('Remaining audit items (integration)', () => {
  let api: ApiApp;
  let admin: Awaited<ReturnType<typeof loginAdmin>>;
  let area: { id: string; name: string; city: string };

  const customer = async (): Promise<Session> => {
    const session = await loginWithOtp(api, { appType: 'CUSTOMER' });
    await as(api, session)
      .post('/api/v1/customers/me', {
        name: 'Asha Rao',
        email: `c.${unique()}@example.test`,
        preferredLanguage: 'en',
      })
      .expect(201);
    return session;
  };
  const verifiedWorker = async (): Promise<OnboardedWorker> => {
    const w = await onboardWorker(api, {
      areaIds: [area.id],
      engagement: 'HOURLY',
      windows: [{ start: '06:00', end: '22:00' }],
    });
    await approveCheck(api, admin, w, 'IDENTITY');
    return w;
  };
  const request = (extra: object = {}) => ({
    category: 'HOUSE_MAID',
    areaId: area.id,
    engagement: 'HOURLY',
    availableFrom: '09:00',
    availableTo: '10:00',
    startDate: inDays(2),
    ...extra,
  });
  /** A booking matched to a worker whose interview/trial is scheduled. */
  const scheduled = async (who: Session, w: OnboardedWorker) => {
    const created = await as(api, who)
      .post(B, { ...request(), workerId: w.workerId })
      .expect(201);
    const id = created.body.id as string;
    const at = new Date(Date.now() + 2 * 86_400_000);
    await as(api, who)
      .post(`${B}/${id}/schedule`, { scheduleType: 'INTERVIEW', scheduledAt: at.toISOString() })
      .expect(200);
    return { id, at };
  };
  const events = async (bookingId: string): Promise<string[]> =>
    (
      await api.prisma.outboxEvent.findMany({
        where: { payload: { path: ['params', 'bookingId'], equals: bookingId } },
        orderBy: { createdAt: 'asc' },
      })
    ).map((e) => (e.payload as { event: string }).event);

  beforeAll(async () => {
    api = await createApiApp();
    admin = await loginAdmin(api);
    area = await createArea(api, admin);
    await setRequiredChecks(api, admin, ['IDENTITY']);
    await ensureFee(api, admin);
  });
  afterAll(async () => {
    await setRequiredChecks(api, admin, []);
    await api.close();
  });

  // ------------------------------------------------------------------------------------------------------------
  describe('worker references (PRD 6.1)', () => {
    const refs = (n: number) =>
      Array.from({ length: n }, (_, i) => ({
        name: `Ref Person ${String.fromCharCode(65 + i)}`,
        mobile: `98765${String(10000 + i * 7 + Math.floor(Math.random() * 5)).padStart(5, '0')}`,
        relationship: 'Previous employer',
      }));

    it('sets, reads, replaces and clears the list; each mobile once; at most five; never the own number', async () => {
      const w = await onboardWorker(api, { areaIds: [area.id] });
      const other = await onboardWorker(api, { areaIds: [area.id] });
      expect((await as(api, w).get('/api/v1/workers/me/references')).body).toEqual([]);
      const set = await as(api, w).put('/api/v1/workers/me/references', { references: refs(3) });
      expect(set.status).toBe(200);
      expect(set.body).toHaveLength(3);
      expect(set.body[0]).toMatchObject({
        name: 'Ref Person A',
        mobile: expect.stringMatching(/^\+91/),
      });
      expect((await as(api, w).get('/api/v1/workers/me/references')).body).toHaveLength(3);
      expect((await as(api, other).get('/api/v1/workers/me/references')).body).toEqual([]);

      const replaced = await as(api, w).put('/api/v1/workers/me/references', {
        references: refs(1),
      });
      expect(replaced.body).toHaveLength(1);
      const same = refs(2);
      same[1].mobile = same[0].mobile;
      expect(
        (await as(api, w).put('/api/v1/workers/me/references', { references: same })).status,
      ).toBe(400);
      expect(
        (await as(api, w).put('/api/v1/workers/me/references', { references: refs(6) })).status,
      ).toBe(400);
      expect(
        (
          await as(api, w).put('/api/v1/workers/me/references', {
            references: [{ name: 'Me', mobile: w.mobile.replace('+91', '') }],
          })
        ).status,
      ).toBe(400);
      expect(
        (
          await as(api, w).put('/api/v1/workers/me/references', {
            references: [{ name: '', mobile: '12345' }],
          })
        ).status,
      ).toBe(400);
      expect((await as(api, w).put('/api/v1/workers/me/references', {})).status).toBe(400);
      expect((await as(api, w).get('/api/v1/workers/me/references')).body).toHaveLength(1); // failures changed nothing
      expect(
        (await as(api, w).put('/api/v1/workers/me/references', { references: [] })).body,
      ).toEqual([]);
    });

    it('staff read them with an audit record; customers and anonymous callers cannot', async () => {
      const w = await onboardWorker(api, { areaIds: [area.id] });
      await as(api, w)
        .put('/api/v1/workers/me/references', { references: refs(2) })
        .expect(200);
      const before = await api.prisma.auditLog.count({
        where: { action: 'worker.sensitive_view', entityId: w.workerId },
      });
      const read = await as(api, admin).get(`${A}/workers/${w.workerId}/references`);
      expect(read.status).toBe(200);
      expect(read.body).toHaveLength(2);
      const after = await api.prisma.auditLog.findMany({
        where: { action: 'worker.sensitive_view', entityId: w.workerId },
      });
      expect(after).toHaveLength(before + 1);
      expect(JSON.stringify(after.at(-1)!.metadata)).toContain('references');
      expect(JSON.stringify(after.at(-1))).not.toContain('Ref Person');
      expect((await as(api, admin).get(`${A}/workers/${UNKNOWN}/references`)).status).toBe(404);
      const c = await customer();
      expect((await as(api, c).get(`${A}/workers/${w.workerId}/references`)).status).toBe(403);
      expect((await as(api, c).get('/api/v1/workers/me/references')).status).toBe(403);
      const noWorkerView = await loginAdminWithPermissions(api, ['booking.view']);
      expect(
        (await as(api, noWorkerView).get(`${A}/workers/${w.workerId}/references`)).status,
      ).toBe(403);
    });
  });

  // ------------------------------------------------------------------------------------------------------------
  describe('interview/trial time proposed by the worker', () => {
    it('customer accepts: the proposed time becomes the scheduled time; the proposal is cleared and both sides are told', async () => {
      const w = await verifiedWorker();
      const c = await customer();
      const { id, at } = await scheduled(c, w);
      const proposed = new Date(at.getTime() + 3 * 3_600_000);
      const res = await as(api, w).put(`${W}/${id}/slot-proposal`, {
        proposedAt: proposed.toISOString(),
        note: 'Clash with another job',
      });
      expect(res.status).toBe(200);
      expect(res.body.proposedSlotAt).toBe(proposed.toISOString());
      expect(res.body.scheduledAt).toBe(at.toISOString()); // unchanged until the customer answers
      const seen = await as(api, c).get(`${B}/${id}`);
      expect(seen.body.proposedSlotAt).toBe(proposed.toISOString());
      expect(seen.body.status).toBe('INTERVIEW_TRIAL_SCHEDULED');

      // repeating the same proposal changes nothing; a different one replaces it
      expect(
        (await as(api, w).put(`${W}/${id}/slot-proposal`, { proposedAt: proposed.toISOString() }))
          .status,
      ).toBe(200);
      const second = new Date(proposed.getTime() + 3_600_000);
      expect(
        (await as(api, w).put(`${W}/${id}/slot-proposal`, { proposedAt: second.toISOString() }))
          .body.proposedSlotAt,
      ).toBe(second.toISOString());

      const accepted = await as(api, c).post(`${B}/${id}/slot-proposal/accept`);
      expect(accepted.status).toBe(200);
      expect(accepted.body.scheduledAt).toBe(second.toISOString());
      expect(accepted.body.proposedSlotAt).toBeNull();
      expect(accepted.body.status).toBe('INTERVIEW_TRIAL_SCHEDULED');
      expect(accepted.body.timeline.map((t: { note: string | null }) => t.note)).toEqual(
        expect.arrayContaining(['proposed another time', 'accepted the proposed time']),
      );
      const seenEvents = await events(id);
      expect(seenEvents).toContain('BOOKING_SLOT_PROPOSED');
      expect(seenEvents).toContain('BOOKING_SLOT_ANSWERED');
      // nothing left to answer
      const again = await as(api, c).post(`${B}/${id}/slot-proposal/accept`);
      expect(again.status).toBe(409);
      expect(again.body.code).toBe('NO_SLOT_PROPOSAL');
    });

    it('customer keeps the original time; staff can answer for the customer', async () => {
      const w = await verifiedWorker();
      const c = await customer();
      const { id, at } = await scheduled(c, w);
      const proposed = new Date(at.getTime() + 3_600_000);
      await as(api, w)
        .put(`${W}/${id}/slot-proposal`, { proposedAt: proposed.toISOString() })
        .expect(200);
      const kept = await as(api, c).post(`${B}/${id}/slot-proposal/reject`);
      expect(kept.status).toBe(200);
      expect(kept.body.scheduledAt).toBe(at.toISOString());
      expect(kept.body.proposedSlotAt).toBeNull();

      await as(api, w)
        .put(`${W}/${id}/slot-proposal`, { proposedAt: proposed.toISOString() })
        .expect(200);
      const byStaff = await as(api, admin).post(`${A}/bookings/${id}/slot-proposal/accept`);
      expect(byStaff.status).toBe(200);
      expect(byStaff.body.scheduledAt).toBe(proposed.toISOString());
      const rows = await api.prisma.auditLog.findMany({
        where: { entityId: id, action: { startsWith: 'booking.slot_' } },
      });
      expect(rows.map((r) => r.action).sort()).toEqual([
        'booking.slot_accepted',
        'booking.slot_proposed',
        'booking.slot_proposed',
        'booking.slot_rejected',
      ]);
    });

    it('refuses wrong states, wrong actors, past or unchanged times and bad input', async () => {
      const w = await verifiedWorker();
      const other = await verifiedWorker();
      const c = await customer();
      const stranger = await customer();
      const early0 = await customer();
      const created = await as(api, early0)
        .post(B, { ...request(), workerId: w.workerId })
        .expect(201);
      const early = created.body.id as string;
      const future = new Date(Date.now() + 5 * 86_400_000).toISOString();
      // not scheduled yet
      expect(
        (await as(api, w).put(`${W}/${early}/slot-proposal`, { proposedAt: future })).status,
      ).toBe(409);
      const { id, at } = await scheduled(c, w);
      expect(
        (await as(api, other).put(`${W}/${id}/slot-proposal`, { proposedAt: future })).status,
      ).toBe(404);
      expect(
        (await as(api, c).put(`${W}/${id}/slot-proposal`, { proposedAt: future })).status,
      ).toBe(403);
      expect(
        (await as(api, w).put(`${W}/${UNKNOWN}/slot-proposal`, { proposedAt: future })).status,
      ).toBe(404);
      for (const bad of [
        {},
        { proposedAt: 'tomorrow' },
        { proposedAt: new Date(Date.now() - 3_600_000).toISOString() },
        { proposedAt: at.toISOString() },
      ]) {
        expect((await as(api, w).put(`${W}/${id}/slot-proposal`, bad)).status).toBe(400);
      }
      await as(api, w).put(`${W}/${id}/slot-proposal`, { proposedAt: future }).expect(200);
      expect((await as(api, stranger).post(`${B}/${id}/slot-proposal/accept`)).status).toBe(404);
      expect((await as(api, w).post(`${B}/${id}/slot-proposal/accept`)).status).toBe(403);
      expect((await as(api, c).post(`${B}/${id}/slot-proposal/maybe`)).status).toBe(400);
      expect((await api.http().post(`${B}/${id}/slot-proposal/accept`)).status).toBe(401);
      // the booking leaves the scheduled state: the proposal disappears and cannot be accepted
      await as(api, c).post(`${B}/${id}/cancel`, { reason: 'changed my mind' }).expect(200);
      const gone = await as(api, c).get(`${B}/${id}`);
      expect(gone.body.proposedSlotAt).toBeNull();
      expect((await as(api, c).post(`${B}/${id}/slot-proposal/accept`)).status).toBe(409);
    });

    it('two answers at the same moment: one wins, the other is told there is nothing to answer', async () => {
      const w = await verifiedWorker();
      const c = await customer();
      const { id, at } = await scheduled(c, w);
      await as(api, w)
        .put(`${W}/${id}/slot-proposal`, {
          proposedAt: new Date(at.getTime() + 7_200_000).toISOString(),
        })
        .expect(200);
      const results = await Promise.all([
        as(api, c).post(`${B}/${id}/slot-proposal/accept`),
        as(api, admin).post(`${A}/bookings/${id}/slot-proposal/accept`),
      ]);
      expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
    });
  });

  // ------------------------------------------------------------------------------------------------------------
  describe('replacement chain', () => {
    it('shows the whole chain oldest first from any link, hides workers from the customer and other customers see nothing', async () => {
      const w1 = await verifiedWorker();
      const w2 = await verifiedWorker();
      const w3 = await verifiedWorker();
      const c = await customer();
      const stranger = await customer();
      const category = await api.prisma.serviceCategory.findFirstOrThrow({
        where: { code: 'HOUSE_MAID' },
      });
      const make = (workerId: string, status: 'REPLACED' | 'ACTIVE', replaces: string | null) =>
        api.prisma.booking.create({
          data: {
            customerUserId: c.userId,
            workerId,
            categoryId: category.id,
            areaId: area.id,
            engagement: 'HOURLY',
            fromMinute: 540,
            toMinute: 600,
            status,
            startDate: new Date(inDays(0)),
            replacesBookingId: replaces,
          },
        });
      const first = await make(w1.workerId, 'REPLACED', null);
      const second = await make(w2.workerId, 'REPLACED', first.id);
      const third = await make(w3.workerId, 'ACTIVE', second.id);
      const lone = await make(w1.workerId, 'ACTIVE', null);

      for (const start of [first.id, second.id, third.id]) {
        const res = await as(api, c).get(`${B}/${start}/replacement-chain`);
        expect(res.status).toBe(200);
        expect(res.body.map((e: { bookingId: string }) => e.bookingId)).toEqual([
          first.id,
          second.id,
          third.id,
        ]);
        expect(res.body.map((e: { position: number }) => e.position)).toEqual([1, 2, 3]);
        expect(res.body.find((e: { current: boolean }) => e.current).bookingId).toBe(start);
        expect(res.body[1]).toMatchObject({ status: 'REPLACED', replacesBookingId: first.id });
        expect(res.body[0]).not.toHaveProperty('workerId');
      }
      const staff = await as(api, admin).get(`${A}/bookings/${second.id}/replacement-chain`);
      expect(staff.body.map((e: { workerId: string }) => e.workerId)).toEqual([
        w1.workerId,
        w2.workerId,
        w3.workerId,
      ]);
      const single = await as(api, c).get(`${B}/${lone.id}/replacement-chain`);
      expect(single.body).toHaveLength(1);
      expect(single.body[0]).toMatchObject({ position: 1, current: true });

      expect((await as(api, stranger).get(`${B}/${second.id}/replacement-chain`)).status).toBe(404);
      expect((await as(api, c).get(`${B}/${UNKNOWN}/replacement-chain`)).status).toBe(404);
      expect((await as(api, c).get(`${B}/not-a-uuid/replacement-chain`)).status).toBe(400);
      expect((await as(api, c).get(`${A}/bookings/${second.id}/replacement-chain`)).status).toBe(
        403,
      );
      expect((await api.http().get(`${B}/${second.id}/replacement-chain`)).status).toBe(401);
      const noBooking = await loginAdminWithPermissions(api, ['report.view']);
      expect(
        (await as(api, noBooking).get(`${A}/bookings/${second.id}/replacement-chain`)).status,
      ).toBe(403);
    });
  });

  // ------------------------------------------------------------------------------------------------------------
  describe('customer self-edit versioning', () => {
    it('refuses a profile edit made on a stale copy (second device) and applies the current one', async () => {
      const c = await customer();
      const first = await as(api, c).get('/api/v1/customers/me');
      const etag = first.headers.etag;
      expect(etag).toMatch(/^"\d+"$/);
      const edit = (name: string, ifMatch?: string) => {
        const call = as(api, c).patch('/api/v1/customers/me', { name });
        return ifMatch ? call.set('If-Match', ifMatch) : call;
      };
      const ok = await edit('First Device', etag);
      expect(ok.status).toBe(200);
      expect(ok.headers.etag).not.toBe(etag);
      const stale = await edit('Second Device', etag);
      expect(stale.status).toBe(412);
      expect(stale.body.code).toBe('STALE_VERSION');
      expect((await as(api, c).get('/api/v1/customers/me')).body.name).toBe('First Device');
      expect((await edit('Latest', ok.headers.etag)).status).toBe(200);
      expect((await edit('No Header')).status).toBe(200);
      expect((await edit('Wildcard', '*')).status).toBe(200);
    });

    it('lets exactly one of two parallel edits with the same version win', async () => {
      const c = await customer();
      const etag = (await as(api, c).get('/api/v1/customers/me')).headers.etag;
      const results = await Promise.all(
        ['Alpha', 'Beta'].map((name) =>
          as(api, c).patch('/api/v1/customers/me', { name }).set('If-Match', etag),
        ),
      );
      expect(results.map((r) => r.status).sort()).toEqual([200, 412]);
    });

    it('versions addresses the same way and keeps other customers out', async () => {
      const c = await customer();
      const other = await customer();
      const created = await as(api, c)
        .post('/api/v1/customers/me/addresses', {
          line: '1 Lake Road',
          area: area.name,
          city: area.city,
          pincode: '500081',
        })
        .expect(201);
      const id = created.body.id as string;
      const etag = (await as(api, c).get(`/api/v1/customers/me/addresses/${id}`)).headers.etag;
      const edit = (line: string, ifMatch?: string) => {
        const call = as(api, c).patch(`/api/v1/customers/me/addresses/${id}`, { line });
        return ifMatch ? call.set('If-Match', ifMatch) : call;
      };
      expect((await edit('2 Lake Road', etag)).status).toBe(200);
      expect((await edit('3 Lake Road', etag)).status).toBe(412);
      expect((await edit('4 Lake Road')).status).toBe(200);
      expect(
        (
          await as(api, other)
            .patch(`/api/v1/customers/me/addresses/${id}`, { line: 'x y z' })
            .set('If-Match', '*')
        ).status,
      ).toBe(404);
    });

    it('guards staff edits of categories, areas and templates with If-Match as well', async () => {
      const code = `IFM_${unique().toUpperCase().slice(0, 8)}`;
      const category = (
        await as(api, admin)
          .post(`${A}/service-categories`, { code, name: `Cat ${unique()}` })
          .expect(201)
      ).body.id as string;
      const catTag = (await as(api, admin).get(`${A}/service-categories/${category}`)).headers.etag;
      expect(
        (
          await as(api, admin)
            .patch(`${A}/service-categories/${category}`, { description: 'one' })
            .set('If-Match', catTag)
        ).status,
      ).toBe(200);
      expect(
        (
          await as(api, admin)
            .patch(`${A}/service-categories/${category}`, { description: 'two' })
            .set('If-Match', catTag)
        ).status,
      ).toBe(412);

      const areaTag = (await as(api, admin).get(`${A}/service-areas/${area.id}`)).headers.etag;
      expect(
        (
          await as(api, admin)
            .patch(`${A}/service-areas/${area.id}`, { name: `Renamed ${unique()}` })
            .set('If-Match', areaTag)
        ).status,
      ).toBe(200);
      expect(
        (
          await as(api, admin)
            .patch(`${A}/service-areas/${area.id}`, { name: `Again ${unique()}` })
            .set('If-Match', areaTag)
        ).status,
      ).toBe(412);

      const template = await api.prisma.notificationTemplate.findFirst({
        where: { eventCode: 'BOOKING_STARTED' },
      });
      if (template) {
        const tplTag = (await as(api, admin).get(`${A}/notification-templates/${template.id}`))
          .headers.etag;
        expect(
          (
            await as(api, admin)
              .patch(`${A}/notification-templates/${template.id}`, { body: 'Started.' })
              .set('If-Match', tplTag)
          ).status,
        ).toBe(200);
        expect(
          (
            await as(api, admin)
              .patch(`${A}/notification-templates/${template.id}`, { body: 'Started again.' })
              .set('If-Match', tplTag)
          ).status,
        ).toBe(412);
      }
    });
  });

  describe('admin worker filters', () => {
    it('filters by service area and minimum rating', async () => {
      const w = await onboardWorker(api, { areaIds: [area.id] });
      const elsewhere = await createArea(api, admin);
      const inArea = await as(api, admin).get(`${A}/workers?areaId=${area.id}&limit=100`);
      expect((inArea.body.data as Array<{ id: string }>).map((x) => x.id)).toContain(w.workerId);
      const notThere = await as(api, admin).get(`${A}/workers?areaId=${elsewhere.id}&limit=100`);
      expect((notThere.body.data as Array<{ id: string }>).map((x) => x.id)).not.toContain(
        w.workerId,
      );
      expect((await as(api, admin).get(`${A}/workers?minRating=4&limit=100`)).status).toBe(200);
      expect((await as(api, admin).get(`${A}/workers?minRating=0`)).status).toBe(400);
      expect((await as(api, admin).get(`${A}/workers?areaId=nope`)).status).toBe(400);
      void randomUUID;
    });
  });
});
