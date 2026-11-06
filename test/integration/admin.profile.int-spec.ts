import '../support/env-api-integration';
import { randomInt } from 'node:crypto';
import sharp from 'sharp';
import { ApiApp, bearer, createApiApp, loginAdmin, loginWithOtp, unique } from '../support/api-app';
import { SAMPLE_JPEG, SAMPLE_PNG } from '../support/images';
import { as } from '../support/workforce';

const PROFILE = '/api/v1/admin/me/profile';
const PHOTO = '/api/v1/admin/me/profile-photo';

/**
 * The admin portal's "My Account": profile retrieval, partial update and direct photo upload. Runs against the real
 * PostgreSQL + Redis (dedicated test database) and the in-memory storage adapter; no real provider is called.
 */
describe('Admin self-service profile (integration)', () => {
  let api: ApiApp;
  let webp: Buffer;

  beforeAll(async () => {
    api = await createApiApp();
    webp = await sharp({
      create: { width: 24, height: 24, channels: 3, background: { r: 10, g: 20, b: 30 } },
    })
      .webp()
      .toBuffer();
  });
  afterAll(async () => {
    await api.close();
  });

  const upload = (
    caller: { accessToken: string },
    bytes: Buffer,
    contentType: string,
    filename = 'photo',
  ) =>
    api
      .http()
      .post(PHOTO)
      .set('Authorization', bearer(caller))
      .attach('file', bytes, { filename, contentType });

  const newAdmin = () => loginAdmin(api);

  describe('authentication and authorization', () => {
    it('rejects every route without a token', async () => {
      expect((await api.http().get(PROFILE)).status).toBe(401);
      expect((await api.http().patch(PROFILE).send({ fullName: 'Nobody' })).status).toBe(401);
      expect((await api.http().post(PHOTO).attach('file', SAMPLE_PNG, 'a.png')).status).toBe(401);
    });

    it('is admin-only: a signed-in customer is refused', async () => {
      const customer = await loginWithOtp(api, { appType: 'CUSTOMER' });
      expect((await as(api, customer).get(PROFILE)).status).toBe(403);
      expect((await as(api, customer).patch(PROFILE, { fullName: 'Nope' })).status).toBe(403);
      expect((await upload(customer, SAMPLE_PNG, 'image/png')).status).toBe(403);
    });
  });

  describe('profile retrieval', () => {
    it('returns only the authenticated admin, with null name/photo until set', async () => {
      const admin = await newAdmin();
      const res = await as(api, admin).get(PROFILE);
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({
        id: admin.userId,
        email: admin.email,
        fullName: null,
        photo: null,
        status: 'ACTIVE',
        roles: ['SUPER_ADMIN'],
        role: 'SUPER_ADMIN',
      });
      expect(res.body).not.toHaveProperty('passwordHash');
      expect(res.body).not.toHaveProperty('permissions');
    });
  });

  describe('profile update', () => {
    it('updates the name without touching omitted fields', async () => {
      const admin = await newAdmin();
      const res = await as(api, admin).patch(PROFILE, { fullName: 'Priya Sharma' });
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ fullName: 'Priya Sharma', email: admin.email });

      const reread = await as(api, admin).get(PROFILE);
      expect(reread.body).toMatchObject({ fullName: 'Priya Sharma', email: admin.email });
      const row = await api.prisma.adminProfile.findUnique({ where: { userId: admin.userId } });
      expect(row?.fullName).toBe('Priya Sharma');
    });

    it('updates the e-mail (lower-cased, trimmed) and the phone (stored as E.164)', async () => {
      const admin = await newAdmin();
      const email = `Changed.${unique()}@Example.Test`.toLowerCase();
      const phone = `+919${String(randomInt(0, 1e9)).padStart(9, '0')}`;
      const res = await as(api, admin).patch(PROFILE, {
        email: `  ${email.toUpperCase()}  `,
        phoneNumber: phone.slice(3),
      });
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ email, phoneNumber: phone });

      const reread = await as(api, admin).get(PROFILE);
      expect(reread.body).toMatchObject({ email, phoneNumber: phone });
    });

    it('rejects an e-mail or phone already used by another account', async () => {
      const owner = await newAdmin();
      const other = await newAdmin();
      const phone = `+919${String(randomInt(0, 1e9)).padStart(9, '0')}`;
      await as(api, owner).patch(PROFILE, { phoneNumber: phone }).expect(200);

      const email = await as(api, other)
        .patch(PROFILE, { email: owner.email.toUpperCase() })
        .expect(409);
      expect(email.body.code).toBe('ADMIN_EMAIL_TAKEN');

      const phoneConflict = await as(api, other).patch(PROFILE, { phoneNumber: phone }).expect(409);
      expect(phoneConflict.body.code).toBe('ADMIN_PHONE_TAKEN');

      // the failed attempts changed nothing
      expect((await as(api, other).get(PROFILE)).body).toMatchObject({
        email: other.email,
        phoneNumber: null,
      });
    });

    it('rejects empty and malformed values', async () => {
      const admin = await newAdmin();
      const cases = [
        { fullName: '   ' },
        { fullName: '<script>alert(1)</script>' },
        { fullName: null },
        { email: 'not-an-email' },
        { email: '' },
        { phoneNumber: '12345' },
        { phoneNumber: '+15551234567' },
      ];
      for (const body of cases) {
        const res = await as(api, admin).patch(PROFILE, body);
        expect({ body, status: res.status }).toEqual({ body, status: 400 });
        expect(res.body.code).toBe('VALIDATION_FAILED');
      }
    });

    it('requires at least one field', async () => {
      const admin = await newAdmin();
      const res = await as(api, admin).patch(PROFILE, {});
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('VALIDATION_FAILED');
    });

    it('cannot change role, status, password or another account, and no target id is accepted', async () => {
      const actor = await newAdmin();
      const victim = await newAdmin();
      const res = await as(api, actor).patch(PROFILE, {
        fullName: 'Actor Name',
        role: 'SUPPORT_EXECUTIVE',
        roles: ['SUPPORT_EXECUTIVE'],
        status: 'SUSPENDED',
        password: 'A-new-password-123',
        userId: victim.userId,
      });
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({
        id: actor.userId,
        fullName: 'Actor Name',
        role: 'SUPER_ADMIN',
        roles: ['SUPER_ADMIN'],
        status: 'ACTIVE',
      });

      const victimProfile = await as(api, victim).get(PROFILE);
      expect(victimProfile.body).toMatchObject({ id: victim.userId, fullName: null });
      expect((await api.prisma.user.findUnique({ where: { id: actor.userId } }))?.status).toBe(
        'ACTIVE',
      );
    });

    it('audits the change without storing the e-mail or phone in metadata', async () => {
      const admin = await newAdmin();
      await as(api, admin)
        .patch(PROFILE, { fullName: 'Audited Name', email: `audit.${unique()}@example.test` })
        .expect(200);
      const entry = await api.prisma.auditLog.findFirst({
        where: { action: 'admin.profile_update', entityId: admin.userId },
      });
      expect(entry).not.toBeNull();
      expect(entry?.actorId).toBe(admin.userId);
      expect(JSON.stringify(entry?.metadata)).not.toContain('@example.test');
    });
  });

  describe('profile photo', () => {
    it('accepts JPEG, PNG and WebP, persists the reference and returns signed links', async () => {
      const admin = await newAdmin();
      for (const [bytes, type] of [
        [SAMPLE_JPEG, 'image/jpeg'],
        [SAMPLE_PNG, 'image/png'],
        [webp, 'image/webp'],
      ] as const) {
        const res = await upload(admin, bytes, type);
        expect({ type, status: res.status, code: res.body.code }).toEqual({
          type,
          status: 200,
          code: undefined,
        });
        const photo = (res.body as { photo: { url: string; largeUrl: string } }).photo;
        expect(photo.url).toContain('memory://download/');
        expect(photo.largeUrl).toContain('memory://download/');

        const row = await api.prisma.adminProfile.findUnique({
          where: { userId: admin.userId },
        });
        expect(row?.photoCardKey).toBeTruthy();
        expect(row?.photoLargeKey).toBeTruthy();
        expect(api.storage.contentTypeOf(row!.photoCardKey!)).toBe('image/webp');
        expect(api.storage.has(row!.photoCardKey!)).toBe(true);

        const reread = await as(api, admin).get(PROFILE);
        expect(reread.body.photo).toMatchObject({ cacheKey: row!.photoCardKey });
      }
    });

    it('replaces the photo and removes the previous objects', async () => {
      const admin = await newAdmin();
      const first = await upload(admin, SAMPLE_JPEG, 'image/jpeg').expect(200);
      const firstKey = (first.body as { photo: { cacheKey: string } }).photo.cacheKey;

      const second = await upload(admin, SAMPLE_PNG, 'image/png').expect(200);
      const secondKey = (second.body as { photo: { cacheKey: string } }).photo.cacheKey;
      expect(secondKey).not.toBe(firstKey);
      expect(api.storage.has(firstKey)).toBe(false);
      expect(api.storage.has(secondKey)).toBe(true);
    });

    it('rejects a missing file, an unsupported type, a spoofed type and a truncated image', async () => {
      const admin = await newAdmin();
      const none = await api.http().post(PHOTO).set('Authorization', bearer(admin));
      expect(none.status).toBe(422);
      expect(none.body.code).toBe('ADMIN_PHOTO_REQUIRED');

      const gif = await upload(admin, Buffer.from('GIF89a-not-really'), 'image/gif');
      expect(gif.status).toBe(422);
      expect(gif.body.code).toBe('ADMIN_PHOTO_TYPE_NOT_ALLOWED');

      const spoofed = await upload(admin, SAMPLE_JPEG, 'image/png');
      expect(spoofed.status).toBe(422);
      expect(spoofed.body.code).toBe('ADMIN_PHOTO_CONTENT_MISMATCH');

      const truncated = await upload(admin, SAMPLE_JPEG.subarray(0, 100), 'image/jpeg');
      expect(truncated.status).toBe(422);
      expect(truncated.body.code).toBe('ADMIN_PHOTO_CONTENT_MISMATCH');

      expect((await as(api, admin).get(PROFILE)).body.photo).toBeNull();
    });

    it('rejects an image above the configured limit with 413', async () => {
      const admin = await newAdmin();
      const max = api.config.profilePhoto.maxBytes as number;
      const res = await upload(admin, Buffer.alloc(max + 1, 1), 'image/png');
      expect(res.status).toBe(413);
      expect((await as(api, admin).get(PROFILE)).body.photo).toBeNull();
    });

    it('keeps the current photo when storage fails, and writes nothing', async () => {
      const admin = await newAdmin();
      const before = await upload(admin, SAMPLE_JPEG, 'image/jpeg').expect(200);
      const cacheKey = (before.body as { photo: { cacheKey: string } }).photo.cacheKey;

      api.storage.failNextPut = true;
      const failed = await upload(admin, SAMPLE_PNG, 'image/png');
      expect(failed.status).toBe(503);
      expect(failed.body.code).toBe('ADMIN_PHOTO_STORAGE_UNAVAILABLE');

      const after = await as(api, admin).get(PROFILE);
      expect(after.body.photo).toMatchObject({ cacheKey });
      expect(api.storage.has(cacheKey)).toBe(true);
    });

    it("does not let one admin overwrite another admin's photo", async () => {
      const first = await newAdmin();
      const second = await newAdmin();
      const firstPhoto = await upload(first, SAMPLE_JPEG, 'image/jpeg').expect(200);
      const firstKey = (firstPhoto.body as { photo: { cacheKey: string } }).photo.cacheKey;

      await upload(second, SAMPLE_PNG, 'image/png').expect(200);

      expect((await as(api, first).get(PROFILE)).body.photo).toMatchObject({ cacheKey: firstKey });
      expect(api.storage.has(firstKey)).toBe(true);
    });
  });

  describe('published OpenAPI', () => {
    it('contains the three operations', async () => {
      const spec = (await api.http().get('/docs/openapi.json')).body as {
        paths: Record<string, Record<string, unknown>>;
      };
      expect(Object.keys(spec.paths[PROFILE])).toEqual(expect.arrayContaining(['get', 'patch']));
      expect(Object.keys(spec.paths[PHOTO])).toEqual(expect.arrayContaining(['post']));
      expect(spec.paths[PHOTO].post).toMatchObject({
        requestBody: { content: { 'multipart/form-data': expect.anything() } },
      });
    });
  });
});
