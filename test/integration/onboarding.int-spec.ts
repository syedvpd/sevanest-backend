import '../support/env-api-integration';
import { ApiApp, createApiApp, loginAdmin, loginWithOtp, unique } from '../support/api-app';
import {
  as,
  checkIdOf,
  createArea,
  onboardWorker,
  setRequiredChecks,
  uploadDocument,
} from '../support/workforce';
import { SAMPLE_JPEG } from '../support/images';

const C = '/api/v1/customers/me';
const W = '/api/v1/workers/me';
const A = '/api/v1/admin';

interface Step {
  key: string;
  done: boolean;
  required: boolean;
  missing: string[];
}
interface WorkerProgress {
  profileStatus: string;
  verificationLevel: string;
  steps: Step[];
  nextStep: string | null;
  canReceiveJobs: boolean;
  actionRequired: string[];
}
interface CustomerProgress {
  profileCreated: boolean;
  steps: Step[];
  nextStep: string | null;
  verificationStatus: string | null;
  canBook: boolean;
}

/**
 * Multi-screen onboarding for both apps: every screen saves its own step, the app reads one progress endpoint after a restart or a new
 * session, and sensitive fields stay out of reach. Mobile screens themselves are not part of this repository (NOT_VERIFIED).
 */
describe('Onboarding, step by step (integration)', () => {
  let api: ApiApp;
  let admin: Awaited<ReturnType<typeof loginAdmin>>;
  let area: { id: string; name: string; city: string };

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

  // ------------------------------------------------------------------------------------------------------------
  describe('customer app: sign in, details, address, verification', () => {
    const progress = async (who: { accessToken: string }): Promise<CustomerProgress> =>
      (await as(api, who).get(`${C}/onboarding`)).body as CustomerProgress;

    it('walks the screens in order and the progress endpoint always names the next one', async () => {
      const who = await loginWithOtp(api, { appType: 'CUSTOMER' });
      // screen 1 (before anything is saved): the first answer is "profile", not an error
      let p = await progress(who);
      expect(p).toMatchObject({
        profileCreated: false,
        nextStep: 'PROFILE',
        canBook: false,
        verificationStatus: null,
      });
      expect(p.steps.map((s: { key: string }) => s.key)).toEqual([
        'PROFILE',
        'ADDRESS',
        'VERIFICATION',
      ]);
      expect((await as(api, who).get(C)).status).toBe(404); // no profile yet

      // screen 2: name, email, preferred language
      const email = `c.${unique()}@example.test`;
      const created = await as(api, who).post(C, {
        name: 'Asha Rao',
        email,
        preferredLanguage: 'hi',
      });
      expect(created.status).toBe(201);
      expect(created.body).toMatchObject({
        name: 'Asha Rao',
        email,
        preferredLanguage: 'hi',
        verificationStatus: 'PENDING',
      });
      p = await progress(who);
      expect(p).toMatchObject({
        profileCreated: true,
        nextStep: 'ADDRESS',
        canBook: false,
        verificationStatus: 'PENDING',
      });
      expect(p.steps[0]).toMatchObject({ key: 'PROFILE', done: true, missing: [] });
      expect(p.steps[1]).toMatchObject({ key: 'ADDRESS', done: false, missing: ['address'] });

      // screen 3: first address
      const address = await as(api, who).post(`${C}/addresses`, {
        line: '12 Lake View Road',
        area: area.name,
        city: area.city,
        pincode: '500081',
        isDefault: true,
      });
      expect(address.status).toBe(201);
      p = await progress(who);
      expect(p.steps[1]).toMatchObject({ key: 'ADDRESS', done: true });
      expect(p.canBook).toBe(true);
      // basic verification is automatic once profile + address exist (interim rule D-59); staff can override
      expect(p).toMatchObject({ verificationStatus: 'VERIFIED', nextStep: null });

      // the same answer from a brand-new session (app restart / sign-in on another device)
      const refreshed = await api
        .http()
        .post('/api/v1/auth/token/refresh')
        .send({ refreshToken: who.refreshToken })
        .expect(200);
      const again = await api
        .http()
        .get(`${C}/onboarding`)
        .set('Authorization', `Bearer ${refreshed.body.accessToken}`);
      expect(again.body).toEqual(p);
      expect(
        (await api.http().get(C).set('Authorization', `Bearer ${refreshed.body.accessToken}`)).body,
      ).toMatchObject({ name: 'Asha Rao', email, preferredLanguage: 'hi' });
    });

    it('validates each screen and refuses duplicates and protected fields', async () => {
      const who = await loginWithOtp(api, { appType: 'CUSTOMER' });
      const good = {
        name: 'Asha Rao',
        email: `c.${unique()}@example.test`,
        preferredLanguage: 'en',
      };
      for (const [field, bad] of [
        ['name', ''],
        ['name', '<script>'],
        ['name', 'x'.repeat(400)],
        ['email', 'not-an-email'],
        ['preferredLanguage', 'xx-unsupported'],
        ['email', undefined],
      ] as const) {
        const res = await as(api, who).post(C, { ...good, [field]: bad });
        expect([field, res.status, res.body.code]).toEqual([field, 400, 'VALIDATION_FAILED']);
      }
      expect((await progress(who)).profileCreated).toBe(false); // nothing was saved
      await as(api, who).post(C, good).expect(201);
      const dup = await as(api, who).post(C, good);
      expect(dup.status).toBe(409);
      expect(dup.body.code).toBe('CUSTOMER_PROFILE_EXISTS');
      // fields the app must never set
      const before = (await as(api, who).get(C)).body;
      for (const protectedField of [
        { verificationStatus: 'VERIFIED' },
        { mobile: '9999999999' },
        { userId: 'x' },
        { id: 'x' },
      ]) {
        // unknown / protected properties are stripped by the whitelist: the edit succeeds but the protected value never changes
        expect(
          (await as(api, who).patch(C, { name: 'Valid Name', ...protectedField })).status,
        ).toBe(200);
      }
      const after = (await as(api, who).get(C)).body;
      expect(after).toMatchObject({
        verificationStatus: before.verificationStatus,
        mobile: before.mobile,
        id: before.id,
        name: 'Valid Name',
      });
      expect((await as(api, who).patch(C, {})).status).toBe(400);
      // partial edit: only what is sent changes
      const edited = await as(api, who).patch(C, { name: 'New Name' });
      expect(edited.body).toMatchObject({
        name: 'New Name',
        email: good.email,
        preferredLanguage: 'en',
      });
      // address screen validation
      for (const bad of [{ pincode: '12' }, { line: '' }, { city: '' }, { latitude: 12.9 }]) {
        expect(
          (
            await as(api, who).post(`${C}/addresses`, {
              line: '1 Road',
              area: area.name,
              city: area.city,
              pincode: '500081',
              ...bad,
            })
          ).status,
        ).toBe(400);
      }
      expect((await progress(who)).steps[1].done).toBe(false);
    });

    it('keeps the default address consistent and the address private to its owner', async () => {
      const who = await loginWithOtp(api, { appType: 'CUSTOMER' });
      const other = await loginWithOtp(api, { appType: 'CUSTOMER' });
      for (const s of [who, other])
        await as(api, s)
          .post(C, {
            name: 'Asha Rao',
            email: `c.${unique()}@example.test`,
            preferredLanguage: 'en',
          })
          .expect(201);
      const make = async (line: string, isDefault: boolean) =>
        (
          await as(api, who)
            .post(`${C}/addresses`, {
              line,
              area: area.name,
              city: area.city,
              pincode: '500081',
              isDefault,
            })
            .expect(201)
        ).body.id as string;
      const first = await make('1 First Road', true);
      const second = await make('2 Second Road', false);
      expect(
        (
          (await as(api, who).get(`${C}/addresses`)).body as Array<{
            id: string;
            isDefault: boolean;
          }>
        )
          .filter((a) => a.isDefault)
          .map((a) => a.id),
      ).toEqual([first]);
      await as(api, who).put(`${C}/addresses/${second}/default`).expect(200);
      expect(
        (
          (await as(api, who).get(`${C}/addresses`)).body as Array<{
            id: string;
            isDefault: boolean;
          }>
        )
          .filter((a) => a.isDefault)
          .map((a) => a.id),
      ).toEqual([second]);
      expect((await as(api, other).get(`${C}/addresses/${first}`)).status).toBe(404);
      expect(
        (await as(api, other).patch(`${C}/addresses/${first}`, { line: 'hijack' })).status,
      ).toBe(404);
      expect((await as(api, other).delete(`${C}/addresses/${first}`)).status).toBe(404);
      await as(api, who).delete(`${C}/addresses/${first}`).expect(204);
      await as(api, who).delete(`${C}/addresses/${second}`).expect(204);
      expect((await progress(who)).canBook).toBe(false); // the last address is gone: booking is blocked again
    });

    it('is closed to the wrong role and to a suspended customer; unauthenticated callers get 401', async () => {
      const who = await loginWithOtp(api, { appType: 'CUSTOMER' });
      await as(api, who)
        .post(C, { name: 'Asha Rao', email: `c.${unique()}@example.test`, preferredLanguage: 'en' })
        .expect(201);
      const worker = await loginWithOtp(api, { appType: 'WORKER' });
      expect((await as(api, worker).get(`${C}/onboarding`)).status).toBe(403);
      expect((await api.http().get(`${C}/onboarding`)).status).toBe(401);
      await as(api, admin)
        .patch(`${A}/users/${who.userId}/status`, { status: 'SUSPENDED', reason: 'test' })
        .expect(200);
      for (const call of [
        () => as(api, who).get(`${C}/onboarding`),
        () => as(api, who).patch(C, { name: 'Valid Name' }),
        () =>
          as(api, who).post(`${C}/addresses`, {
            line: '1 Road',
            area: area.name,
            city: area.city,
            pincode: '500081',
          }),
      ]) {
        const res = await call();
        expect([res.status, res.body.code]).toEqual([403, 'ACCOUNT_SUSPENDED']);
      }
    });
  });

  // ------------------------------------------------------------------------------------------------------------
  describe('worker app: profile, work, availability, photo, documents, submit, verification', () => {
    const state = async (who: { accessToken: string }): Promise<WorkerProgress> =>
      (await as(api, who).get(`${W}/onboarding`)).body as WorkerProgress;
    const step = (p: { steps: Step[] }, key: string) => p.steps.find((s) => s.key === key)!;

    it('saves each screen on its own, resumes after a new session, and reaches VERIFIED only after staff approval', async () => {
      const who = await loginWithOtp(api, { appType: 'WORKER' });
      // before the first screen is saved the profile does not exist
      expect((await as(api, who).get(`${W}/onboarding`)).status).toBe(404);
      expect((await as(api, who).get(W)).status).toBe(404);

      // screen 1: name (creates the draft)
      const created = await as(api, who).post(W, { name: 'Ramesh Kumar' });
      expect(created.status).toBe(201);
      let p = await state(who);
      expect(p).toMatchObject({
        profileStatus: 'DRAFT',
        verificationLevel: 'NOT_STARTED',
        nextStep: 'PROFILE',
        canReceiveJobs: false,
      });
      expect(step(p, 'PROFILE').missing).toEqual(
        expect.arrayContaining(['address', 'emergencyContact']),
      );
      expect(step(p, 'WORK').missing).toEqual(
        expect.arrayContaining(['categories', 'languages', 'experience']),
      );
      expect(step(p, 'AVAILABILITY').done).toBe(false);

      // screen 2: address, emergency contact, previous employer / references
      await as(api, who)
        .patch(W, {
          address: { line: '1 Main Rd', area: 'Madhapur', city: 'Hyderabad', pincode: '500081' },
          emergencyContact: { name: 'Lakshmi Devi', mobile: '9876543210' },
          previousEmployer: { name: 'Mrs Rao', mobile: '9876500000' },
        })
        .expect(200);
      await as(api, who)
        .put(`${W}/references`, {
          references: [{ name: 'Mr Sharma', mobile: '9876511111', relationship: 'Neighbour' }],
        })
        .expect(200);
      p = await state(who);
      expect(step(p, 'PROFILE')).toMatchObject({ done: true, missing: [] });
      expect(p.nextStep).toBe('WORK');
      // what was saved is returned on the next read (read-after-write, same data in a new session)
      const profile = (await as(api, who).get(W)).body;
      expect(profile.address).toMatchObject({ city: 'Hyderabad', pincode: '500081' });
      expect(profile.emergencyContact).toMatchObject({ name: 'Lakshmi Devi' });
      expect(profile.previousEmployer).toMatchObject({ name: 'Mrs Rao' });

      // screen 3: roles, languages, experience, expected salary
      await as(api, who)
        .put(`${W}/categories`, {
          categoryIds: [
            (await api.prisma.serviceCategory.findFirstOrThrow({ where: { code: 'HOUSE_MAID' } }))
              .id,
          ],
        })
        .expect(200);
      await as(api, who)
        .patch(W, { languages: ['en', 'hi'], experienceMonths: 36, expectedSalary: 18000 })
        .expect(200);
      p = await state(who);
      expect(step(p, 'WORK')).toMatchObject({ done: true, missing: [] });
      expect(p.nextStep).toBe('AVAILABILITY');

      // screen 4: engagement preference, areas, time windows
      await as(api, who)
        .patch(`${W}/availability`, {
          engagementPreference: 'PART_TIME',
          areaIds: [area.id],
          timeWindows: [{ start: '08:00', end: '14:00' }],
        })
        .expect(200);
      p = await state(who);
      expect(step(p, 'AVAILABILITY')).toMatchObject({ done: true, missing: [] });
      // the photo is optional for submission, so the next required screen is the submit screen
      expect(p.nextStep).toBe('SUBMIT');
      expect(step(p, 'PHOTO')).toMatchObject({ done: false, required: false, missing: ['photo'] });

      // screen 5: photo
      const photo = await as(api, who)
        .post(`${W}/photo`, { contentType: 'image/jpeg', sizeBytes: 5000 })
        .expect(201);
      api.storage.simulateUpload(api.storage.issuedUploads.at(-1)!.objectKey, 5000, SAMPLE_JPEG);
      await as(api, who).post(`${W}/photo/${photo.body.photoId}/confirm`).expect(200);
      p = await state(who);
      expect(step(p, 'PHOTO').done).toBe(true);
      expect(p.nextStep).toBe('SUBMIT');
      // documents cannot start before the profile is submitted
      expect(step(p, 'DOCUMENTS').missing).toEqual([]);
      const early = await as(api, who).post(`${W}/verification/checks/IDENTITY/documents`, {
        contentType: 'application/pdf',
        sizeBytes: 2000,
      });
      expect(early.status).toBe(422);
      expect(early.body.code).toBe('PROFILE_NOT_SUBMITTED');

      // screen 6: final submit; repeating it changes nothing
      const submitted = await as(api, who).post(`${W}/submit`);
      expect(submitted.status).toBe(200);
      expect(submitted.body.onboardingStatus).toBe('SUBMITTED');
      const submittedAt = submitted.body.submittedAt;
      expect((await as(api, who).post(`${W}/submit`)).body.submittedAt).toBe(submittedAt);

      // screen 7: identity document, then submit the check
      p = await state(who);
      expect(p.nextStep).toBe('DOCUMENTS');
      expect(step(p, 'DOCUMENTS').missing).toEqual(['IDENTITY']);
      await uploadDocument(api, who, 'IDENTITY');
      await as(api, who).post(`${W}/verification/checks/IDENTITY/submit`).expect(200);
      p = await state(who);
      expect(step(p, 'DOCUMENTS').done).toBe(true);
      expect(p).toMatchObject({
        profileStatus: 'SUBMITTED',
        verificationLevel: 'IN_PROGRESS',
        canReceiveJobs: false,
      });
      expect(p.nextStep).toBe('VERIFICATION');

      // resume with a new session: identical answer
      const refreshed = await api
        .http()
        .post('/api/v1/auth/token/refresh')
        .send({ refreshToken: who.refreshToken })
        .expect(200);
      const resumed = await api
        .http()
        .get(`${W}/onboarding`)
        .set('Authorization', `Bearer ${refreshed.body.accessToken}`);
      expect(resumed.body).toEqual(p);

      expect(step(p, 'SUBMIT').done).toBe(true);

      // staff review: approve -> verified and visible to customers
      const checkId = await checkIdOf(
        api,
        admin,
        (await as(api, who).get(W)).body.id as string,
        'IDENTITY',
      );
      await as(api, admin).post(`${A}/verification/checks/${checkId}/start-review`).expect(200);
      await as(api, admin).post(`${A}/verification/checks/${checkId}/approve`, {}).expect(200);
      p = await state(who);
      expect(p).toMatchObject({
        verificationLevel: 'VERIFIED',
        canReceiveJobs: true,
        nextStep: null,
      });
      expect(step(p, 'VERIFICATION').done).toBe(true);
    });

    it('shows a rejected document as an action for the worker and accepts a resubmission', async () => {
      const who = await onboardWorker(api, { areaIds: [area.id] });
      await uploadDocument(api, who, 'IDENTITY');
      await as(api, who).post(`${W}/verification/checks/IDENTITY/submit`).expect(200);
      const workerId = (await as(api, who).get(W)).body.id as string;
      const checkId = await checkIdOf(api, admin, workerId, 'IDENTITY');
      await as(api, admin).post(`${A}/verification/checks/${checkId}/start-review`).expect(200);
      await as(api, admin)
        .post(`${A}/verification/checks/${checkId}/reject`, {
          reasonCode: 'OTHER',
          remarks: 'Photo is blurred',
        })
        .expect(200);
      const p = await state(who);
      expect(p.actionRequired).toEqual(['IDENTITY']);
      expect(step(p, 'DOCUMENTS')).toMatchObject({ done: false, missing: ['IDENTITY'] });
      const check = (await as(api, who).get(`${W}/verification`)).body.checks.find(
        (c: { checkType: string }) => c.checkType === 'IDENTITY',
      );
      expect(check).toMatchObject({ status: 'REJECTED', remarks: 'Photo is blurred' });
      await uploadDocument(api, who, 'IDENTITY');
      await as(api, who).post(`${W}/verification/checks/IDENTITY/submit`).expect(200);
      expect((await state(who)).actionRequired).toEqual([]);
    });

    it('refuses an incomplete submission with the exact missing fields, and protects fields only staff set', async () => {
      const who = await loginWithOtp(api, { appType: 'WORKER' });
      await as(api, who).post(W, { name: 'Ramesh Kumar' }).expect(201);
      const early = await as(api, who).post(`${W}/submit`);
      expect(early.status).toBe(422);
      expect(early.body.code).toBe('PROFILE_INCOMPLETE');
      expect(early.body.details[0].messages).toEqual(
        expect.arrayContaining([
          'address',
          'emergencyContact',
          'categories',
          'languages',
          'experience',
        ]),
      );
      expect((await state(who)).profileStatus).toBe('DRAFT');
      const draft = (await as(api, who).get(W)).body;
      for (const protectedField of [
        { onboardingStatus: 'SUBMITTED' },
        { userId: 'x' },
        { profilePhotoRef: 'k' },
        { submittedAt: '2026-01-01' },
        { mobile: '9999999999' },
      ]) {
        // stripped by the whitelist: the edit succeeds, the protected value never changes
        expect(
          (await as(api, who).patch(W, { name: 'Valid Name', ...protectedField })).status,
        ).toBe(200);
      }
      const kept = (await as(api, who).get(W)).body;
      expect(kept).toMatchObject({
        onboardingStatus: 'DRAFT',
        mobile: draft.mobile,
        submittedAt: null,
        hasProfilePhoto: false,
      });
      for (const bad of [
        { experienceMonths: -1 },
        { experienceMonths: 5000 },
        { expectedSalary: 0 },
        { languages: ['zz-unsupported'] },
        { emergencyContact: { name: 'X', mobile: '123' } },
        { address: { line: 'x', area: 'y', city: 'z', pincode: '1' } },
      ]) {
        expect((await as(api, who).patch(W, bad)).status).toBe(400);
      }
      expect((await as(api, who).post(W, { name: 'Another' })).status).toBe(409); // a profile exists already
      expect((await as(api, who).put(`${W}/categories`, { categoryIds: [] })).status).toBe(400);
      expect(
        (
          await as(api, who).put(`${W}/categories`, {
            categoryIds: ['00000000-0000-7000-8000-000000000000'],
          })
        ).status,
      ).toBe(400);
      expect(
        (await as(api, who).patch(`${W}/availability`, { engagementPreference: 'SOMETIMES' }))
          .status,
      ).toBe(400);
      expect(
        (
          await as(api, who).patch(`${W}/availability`, {
            areaIds: ['00000000-0000-7000-8000-000000000000'],
          })
        ).status,
      ).toBeGreaterThanOrEqual(400);
      expect(
        (
          await as(api, who).patch(`${W}/availability`, {
            timeWindows: [{ start: '14:00', end: '08:00' }],
          })
        ).status,
      ).toBe(400);
    });

    it('is closed to the wrong role and to a suspended worker; parallel saves both land', async () => {
      const who = await loginWithOtp(api, { appType: 'WORKER' });
      await as(api, who).post(W, { name: 'Ramesh Kumar' }).expect(201);
      const customer = await loginWithOtp(api, { appType: 'CUSTOMER' });
      expect((await as(api, customer).get(`${W}/onboarding`)).status).toBe(403);
      expect((await api.http().get(`${W}/onboarding`)).status).toBe(401);
      const [a, b] = await Promise.all([
        as(api, who).patch(W, { languages: ['en'] }),
        as(api, who).patch(W, { experienceMonths: 12 }),
      ]);
      expect([a.status, b.status]).toEqual([200, 200]);
      const saved = (await as(api, who).get(W)).body;
      expect(saved.languages).toEqual(['en']);
      expect(saved.experienceMonths).toBe(12);
      await as(api, admin)
        .patch(`${A}/users/${who.userId}/status`, { status: 'SUSPENDED', reason: 'test' })
        .expect(200);
      for (const call of [
        () => as(api, who).get(`${W}/onboarding`),
        () => as(api, who).patch(W, { experienceMonths: 1 }),
        () => as(api, who).post(`${W}/submit`),
      ]) {
        const res = await call();
        expect([res.status, res.body.code]).toEqual([403, 'ACCOUNT_SUSPENDED']);
      }
    });
  });
});
