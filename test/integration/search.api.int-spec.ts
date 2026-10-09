import '../support/env-api-integration';
import {
  ApiApp,
  createApiApp,
  loginAdmin,
  loginAdminWithPermissions,
  loginWithOtp,
} from '../support/api-app';
import {
  approveCheck,
  as,
  categoryId,
  createArea,
  onboardWorker,
  OnboardedWorker,
  setRequiredChecks,
} from '../support/workforce';

const S = '/api/v1/search/workers';

/** Worker search against the REAL PostgreSQL + Redis (dedicated test database), through the HTTP API. */
describe('Search API (integration)', () => {
  let api: ApiApp;
  let admin: Awaited<ReturnType<typeof loginAdmin>>;
  let customer: Awaited<ReturnType<typeof loginWithOtp>>;
  let areaA: { id: string };
  let areaB: { id: string };

  // w1..w3 are the expected results for HOUSE_MAID in area A.
  let w1: OnboardedWorker; // 60 months, PART_TIME 08-14, en+hi
  let w2: OnboardedWorker; // 24 months, FULL_TIME 06-12, en+te
  let w3: OnboardedWorker; // 24 months (tie with w2), PART_TIME 13-18, hi
  let suspended: OnboardedWorker;
  let unverified: OnboardedWorker;
  let draft: OnboardedWorker;
  let cook: OnboardedWorker;
  let otherArea: OnboardedWorker;
  let recheckDue: OnboardedWorker;

  const verify = (worker: OnboardedWorker) => approveCheck(api, admin, worker, 'IDENTITY');
  const search = (query: string) => as(api, customer).get(`${S}?${query}`);
  const base = () => `category=HOUSE_MAID&areaId=${areaA.id}`;
  const ids = (body: unknown): string[] =>
    (body as { data: Array<{ workerId: string }> }).data.map((c) => c.workerId);

  beforeAll(async () => {
    api = await createApiApp();
    admin = await loginAdmin(api);
    customer = await loginWithOtp(api, { appType: 'CUSTOMER' });
    areaA = await createArea(api, admin);
    areaB = await createArea(api, admin);
    await setRequiredChecks(api, admin, ['IDENTITY']);
    const make = (o: Parameters<typeof onboardWorker>[1]) =>
      onboardWorker(api, { areaIds: [areaA.id], ...o });

    w1 = await make({
      experienceMonths: 60,
      engagement: 'PART_TIME',
      windows: [{ start: '08:00', end: '14:00' }],
      languages: ['en', 'hi'],
      name: 'Secret Name One',
    });
    w2 = await make({
      experienceMonths: 24,
      engagement: 'FULL_TIME',
      windows: [{ start: '06:00', end: '12:00' }],
      languages: ['en', 'te'],
    });
    w3 = await make({
      experienceMonths: 24,
      engagement: 'PART_TIME',
      windows: [{ start: '13:00', end: '18:00' }],
      languages: ['hi'],
    });
    suspended = await make({ experienceMonths: 100 });
    unverified = await make({ experienceMonths: 100 });
    draft = await make({ experienceMonths: 100, submit: false });
    cook = await make({ categoryCodes: ['COOK'], experienceMonths: 100 });
    otherArea = await onboardWorker(api, { areaIds: [areaB.id], experienceMonths: 100 });
    recheckDue = await make({ experienceMonths: 100 });

    for (const w of [w1, w2, w3, suspended, cook, otherArea, recheckDue]) await verify(w);
    // A submitted but not yet approved identity check does not make anyone verified.
    await as(api, unverified)
      .post('/api/v1/workers/me/verification/checks/EMERGENCY_CONTACT/submit')
      .expect(200);
    // An approval row on a DRAFT profile (impossible through the API) must still not surface the worker.
    await api.prisma.workerVerificationCheck.create({
      data: {
        workerId: draft.workerId,
        checkType: 'IDENTITY',
        status: 'APPROVED',
        submittedAt: new Date(),
        reviewedAt: new Date(),
        reviewerUserId: admin.userId,
      },
    });
    await as(api, admin)
      .patch(`/api/v1/admin/users/${suspended.userId}/status`, { status: 'SUSPENDED' })
      .expect(200);
    await api.prisma
      .$executeRaw`UPDATE worker_verification_checks SET status = 'APPROVED', recheck_at = ((now() AT TIME ZONE 'Asia/Kolkata')::date) WHERE worker_id = ${recheckDue.workerId}::uuid AND check_type = 'IDENTITY'`;
  });

  afterAll(async () => {
    await setRequiredChecks(api, admin, []);
    await api.close();
  });

  describe('eligibility', () => {
    it('returns only active, submitted, fully verified workers for the category and area', async () => {
      const res = await search(base());
      expect(res.status).toBe(200);
      expect(new Set(ids(res.body))).toEqual(new Set([w1.workerId, w2.workerId, w3.workerId]));
      expect(res.body.meta).toEqual({ page: 1, limit: 20, total: 3 });
      const excluded = [suspended, unverified, draft, cook, otherArea, recheckDue].map(
        (w) => w.workerId,
      );
      for (const id of excluded) expect(ids(res.body)).not.toContain(id);
    });

    it('finds the cook only under COOK and the other-area worker only in the other area', async () => {
      expect(ids((await search(`category=COOK&areaId=${areaA.id}`)).body)).toEqual([cook.workerId]);
      expect(ids((await search(`category=HOUSE_MAID&areaId=${areaB.id}`)).body)).toEqual([
        otherArea.workerId,
      ]);
    });

    it('applies the engagement, availability, language and experience filters, alone and together', async () => {
      expect(new Set(ids((await search(`${base()}&engagement=PART_TIME`)).body))).toEqual(
        new Set([w1.workerId, w3.workerId]),
      );
      expect(ids((await search(`${base()}&engagement=FULL_TIME`)).body)).toEqual([w2.workerId]);
      expect(ids((await search(`${base()}&engagement=LIVE_IN`)).body)).toEqual([]);
      // One window must cover the whole range.
      expect(
        new Set(ids((await search(`${base()}&availableFrom=09:00&availableTo=11:00`)).body)),
      ).toEqual(new Set([w1.workerId, w2.workerId]));
      expect(ids((await search(`${base()}&availableFrom=08:00&availableTo=14:00`)).body)).toEqual([
        w1.workerId,
      ]);
      expect(ids((await search(`${base()}&availableFrom=07:00&availableTo=15:00`)).body)).toEqual(
        [],
      );
      expect(new Set(ids((await search(`${base()}&language=hi`)).body))).toEqual(
        new Set([w1.workerId, w3.workerId]),
      );
      expect(ids((await search(`${base()}&language=te`)).body)).toEqual([w2.workerId]);
      expect(ids((await search(`${base()}&minExperienceMonths=48`)).body)).toEqual([w1.workerId]);
      expect(ids((await search(`${base()}&minExperienceMonths=24`)).body)).toHaveLength(3);
      expect(
        ids(
          (
            await search(
              `${base()}&engagement=PART_TIME&language=hi&availableFrom=14:00&availableTo=17:00&minExperienceMonths=12`,
            )
          ).body,
        ),
      ).toEqual([w3.workerId]);
    });

    it('follows verification changes at once: a re-check removes the worker, approval adds one back', async () => {
      const own = await createArea(api, admin);
      const base = () => `category=HOUSE_MAID&areaId=${own.id}`;
      const extra = await onboardWorker(api, { areaIds: [own.id], experienceMonths: 1 });
      expect(ids((await search(base())).body)).not.toContain(extra.workerId);
      const checkId = await approveCheck(api, admin, extra, 'IDENTITY');
      expect(ids((await search(base())).body)).toContain(extra.workerId);
      await as(api, admin)
        .post(`/api/v1/admin/verification/checks/${checkId}/recheck`, { remarks: 'Expired' })
        .expect(200);
      expect(ids((await search(base())).body)).not.toContain(extra.workerId);
    });

    it('lists nobody while no check is required, and follows the required set', async () => {
      await setRequiredChecks(api, admin, []);
      try {
        expect((await search(base())).body.meta.total).toBe(0);
        await setRequiredChecks(api, admin, ['IDENTITY', 'POLICE_VERIFICATION']);
        expect((await search(base())).body.meta.total).toBe(0);
      } finally {
        await setRequiredChecks(api, admin, ['IDENTITY']);
      }
      expect((await search(base())).body.meta.total).toBeGreaterThanOrEqual(3);
    });

    it('stops listing a worker when the account is suspended and lists them again when reactivated', async () => {
      const own = await createArea(api, admin);
      const base = () => `category=HOUSE_MAID&areaId=${own.id}`;
      const extra = await onboardWorker(api, { areaIds: [own.id], experienceMonths: 2 });
      await verify(extra);
      expect(ids((await search(base())).body)).toContain(extra.workerId);
      await as(api, admin)
        .patch(`/api/v1/admin/users/${extra.userId}/status`, { status: 'SUSPENDED' })
        .expect(200);
      expect(ids((await search(base())).body)).not.toContain(extra.workerId);
      await as(api, admin)
        .patch(`/api/v1/admin/users/${extra.userId}/status`, { status: 'ACTIVE' })
        .expect(200);
      expect(ids((await search(base())).body)).toContain(extra.workerId);
    });

    it('answers 422 for a disabled or unknown category and area, and shows disabled categories nowhere on a card', async () => {
      const cookCategory = await categoryId(api, 'COOK');
      const area = await createArea(api, admin);
      await as(api, admin)
        .patch(`/api/v1/admin/service-areas/${area.id}`, { isEnabled: false })
        .expect(200);
      const disabledArea = await search(`category=HOUSE_MAID&areaId=${area.id}`);
      expect(disabledArea.status).toBe(422);
      expect(disabledArea.body.code).toBe('AREA_NOT_AVAILABLE');
      const unknownArea = await search(
        'category=HOUSE_MAID&areaId=00000000-0000-7000-8000-000000000000',
      );
      expect(unknownArea.body.code).toBe('AREA_NOT_AVAILABLE');
      const unknownCategory = await search(`category=NO_SUCH&areaId=${areaA.id}`);
      expect(unknownCategory.status).toBe(422);
      expect(unknownCategory.body.code).toBe('CATEGORY_NOT_AVAILABLE');
      await as(api, admin)
        .patch(`/api/v1/admin/service-categories/${cookCategory}`, { isEnabled: false })
        .expect(200);
      try {
        const disabled = await search(`category=COOK&areaId=${areaA.id}`);
        expect(disabled.status).toBe(422);
        expect(disabled.body.code).toBe('CATEGORY_NOT_AVAILABLE');
      } finally {
        await as(api, admin)
          .patch(`/api/v1/admin/service-categories/${cookCategory}`, { isEnabled: true })
          .expect(200);
      }
    });
  });

  describe('ordering and pagination', () => {
    it('orders by experience with a stable tie-break, ascending or descending, identically on every call', async () => {
      const desc = ids((await search(base())).body);
      expect(desc[0]).toBe(w1.workerId);
      const tied = [w2.workerId, w3.workerId].sort();
      expect(desc.slice(1)).toEqual(tied);
      expect(ids((await search(base())).body)).toEqual(desc);
      const asc = ids((await search(`${base()}&sort=EXPERIENCE_ASC`)).body);
      expect(asc).toEqual([...tied, w1.workerId]);
      expect((await search(`${base()}&sort=RELEVANCE`)).status).toBe(400);
    });

    it('pages without gaps or repeats and reports the total', async () => {
      const first = await search(`${base()}&limit=2&page=1`);
      const second = await search(`${base()}&limit=2&page=2`);
      const beyond = await search(`${base()}&limit=2&page=3`);
      expect(first.body.meta).toEqual({ page: 1, limit: 2, total: 3 });
      expect(ids(first.body)).toHaveLength(2);
      expect(ids(second.body)).toHaveLength(1);
      expect(beyond.body.data).toEqual([]);
      expect(beyond.body.meta.total).toBe(3);
      expect(new Set([...ids(first.body), ...ids(second.body)]).size).toBe(3);
      expect([...ids(first.body), ...ids(second.body)]).toEqual(ids((await search(base())).body));
    });

    it('bounds the page size and rejects malformed input', async () => {
      for (const bad of [
        `${base()}&limit=101`,
        `${base()}&limit=0`,
        `${base()}&page=0`,
        `${base()}&page=abc`,
        `${base()}&engagement=DAILY`,
        `${base()}&availableFrom=09:00`,
        `${base()}&availableTo=09:00`,
        `${base()}&availableFrom=12:00&availableTo=09:00`,
        `${base()}&availableFrom=9am&availableTo=10am`,
        `${base()}&language=HINDI`,
        `${base()}&minExperienceMonths=-1`,
        'category=HOUSE_MAID',
        `areaId=${areaA.id}`,
        `category=house_maid&areaId=${areaA.id}`,
        `category=HOUSE_MAID&areaId=not-a-uuid`,
      ]) {
        const res = await search(bad);
        expect([400, 422]).toContain(res.status);
        expect(res.body.code).toBeDefined();
      }
    });
  });

  describe('authorization and privacy', () => {
    it('is for customers only', async () => {
      const worker = await onboardWorker(api, { areaIds: [areaA.id] });
      expect((await api.http().get(`${S}?${base()}`)).status).toBe(401);
      expect((await as(api, worker).get(`${S}?${base()}`)).status).toBe(403);
      expect((await as(api, admin).get(`${S}?${base()}`)).status).toBe(403);
      const everything = await loginAdminWithPermissions(api, ['worker.view', 'matching.run']);
      expect((await as(api, everything).get(`${S}?${base()}`)).status).toBe(403);
    });

    it('returns an exact allow-list of card fields and nothing private', async () => {
      const res = await search(`${base()}&sort=EXPERIENCE_DESC`);
      const card = res.body.data[0];
      expect(Object.keys(card as object).sort()).toEqual(
        [
          'availability',
          'categories',
          'engagementPreference',
          'experienceMonths',
          'languages',
          'serviceAreas',
          'verification',
          'workerId',
        ].sort(),
      );
      expect(card).toMatchObject({
        workerId: w1.workerId,
        experienceMonths: 60,
        verification: 'VERIFIED',
        engagementPreference: 'PART_TIME',
        languages: ['en', 'hi'],
        availability: [{ start: '08:00', end: '14:00' }],
        categories: [{ code: 'HOUSE_MAID', name: expect.any(String) }],
      });
      const text = JSON.stringify(res.body);
      for (const forbidden of [
        'Secret Name One',
        'Ramesh',
        'Madhapur',
        '500081',
        'Lakshmi',
        '9876543210',
        w1.mobile,
        w1.userId,
        'expectedSalary',
        '18000',
        'emergency',
        'address',
        'userId',
        'mobile',
        'password',
        'objectKey',
        'kyc/',
        'documents',
        'remarks',
      ]) {
        expect(text).not.toContain(forbidden);
      }
    });

    it('does not disclose why a worker is missing: an unverified worker looks exactly like a non-existent one', async () => {
      const res = await search(`${base()}&minExperienceMonths=100`);
      expect(res.body.data).toEqual([]);
      expect(res.body.meta.total).toBe(0);
    });
  });

  describe('query shape and indexes', () => {
    it('runs a constant number of statements however many workers are returned', async () => {
      const spy = jest.spyOn(api.prisma, '$queryRaw');
      try {
        spy.mockClear();
        await search(`${base()}&limit=1`).expect(200);
        const one = spy.mock.calls.length;
        spy.mockClear();
        await search(`${base()}&limit=100`).expect(200);
        const many = spy.mock.calls.length;
        spy.mockClear();
        await search(`${base()}&minExperienceMonths=1000`).expect(200);
        const none = spy.mock.calls.length;
        expect(one).toBe(many);
        expect(one).toBe(6);
        expect(none).toBe(2);
      } finally {
        spy.mockRestore();
      }
    });

    it('has the indexes the search relies on, and the planner can use them', async () => {
      const indexes = (
        await api.prisma.$queryRaw<
          Array<{ indexname: string }>
        >`SELECT indexname FROM pg_indexes WHERE tablename IN ('worker_profiles','worker_skills','worker_preferred_areas','worker_verification_checks','worker_time_windows')`
      ).map((i) => i.indexname);
      for (const name of [
        'worker_profiles_search_order_idx',
        'worker_profiles_search_submitted_idx',
        'worker_skills_category_id_idx',
        'worker_preferred_areas_area_id_idx',
        'worker_verification_checks_worker_id_check_type_key',
      ]) {
        expect(indexes).toContain(name);
      }
      const plan = await api.prisma.$transaction(async (tx) => {
        await tx.$executeRawUnsafe('SET LOCAL enable_seqscan = off');
        await tx.$executeRawUnsafe('SET LOCAL enable_bitmapscan = off');
        const rows = await tx.$queryRawUnsafe<Array<{ 'QUERY PLAN': string }>>(
          `EXPLAIN SELECT wp.id FROM worker_profiles wp WHERE wp.onboarding_status = 'SUBMITTED' ORDER BY wp.experience_months DESC NULLS LAST, wp.id LIMIT 20`,
        );
        return rows.map((r) => r['QUERY PLAN']).join('\n');
      });
      expect(plan).toContain('worker_profiles_search_order_idx');
    });
  });
});
