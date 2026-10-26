import '../support/env-api-integration';
import { ApiApp, createApiApp, loginAdmin, loginWithOtp } from '../support/api-app';
import { inDays, makeBooking } from '../support/bookings';
import { ShortlistService } from '../../src/modules/shortlist/shortlist.service';
import {
  approveCheck,
  as,
  createArea,
  onboardWorker,
  OnboardedWorker,
  setRequiredChecks,
} from '../support/workforce';

const HOME = '/api/v1/customers/me/home';
const SHORTLIST = '/api/v1/shortlist';
const UNKNOWN_ID = '00000000-0000-7000-8000-000000000000';

type Customer = Awaited<ReturnType<typeof loginWithOtp>> & { userId: string };

interface HomeBody {
  activeBooking: { id: string; worker: Record<string, unknown> | null } | null;
  activeBookingsTotal: number;
  upcomingInterview: { id: string; worker: Record<string, unknown> | null } | null;
  unreadNotifications: number;
  shortlistPreview: Array<{
    workerId: string;
    available: boolean;
    worker: Record<string, unknown>;
  }>;
  shortlistTotal: number;
}

/** Customer Home (Your Activity, Your Shortlist) and the shortlist mutations. */
describe('Customer home and shortlist (integration)', () => {
  let api: ApiApp;
  let admin: Awaited<ReturnType<typeof loginAdmin>>;
  let area: { id: string };

  const newCustomer = async (): Promise<Customer> => {
    const c: Customer = await loginWithOtp(api, { appType: 'CUSTOMER' });
    await as(api, c)
      .post('/api/v1/customers/me', {
        name: 'Home Tester',
        email: `h.${Date.now()}.${Math.round(Math.random() * 1e6)}@example.test`,
        preferredLanguage: 'en',
      })
      .expect(201);
    return c;
  };
  const verifiedWorker = async (name = 'Lakshmi Devi'): Promise<OnboardedWorker> => {
    const w = await onboardWorker(api, { areaIds: [area.id], name });
    await approveCheck(api, admin, w, 'IDENTITY');
    return w;
  };
  const home = async (c: Customer, headers: Record<string, string> = {}) => {
    const req = as(api, c).get(HOME);
    for (const [k, v] of Object.entries(headers)) req.set(k, v);
    return req;
  };
  const homeBody = async (c: Customer): Promise<HomeBody> => {
    const res = await home(c);
    expect(res.status).toBe(200);
    return res.body as HomeBody;
  };

  beforeAll(async () => {
    api = await createApiApp();
    admin = await loginAdmin(api);
    area = await createArea(api, admin);
    await setRequiredChecks(api, admin, ['IDENTITY']);
  });
  afterAll(async () => {
    await setRequiredChecks(api, admin, []);
    await api.close();
  });

  describe('GET /customers/me/home: Your Activity', () => {
    it('an empty customer gets empty values, a validator and private cache headers', async () => {
      const c = await newCustomer();
      const res = await home(c);
      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        activeBooking: null,
        activeBookingsTotal: 0,
        upcomingInterview: null,
        unreadNotifications: 0,
        shortlistPreview: [],
        shortlistTotal: 0,
      });
      expect(res.headers['cache-control']).toBe('private, no-cache');
      expect(res.headers.vary).toContain('Authorization');
      expect(res.headers.etag).toMatch(/^W\/"[0-9a-f]{32}"$/);
    });

    it('shows the worker name, verified flag and photo slot on the active booking, from the interview stage on', async () => {
      const c = await newCustomer();
      const early = await makeBooking(api, admin, c, area.id, 'MATCHED');
      let body = await homeBody(c);
      expect(body.activeBooking?.id).toBe(early.id);
      expect(body.activeBooking?.worker).toBeNull(); // D-81: no name before the interview stage

      const c2 = await newCustomer();
      const b = await makeBooking(api, admin, c2, area.id, 'ACTIVE');
      body = await homeBody(c2);
      expect(body.activeBooking?.worker).toEqual({
        displayName: 'Ramesh K.',
        name: 'Ramesh K.',
        initials: 'RK',
        verified: true,
        photo: null,
      });
      // not the service category, no private fields
      const json = JSON.stringify(body);
      expect(body.activeBooking?.worker?.name).not.toBe('House Maid');
      expect(json).not.toMatch(/expectedSalary|18000|Kumar|mobile|emergency|9876543210/);

      // verified follows the real state: a blacklisted worker is shown by name but not as verified
      await api.prisma.workerProfile.update({
        where: { id: b.worker.workerId },
        data: { blacklistedAt: new Date() },
      });
      try {
        const after = await homeBody(c2);
        expect(after.activeBooking?.worker).toMatchObject({ name: 'Ramesh K.', verified: false });
      } finally {
        await api.prisma.workerProfile.update({
          where: { id: b.worker.workerId },
          data: { blacklistedAt: null },
        });
      }
      expect((await homeBody(c2)).activeBooking?.worker).toMatchObject({ verified: true });
    });

    it('keeps one representative active booking (the newest) and counts all unfinished ones', async () => {
      const c = await newCustomer();
      const first = await makeBooking(api, admin, c, area.id, 'ACTIVE');
      const second = await makeBooking(api, admin, c, area.id, 'ACTIVE');
      const third = await makeBooking(api, admin, c, area.id, 'MATCHED');
      let body = await homeBody(c);
      expect(body.activeBookingsTotal).toBe(3);
      expect(body.activeBooking?.id).toBe(third.id);
      // finishing the newest moves the representative to the next newest and lowers the count
      await as(api, c).post(`/api/v1/bookings/${third.id}/cancel`, { reason: 'changed my mind' });
      body = await homeBody(c);
      expect(body.activeBookingsTotal).toBe(2);
      expect(body.activeBooking?.id).toBe(second.id);
      await as(api, c).post(`/api/v1/bookings/${second.id}/complete`).expect(200);
      body = await homeBody(c);
      expect(body.activeBookingsTotal).toBe(1);
      expect(body.activeBooking?.id).toBe(first.id);
    });

    it('names the worker on the upcoming interview', async () => {
      const c = await newCustomer();
      const w = await verifiedWorker('Meena Pillai');
      const booking = await as(api, c)
        .post('/api/v1/bookings', {
          category: 'HOUSE_MAID',
          areaId: area.id,
          engagement: 'PART_TIME',
          availableFrom: '09:00',
          availableTo: '10:00',
          startDate: inDays(3),
          workerId: w.workerId,
        })
        .expect(201);
      const preferredAt = new Date(Date.now() + 2 * 86_400_000);
      preferredAt.setUTCHours(10, 0, 0, 0);
      const interview = await as(api, c)
        .post('/api/v1/interviews', {
          bookingId: (booking.body as { id: string }).id,
          type: 'INTERVIEW',
          preferredAt: preferredAt.toISOString(),
        })
        .expect(201);
      const id = (interview.body as { id: string }).id;
      // before the worker accepts there is nothing confirmed to show
      expect((await homeBody(c)).upcomingInterview).toBeNull();
      await as(api, w).post(`/api/v1/workers/me/interviews/${id}/accept`).expect(200);
      const body = await homeBody(c);
      expect(body.upcomingInterview?.id).toBe(id);
      expect(body.upcomingInterview?.worker).toEqual({
        displayName: 'Meena P.',
        name: 'Meena P.',
        initials: 'MP',
        verified: true,
        photo: null,
      });
    });
  });

  describe('GET /customers/me/home: Your Shortlist', () => {
    it('caps the preview at five, counts the whole shortlist, newest first, with customer-safe cards', async () => {
      const c = await newCustomer();
      const workers: OnboardedWorker[] = [];
      for (let i = 0; i < 6; i++) workers.push(await verifiedWorker());
      for (const w of workers) {
        await as(api, c).put(`${SHORTLIST}/${w.workerId}`).expect(204);
      }
      const body = await homeBody(c);
      expect(body.shortlistPreview).toHaveLength(5);
      expect(body.shortlistTotal).toBe(6);
      expect(body.shortlistPreview.map((i) => i.workerId)).toEqual(
        workers
          .slice(1)
          .reverse()
          .map((w) => w.workerId),
      );
      const card = body.shortlistPreview[0];
      expect(card.available).toBe(true);
      expect(card.worker).toMatchObject({
        verification: 'VERIFIED',
        verified: true,
        experienceMonths: 36,
        rating: null,
        photo: null,
      });
      // first name and last initial only; pay is a separate open decision (Q-39)
      const json = JSON.stringify(body);
      expect(card.worker.name).toBe('Lakshmi D.');
      expect(Object.keys(card.worker)).not.toContain('pricing');
      expect(json).not.toMatch(/Devi\b|Kumar|expectedSalary|pricing|@example|\+91/);
      // the full list endpoint keeps its own pagination
      const page2 = await as(api, c).get(`${SHORTLIST}?page=2&limit=5`);
      expect((page2.body as { data: unknown[]; meta: { total: number } }).data).toHaveLength(1);
      expect((page2.body as { meta: { total: number } }).meta.total).toBe(6);
    });

    it('is scoped to the signed-in customer', async () => {
      const a = await newCustomer();
      const b = await newCustomer();
      const w = await verifiedWorker();
      await as(api, a).put(`${SHORTLIST}/${w.workerId}`).expect(204);
      expect((await homeBody(b)).shortlistTotal).toBe(0);
      expect((await homeBody(b)).shortlistPreview).toEqual([]);
      expect((await homeBody(a)).shortlistTotal).toBe(1);
    });

    it('keeps an entry whose worker is no longer visible as unavailable, with the id only', async () => {
      const c = await newCustomer();
      const w = await verifiedWorker();
      await as(api, c).put(`${SHORTLIST}/${w.workerId}`).expect(204);
      await api.prisma.workerProfile.update({
        where: { id: w.workerId },
        data: { blacklistedAt: new Date() },
      });
      try {
        const body = await homeBody(c);
        expect(body.shortlistTotal).toBe(1);
        expect(body.shortlistPreview[0]).toMatchObject({
          workerId: w.workerId,
          available: false,
          worker: null,
        });
      } finally {
        await api.prisma.workerProfile.update({
          where: { id: w.workerId },
          data: { blacklistedAt: null },
        });
      }
    });
  });

  describe('worker display name on every card (list, detail, shortlist, home)', () => {
    it('shows the same first-name-and-initial text everywhere and never the surname or contact data', async () => {
      const c = await newCustomer();
      const w = await verifiedWorker('Lakshmi Devi Rao');
      await as(api, c).put(`${SHORTLIST}/${w.workerId}`).expect(204);

      const list = await as(api, c).get(
        `/api/v1/search/workers?category=HOUSE_MAID&areaId=${area.id}&limit=100`,
      );
      expect(list.status).toBe(200);
      const inList = (list.body as { data: Array<Record<string, unknown>> }).data.find(
        (x) => x.workerId === w.workerId,
      );
      const detail = await as(api, c).get(`/api/v1/search/workers/${w.workerId}`);
      const shortlist = await as(api, c).get(SHORTLIST);
      const home = await homeBody(c);

      const expected = { name: 'Lakshmi R.', initials: 'LR' };
      expect(inList).toMatchObject(expected);
      expect(detail.body).toMatchObject(expected);
      expect((shortlist.body as { data: Array<{ worker: object }> }).data[0].worker).toMatchObject(
        expected,
      );
      expect(home.shortlistPreview[0].worker).toMatchObject(expected);
      // the list card and the detail card are the same shape
      expect(Object.keys(inList as object).sort()).toEqual(
        Object.keys(detail.body as object).sort(),
      );
      const all = JSON.stringify([inList, detail.body, home.shortlistPreview[0]]);
      expect(all).not.toMatch(/Devi|Rao\b|9876543210|expectedSalary|18000/);
    });

    it('does not show an ineligible worker, and needs a customer token', async () => {
      const c = await newCustomer();
      const unverified = await onboardWorker(api, { areaIds: [area.id], name: 'Hidden Person' });
      const detail = await as(api, c).get(`/api/v1/search/workers/${unverified.workerId}`);
      expect(detail.status).toBe(404);
      expect(JSON.stringify(detail.body)).not.toMatch(/Hidden/);
      const list = await as(api, c).get(
        `/api/v1/search/workers?category=HOUSE_MAID&areaId=${area.id}&limit=100`,
      );
      expect(JSON.stringify(list.body)).not.toContain(unverified.workerId);
      expect((await api.http().get('/api/v1/search/workers')).status).toBe(401);
      expect((await api.http().get(`/api/v1/search/workers/${unverified.workerId}`)).status).toBe(
        401,
      );
    });
  });

  describe('conditional requests (ETag)', () => {
    it('answers 304 while nothing changed, and a new validator after a relevant change', async () => {
      const c = await newCustomer();
      const first = await home(c);
      const etag = first.headers.etag;
      const again = await home(c, { 'If-None-Match': etag });
      expect(again.status).toBe(304);
      expect(again.text ?? '').toBe('');
      expect(again.headers.etag).toBe(etag);

      const w = await verifiedWorker();
      await as(api, c).put(`${SHORTLIST}/${w.workerId}`).expect(204);
      const changed = await home(c, { 'If-None-Match': etag });
      expect(changed.status).toBe(200);
      expect(changed.headers.etag).not.toBe(etag);
      expect((changed.body as HomeBody).shortlistTotal).toBe(1);
      expect((await home(c, { 'If-None-Match': changed.headers.etag })).status).toBe(304);

      // a booking change also moves the validator
      const b = await makeBooking(api, admin, c, area.id, 'MATCHED');
      const afterBooking = await home(c, { 'If-None-Match': changed.headers.etag });
      expect(afterBooking.status).toBe(200);
      expect((afterBooking.body as HomeBody).activeBooking?.id).toBe(b.id);
    });

    it("never validates one customer's validator against another customer", async () => {
      const a = await newCustomer();
      const b = await newCustomer();
      const w = await verifiedWorker();
      await as(api, a).put(`${SHORTLIST}/${w.workerId}`).expect(204);
      const etagA = (await home(a)).headers.etag;
      const forB = await home(b, { 'If-None-Match': etagA });
      expect(forB.status).toBe(200);
      expect((forB.body as HomeBody).shortlistTotal).toBe(0);
      expect(forB.headers.etag).not.toBe(etagA);
    });

    it('needs a customer token', async () => {
      expect((await api.http().get(HOME)).status).toBe(401);
      expect((await as(api, admin).get(HOME)).status).toBe(403);
    });
  });

  describe('shortlist mutations', () => {
    it('PUT and DELETE are idempotent and never touch the worker or bookings', async () => {
      const c = await newCustomer();
      const w = await verifiedWorker();
      for (let i = 0; i < 3; i++) {
        const put = await as(api, c).put(`${SHORTLIST}/${w.workerId}`);
        expect(put.status).toBe(204);
        expect(put.text ?? '').toBe('');
      }
      expect(
        await api.prisma.customerShortlistItem.count({
          where: { customerUserId: c.userId, workerId: w.workerId },
        }),
      ).toBe(1);
      expect((await as(api, c).delete(`${SHORTLIST}/${w.workerId}`)).status).toBe(204);
      expect((await as(api, c).delete(`${SHORTLIST}/${w.workerId}`)).status).toBe(204);
      expect((await as(api, c).delete(`${SHORTLIST}/${UNKNOWN_ID}`)).status).toBe(204);
      expect(await api.prisma.workerProfile.count({ where: { id: w.workerId } })).toBe(1);
    });

    it('has one stable error contract: 400 malformed, 404 WORKER_NOT_FOUND for unknown and not visible alike', async () => {
      const c = await newCustomer();
      const hidden = await verifiedWorker();
      await api.prisma.workerProfile.update({
        where: { id: hidden.workerId },
        data: { blacklistedAt: new Date() },
      });
      const malformed = await as(api, c).put(`${SHORTLIST}/not-a-uuid`);
      expect(malformed.status).toBe(400);
      const unknown = await as(api, c).put(`${SHORTLIST}/${UNKNOWN_ID}`);
      const notVisible = await as(api, c).put(`${SHORTLIST}/${hidden.workerId}`);
      for (const res of [unknown, notVisible]) {
        expect(res.status).toBe(404);
        expect(res.body).toMatchObject({ code: 'WORKER_NOT_FOUND', message: 'Worker not found' });
      }
      // identical apart from the request id: nothing about the worker leaks
      const strip = (b: Record<string, unknown>) => ({ ...b, requestId: undefined });
      expect(strip(unknown.body as Record<string, unknown>)).toEqual(
        strip(notVisible.body as Record<string, unknown>),
      );
      expect(
        await api.prisma.customerShortlistItem.count({ where: { customerUserId: c.userId } }),
      ).toBe(0);
      expect((await api.http().put(`${SHORTLIST}/${hidden.workerId}`)).status).toBe(401);
      expect((await as(api, hidden).put(`${SHORTLIST}/${hidden.workerId}`)).status).toBe(403);
    });

    it("one customer cannot change another customer's shortlist", async () => {
      const a = await newCustomer();
      const b = await newCustomer();
      const w = await verifiedWorker();
      await as(api, a).put(`${SHORTLIST}/${w.workerId}`).expect(204);
      await as(api, b).delete(`${SHORTLIST}/${w.workerId}`).expect(204);
      expect(
        await api.prisma.customerShortlistItem.count({
          where: { customerUserId: a.userId, workerId: w.workerId },
        }),
      ).toBe(1);
    });

    it('enforces the cap under concurrent additions: exactly the cap succeeds, the rest are 422 SHORTLIST_FULL', async () => {
      const service = api.app.get(ShortlistService);
      const original = service.maxEntries;
      expect(original).toBe(100);
      service.maxEntries = 3;
      try {
        const c = await newCustomer();
        const workers: OnboardedWorker[] = [];
        for (let i = 0; i < 6; i++) workers.push(await verifiedWorker());
        const results = await Promise.all(
          workers.map((w) => as(api, c).put(`${SHORTLIST}/${w.workerId}`)),
        );
        const ok = results.filter((r) => r.status === 204);
        const full = results.filter((r) => r.status === 422);
        expect(ok).toHaveLength(3);
        expect(full).toHaveLength(3);
        for (const r of full) {
          expect(r.body).toMatchObject({ code: 'SHORTLIST_FULL' });
        }
        expect(
          await api.prisma.customerShortlistItem.count({ where: { customerUserId: c.userId } }),
        ).toBe(3);
        // at the cap, repeating an existing entry is still a success; a new one is refused; removing frees a place
        const stored = await api.prisma.customerShortlistItem.findMany({
          where: { customerUserId: c.userId },
        });
        const kept = stored[0].workerId;
        const extra = workers.find((w) => !stored.some((s) => s.workerId === w.workerId))!;
        expect((await as(api, c).put(`${SHORTLIST}/${kept}`)).status).toBe(204);
        expect((await as(api, c).put(`${SHORTLIST}/${extra.workerId}`)).status).toBe(422);
        await as(api, c).delete(`${SHORTLIST}/${kept}`).expect(204);
        expect((await as(api, c).put(`${SHORTLIST}/${extra.workerId}`)).status).toBe(204);
      } finally {
        service.maxEntries = original;
      }
    });

    it('does not create duplicates for concurrent identical additions', async () => {
      const c = await newCustomer();
      const w = await verifiedWorker();
      const results = await Promise.all(
        Array.from({ length: 12 }, () => as(api, c).put(`${SHORTLIST}/${w.workerId}`)),
      );
      expect(results.every((r) => r.status === 204)).toBe(true);
      expect(
        await api.prisma.customerShortlistItem.count({ where: { customerUserId: c.userId } }),
      ).toBe(1);
    });
  });
});
