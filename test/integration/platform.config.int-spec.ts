import '../support/env-api-integration';
import {
  ApiApp,
  createApiApp,
  loginAdmin,
  loginAdminWithPermissions,
  loginWithOtp,
  unique,
} from '../support/api-app';
import { as } from '../support/workforce';

const SETTINGS = '/api/v1/admin/app-settings';
const TAGS = '/api/v1/admin/rating-tags';
const APP_CONFIG = '/api/v1/app-config';
const REFERENCE = '/api/v1/reference-data';

type Setting = { key: string; value: string | boolean | null; source: string };

/**
 * Values the apps receive come from the database and change without a deployment: the app start-up settings (GET /app-config)
 * and the rating tag catalogue (GET /reference-data). Staff with config.manage edit them; everyone else is refused.
 */
describe('Platform configuration (integration)', () => {
  let api: ApiApp;
  let admin: Awaited<ReturnType<typeof loginAdmin>>;

  beforeAll(async () => {
    api = await createApiApp();
    admin = await loginAdmin(api);
  });
  afterAll(async () => {
    await api.prisma.appSetting.deleteMany({});
    await api.close();
  });

  const settings = async (): Promise<Setting[]> =>
    (await as(api, admin).get(SETTINGS).expect(200)).body as Setting[];

  describe('permissions', () => {
    it('refuses anonymous callers, customers, workers and staff without config.manage; allows config.manage', async () => {
      const customer = await loginWithOtp(api, { appType: 'CUSTOMER' });
      const worker = await loginWithOtp(api, { appType: 'WORKER' });
      const noPermission = await loginAdminWithPermissions(api, ['category.manage']);
      const withPermission = await loginAdminWithPermissions(api, ['config.manage']);
      for (const route of [SETTINGS, TAGS]) {
        expect((await api.http().get(route)).status).toBe(401);
        expect((await as(api, customer).get(route)).status).toBe(403);
        expect((await as(api, worker).get(route)).status).toBe(403);
        expect((await as(api, noPermission).get(route)).status).toBe(403);
        expect((await as(api, withPermission).get(route)).status).toBe(200);
      }
      expect(
        (await as(api, noPermission).put(`${SETTINGS}/supportPhone`, { value: '+91 40 1234 5678' }))
          .status,
      ).toBe(403);
      expect(
        (
          await as(api, noPermission).post(TAGS, {
            code: 'NOPE',
            label: 'No',
            sentiment: 'POSITIVE',
          })
        ).status,
      ).toBe(403);
    });
  });

  describe('app settings', () => {
    afterEach(async () => {
      await api.prisma.appSetting.deleteMany({});
    });

    it('lists every setting with its source and starts from the deployment defaults', async () => {
      const list = await settings();
      expect(list.map((s) => s.key)).toEqual(
        expect.arrayContaining([
          'customerMinVersion',
          'workerStoreUrl',
          'maintenance',
          'supportPhone',
          'supportEmail',
          'refundPolicyText',
        ]),
      );
      for (const s of list) expect(['ENVIRONMENT', 'UNSET']).toContain(s.source);
    });

    it('serves a value set by staff on the very next /app-config call and falls back when cleared', async () => {
      const phone = `+91 40 ${String(Date.now()).slice(-8)}`;
      const set = await as(api, admin).put(`${SETTINGS}/supportPhone`, { value: phone });
      expect(set.status).toBe(200);
      expect(set.body).toMatchObject({ key: 'supportPhone', value: phone, source: 'DATABASE' });
      const during = await api.http().get(APP_CONFIG).expect(200);
      expect(during.body.support.phone).toBe(phone);

      const cleared = await as(api, admin).delete(`${SETTINGS}/supportPhone`);
      expect(cleared.status).toBe(200);
      expect(cleared.body.source).not.toBe('DATABASE');
      const after = await api.http().get(APP_CONFIG).expect(200);
      expect(after.body.support.phone).not.toBe(phone);
    });

    it('feeds update policy, maintenance flag and policy text from the database', async () => {
      await as(api, admin).put(`${SETTINGS}/customerMinVersion`, { value: '3.2.1' }).expect(200);
      await as(api, admin)
        .put(`${SETTINGS}/workerStoreUrl`, { value: 'https://store.example.test/worker' })
        .expect(200);
      await as(api, admin).put(`${SETTINGS}/maintenance`, { value: true }).expect(200);
      await as(api, admin)
        .put(`${SETTINGS}/refundPolicyText`, { value: 'Refunds follow the approved policy.' })
        .expect(200);
      const body = (await api.http().get(APP_CONFIG).expect(200)).body;
      expect(body.customer.minVersion).toBe('3.2.1');
      expect(body.worker.storeUrl).toBe('https://store.example.test/worker');
      expect(body.maintenance).toBe(true);
      expect(body.policy.refundText).toBe('Refunds follow the approved policy.');
    });

    it('validates type and format, and reports unknown keys', async () => {
      const put = (key: string, value: unknown) =>
        as(api, admin).put(`${SETTINGS}/${key}`, { value });
      for (const [key, value] of [
        ['customerMinVersion', '3.2'],
        ['customerMinVersion', 5],
        ['workerStoreUrl', 'http://insecure.example.test'],
        ['supportEmail', 'not-an-email'],
        ['supportPhone', 'call me'],
        ['maintenance', 'yes'],
        ['refundPolicyText', '   '],
        ['refundPolicyText', 'x'.repeat(4001)],
      ] as const) {
        const res = await put(key, value);
        expect([key, res.status, res.body.code]).toEqual([key, 422, 'SETTING_VALUE_INVALID']);
      }
      const unknown = await put('notASetting', 'x');
      expect(unknown.status).toBe(404);
      expect(unknown.body.code).toBe('SETTING_UNKNOWN');
      expect((await as(api, admin).put(`${SETTINGS}/supportPhone`, {})).status).toBe(400);
      expect(await api.prisma.appSetting.count()).toBe(0);
    });

    it('audits every change with the key only', async () => {
      await as(api, admin)
        .put(`${SETTINGS}/supportEmail`, { value: 'help@example.test' })
        .expect(200);
      await as(api, admin).delete(`${SETTINGS}/supportEmail`).expect(200);
      const rows = await api.prisma.auditLog.findMany({
        where: { actorId: admin.userId, entityType: 'app_setting', entityId: 'supportEmail' },
        orderBy: { createdAt: 'asc' },
      });
      expect(rows.map((r) => r.action)).toEqual(['app_setting.set', 'app_setting.clear']);
      expect(JSON.stringify(rows.map((r) => r.metadata))).not.toContain('help@example.test');
    });
  });

  describe('rating tags', () => {
    it('are created by staff, offered to customers at once, reordered, retired and never deleted', async () => {
      const code = `T_${unique().toUpperCase()}`.slice(0, 20);
      const created = await as(api, admin).post(TAGS, {
        code,
        label: 'Very kind',
        sentiment: 'POSITIVE',
        sortOrder: 5,
      });
      expect(created.status).toBe(201);
      expect(created.body).toMatchObject({ code, label: 'Very kind', isActive: true });
      expect(
        (await as(api, admin).post(TAGS, { code, label: 'x', sentiment: 'NEGATIVE' })).status,
      ).toBe(409);

      const offered = async (): Promise<Array<{ code: string; label: string }>> =>
        (
          (await api.http().get(REFERENCE).expect(200)).body as {
            ratingTags: Array<{ code: string; label: string }>;
          }
        ).ratingTags;
      expect((await offered()).find((t) => t.code === code)).toMatchObject({ label: 'Very kind' });

      const renamed = await as(api, admin).patch(`${TAGS}/${code}`, { label: 'Kind and patient' });
      expect(renamed.status).toBe(200);
      expect((await offered()).find((t) => t.code === code)?.label).toBe('Kind and patient');

      await as(api, admin).patch(`${TAGS}/${code}`, { isActive: false }).expect(200);
      expect((await offered()).find((t) => t.code === code)).toBeUndefined();
      const all = (await as(api, admin).get(TAGS).expect(200)).body as Array<{
        code: string;
        isActive: boolean;
      }>;
      expect(all.find((t) => t.code === code)).toMatchObject({ isActive: false });
    });

    it('validates input and reports unknown tags and empty changes', async () => {
      for (const body of [
        { code: 'lower', label: 'x', sentiment: 'POSITIVE' },
        { code: 'OK_CODE', label: '', sentiment: 'POSITIVE' },
        { code: 'OK_CODE', label: 'x', sentiment: 'NEUTRAL' },
        { code: 'OK_CODE', label: 'x', sentiment: 'POSITIVE', sortOrder: -1 },
      ]) {
        expect((await as(api, admin).post(TAGS, body)).status).toBe(400);
      }
      const missing = await as(api, admin).patch(`${TAGS}/NO_SUCH_TAG`, { label: 'x' });
      expect(missing.status).toBe(404);
      expect(missing.body.code).toBe('RATING_TAG_NOT_FOUND');
      expect((await as(api, admin).patch(`${TAGS}/NO_SUCH_TAG`, {})).status).toBe(400);
    });

    it('audits create and update', async () => {
      const code = `A_${unique().toUpperCase()}`.slice(0, 20);
      await as(api, admin)
        .post(TAGS, { code, label: 'Audited', sentiment: 'NEGATIVE' })
        .expect(201);
      await as(api, admin).patch(`${TAGS}/${code}`, { sortOrder: 9 }).expect(200);
      const rows = await api.prisma.auditLog.findMany({
        where: { entityType: 'rating_tag', entityId: code },
        orderBy: { createdAt: 'asc' },
      });
      expect(rows.map((r) => r.action)).toEqual(['rating_tag.create', 'rating_tag.update']);
    });
  });
});
