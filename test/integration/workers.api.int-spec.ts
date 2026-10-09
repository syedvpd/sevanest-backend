import '../support/env-api-integration';
import { WorkersService } from '../../src/modules/workers/workers.service';
import {
  ApiApp,
  bearer,
  createApiApp,
  loginAdmin,
  loginAdminWithPermissions,
  loginWithOtp,
  unique,
} from '../support/api-app';

const UNKNOWN_ID = '00000000-0000-7000-8000-000000000000';

interface Worker {
  accessToken: string;
  refreshToken: string;
  userId: string;
  mobile: string;
  workerId: string;
}

const address = {
  line: '4-5-6, Gandhi Nagar',
  area: 'Kukatpally',
  city: 'Hyderabad',
  pincode: '500072',
};
const emergencyContact = { name: 'Lakshmi Devi', mobile: '9876543210' };

/** Workers module against the REAL PostgreSQL + Redis (dedicated test database), through the HTTP API. */
describe('Workers API (integration)', () => {
  let api: ApiApp;
  let superAdmin: Awaited<ReturnType<typeof loginAdmin>>;
  let categoryIds: Record<string, string>;

  const as = (caller: { accessToken: string }) => ({
    get: (url: string) => api.http().get(url).set('Authorization', bearer(caller)),
    post: (url: string, body: object = {}) =>
      api.http().post(url).set('Authorization', bearer(caller)).send(body),
    patch: (url: string, body: object = {}) =>
      api.http().patch(url).set('Authorization', bearer(caller)).send(body),
    put: (url: string, body: object = {}) =>
      api.http().put(url).set('Authorization', bearer(caller)).send(body),
  });

  async function newWorker(withProfile = true): Promise<Worker> {
    const session = await loginWithOtp(api, { appType: 'WORKER' });
    let workerId = '';
    if (withProfile) {
      const res = await as(session).post('/api/v1/workers/me', { name: 'Ramesh Kumar' });
      expect(res.status).toBe(201);
      workerId = (res.body as { id: string }).id;
    }
    return { ...session, mobile: session.mobile!, workerId };
  }

  beforeAll(async () => {
    api = await createApiApp();
    superAdmin = await loginAdmin(api);
    const rows = await api.prisma.serviceCategory.findMany({ select: { id: true, code: true } });
    categoryIds = Object.fromEntries(rows.map((r) => [r.code, r.id]));
  });
  afterAll(async () => {
    await api.close();
  });

  describe('profile', () => {
    it('answers 404 until the profile exists', async () => {
      const worker = await newWorker(false);
      const res = await as(worker).get('/api/v1/workers/me');
      expect(res.status).toBe(404);
      expect(res.body.code).toBe('WORKER_PROFILE_NOT_FOUND');
    });

    it('starts a DRAFT profile on the verified account, audited without personal data', async () => {
      const worker = await newWorker(false);
      const res = await as(worker).post('/api/v1/workers/me', { name: '  Ramesh Kumar ' });
      expect(res.status).toBe(201);
      expect(res.body).toMatchObject({
        name: 'Ramesh Kumar',
        mobile: worker.mobile,
        onboardingStatus: 'DRAFT',
        submittedAt: null,
        experienceMonths: null,
        expectedSalary: null,
        languages: [],
        address: null,
        emergencyContact: null,
        previousEmployer: null,
        hasProfilePhoto: false,
        categories: [],
      });
      expect(res.body.missingForSubmission).toEqual(
        expect.arrayContaining([
          'address',
          'emergencyContact',
          'categories',
          'languages',
          'experience',
        ]),
      );
      const audit = await api.prisma.auditLog.findMany({
        where: { action: 'worker.profile_create', actorId: worker.userId },
      });
      expect(audit).toHaveLength(1);
      expect(JSON.stringify(audit[0])).not.toMatch(/Ramesh/);
    });

    it('never exposes internal or KYC-related fields', async () => {
      const worker = await newWorker();
      const body = (await as(worker).get('/api/v1/workers/me')).body as object;
      expect(Object.keys(body).sort()).toEqual(
        [
          'address',
          'categories',
          'createdAt',
          'emergencyContact',
          'experienceMonths',
          'expectedSalary',
          'hasProfilePhoto',
          'id',
          'languages',
          'missingForSubmission',
          'mobile',
          'name',
          'onboardingStatus',
          'previousEmployer',
          'submittedAt',
          'updatedAt',
        ].sort(),
      );
      expect(JSON.stringify(body)).not.toMatch(
        /userId|profilePhotoRef|kyc|document|aadhaar|password/i,
      );
    });

    it.each([
      ['empty name', { name: '' }],
      ['digits in name', { name: 'Ramesh123' }],
      ['symbols in name', { name: '<b>Ramesh</b>' }],
      ['name too long', { name: 'R'.repeat(201) }],
      ['missing name', {}],
    ])('rejects %s and creates nothing', async (_n, body) => {
      const worker = await newWorker(false);
      const res = await as(worker).post('/api/v1/workers/me', body);
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('VALIDATION_FAILED');
      expect(await api.prisma.workerProfile.count({ where: { userId: worker.userId } })).toBe(0);
    });

    it('rejects a second profile and creates exactly one under parallel requests', async () => {
      const worker = await newWorker(false);
      const results = await Promise.all(
        Array.from({ length: 5 }, () =>
          as(worker).post('/api/v1/workers/me', { name: 'Ramesh Kumar' }),
        ),
      );
      expect(results.filter((r) => r.status === 201)).toHaveLength(1);
      const conflicts = results.filter((r) => r.status === 409);
      expect(conflicts).toHaveLength(4);
      expect(conflicts.every((r) => r.body.code === 'WORKER_PROFILE_EXISTS')).toBe(true);
      expect(await api.prisma.workerProfile.count({ where: { userId: worker.userId } })).toBe(1);
    });

    it('ignores server-controlled fields on create (mass assignment)', async () => {
      const victim = await newWorker();
      const worker = await newWorker(false);
      const res = await as(worker).post('/api/v1/workers/me', {
        name: 'Ramesh Kumar',
        id: UNKNOWN_ID,
        userId: victim.userId,
        onboardingStatus: 'SUBMITTED',
        submittedAt: '2020-01-01T00:00:00Z',
        profilePhotoRef: 'private/other-users-photo.jpg',
      });
      expect(res.status).toBe(201);
      const row = await api.prisma.workerProfile.findUniqueOrThrow({
        where: { userId: worker.userId },
      });
      expect(row).toMatchObject({
        onboardingStatus: 'DRAFT',
        submittedAt: null,
        profilePhotoRef: null,
      });
      expect(row.id).not.toBe(UNKNOWN_ID);
      expect(row.userId).toBe(worker.userId);
    });
  });

  describe('saving steps (PATCH /workers/me)', () => {
    it('saves each onboarding step independently and keeps the others', async () => {
      const worker = await newWorker();
      const step1 = await as(worker).patch('/api/v1/workers/me', { address, emergencyContact });
      expect(step1.status).toBe(200);
      expect(step1.body.address).toEqual(address);
      expect(step1.body.emergencyContact).toEqual({
        name: 'Lakshmi Devi',
        mobile: '+919876543210',
      });

      const step2 = await as(worker).patch('/api/v1/workers/me', {
        previousEmployer: { name: 'Mr. Sharma', mobile: '09123456780' },
      });
      expect(step2.body.previousEmployer).toEqual({ name: 'Mr. Sharma', mobile: '+919123456780' });
      expect(step2.body.address).toEqual(address); // untouched

      const step3 = await as(worker).patch('/api/v1/workers/me', {
        experienceMonths: 30,
        expectedSalary: 15000.5,
        languages: ['hi', 'en'],
      });
      expect(step3.body).toMatchObject({
        experienceMonths: 30,
        expectedSalary: 15000.5,
        languages: ['en', 'hi'],
      });
      expect(step3.body.missingForSubmission).not.toEqual(
        expect.arrayContaining(['address', 'emergencyContact', 'languages', 'experience']),
      );
    });

    it('replaces a group as a whole, replaces languages, and clears optional values with null', async () => {
      const worker = await newWorker();
      await as(worker).patch('/api/v1/workers/me', {
        languages: ['en', 'hi', 'te'],
        expectedSalary: 12000,
        previousEmployer: { name: 'Mrs. Rao', mobile: '9000000001' },
      });
      const res = await as(worker).patch('/api/v1/workers/me', {
        languages: ['te'],
        expectedSalary: null,
        previousEmployer: null,
        address,
      });
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({
        languages: ['te'],
        expectedSalary: null,
        previousEmployer: null,
      });
      const row = await api.prisma.workerProfile.findUniqueOrThrow({
        where: { id: worker.workerId },
      });
      expect(row.previousEmployerName).toBeNull();
      expect(row.previousEmployerMobile).toBeNull();
    });

    it.each([
      ['negative experience', { experienceMonths: -1 }],
      ['fractional experience', { experienceMonths: 1.5 }],
      ['absurd experience', { experienceMonths: 5000 }],
      ['zero salary', { expectedSalary: 0 }],
      ['negative salary', { expectedSalary: -100 }],
      ['salary with 3 decimals', { expectedSalary: 100.123 }],
      ['empty languages', { languages: [] }],
      ['duplicate languages', { languages: ['en', 'en'] }],
      ['bad language code', { languages: ['English'] }],
      ['bad pincode', { address: { ...address, pincode: '12345' } }],
      ['incomplete address', { address: { line: 'x', area: 'y', city: 'z' } }],
      ['bad emergency mobile', { emergencyContact: { name: 'Lakshmi Devi', mobile: '12345' } }],
      ['emergency contact without name', { emergencyContact: { mobile: '9876543210' } }],
      ['bad previous employer mobile', { previousEmployer: { name: 'X', mobile: 'abc' } }],
      ['name with digits', { name: 'R2D2' }],
    ])('rejects %s and changes nothing', async (_n, bad) => {
      const worker = await newWorker();
      await as(worker).patch('/api/v1/workers/me', { experienceMonths: 12, languages: ['en'] });
      const res = await as(worker).patch('/api/v1/workers/me', bad);
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('VALIDATION_FAILED');
      const after = (await as(worker).get('/api/v1/workers/me')).body;
      expect(after).toMatchObject({ experienceMonths: 12, languages: ['en'], address: null });
    });

    it('rejects empty updates and updates that contain only server-controlled fields', async () => {
      const worker = await newWorker();
      for (const body of [
        {},
        { onboardingStatus: 'SUBMITTED' },
        { profilePhotoRef: 'x', userId: UNKNOWN_ID },
      ]) {
        const res = await as(worker).patch('/api/v1/workers/me', body);
        expect(res.status).toBe(400);
      }
    });

    it('ignores server-controlled fields mixed into a valid update (mass assignment)', async () => {
      const worker = await newWorker();
      const other = await newWorker();
      const res = await as(worker).patch('/api/v1/workers/me', {
        experienceMonths: 6,
        onboardingStatus: 'SUBMITTED',
        submittedAt: '2020-01-01T00:00:00Z',
        profilePhotoRef: 'private/x.jpg',
        userId: other.userId,
        id: other.workerId,
      });
      expect(res.status).toBe(200);
      const row = await api.prisma.workerProfile.findUniqueOrThrow({
        where: { id: worker.workerId },
      });
      expect(row).toMatchObject({
        experienceMonths: 6,
        onboardingStatus: 'DRAFT',
        submittedAt: null,
        profilePhotoRef: null,
        userId: worker.userId,
      });
      expect(
        (await api.prisma.workerProfile.findUniqueOrThrow({ where: { id: other.workerId } }))
          .experienceMonths,
      ).toBeNull();
    });

    it('audits field names only, never values', async () => {
      const worker = await newWorker();
      await as(worker).patch('/api/v1/workers/me', { address, emergencyContact, name: 'Ramesh K' });
      const audit = await api.prisma.auditLog.findMany({
        where: { action: 'worker.profile_update', entityId: worker.workerId },
      });
      expect(audit).toHaveLength(1);
      expect(audit[0].metadata).toEqual({ changedFields: ['address', 'emergencyContact', 'name'] });
      expect(JSON.stringify(audit)).not.toMatch(/Gandhi|Kukatpally|Lakshmi|98765|Ramesh/);
    });

    it('cannot update a profile that does not exist', async () => {
      const worker = await newWorker(false);
      expect((await as(worker).patch('/api/v1/workers/me', { experienceMonths: 1 })).status).toBe(
        404,
      );
    });

    it('keeps parallel language replacements consistent (exactly one wins, no merged set)', async () => {
      const worker = await newWorker();
      const sets = [['en'], ['hi'], ['te'], ['en', 'hi'], ['hi', 'te'], ['en', 'te']];
      const results = await Promise.all(
        sets.map((languages) => as(worker).patch('/api/v1/workers/me', { languages })),
      );
      expect(results.every((r) => r.status === 200)).toBe(true);
      const final = (await as(worker).get('/api/v1/workers/me')).body.languages as string[];
      expect(sets.map((s) => [...s].sort().join(','))).toContain([...final].sort().join(','));
    });

    it('keeps parallel updates of different steps (no lost update)', async () => {
      const worker = await newWorker();
      const results = await Promise.all([
        as(worker).patch('/api/v1/workers/me', { address }),
        as(worker).patch('/api/v1/workers/me', { emergencyContact }),
        as(worker).patch('/api/v1/workers/me', { experienceMonths: 18 }),
        as(worker).patch('/api/v1/workers/me', { languages: ['en'] }),
      ]);
      expect(results.every((r) => r.status === 200)).toBe(true);
      const final = (await as(worker).get('/api/v1/workers/me')).body;
      expect(final).toMatchObject({ address, experienceMonths: 18, languages: ['en'] });
      expect(final.emergencyContact.name).toBe('Lakshmi Devi');
    });
  });

  describe('roles (PUT /workers/me/categories)', () => {
    it("sets and replaces the worker's roles from enabled categories, audited with added/removed", async () => {
      const worker = await newWorker();
      const first = await as(worker).put('/api/v1/workers/me/categories', {
        categoryIds: [categoryIds.HOUSE_MAID, categoryIds.COOK],
      });
      expect(first.status).toBe(200);
      expect(first.body.categories.map((c: { code: string }) => c.code).sort()).toEqual([
        'COOK',
        'HOUSE_MAID',
      ]);

      const second = await as(worker).put('/api/v1/workers/me/categories', {
        categoryIds: [categoryIds.COOK, categoryIds.DRIVER],
      });
      expect(second.body.categories.map((c: { code: string }) => c.code).sort()).toEqual([
        'COOK',
        'DRIVER',
      ]);

      const audit = await api.prisma.auditLog.findMany({
        where: { action: 'worker.categories_set', entityId: worker.workerId },
        orderBy: { createdAt: 'asc' },
      });
      expect(audit).toHaveLength(2);
      expect(audit[1].metadata).toEqual({
        added: [categoryIds.DRIVER],
        removed: [categoryIds.HOUSE_MAID],
      });
      // Same set again: nothing changes, nothing is audited.
      await as(worker)
        .put('/api/v1/workers/me/categories', {
          categoryIds: [categoryIds.DRIVER, categoryIds.COOK],
        })
        .expect(200);
      expect(
        await api.prisma.auditLog.count({
          where: { action: 'worker.categories_set', entityId: worker.workerId },
        }),
      ).toBe(2);
    });

    it.each([
      ['empty set', { categoryIds: [] }],
      ['not an array', { categoryIds: categoryIds }],
      ['not a uuid', { categoryIds: ['house-maid'] }],
      [
        'duplicates',
        {
          categoryIds: [
            '11111111-1111-7111-8111-111111111111',
            '11111111-1111-7111-8111-111111111111',
          ],
        },
      ],
      ['missing', {}],
    ])('rejects %s', async (_n, body) => {
      const worker = await newWorker();
      expect((await as(worker).put('/api/v1/workers/me/categories', body)).status).toBe(400);
    });

    it('rejects an unknown category (400) and a disabled category the worker does not hold (422)', async () => {
      const worker = await newWorker();
      const unknown = await as(worker).put('/api/v1/workers/me/categories', {
        categoryIds: [UNKNOWN_ID],
      });
      expect(unknown.status).toBe(400);
      expect(unknown.body.code).toBe('VALIDATION_FAILED');

      const extra = await api.prisma.serviceCategory.create({
        data: {
          code: `RETIRED_${unique().toUpperCase()}`,
          name: `Retired ${unique()}`,
          isEnabled: false,
        },
      });
      const disabled = await as(worker).put('/api/v1/workers/me/categories', {
        categoryIds: [categoryIds.COOK, extra.id],
      });
      expect(disabled.status).toBe(422);
      expect(disabled.body.code).toBe('CATEGORY_NOT_AVAILABLE');
      expect(await api.prisma.workerSkill.count({ where: { workerId: worker.workerId } })).toBe(0);
    });

    it('lets a worker keep a category that was disabled after they chose it', async () => {
      const worker = await newWorker();
      const temp = await api.prisma.serviceCategory.create({
        data: { code: `TEMP_${unique().toUpperCase()}`, name: `Temporary ${unique()}` },
      });
      await as(worker)
        .put('/api/v1/workers/me/categories', { categoryIds: [temp.id, categoryIds.COOK] })
        .expect(200);
      await api.prisma.serviceCategory.update({
        where: { id: temp.id },
        data: { isEnabled: false },
      });
      const kept = await as(worker).put('/api/v1/workers/me/categories', {
        categoryIds: [temp.id],
      });
      expect(kept.status).toBe(200);
      expect(kept.body.categories).toEqual([
        expect.objectContaining({ id: temp.id, isEnabled: false }),
      ]);
    });

    it('stays consistent when different role sets are submitted in parallel', async () => {
      const worker = await newWorker();
      const sets = [
        [categoryIds.COOK],
        [categoryIds.DRIVER],
        [categoryIds.BABYSITTER, categoryIds.COOK],
        [categoryIds.HOUSE_MAID, categoryIds.DRIVER],
        [categoryIds.CLEANING_HELPER],
      ];
      const results = await Promise.all(
        sets.map((ids) => as(worker).put('/api/v1/workers/me/categories', { categoryIds: ids })),
      );
      expect(results.every((r) => r.status === 200)).toBe(true);
      const final = (
        await api.prisma.workerSkill.findMany({ where: { workerId: worker.workerId } })
      )
        .map((s) => s.categoryId)
        .sort();
      expect(sets.map((s) => [...s].sort().join(','))).toContain(final.join(','));
    });
  });

  describe('submission rules (availability items are covered in the Availability suite)', () => {
    it('answers 422 PROFILE_INCOMPLETE listing what is missing, and stays DRAFT', async () => {
      const worker = await newWorker();
      const res = await as(worker).post('/api/v1/workers/me/submit');
      expect(res.status).toBe(422);
      expect(res.body.code).toBe('PROFILE_INCOMPLETE');
      expect(res.body.details[0].messages).toEqual(
        expect.arrayContaining([
          'address',
          'emergencyContact',
          'categories',
          'languages',
          'experience',
        ]),
      );
      const row = await api.prisma.workerProfile.findUniqueOrThrow({
        where: { id: worker.workerId },
      });
      expect(row).toMatchObject({ onboardingStatus: 'DRAFT', submittedAt: null });
    });

    it('cannot submit without a profile', async () => {
      const worker = await newWorker(false);
      expect((await as(worker).post('/api/v1/workers/me/submit')).status).toBe(404);
    });
  });

  describe('ownership and role isolation', () => {
    it("keeps every worker's data separate (the API has no worker id to tamper with)", async () => {
      const a = await newWorker();
      const b = await newWorker();
      await as(a).patch('/api/v1/workers/me', { name: 'Worker A', address });
      await as(b).patch('/api/v1/workers/me', { name: 'Worker B' });
      expect((await as(a).get('/api/v1/workers/me')).body).toMatchObject({
        id: a.workerId,
        name: 'Worker A',
        address,
      });
      expect((await as(b).get('/api/v1/workers/me')).body).toMatchObject({
        id: b.workerId,
        name: 'Worker B',
        address: null,
      });
    });

    it('is reserved for workers: customers, admins and anonymous callers are refused on every operation', async () => {
      const customer = await loginWithOtp(api, { appType: 'CUSTOMER' });
      for (const caller of [customer, superAdmin]) {
        for (const res of [
          await as(caller).get('/api/v1/workers/me'),
          await as(caller).post('/api/v1/workers/me', { name: 'Ramesh Kumar' }),
          await as(caller).patch('/api/v1/workers/me', { experienceMonths: 1 }),
          await as(caller).put('/api/v1/workers/me/categories', {
            categoryIds: [categoryIds.COOK],
          }),
          await as(caller).post('/api/v1/workers/me/submit'),
        ]) {
          expect(res.status).toBe(403);
          expect(res.body.code).toBe('FORBIDDEN');
        }
      }
      await api.http().get('/api/v1/workers/me').expect(401);
      await api.http().post('/api/v1/workers/me').send({ name: 'Ramesh Kumar' }).expect(401);
    });

    it('stops a suspended worker at once and changes nothing behind the rejected requests', async () => {
      const worker = await newWorker();
      await as(superAdmin)
        .patch(`/api/v1/admin/users/${worker.userId}/status`, { status: 'SUSPENDED' })
        .expect(200);
      expect((await as(worker).get('/api/v1/workers/me')).status).toBe(401);
      expect((await as(worker).patch('/api/v1/workers/me', { experienceMonths: 99 })).status).toBe(
        401,
      );
      expect(
        (await api.prisma.workerProfile.findUniqueOrThrow({ where: { id: worker.workerId } }))
          .experienceMonths,
      ).toBeNull();
    });
  });

  describe('admin worker management', () => {
    const base = '/api/v1/admin/workers';

    it('lists workers with pagination, masked mobiles, categories, and filters', async () => {
      const a = await newWorker();
      const b = await newWorker();
      await as(a).put('/api/v1/workers/me/categories', { categoryIds: [categoryIds.DRIVER] });
      await as(b).put('/api/v1/workers/me/categories', {
        categoryIds: [categoryIds.COOK, categoryIds.BABYSITTER],
      });

      const page = await as(superAdmin).get(`${base}?page=1&limit=2`);
      expect(page.status).toBe(200);
      expect(page.body.data).toHaveLength(2);
      expect(page.body.meta.total).toBeGreaterThanOrEqual(2);
      for (const row of page.body.data as Array<Record<string, unknown>>) {
        expect(Object.keys(row).sort()).toEqual([
          'accountStatus',
          'categories',
          'createdAt',
          'id',
          'mobile',
          'name',
          'onboardingStatus',
          'userId',
        ]);
        expect(row.mobile).toMatch(/^\+91\*{6}\d{4}$/);
      }

      const byCategory = await as(superAdmin).get(
        `${base}?categoryId=${categoryIds.DRIVER}&limit=100`,
      );
      expect(byCategory.body.data.map((w: { id: string }) => w.id)).toContain(a.workerId);
      expect(byCategory.body.data.map((w: { id: string }) => w.id)).not.toContain(b.workerId);
      const mine = (
        byCategory.body.data as Array<{ id: string; categories: Array<{ code: string }> }>
      ).find((w) => w.id === a.workerId)!;
      expect(mine.categories.map((c) => c.code)).toEqual(['DRIVER']);

      const byMobile = await as(superAdmin).get(
        `${base}?mobile=${encodeURIComponent(b.mobile.slice(3))}`,
      );
      expect(byMobile.body.data.map((w: { id: string }) => w.id)).toEqual([b.workerId]);
      const byStatus = await as(superAdmin).get(`${base}?onboardingStatus=SUBMITTED&limit=100`);
      expect(
        byStatus.body.data.every(
          (w: { onboardingStatus: string }) => w.onboardingStatus === 'SUBMITTED',
        ),
      ).toBe(true);
    });

    it.each([
      ['page 0', 'page=0'],
      ['limit 101', 'limit=101'],
      ['bad status', 'onboardingStatus=APPROVED'],
      ['bad category id', 'categoryId=nope'],
    ])('rejects %s', async (_n, query) => {
      expect((await as(superAdmin).get(`${base}?${query}`)).status).toBe(400);
    });

    it('shows full detail to authorised admins, including private fields, with 404/400 handling', async () => {
      const worker = await newWorker();
      await as(worker).patch('/api/v1/workers/me', { address, emergencyContact });
      const res = await as(superAdmin).get(`${base}/${worker.workerId}`);
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({
        id: worker.workerId,
        userId: worker.userId,
        mobile: worker.mobile,
        accountStatus: 'ACTIVE',
        address,
        emergencyContact: { name: 'Lakshmi Devi', mobile: '+919876543210' },
      });
      expect(JSON.stringify(res.body)).not.toMatch(/profilePhotoRef|kyc|document/i);
      expect((await as(superAdmin).get(`${base}/${UNKNOWN_ID}`)).status).toBe(404);
      expect((await as(superAdmin).get(`${base}/nope`)).status).toBe(400);
    });

    it("supports assisted onboarding: admin edits and sets roles on the worker's behalf, audited with the admin as actor", async () => {
      const worker = await newWorker();
      const edited = await as(superAdmin).patch(`${base}/${worker.workerId}`, {
        address,
        languages: ['en'],
        experienceMonths: 60,
      });
      expect(edited.status).toBe(200);
      expect(edited.body).toMatchObject({ address, languages: ['en'], experienceMonths: 60 });
      const roles = await as(superAdmin).put(`${base}/${worker.workerId}/categories`, {
        categoryIds: [categoryIds.HOUSE_MAID],
      });
      expect(roles.status).toBe(200);
      expect(roles.body.categories[0].code).toBe('HOUSE_MAID');

      const audit = await api.prisma.auditLog.findMany({
        where: {
          entityId: worker.workerId,
          action: { in: ['worker.profile_update', 'worker.categories_set'] },
        },
      });
      expect(audit).toHaveLength(2);
      expect(
        audit.every((a) => a.actorId === superAdmin.userId && a.actorRole === 'SUPER_ADMIN'),
      ).toBe(true);
      expect((await as(worker).get('/api/v1/workers/me')).body).toMatchObject({
        address,
        experienceMonths: 60,
      });

      expect(
        (await as(superAdmin).patch(`${base}/${UNKNOWN_ID}`, { experienceMonths: 1 })).status,
      ).toBe(404);
      expect(
        (
          await as(superAdmin).patch(`${base}/${worker.workerId}`, {
            onboardingStatus: 'SUBMITTED',
          })
        ).status,
      ).toBe(400);
    });

    it('enforces permissions per capability and refuses non-admins', async () => {
      const worker = await newWorker();
      const viewer = await loginAdminWithPermissions(api, ['worker.view']);
      const manager = await loginAdminWithPermissions(api, ['worker.manage']);
      const unrelated = await loginAdminWithPermissions(api, ['customer.view']);
      const otherWorker = await newWorker();
      const customer = await loginWithOtp(api, { appType: 'CUSTOMER' });

      expect((await as(viewer).get(base)).status).toBe(200);
      expect((await as(viewer).get(`${base}/${worker.workerId}`)).status).toBe(200);
      expect(
        (await as(viewer).patch(`${base}/${worker.workerId}`, { experienceMonths: 1 })).status,
      ).toBe(403);
      expect(
        (
          await as(viewer).put(`${base}/${worker.workerId}/categories`, {
            categoryIds: [categoryIds.COOK],
          })
        ).status,
      ).toBe(403);

      expect(
        (await as(manager).patch(`${base}/${worker.workerId}`, { experienceMonths: 2 })).status,
      ).toBe(200);
      expect((await as(manager).get(base)).status).toBe(403); // manage does not imply view

      for (const caller of [unrelated, otherWorker, customer]) {
        expect((await as(caller).get(base)).status).toBe(403);
        expect((await as(caller).get(`${base}/${worker.workerId}`)).status).toBe(403);
        expect(
          (await as(caller).patch(`${base}/${worker.workerId}`, { experienceMonths: 3 })).status,
        ).toBe(403);
      }
      await api.http().get(base).expect(401);
      expect(
        (await api.prisma.workerProfile.findUniqueOrThrow({ where: { id: worker.workerId } }))
          .experienceMonths,
      ).toBe(2);
    });
  });

  describe('contract for other modules and database invariants', () => {
    it('exposes a private-data-free contract to future modules', async () => {
      const worker = await newWorker();
      await as(worker).patch('/api/v1/workers/me', {
        address,
        emergencyContact,
        languages: ['en'],
        experienceMonths: 12,
      });
      await as(worker).put('/api/v1/workers/me/categories', { categoryIds: [categoryIds.COOK] });
      const contract = await api.app.get(WorkersService).getContract(worker.workerId);
      expect(contract).toEqual({
        id: worker.workerId,
        userId: worker.userId,
        name: 'Ramesh Kumar',
        onboardingStatus: 'DRAFT',
        experienceMonths: 12,
        languages: ['en'],
        categoryIds: [categoryIds.COOK],
      });
    });

    it('lets the database refuse states the application must never produce', async () => {
      const worker = await newWorker();
      const update = (data: object) =>
        api.prisma.workerProfile.update({ where: { id: worker.workerId }, data });
      await expect(update({ addressLine: 'only a line' })).rejects.toThrow(); // address is all-or-none
      await expect(update({ emergencyContactName: 'only a name' })).rejects.toThrow();
      await expect(update({ experienceMonths: -3 })).rejects.toThrow();
      await expect(update({ expectedSalary: 0 })).rejects.toThrow();
      await expect(update({ onboardingStatus: 'SUBMITTED' })).rejects.toThrow(); // needs submittedAt
      await expect(update({ submittedAt: new Date() })).rejects.toThrow(); // needs SUBMITTED
      await expect(
        api.prisma.workerLanguage.create({
          data: { workerId: worker.workerId, languageCode: 'English' },
        }),
      ).rejects.toThrow();
      await expect(
        api.prisma.workerSkill.create({
          data: { workerId: worker.workerId, categoryId: UNKNOWN_ID },
        }),
      ).rejects.toThrow();
    });
  });
});
