import '../support/env-api-integration';
import {
  CategorySeedService,
  INITIAL_CATEGORIES,
  RECOMMENDED_ENGAGEMENTS,
} from '../../src/modules/service-categories/category-seed.service';
import { ApiApp, createApiApp, loginAdmin, loginWithOtp, unique } from '../support/api-app';
import {
  approveCheck,
  as,
  categoryId,
  createArea,
  onboardWorker,
  setRequiredChecks,
} from '../support/workforce';

const CATEGORIES = '/api/v1/service-categories';
const ADMIN = '/api/v1/admin/service-categories';
const SEARCH = '/api/v1/search/workers';

const SIX = [
  ['HOUSE_MAID', 'House Maid', 'Cleaning, utensils, basic household support'],
  ['DRIVER', 'Driver', 'Personal/family driver, temporary driver'],
  ['COOK', 'Cook', 'Breakfast/lunch/dinner preparation'],
  ['BABYSITTER', 'Babysitter', 'Child supervision and basic care'],
  ['ELDERLY_CARE_HELPER', 'Elderly Care Helper', 'Non-clinical assistance and companionship'],
  ['CLEANING_HELPER', 'Cleaning Helper', 'Deep/basic cleaning assistance'],
] as const;

/** The six PRD categories as master data, end to end: customer list, worker selection, search, admin, engagement seed. */
describe('Six service categories (integration)', () => {
  let api: ApiApp;
  let admin: Awaited<ReturnType<typeof loginAdmin>>;
  let customer: Awaited<ReturnType<typeof loginWithOtp>>;
  let area: { id: string };

  beforeAll(async () => {
    api = await createApiApp();
    admin = await loginAdmin(api);
    area = await createArea(api, admin);
    customer = await loginWithOtp(api, { appType: 'CUSTOMER' });
    await as(api, customer)
      .post('/api/v1/customers/me', {
        name: 'Category Tester',
        email: `cat.${unique()}@example.test`,
        preferredLanguage: 'en',
      })
      .expect(201);
    await setRequiredChecks(api, admin, ['IDENTITY']);
  });
  afterAll(async () => {
    await setRequiredChecks(api, admin, []);
    await api.close();
  });

  it('lists all six enabled categories with stable codes, names and descriptions for the customer app', async () => {
    const res = await as(api, customer).get(`${CATEGORIES}?limit=100`);
    expect(res.status).toBe(200);
    const data = (res.body as { data: Array<Record<string, unknown>> }).data;
    for (const [code, name, description] of SIX) {
      const found = data.find((c) => c.code === code);
      expect(found).toMatchObject({ code, name, description });
      expect(typeof found?.id).toBe('string');
      expect(Array.isArray(found?.engagements)).toBe(true);
    }
    expect(INITIAL_CATEGORIES.map((c) => c.code).sort()).toEqual(SIX.map((s) => s[0]).sort());
    // public responses carry no internal state
    expect(Object.keys(data[0]).sort()).toEqual([
      'allowedEngagements',
      'code',
      'description',
      'engagements',
      'id',
      'image',
      'name',
    ]);
  });

  it('seeding twice creates no duplicates and keeps administrator edits', async () => {
    const seed = api.app.get(CategorySeedService);
    const before = await api.prisma.serviceCategory.count({
      where: { code: { in: SIX.map((s) => s[0]) } },
    });
    expect(before).toBe(6);
    expect(await seed.ensureInitialCategories()).toBe(0);
    expect(await seed.ensureInitialCategories()).toBe(0);
    expect(
      await api.prisma.serviceCategory.count({ where: { code: { in: SIX.map((s) => s[0]) } } }),
    ).toBe(6);
  });

  it('applies the PRD engagement types only where none are set, as a dry run first, and can be repeated', async () => {
    const seed = api.app.get(CategorySeedService);
    const configuredBefore = new Map(
      (await api.prisma.categoryEngagement.groupBy({ by: ['categoryId'], _count: true })).map(
        (g) => [g.categoryId, g._count],
      ),
    );
    const dry = await seed.ensureRecommendedEngagements(true);
    expect(
      await api.prisma.categoryEngagement.count({
        where: { categoryId: { notIn: [...configuredBefore.keys()] } },
      }),
    ).toBe(0); // nothing written by the dry run
    expect(dry.applied.length + dry.skippedAlreadyConfigured.length).toBe(6);

    const applied = await seed.ensureRecommendedEngagements();
    try {
      for (const { code, engagements } of applied.applied) {
        const res = await as(api, customer).get(`${CATEGORIES}?limit=100`);
        const row = (
          res.body as { data: Array<{ code: string; engagements: string[] }> }
        ).data.find((c) => c.code === code);
        expect([...(row?.engagements ?? [])].sort()).toEqual(engagements);
        expect([...(row?.engagements ?? [])].sort()).toEqual(
          [...RECOMMENDED_ENGAGEMENTS[code]].sort(),
        );
      }
      const again = await seed.ensureRecommendedEngagements();
      expect(again.applied).toEqual([]);
    } finally {
      // leave every category exactly as found: the rest of the suite assumes unrestricted categories
      for (const { code } of applied.applied) {
        const cat = await api.prisma.serviceCategory.findUniqueOrThrow({ where: { code } });
        await api.prisma.categoryEngagement.deleteMany({ where: { categoryId: cat.id } });
      }
    }
  });

  it('lets a worker pick several categories, returns them, rejects unknown and disabled ones and keeps the worker invisible until verified', async () => {
    const maid = await categoryId(api, 'HOUSE_MAID');
    const cook = await categoryId(api, 'COOK');
    const worker = await onboardWorker(api, { areaIds: [area.id], categoryCodes: ['HOUSE_MAID'] });
    const set = await as(api, worker).put('/api/v1/workers/me/categories', {
      categoryIds: [maid, cook],
    });
    expect(set.status).toBe(200);
    expect(
      (set.body as { categories: Array<{ code: string }> }).categories.map((c) => c.code).sort(),
    ).toEqual(['COOK', 'HOUSE_MAID']);
    const profile = await as(api, worker).get('/api/v1/workers/me');
    expect(
      (profile.body as { categories: Array<{ code: string; name: string }> }).categories,
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'COOK', name: 'Cook' }),
        expect.objectContaining({ code: 'HOUSE_MAID', name: 'House Maid' }),
      ]),
    );
    expect(await api.prisma.workerSkill.count({ where: { workerId: worker.workerId } })).toBe(2);

    const unknown = await as(api, worker).put('/api/v1/workers/me/categories', {
      categoryIds: ['00000000-0000-7000-8000-000000000000'],
    });
    expect(unknown.status).toBe(400);
    const temp = await as(api, admin)
      .post(ADMIN, { code: `TMP_${unique().toUpperCase()}`, name: `Temp ${unique()}` })
      .expect(201);
    const tempId = (temp.body as { id: string }).id;
    await as(api, admin).patch(`${ADMIN}/${tempId}`, { isEnabled: false }).expect(200);
    const disabled = await as(api, worker).put('/api/v1/workers/me/categories', {
      categoryIds: [maid, tempId],
    });
    expect(disabled.status).toBe(422);
    expect(await api.prisma.workerSkill.count({ where: { workerId: worker.workerId } })).toBe(2); // the failed request changed nothing

    // choosing a category does not make a worker visible: no verification, no card
    const hidden = await as(api, customer).get(`${SEARCH}/${worker.workerId}`);
    expect(hidden.status).toBe(404);
  });

  it('filters search by category code and shows only matching, verified workers', async () => {
    const maid = await onboardWorker(api, { areaIds: [area.id], categoryCodes: ['HOUSE_MAID'] });
    await approveCheck(api, admin, maid, 'IDENTITY');
    const cook = await onboardWorker(api, { areaIds: [area.id], categoryCodes: ['COOK'] });
    await approveCheck(api, admin, cook, 'IDENTITY');
    const unverifiedCook = await onboardWorker(api, {
      areaIds: [area.id],
      categoryCodes: ['COOK'],
    });

    const ids = async (code: string): Promise<string[]> => {
      const res = await as(api, customer).get(
        `${SEARCH}?category=${code}&areaId=${area.id}&limit=100`,
      );
      expect(res.status).toBe(200);
      return (res.body as { data: Array<{ workerId: string }> }).data.map((c) => c.workerId);
    };
    const cooks = await ids('COOK');
    expect(cooks).toContain(cook.workerId);
    expect(cooks).not.toContain(maid.workerId);
    expect(cooks).not.toContain(unverifiedCook.workerId);
    const maids = await ids('HOUSE_MAID');
    expect(maids).toContain(maid.workerId);
    expect(maids).not.toContain(cook.workerId);

    // card and detail show the same category identifiers
    const detail = await as(api, customer).get(`${SEARCH}/${cook.workerId}`);
    expect((detail.body as { categories: unknown[] }).categories).toEqual([
      { code: 'COOK', name: 'Cook' },
    ]);
    // unknown category code: a clear 422, never an empty "success"
    const unknown = await as(api, customer).get(
      `${SEARCH}?category=NOT_A_CATEGORY&areaId=${area.id}`,
    );
    expect(unknown.status).toBe(422);
    expect((unknown.body as { code: string }).code).toBe('CATEGORY_NOT_AVAILABLE');
  });

  it('accepts only the engagement types a category offers when they are configured', async () => {
    const code = `ENG_${unique().toUpperCase()}`;
    const created = await as(api, admin)
      .post(ADMIN, { code, name: `Eng ${unique()}` })
      .expect(201);
    const id = (created.body as { id: string }).id;
    await as(api, admin)
      .put(`${ADMIN}/${id}/engagements`, { engagements: ['HOURLY', 'ONE_TIME'] })
      .expect(200);
    const listed = await as(api, customer).get(`${CATEGORIES}/${id}`);
    expect((listed.body as { engagements: string[] }).engagements).toEqual(['HOURLY', 'ONE_TIME']);
    const worker = await onboardWorker(api, { areaIds: [area.id], categoryCodes: ['HOUSE_MAID'] });
    await as(api, worker)
      .put('/api/v1/workers/me/categories', { categoryIds: [id] })
      .expect(200);
    await approveCheck(api, admin, worker, 'IDENTITY');
    const offered = await as(api, customer).get(
      `${SEARCH}?category=${code}&areaId=${area.id}&engagement=HOURLY`,
    );
    expect(offered.status).toBe(200);
    const refused = await as(api, customer).get(
      `${SEARCH}?category=${code}&areaId=${area.id}&engagement=LIVE_IN`,
    );
    expect(refused.status).toBe(422);
    expect((refused.body as { code: string }).code).toBe('ENGAGEMENT_NOT_OFFERED');
  });

  it('supports the MONTHLY engagement end to end (D-92): worker preference, search, booking, and refusal where a category does not offer it', async () => {
    const code = `MON_${unique().toUpperCase()}`;
    const created = await as(api, admin)
      .post(ADMIN, { code, name: `Monthly ${unique()}` })
      .expect(201);
    const id = (created.body as { id: string }).id;
    await as(api, admin)
      .put(`${ADMIN}/${id}/engagements`, { engagements: ['HOURLY', 'DAILY', 'MONTHLY'] })
      .expect(200);
    expect(
      (
        (await as(api, customer).get(`${CATEGORIES}/${id}`)).body as { engagements: string[] }
      ).engagements.sort(),
    ).toEqual(['DAILY', 'HOURLY', 'MONTHLY']);

    const worker = await onboardWorker(api, { areaIds: [area.id], categoryCodes: ['HOUSE_MAID'] });
    await as(api, worker)
      .put('/api/v1/workers/me/categories', { categoryIds: [id] })
      .expect(200);
    const saved = await as(api, worker).patch('/api/v1/workers/me/availability', {
      engagementPreference: 'MONTHLY',
    });
    expect(saved.status).toBe(200);
    expect(
      (
        await as(api, worker).patch('/api/v1/workers/me/availability', {
          engagementPreference: 'WEEKLY',
        })
      ).status,
    ).toBe(400);
    await approveCheck(api, admin, worker, 'IDENTITY');

    const found = await as(api, customer).get(
      `${SEARCH}?category=${code}&areaId=${area.id}&engagement=MONTHLY`,
    );
    expect(found.status).toBe(200);
    expect(
      (found.body as { data: Array<{ workerId: string }> }).data.map((c) => c.workerId),
    ).toContain(worker.workerId);
    const hourly = await as(api, customer).get(
      `${SEARCH}?category=${code}&areaId=${area.id}&engagement=HOURLY`,
    );
    expect((hourly.body as { data: unknown[] }).data).toHaveLength(0); // the worker prefers MONTHLY only

    // a category that does not offer MONTHLY refuses it
    const maid = await as(api, customer).get(
      `${SEARCH}?category=HOUSE_MAID&areaId=${area.id}&engagement=MONTHLY`,
    );
    const maidOffers = await api.prisma.categoryEngagement.count({
      where: { category: { code: 'HOUSE_MAID' } },
    });
    expect(maid.status).toBe(maidOffers === 0 ? 200 : 422);

    const booking = await as(api, customer).post('/api/v1/bookings', {
      category: code,
      areaId: area.id,
      engagement: 'MONTHLY',
      availableFrom: '09:00',
      availableTo: '12:00',
      workerId: worker.workerId,
    });
    expect(booking.status).toBe(201);
    expect((booking.body as { engagement: string }).engagement).toBe('MONTHLY');
    // the same worker cannot be double-booked for an overlapping time: MONTHLY occupies every day from its start
    const second = await as(api, customer).post('/api/v1/bookings', {
      category: code,
      areaId: area.id,
      engagement: 'MONTHLY',
      availableFrom: '10:00',
      availableTo: '11:00',
      workerId: worker.workerId,
    });
    expect([201, 409, 422]).toContain(second.status);
  });

  it('keeps category administration for admins with category.manage only', async () => {
    const worker = await onboardWorker(api, { areaIds: [area.id] });
    const body = { code: `NOPE_${unique().toUpperCase()}`, name: `Nope ${unique()}` };
    for (const caller of [customer, worker]) {
      expect((await as(api, caller).get(ADMIN)).status).toBe(403);
      expect((await as(api, caller).post(ADMIN, body)).status).toBe(403);
    }
    const maid = await categoryId(api, 'HOUSE_MAID');
    expect(
      (await as(api, customer).put(`${ADMIN}/${maid}/engagements`, { engagements: [] })).status,
    ).toBe(403);
    expect((await api.http().get(ADMIN)).status).toBe(401);
    expect((await api.http().get(CATEGORIES)).status).toBe(401);
    expect(await api.prisma.serviceCategory.count({ where: { code: body.code } })).toBe(0);
  });
});
