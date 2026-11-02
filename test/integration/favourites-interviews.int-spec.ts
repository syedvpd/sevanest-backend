import '../support/env-api-integration';
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
const I = '/api/v1/interviews';
const W = '/api/v1/workers/me/interviews';
const SHORTLIST = '/api/v1/shortlist';

type Session = Awaited<ReturnType<typeof loginWithOtp>>;

const at = (days: number, hour = 10): string => {
  const d = new Date(Date.now() + days * 86_400_000);
  d.setUTCHours(hour, 0, 0, 0);
  return d.toISOString();
};

interface ListBody {
  data: Array<{
    id: string;
    status: string;
    durationMinutes: number;
    scheduledAt: string | null;
    worker: { workerId: string; name: string; initials: string; photoUrl: string | null } | null;
    timeline: Array<{ state: string; at: string | null }>;
  }>;
  meta: { page: number; limit: number; total: number };
  counts: { upcoming: number; past: number; total: number };
}

/** Customer app: Favourites and Interviews screens (list worker summary, duration, counts, scope, shortlist categories). */
describe('Favourites and Interviews contract (integration)', () => {
  let api: ApiApp;
  let admin: Awaited<ReturnType<typeof loginAdmin>>;
  let area: { id: string };

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
    categoryCodes: string[],
    name = 'Ramesh Kumar',
  ): Promise<OnboardedWorker> => {
    const w = await onboardWorker(api, {
      name,
      categoryCodes,
      areaIds: [area.id],
      engagement: 'HOURLY',
      windows: [{ start: '06:00', end: '22:00' }],
    });
    await approveCheck(api, admin, w, 'IDENTITY');
    return w;
  };
  const matched = async (c: Session, w: OnboardedWorker, category = 'HOUSE_MAID') => {
    const created = await as(api, c)
      .post(B, {
        category,
        areaId: area.id,
        engagement: 'HOURLY',
        availableFrom: '09:00',
        availableTo: '10:00',
        startDate: inDays(3),
        workerId: w.workerId,
      })
      .expect(201);
    return created.body.id as string;
  };
  const request = async (c: Session, bookingId: string, days: number) => {
    const res = await as(api, c).post(I, { bookingId, type: 'INTERVIEW', preferredAt: at(days) });
    expect(res.status).toBe(201);
    return res.body as { id: string };
  };
  const list = async (c: Session, query = ''): Promise<ListBody> => {
    const res = await as(api, c).get(`${I}${query}`);
    expect(res.status).toBe(200);
    return res.body as ListBody;
  };

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

  describe('GET /interviews', () => {
    it('embeds the worker summary and the duration, and counts across all pages', async () => {
      const c = await customer();
      const w1 = await worker(['HOUSE_MAID'], 'Lakshmi Devi');
      const w2 = await worker(['HOUSE_MAID'], 'Sunita Rao');
      const w3 = await worker(['HOUSE_MAID'], 'Meena Patel');
      const i1 = await request(c, await matched(c, w1), 5);
      const i2 = await request(c, await matched(c, w2), 2);
      const i3 = await request(c, await matched(c, w3), 3);
      // i2 confirmed, i3 cancelled (closed), i1 still waiting
      await as(api, w2).post(`${W}/${i2.id}/accept`).expect(200);
      await as(api, c).post(`${I}/${i3.id}/cancel`, { reason: 'changed my mind' }).expect(200);

      const all = await list(c, '?limit=1');
      expect(all.data).toHaveLength(1);
      expect(all.meta).toEqual({ page: 1, limit: 1, total: 3 });
      // counts do not depend on the page size
      expect(all.counts).toEqual({ upcoming: 2, past: 1, total: 3 });

      const full = await list(c);
      const byId = new Map(full.data.map((i) => [i.id, i]));
      expect(byId.get(i1.id)?.worker).toMatchObject({
        workerId: w1.workerId,
        name: 'Lakshmi D.',
        initials: 'LD',
        photoUrl: null,
      });
      expect(byId.get(i2.id)?.worker?.workerId).toBe(w2.workerId);
      for (const row of full.data) expect(row.durationMinutes).toBe(60);
      expect(JSON.stringify(full)).not.toMatch(/Devi|Patel|\+91|mobile/);
    });

    it('scope=upcoming lists open sessions, soonest agreed time first; scope=past the closed ones', async () => {
      const c = await customer();
      const wa = await worker(['HOUSE_MAID']);
      const wb = await worker(['HOUSE_MAID']);
      const wc = await worker(['HOUSE_MAID']);
      const later = await request(c, await matched(c, wa), 6);
      const sooner = await request(c, await matched(c, wb), 2);
      const closed = await request(c, await matched(c, wc), 4);
      await as(api, wa).post(`${W}/${later.id}/accept`).expect(200);
      await as(api, wb).post(`${W}/${sooner.id}/accept`).expect(200);
      await as(api, c).post(`${I}/${closed.id}/cancel`, { reason: 'no longer needed' }).expect(200);

      const up = await list(c, '?scope=upcoming');
      expect(up.data.map((i) => i.id)).toEqual([sooner.id, later.id]);
      expect(up.meta.total).toBe(2);
      expect(up.counts).toEqual({ upcoming: 2, past: 1, total: 3 });

      const past = await list(c, '?scope=past');
      expect(past.data.map((i) => i.id)).toEqual([closed.id]);
      expect(past.data[0].status).toBe('CANCELLED');

      expect((await as(api, c).get(`${I}?scope=other`)).status).toBe(400);
    });

    it('answers an empty list with zero counts, and never counts another customer', async () => {
      const empty = await customer();
      const body = await list(empty, '?scope=upcoming');
      expect(body.data).toEqual([]);
      expect(body.counts).toEqual({ upcoming: 0, past: 0, total: 0 });

      const owner = await customer();
      const w = await worker(['HOUSE_MAID']);
      await request(owner, await matched(owner, w), 3);
      expect((await list(empty)).counts.total).toBe(0);
      expect((await list(owner)).counts.total).toBe(1);
    });

    it('timeline carries a timestamp for every done or failed step and none for pending ones', async () => {
      const c = await customer();
      const w = await worker(['HOUSE_MAID']);
      const waiting = await request(c, await matched(c, w), 3);
      const body = await list(c);
      const row = body.data.find((i) => i.id === waiting.id)!;
      for (const step of row.timeline) {
        if (step.state === 'done' || step.state === 'failed') expect(step.at).not.toBeNull();
        else expect(step.at).toBeNull();
      }
    });
  });

  describe('GET /shortlist', () => {
    it('counts categories across the whole shortlist and filters by category', async () => {
      const c = await customer();
      const other = await customer();
      const maid1 = await worker(['HOUSE_MAID']);
      const maid2 = await worker(['HOUSE_MAID']);
      const cook = await worker(['COOK']);
      const both = await worker(['HOUSE_MAID', 'COOK']);
      for (const w of [maid1, maid2, cook, both]) {
        await as(api, c).put(`${SHORTLIST}/${w.workerId}`).expect(204);
      }
      await as(api, other).put(`${SHORTLIST}/${cook.workerId}`).expect(204);

      const res = await as(api, c).get(`${SHORTLIST}?limit=1`);
      expect(res.status).toBe(200);
      const body = res.body as {
        data: unknown[];
        meta: { total: number };
        categoryCounts: Array<{ code: string; name: string; count: number }>;
      };
      expect(body.data).toHaveLength(1);
      expect(body.meta.total).toBe(4);
      const counts = Object.fromEntries(body.categoryCounts.map((x) => [x.code, x.count]));
      // a worker with two categories counts once in each; the customer's own entries only
      expect(counts).toEqual({ COOK: 2, HOUSE_MAID: 3 });

      const maids = await as(api, c).get(`${SHORTLIST}?category=HOUSE_MAID&limit=2&page=2`);
      const maidBody = maids.body as {
        data: Array<{ workerId: string }>;
        meta: { total: number };
        categoryCounts: unknown[];
      };
      expect(maidBody.meta.total).toBe(3);
      expect(maidBody.data).toHaveLength(1);
      expect(maidBody.categoryCounts).toEqual(body.categoryCounts);

      const none = await as(api, c).get(`${SHORTLIST}?category=GARDENER`);
      expect((none.body as { meta: { total: number } }).meta.total).toBe(0);
      expect((await as(api, c).get(`${SHORTLIST}?category=bad-code`)).status).toBe(400);
    });

    it('an empty shortlist answers no counts', async () => {
      const c = await customer();
      const body = (await as(api, c).get(SHORTLIST)).body as {
        data: unknown[];
        categoryCounts: unknown[];
      };
      expect(body.data).toEqual([]);
      expect(body.categoryCounts).toEqual([]);
    });
  });
});
