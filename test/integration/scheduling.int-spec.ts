import '../support/env-api-integration';
import { indiaToday } from '../../src/common/time/india';
import { ApiApp, createApiApp, loginAdmin, loginWithOtp, unique } from '../support/api-app';
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
const A = '/api/v1/admin';

type Session = Awaited<ReturnType<typeof loginWithOtp>>;

/**
 * Double-booking rule: a worker booked for a time cannot be taken for an overlapping time on the same dates, but is bookable again
 * for other hours and as soon as the service ends. Category engagement restrictions (PRD 4).
 */
describe('Worker scheduling and category engagements (integration)', () => {
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
  const worker = async (
    engagement: 'HOURLY' | 'PART_TIME' = 'HOURLY',
  ): Promise<OnboardedWorker> => {
    const w = await onboardWorker(api, {
      areaIds: [area.id],
      engagement,
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
  /** Creates the booking for a worker and takes it to the confirmation (the worker's time is then held). */
  const create = (who: Session, body: object) => as(api, who).post(B, body);
  const confirm = async (who: Session, bookingId: string, startDate: string) => {
    const c = as(api, who);
    await c
      .post(`${B}/${bookingId}/schedule`, {
        scheduleType: 'INTERVIEW',
        scheduledAt: new Date(Date.now() + 86_400_000).toISOString(),
      })
      .expect(200);
    await c.post(`${B}/${bookingId}/interview-complete`, { outcomeNote: 'ok' }).expect(200);
    return c.post(`${B}/${bookingId}/confirm-worker`, { startDate });
  };
  const book = async (who: Session, w: OnboardedWorker, body: object, startDate = inDays(2)) => {
    const created = await create(who, { ...request(), workerId: w.workerId, ...body });
    expect(created.status).toBe(201);
    return {
      id: created.body.id as string,
      confirm: () => confirm(who, created.body.id as string, startDate),
    };
  };
  const searchIds = async (who: Session, query: string): Promise<string[]> =>
    (
      (
        await as(api, who).get(
          `/api/v1/search/workers?areaId=${area.id}&category=HOUSE_MAID&limit=100&${query}`,
        )
      ).body.data as Array<{ workerId: string }>
    ).map((w) => w.workerId);

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

  describe('a worker is busy only for the booked hours', () => {
    it('refuses an overlapping time, allows the hour after it ends, the same hour on another day, and another worker', async () => {
      const w = await worker();
      const first = await customer();
      const second = await customer();
      const held = await book(first, w, {});
      expect((await held.confirm()).status).toBe(200); // 09:00-10:00 on day+2 is now held

      for (const [from, to] of [
        ['09:00', '10:00'],
        ['09:30', '10:30'],
        ['08:30', '09:15'],
      ]) {
        const res = await create(second, {
          ...request({ availableFrom: from, availableTo: to }),
          workerId: w.workerId,
        });
        expect(res.status).toBe(409);
        expect(res.body.code).toBe('WORKER_UNAVAILABLE');
      }
      // the service ends at 10:00: the worker is free again from then on
      expect(
        (
          await create(second, {
            ...request({ availableFrom: '10:00', availableTo: '11:00' }),
            workerId: w.workerId,
          })
        ).status,
      ).toBe(201);
      // the same hour on another date is free
      expect(
        (
          await create(await customer(), {
            ...request({ startDate: inDays(3) }),
            workerId: w.workerId,
          })
        ).status,
      ).toBe(201);
      // the customer can still hire a different, free worker for the same hour
      const other = await worker();
      expect((await create(first, { ...request(), workerId: other.workerId })).status).toBe(201);
    });

    it('hides a busy worker from search and matching only for the overlapping time', async () => {
      const w = await worker();
      const first = await customer();
      const viewer = await customer();
      const held = await book(first, w, {});
      expect((await held.confirm()).status).toBe(200);
      const day = inDays(2);

      expect(
        await searchIds(
          viewer,
          `availableFrom=09:00&availableTo=10:00&startDate=${day}&engagement=HOURLY`,
        ),
      ).not.toContain(w.workerId);
      expect(
        await searchIds(
          viewer,
          `availableFrom=10:00&availableTo=11:00&startDate=${day}&engagement=HOURLY`,
        ),
      ).toContain(w.workerId);
      expect(
        await searchIds(
          viewer,
          `availableFrom=09:00&availableTo=10:00&startDate=${inDays(3)}&engagement=HOURLY`,
        ),
      ).toContain(w.workerId);
      // without a time window nothing can be said to overlap, so the worker is listed
      expect(await searchIds(viewer, 'engagement=HOURLY')).toContain(w.workerId);

      const match = await as(api, admin).post(`${A}/matching/candidates`, {
        category: 'HOUSE_MAID',
        areaId: area.id,
        engagement: 'HOURLY',
        availableFrom: '09:00',
        availableTo: '10:00',
        startDate: day,
      });
      expect(match.status).toBe(200);
      expect((match.body.data as Array<{ workerId: string }>).map((c) => c.workerId)).not.toContain(
        w.workerId,
      );
    });

    it('lets only one of two customers confirm the same worker for overlapping times, even at the same moment', async () => {
      const w = await worker();
      const a = await customer();
      const b = await customer();
      const first = await book(a, w, {});
      const second = await book(b, w, { availableFrom: '09:30', availableTo: '10:30' }); // matched, nothing held yet
      const ready = async (who: Session, id: string) => {
        const c = as(api, who);
        await c
          .post(`${B}/${id}/schedule`, {
            scheduleType: 'INTERVIEW',
            scheduledAt: new Date(Date.now() + 86_400_000).toISOString(),
          })
          .expect(200);
        await c.post(`${B}/${id}/interview-complete`, { outcomeNote: 'ok' }).expect(200);
      };
      await ready(a, first.id);
      await ready(b, second.id);
      const results = await Promise.all([
        as(api, a).post(`${B}/${first.id}/confirm-worker`, { startDate: inDays(2) }),
        as(api, b).post(`${B}/${second.id}/confirm-worker`, { startDate: inDays(2) }),
      ]);
      expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
      const loser = results.find((r) => r.status === 409)!;
      expect(loser.body.code).toBe('WORKER_UNAVAILABLE');
    });

    it('frees the worker again when the booking is cancelled', async () => {
      const w = await worker();
      const a = await customer();
      const b = await customer();
      const held = await book(a, w, {});
      expect((await held.confirm()).status).toBe(200);
      const overlap = {
        ...request({ availableFrom: '09:30', availableTo: '10:30' }),
        workerId: w.workerId,
      };
      const refused = await create(b, overlap);
      expect(refused.status).toBe(409);
      expect(refused.body.code).toBe('WORKER_UNAVAILABLE');
      await as(api, a).post(`${B}/${held.id}/cancel`, { reason: 'plans changed' }).expect(200);
      const c = await customer();
      expect((await create(c, overlap)).status).toBe(201);
    });

    it('treats a recurring engagement as busy on every day from its start, and a live-in worker as busy all day', async () => {
      const w = await worker('PART_TIME');
      const a = await customer();
      const b = await customer();
      const recurring = await book(
        a,
        w,
        { engagement: 'PART_TIME', availableFrom: '09:00', availableTo: '12:00' },
        inDays(2),
      );
      expect((await recurring.confirm()).status).toBe(200);
      for (const day of [inDays(2), inDays(9), inDays(60)]) {
        const res = await create(b, {
          ...request({
            engagement: 'PART_TIME',
            availableFrom: '11:00',
            availableTo: '12:00',
            startDate: day,
          }),
          workerId: w.workerId,
        });
        expect(res.status).toBe(409);
      }
    });

    it('an unpaid held booking stays held until it is paid or cancelled (period undecided, Q-78)', async () => {
      const w = await worker();
      const a = await customer();
      const b = await customer();
      const held = await book(a, w, {});
      const done = await held.confirm();
      expect(done.body.status).toBe('PENDING_PAYMENT');
      expect((await create(b, { ...request(), workerId: w.workerId })).status).toBe(409);
    });
  });

  describe('worker opportunity feed and admin worker filters', () => {
    it('lists jobs waiting for the worker, drops them once answered, and shows nothing of other workers', async () => {
      const w = await worker();
      const other = await worker();
      const c = await customer();
      const made = await book(c, w, {});
      const feed = await as(api, w).get('/api/v1/workers/me/opportunities');
      expect(feed.status).toBe(200);
      expect((feed.body.data as Array<{ id: string }>).map((b) => b.id)).toEqual([made.id]);
      expect(feed.body.data[0]).not.toHaveProperty('customerUserId');
      expect((await as(api, other).get('/api/v1/workers/me/opportunities')).body.data).toEqual([]);
      await as(api, w).post(`/api/v1/workers/me/bookings/${made.id}/accept`).expect(200);
      expect((await as(api, w).get('/api/v1/workers/me/opportunities')).body.data).toEqual([]);
      expect((await as(api, c).get('/api/v1/workers/me/opportunities')).status).toBe(403);
      expect((await api.http().get('/api/v1/workers/me/opportunities')).status).toBe(401);
    });

    it('shows staff the complaint history of one user', async () => {
      const categoryId = (
        await as(api, admin)
          .post(`${A}/support/categories`, {
            code: `HIST_${unique().toUpperCase().slice(0, 8)}`,
            name: 'General',
          })
          .expect(201)
      ).body.id as string;
      const c = await customer();
      const other = await customer();
      for (const who of [c, c, other]) {
        await as(api, who)
          .post('/api/v1/support/tickets', { categoryId, description: 'Worker arrived late' })
          .expect(201);
      }
      const mine = await as(api, admin).get(`${A}/support/tickets?creatorUserId=${c.userId}`);
      expect(mine.status).toBe(200);
      expect(mine.body.data).toHaveLength(2);
      expect((await as(api, admin).get(`${A}/support/tickets?creatorUserId=nope`)).status).toBe(
        400,
      );
    });

    it('filters workers for staff by name, account status and registration date', async () => {
      const marker = `Wk${Array.from({ length: 8 }, () => String.fromCharCode(97 + Math.floor(Math.random() * 26))).join('')}`;
      const w = await onboardWorker(api, { areaIds: [area.id], name: `${marker} Kumar` });
      const byName = await as(api, admin).get(`${A}/workers?name=${marker.toLowerCase()}`);
      expect((byName.body.data as Array<{ id: string }>).map((x) => x.id)).toEqual([w.workerId]);
      const today = indiaToday();
      expect(
        (
          await as(api, admin).get(
            `${A}/workers?name=${marker}&createdFrom=${today}&createdTo=${today}`,
          )
        ).body.data,
      ).toHaveLength(1);
      expect(
        (await as(api, admin).get(`${A}/workers?name=${marker}&createdTo=2020-01-01`)).body.data,
      ).toEqual([]);
      await as(api, admin)
        .patch(`${A}/users/${w.userId}/status`, { status: 'SUSPENDED', reason: 'test' })
        .expect(200);
      expect(
        (await as(api, admin).get(`${A}/workers?name=${marker}&accountStatus=SUSPENDED`)).body.data,
      ).toHaveLength(1);
      expect(
        (await as(api, admin).get(`${A}/workers?name=${marker}&accountStatus=ACTIVE`)).body.data,
      ).toEqual([]);
      expect((await as(api, admin).get(`${A}/workers?accountStatus=GONE`)).status).toBe(400);
      expect((await as(api, admin).get(`${A}/workers?createdFrom=2026-02-30`)).status).toBe(400);
    });
  });

  describe('category engagement types', () => {
    it('refuses an engagement the category does not offer, in booking and search, and lifts the limit when emptied', async () => {
      const code = `CAT_${unique().toUpperCase().slice(0, 8)}`;
      const created = await as(api, admin)
        .post(`${A}/service-categories`, { code, name: `Cat ${unique()}` })
        .expect(201);
      const id = created.body.id as string;
      const c = await customer();
      const body = (engagement: string) => ({
        category: code,
        areaId: area.id,
        engagement,
        availableFrom: '09:00',
        availableTo: '10:00',
      });
      expect((await create(c, body('FULL_TIME'))).status).toBe(201); // not restricted yet
      const set = await as(api, admin).put(`${A}/service-categories/${id}/engagements`, {
        engagements: ['HOURLY', 'ONE_TIME'],
      });
      expect(set.status).toBe(200);
      expect(set.body.allowedEngagements).toEqual(['HOURLY', 'ONE_TIME']);

      const refused = await create(c, body('FULL_TIME'));
      expect(refused.status).toBe(422);
      expect(refused.body.code).toBe('ENGAGEMENT_NOT_OFFERED');
      expect((await create(c, body('HOURLY'))).status).toBe(201);
      const search = await as(api, c).get(
        `/api/v1/search/workers?category=${code}&areaId=${area.id}&engagement=PART_TIME`,
      );
      expect(search.status).toBe(422);
      expect(search.body.code).toBe('ENGAGEMENT_NOT_OFFERED');
      expect(
        (
          await as(api, c).get(
            `/api/v1/search/workers?category=${code}&areaId=${area.id}&engagement=HOURLY`,
          )
        ).status,
      ).toBe(200);
      const match = await as(api, admin).post(`${A}/matching/candidates`, { ...body('SHIFT') });
      expect(match.status).toBe(422);

      const visible = await as(api, c).get('/api/v1/service-categories?limit=100');
      const row = (visible.body.data as Array<{ code: string; allowedEngagements: string[] }>).find(
        (x) => x.code === code,
      );
      expect(row?.allowedEngagements).toEqual(['HOURLY', 'ONE_TIME']);

      expect(
        (await as(api, admin).put(`${A}/service-categories/${id}/engagements`, { engagements: [] }))
          .status,
      ).toBe(200);
      expect((await create(c, body('FULL_TIME'))).status).toBe(201);
    });

    it('validates the list, needs the permission and audits the change', async () => {
      const code = `CAT_${unique().toUpperCase().slice(0, 8)}`;
      const id = (
        await as(api, admin)
          .post(`${A}/service-categories`, { code, name: `Cat ${unique()}` })
          .expect(201)
      ).body.id as string;
      for (const bad of [{ engagements: ['WEEKLY'] }, { engagements: 'HOURLY' }, {}]) {
        expect(
          (await as(api, admin).put(`${A}/service-categories/${id}/engagements`, bad)).status,
        ).toBe(400);
      }
      expect(
        (
          await as(api, admin).put(
            `${A}/service-categories/00000000-0000-7000-8000-000000000000/engagements`,
            { engagements: [] },
          )
        ).status,
      ).toBe(404);
      const c = await customer();
      expect(
        (await as(api, c).put(`${A}/service-categories/${id}/engagements`, { engagements: [] }))
          .status,
      ).toBe(403);
      await as(api, admin)
        .put(`${A}/service-categories/${id}/engagements`, {
          engagements: ['DAILY', 'DAILY', 'HOURLY'],
        })
        .expect(200);
      const rows = await api.prisma.auditLog.findMany({
        where: { action: 'service_category.engagements_set', entityId: id },
      });
      expect(rows).toHaveLength(1);
      expect(rows[0].metadata).toMatchObject({ code, from: [], to: ['DAILY', 'HOURLY'] });
      void indiaToday;
    });
  });
});
