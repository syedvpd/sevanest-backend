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
  createArea,
  onboardWorker,
  OnboardedWorker,
  setRequiredChecks,
} from '../support/workforce';

const M = '/api/v1/admin/matching/candidates';

/** Manual matching against the REAL PostgreSQL + Redis (dedicated test database), through the HTTP API. */
describe('Matching API (integration)', () => {
  let api: ApiApp;
  let admin: Awaited<ReturnType<typeof loginAdmin>>;
  let area: { id: string };
  let fits: OnboardedWorker;
  let fitsLater: OnboardedWorker;
  let wrongEngagement: OnboardedWorker;
  let wrongWindow: OnboardedWorker;
  let wrongLanguage: OnboardedWorker;
  let notVerified: OnboardedWorker;
  let draft: OnboardedWorker;
  let suspended: OnboardedWorker;

  const requirement = (extra: object = {}) => ({
    category: 'HOUSE_MAID',
    areaId: area.id,
    engagement: 'PART_TIME',
    availableFrom: '09:00',
    availableTo: '12:00',
    ...extra,
  });
  const match = (body: object, caller: { accessToken: string } = admin) =>
    as(api, caller).post(M, body);
  const ids = (body: unknown): string[] =>
    (body as { data: Array<{ workerId: string }> }).data.map((c) => c.workerId);

  beforeAll(async () => {
    api = await createApiApp();
    admin = await loginAdmin(api);
    area = await createArea(api, admin);
    await setRequiredChecks(api, admin, ['IDENTITY']);
    const make = (o: Parameters<typeof onboardWorker>[1] = {}) =>
      onboardWorker(api, {
        areaIds: [area.id],
        engagement: 'PART_TIME',
        windows: [{ start: '08:00', end: '13:00' }],
        languages: ['en', 'hi'],
        experienceMonths: 36,
        ...o,
      });
    fits = await make({ name: 'Matched Worker One' });
    fitsLater = await make();
    wrongEngagement = await make({ engagement: 'LIVE_IN' });
    wrongWindow = await make({ windows: [{ start: '10:00', end: '13:00' }] });
    wrongLanguage = await make({ languages: ['te'] });
    notVerified = await make();
    draft = await make({ submit: false });
    suspended = await make();
    for (const w of [fits, fitsLater, wrongEngagement, wrongWindow, wrongLanguage, suspended]) {
      await approveCheck(api, admin, w, 'IDENTITY');
    }
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
  });

  afterAll(async () => {
    await setRequiredChecks(api, admin, []);
    await api.close();
  });

  describe('candidate selection', () => {
    it('returns exactly the verified, active, submitted workers that meet every criterion, in a stable non-ranked order', async () => {
      const res = await match(requirement());
      expect(res.status).toBe(200);
      expect(ids(res.body)).toEqual([fits.workerId, fitsLater.workerId, wrongLanguage.workerId]);
      expect(res.body.ranked).toBe(false);
      expect(res.body.ordering).toBe('SUBMITTED_ASC');
      expect(res.body.meta).toEqual({ page: 1, limit: 20, total: 3 });
      expect(JSON.stringify(res.body)).not.toContain('score');
      expect((await match(requirement())).body).toEqual(res.body);
    });

    it('applies each criterion: engagement, timings, language and experience', async () => {
      expect(ids((await match(requirement({ engagement: 'LIVE_IN' }))).body)).toEqual([
        wrongEngagement.workerId,
      ]);
      expect(
        ids((await match(requirement({ availableFrom: '08:00', availableTo: '13:00' }))).body),
      ).toEqual([fits.workerId, fitsLater.workerId, wrongLanguage.workerId]);
      // wrongWindow (10:00-13:00) only appears once the requested range fits inside its window.
      expect(
        ids((await match(requirement({ availableFrom: '10:00', availableTo: '12:00' }))).body),
      ).toEqual([fits.workerId, fitsLater.workerId, wrongWindow.workerId, wrongLanguage.workerId]);
      expect(ids((await match(requirement({ language: 'hi' }))).body)).toEqual([
        fits.workerId,
        fitsLater.workerId,
      ]);
      expect(ids((await match(requirement({ language: 'te' }))).body)).toEqual([
        wrongLanguage.workerId,
      ]);
      expect(ids((await match(requirement({ language: 'fr' }))).body)).toEqual([]);
      expect(ids((await match(requirement({ minExperienceMonths: 37 }))).body)).toEqual([]);
    });

    it('cannot be used to reach workers that are unverified, in draft, or suspended', async () => {
      const all = ids(
        (await match(requirement({ availableFrom: '10:00', availableTo: '12:00' }))).body,
      );
      for (const w of [notVerified, draft, suspended]) expect(all).not.toContain(w.workerId);
      // No request field switches verification off.
      const tryBypass = await match(
        requirement({ includeUnverified: true, verification: 'ANY', status: 'DRAFT' }),
      );
      expect([200, 400]).toContain(tryBypass.status);
      if (tryBypass.status === 200) {
        for (const w of [notVerified, draft, suspended])
          expect(ids(tryBypass.body)).not.toContain(w.workerId);
      }
      // With no check required, nobody is a candidate at all.
      await setRequiredChecks(api, admin, []);
      try {
        expect((await match(requirement())).body.meta.total).toBe(0);
      } finally {
        await setRequiredChecks(api, admin, ['IDENTITY']);
      }
    });

    it('agrees with customer search for the same criteria', async () => {
      const customer = await loginWithOtp(api, { appType: 'CUSTOMER' });
      const searched = await as(api, customer).get(
        `/api/v1/search/workers?category=HOUSE_MAID&areaId=${area.id}&engagement=PART_TIME&availableFrom=09:00&availableTo=12:00&limit=100`,
      );
      expect(new Set(ids(searched.body))).toEqual(new Set(ids((await match(requirement())).body)));
    });

    it('pages deterministically and bounds the page size', async () => {
      const one = await match(requirement({ limit: 1, page: 1 }));
      const two = await match(requirement({ limit: 1, page: 2 }));
      expect([...ids(one.body), ...ids(two.body)]).toEqual([fits.workerId, fitsLater.workerId]);
      expect(one.body.meta).toEqual({ page: 1, limit: 1, total: 3 });
      expect(ids((await match(requirement({ limit: 1, page: 3 }))).body)).toEqual([
        wrongLanguage.workerId,
      ]);
      expect((await match(requirement({ limit: 1, page: 4 }))).body.data).toEqual([]);
      expect((await match(requirement({ limit: 101 }))).status).toBe(400);
    });

    it('gives staff the worker identity needed to act, but no contact or private profile data', async () => {
      const res = await match(requirement());
      const first = res.body.data[0];
      expect(Object.keys(first as object).sort()).toEqual(
        [
          'availability',
          'categories',
          'engagementPreference',
          'experienceMonths',
          'languages',
          'name',
          'serviceAreas',
          'userId',
          'workerId',
        ].sort(),
      );
      expect(first.name).toBe('Matched Worker One');
      expect(first.userId).toBe(fits.userId);
      const text = JSON.stringify(res.body);
      for (const forbidden of [
        fits.mobile,
        'Madhapur',
        '500081',
        'Lakshmi',
        '9876543210',
        'expectedSalary',
        'emergency',
        'objectKey',
        'kyc/',
      ]) {
        expect(text).not.toContain(forbidden);
      }
    });
  });

  describe('requirement validation', () => {
    it('needs the whole requirement and rejects malformed values', async () => {
      for (const field of ['category', 'areaId', 'engagement', 'availableFrom', 'availableTo']) {
        const body: Record<string, unknown> = { ...requirement() };
        delete body[field];
        expect((await match(body)).status).toBe(400);
      }
      for (const bad of [
        { engagement: 'DAILY' },
        { availableFrom: '12:00', availableTo: '09:00' },
        { availableFrom: '09:00', availableTo: '09:00' },
        { availableFrom: '9', availableTo: '12:00' },
        { areaId: 'nope' },
        { category: 'house' },
        { language: 'HINDI' },
        { minExperienceMonths: -3 },
      ]) {
        expect((await match(requirement(bad))).status).toBe(400);
      }
    });

    it('answers 422 for a category or area that is not enabled', async () => {
      const disabled = await createArea(api, admin);
      await as(api, admin)
        .patch(`/api/v1/admin/service-areas/${disabled.id}`, { isEnabled: false })
        .expect(200);
      const a = await match(requirement({ areaId: disabled.id }));
      expect(a.status).toBe(422);
      expect(a.body.code).toBe('AREA_NOT_AVAILABLE');
      const c = await match(requirement({ category: 'NO_SUCH' }));
      expect(c.status).toBe(422);
      expect(c.body.code).toBe('CATEGORY_NOT_AVAILABLE');
    });
  });

  describe('authorization and audit', () => {
    it('needs the matching.run permission and an admin account', async () => {
      const worker = await onboardWorker(api, { areaIds: [area.id] });
      const customer = await loginWithOtp(api, { appType: 'CUSTOMER' });
      expect((await api.http().post(M).send(requirement())).status).toBe(401);
      expect((await match(requirement(), worker)).status).toBe(403);
      expect((await match(requirement(), customer)).status).toBe(403);
      const noPermission = await loginAdminWithPermissions(api, [
        'worker.view',
        'verification.review',
      ]);
      expect((await match(requirement(), noPermission)).status).toBe(403);
      const allowed = await loginAdminWithPermissions(api, ['matching.run']);
      expect((await match(requirement(), allowed)).status).toBe(200);
    });

    it('audits each run with the requirement and the count, never with worker names or contact details', async () => {
      const runner = await loginAdminWithPermissions(api, ['matching.run']);
      await match(requirement({ language: 'hi' }), runner).expect(200);
      const row = await api.prisma.auditLog.findFirstOrThrow({
        where: { action: 'matching.candidates', actorId: runner.userId },
        orderBy: { createdAt: 'desc' },
      });
      expect(row.metadata).toMatchObject({
        category: 'HOUSE_MAID',
        areaId: area.id,
        engagement: 'PART_TIME',
        availableFrom: '09:00',
        availableTo: '12:00',
        language: 'hi',
        total: 2,
      });
      const text = JSON.stringify(row);
      expect(text).not.toContain('Matched Worker One');
      expect(text).not.toContain(fits.workerId);
      expect(text).not.toContain(fits.mobile);
    });

    it('assigns, reserves and changes nothing: the workforce tables are identical before and after', async () => {
      const snapshot = async () => ({
        checks: await api.prisma.workerVerificationCheck.count(),
        events: await api.prisma.workerVerificationEvent.count(),
        profiles: await api.prisma.workerProfile.count(),
        updated: (
          await api.prisma.workerProfile.findUniqueOrThrow({ where: { id: fits.workerId } })
        ).updatedAt,
      });
      const before = await snapshot();
      await match(requirement()).expect(200);
      expect(await snapshot()).toEqual(before);
    });
  });
});
