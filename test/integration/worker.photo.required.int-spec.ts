import '../support/env-api-integration';
import { ApiApp, createApiApp, loginAdmin } from '../support/api-app';
import { AppConfigService } from '../../src/config/app-config.service';
import { as, createArea, onboardWorker, setRequiredChecks } from '../support/workforce';

/** FM-04 / DEC-10: a worker cannot submit the profile for verification without a confirmed photo. */
describe('Profile photo required to submit (integration)', () => {
  let api: ApiApp;
  let area: { id: string };

  beforeAll(async () => {
    api = await createApiApp();
    const admin = await loginAdmin(api);
    area = await createArea(api, admin);
    await setRequiredChecks(api, admin, ['IDENTITY']);
  });
  afterAll(async () => {
    await api.close();
  });

  it('refuses the submit with 422 PHOTO_REQUIRED until a photo is confirmed, then accepts it', async () => {
    const worker = await onboardWorker(api, { areaIds: [area.id], submit: false });
    const spy = jest
      .spyOn(api.app.get(AppConfigService), 'profilePhotoRequired', 'get')
      .mockReturnValue(true);
    try {
      const draft = await as(api, worker).get('/api/v1/workers/me').expect(200);
      expect(draft.body.missingForSubmission).toContain('profilePhoto');

      const refused = await as(api, worker).post('/api/v1/workers/me/submit');
      expect(refused.status).toBe(422);
      expect(refused.body.code).toBe('PHOTO_REQUIRED');
      expect(
        (await api.prisma.workerProfile.findUniqueOrThrow({ where: { id: worker.workerId } }))
          .onboardingStatus,
      ).toBe('DRAFT');

      // the photo is confirmed (the upload flow itself is covered by the photo suite)
      await api.prisma.workerProfile.update({
        where: { id: worker.workerId },
        data: { profilePhotoRef: 'workers/test/photo.jpg' },
      });
      const done = await as(api, worker).post('/api/v1/workers/me/submit').expect(200);
      expect(done.body.onboardingStatus).toBe('SUBMITTED');
    } finally {
      spy.mockRestore();
    }
  });

  it('can be switched off by configuration (the rule is not hard-coded)', async () => {
    const worker = await onboardWorker(api, { areaIds: [area.id], submit: false });
    const spy = jest
      .spyOn(api.app.get(AppConfigService), 'profilePhotoRequired', 'get')
      .mockReturnValue(false);
    try {
      await as(api, worker).post('/api/v1/workers/me/submit').expect(200);
    } finally {
      spy.mockRestore();
    }
  });
});
