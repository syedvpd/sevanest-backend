import '../support/env-api-integration';
import { ApiApp, bearer, createApiApp, loginAdmin, loginWithOtp, unique } from '../support/api-app';
import { InMemoryStorageProvider } from '../../src/integrations/storage/in-memory-storage.provider';
import {
  PUBLIC_MEDIA_STORAGE,
  type PublicMediaStorage,
} from '../../src/integrations/storage/public-media.storage';
import { SAMPLE_JPEG, SAMPLE_PNG } from '../support/images';
import { as, onboardWorker } from '../support/workforce';

const BASE = 'https://media.example.test/public/seva';
const PHOTO = '/api/v1/workers/me/photo';
const CATEGORIES = '/api/v1/admin/service-categories';

interface CategoryBody {
  id: string;
  image: { url: string; largeUrl: string; cacheKey: string } | null;
}

/** D-93: worker photos and category images get permanent public links; everything else stays private. */
describe('Public image storage (integration)', () => {
  let api: ApiApp;
  let admin: Awaited<ReturnType<typeof loginAdmin>>;
  let publicFiles: InMemoryStorageProvider;

  beforeAll(async () => {
    process.env.STORAGE_PUBLIC_BASE_URL = BASE;
    api = await createApiApp();
    admin = await loginAdmin(api);
    publicFiles = api.app.get<PublicMediaStorage>(PUBLIC_MEDIA_STORAGE)
      .provider as InMemoryStorageProvider;
  });
  afterAll(async () => {
    delete process.env.STORAGE_PUBLIC_BASE_URL;
    await api.close();
  });

  describe('worker photo', () => {
    it('writes WebP renditions to the public bucket and answers permanent links; the original is removed', async () => {
      const worker = await onboardWorker(api, { submit: false });
      const created = await as(api, worker).post(PHOTO, {
        contentType: 'image/jpeg',
        sizeBytes: 5000,
      });
      expect(created.status).toBe(201);
      const { photoId } = created.body as { photoId: string };
      const original = api.storage.issuedUploads.at(-1)!.objectKey;
      api.storage.simulateUpload(original, 5000, SAMPLE_JPEG);
      expect((await as(api, worker).post(`${PHOTO}/${photoId}/confirm`)).status).toBe(200);

      const mine = await as(api, worker).get(PHOTO);
      expect(mine.status).toBe(200);
      const link = mine.body as { url: string; largeUrl: string; cacheKey: string };
      expect(link.url).toBe(`${BASE}/pub/${original}.card.webp`);
      expect(link.largeUrl).toBe(`${BASE}/pub/${original}.large.webp`);
      expect(link.url).not.toMatch(/sig|signature|expires/i);
      expect(link.cacheKey).toBe(photoId);

      expect(publicFiles.has(`pub/${original}.card.webp`)).toBe(true);
      expect(publicFiles.contentTypeOf(`pub/${original}.card.webp`)).toBe('image/webp');
      expect(api.storage.has(`pub/${original}.card.webp`)).toBe(false);
      expect(api.storage.has(original)).toBe(false);
    });
  });

  describe('category image', () => {
    const upload = (
      id: string,
      file: Buffer,
      contentType: string,
      caller: { accessToken: string } = admin,
    ) =>
      api
        .http()
        .put(`${CATEGORIES}/${id}/image`)
        .set('Authorization', bearer(caller))
        .attach('file', file, { filename: 'icon', contentType });

    async function newCategory(): Promise<string> {
      const res = await as(api, admin).post(CATEGORIES, {
        code: `IMG_${unique().toUpperCase()}`,
        name: `Image ${unique()}`,
      });
      expect(res.status).toBe(201);
      expect((res.body as CategoryBody).image).toBeNull();
      return (res.body as CategoryBody).id;
    }

    it('sets, shows to customers, replaces (old files removed) and removes an image', async () => {
      const id = await newCategory();
      const first = await upload(id, SAMPLE_PNG, 'image/png');
      expect(first.status).toBe(200);
      const one = (first.body as CategoryBody).image!;
      expect(one.url).toMatch(
        new RegExp(`^${BASE}/pub/categories/${id}/[0-9a-f-]{36}\\.card\\.webp$`),
      );
      expect(one.largeUrl.endsWith('.large.webp')).toBe(true);

      const customer = await loginWithOtp(api, { appType: 'CUSTOMER' });
      const seen = await as(api, customer).get(`/api/v1/service-categories/${id}`);
      expect((seen.body as CategoryBody).image).toEqual(one);

      const second = await upload(id, SAMPLE_JPEG, 'image/jpeg');
      expect(second.status).toBe(200);
      const two = (second.body as CategoryBody).image!;
      expect(two.cacheKey).not.toBe(one.cacheKey);
      const oldKey = new URL(one.url).pathname.replace('/public/seva/', '');
      expect(publicFiles.has(oldKey)).toBe(false);
      expect(publicFiles.has(new URL(two.url).pathname.replace('/public/seva/', ''))).toBe(true);

      const removed = await as(api, admin).delete(`${CATEGORIES}/${id}/image`);
      expect(removed.status).toBe(200);
      expect((removed.body as CategoryBody).image).toBeNull();
      expect((await as(api, admin).delete(`${CATEGORIES}/${id}/image`)).status).toBe(200);
      expect(
        await api.prisma.auditLog.count({
          where: {
            entityId: id,
            action: { in: ['service_category.image_set', 'service_category.image_removed'] },
          },
        }),
      ).toBe(3);
    });

    it('refuses a missing file, a wrong type, a fake image and a too-large file', async () => {
      const id = await newCategory();
      const none = await api
        .http()
        .put(`${CATEGORIES}/${id}/image`)
        .set('Authorization', bearer(admin));
      expect(none.status).toBe(400);
      const gif = await upload(id, Buffer.from('GIF89a'), 'image/gif');
      expect(gif.status).toBe(422);
      expect((gif.body as { code: string }).code).toBe('IMAGE_TYPE_NOT_ALLOWED');
      const fake = await upload(id, Buffer.from('<html><script>alert(1)</script>'), 'image/jpeg');
      expect(fake.status).toBe(422);
      expect((fake.body as { code: string }).code).toBe('IMAGE_CONTENT_MISMATCH');
      const huge = await upload(id, Buffer.alloc(5_300_000, 1), 'image/png');
      expect(huge.status).toBe(413);
      expect((await as(api, admin).get(`${CATEGORIES}/${id}`)).body).toMatchObject({ image: null });
    });

    it('is admin-only and needs a known category', async () => {
      const id = await newCategory();
      const customer = await loginWithOtp(api, { appType: 'CUSTOMER' });
      expect((await upload(id, SAMPLE_PNG, 'image/png', customer)).status).toBe(403);
      expect(
        (await api.http().put(`${CATEGORIES}/${id}/image`).attach('file', SAMPLE_PNG, 'a.png'))
          .status,
      ).toBe(401);
      const unknown = await upload('00000000-0000-7000-8000-000000000000', SAMPLE_PNG, 'image/png');
      expect(unknown.status).toBe(404);
    });
  });
});
