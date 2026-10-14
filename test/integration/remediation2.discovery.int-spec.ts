import '../support/env-api-integration';
import { ApiApp, createApiApp, loginAdmin, loginWithOtp } from '../support/api-app';
import { AppConfigService } from '../../src/config/app-config.service';
import {
  approveCheck,
  as,
  createArea,
  onboardWorker,
  OnboardedWorker,
  setRequiredChecks,
} from '../support/workforce';
import { SAMPLE_JPEG, SAMPLE_PNG } from '../support/images';
import {
  MALWARE_SCANNER,
  type MalwareScanner,
} from '../../src/integrations/malware/malware-scanner';

const PROFILE = '/api/v1/search/workers';
const SHORTLIST = '/api/v1/shortlist';
const PHOTO = '/api/v1/workers/me/photo';
const UNKNOWN_ID = '00000000-0000-7000-8000-000000000000';

/** Customer-safe profile, shortlist and worker photo against the real database (phase 2). */
describe('Worker profile, shortlist and photo (integration)', () => {
  let api: ApiApp;
  let admin: Awaited<ReturnType<typeof loginAdmin>>;
  let customer: Awaited<ReturnType<typeof loginWithOtp>>;
  let other: Awaited<ReturnType<typeof loginWithOtp>>;
  let area: { id: string };
  let visible: OnboardedWorker;
  let unverified: OnboardedWorker;
  let draft: OnboardedWorker;
  let suspended: OnboardedWorker;
  let expired: OnboardedWorker;

  const verify = (w: OnboardedWorker) => approveCheck(api, admin, w, 'IDENTITY');
  const make = (o: Parameters<typeof onboardWorker>[1] = {}) =>
    onboardWorker(api, { areaIds: [area.id], ...o });

  beforeAll(async () => {
    api = await createApiApp();
    admin = await loginAdmin(api);
    customer = await loginWithOtp(api, { appType: 'CUSTOMER' });
    other = await loginWithOtp(api, { appType: 'CUSTOMER' });
    area = await createArea(api, admin);
    await setRequiredChecks(api, admin, ['IDENTITY']);
    visible = await make({ name: 'Secret Private Name' });
    unverified = await make();
    draft = await make({ submit: false });
    suspended = await make();
    expired = await make();
    for (const w of [visible, suspended, expired]) await verify(w);
    await as(api, admin)
      .patch(`/api/v1/admin/users/${suspended.userId}/status`, { status: 'SUSPENDED' })
      .expect(200);
    await api.prisma
      .$executeRaw`UPDATE worker_verification_checks SET recheck_at = ((now() AT TIME ZONE 'Asia/Kolkata')::date) WHERE worker_id = ${expired.workerId}::uuid`;
  });
  afterAll(async () => {
    await setRequiredChecks(api, admin, []);
    await api.close();
  });

  describe('GET /search/workers/:workerId (customer-safe profile)', () => {
    it('returns the allow-listed fields only: no name, contact, salary or account id', async () => {
      const res = await as(api, customer).get(`${PROFILE}/${visible.workerId}`);
      expect(res.status).toBe(200);
      expect(Object.keys(res.body as object).sort()).toEqual(
        [
          'availability',
          'categories',
          'engagementPreference',
          'experienceMonths',
          'languages',
          'photo',
          'rating',
          'serviceAreas',
          'verification',
          'workerId',
        ].sort(),
      );
      const text = JSON.stringify(res.body);
      expect(text).not.toMatch(
        /Secret Private Name|1 Main Rd|Lakshmi|9876543210|18000|expectedSalary/,
      );
      expect(text).not.toContain(visible.userId);
      expect((res.body as { rating: unknown }).rating).toBeNull();
    });

    it('answers identically for unknown, draft, unverified, suspended and re-check-due workers', async () => {
      const bodies: unknown[] = [];
      for (const id of [
        UNKNOWN_ID,
        draft.workerId,
        unverified.workerId,
        suspended.workerId,
        expired.workerId,
      ]) {
        const res = await as(api, customer).get(`${PROFILE}/${id}`);
        expect(res.status).toBe(404);
        expect((res.body as { code: string }).code).toBe('WORKER_NOT_FOUND');
        bodies.push((res.body as { code: string; message: string }).message);
      }
      expect(new Set(bodies).size).toBe(1);
    });

    it('shows the rating aggregate and nothing about reviewers', async () => {
      await api.prisma.workerRatingSummary.create({
        data: { workerId: visible.workerId, ratingSum: 9, ratingCount: 2 },
      });
      const res = await as(api, customer).get(`${PROFILE}/${visible.workerId}`);
      expect((res.body as { rating: unknown }).rating).toEqual({ average: 4.5, count: 2 });
      await api.prisma.workerRatingSummary.delete({ where: { workerId: visible.workerId } });
    });

    it('rejects malformed ids, no token, a worker token and an admin token', async () => {
      expect((await as(api, customer).get(`${PROFILE}/not-a-uuid`)).status).toBe(400);
      expect((await api.http().get(`${PROFILE}/${visible.workerId}`)).status).toBe(401);
      expect((await as(api, visible).get(`${PROFILE}/${visible.workerId}`)).status).toBe(403);
      expect((await as(api, admin).get(`${PROFILE}/${visible.workerId}`)).status).toBe(403);
    });
  });

  describe('shortlist', () => {
    it('adds idempotently, lists the card, removes idempotently', async () => {
      expect((await as(api, customer).put(`${SHORTLIST}/${visible.workerId}`)).status).toBe(204);
      expect((await as(api, customer).put(`${SHORTLIST}/${visible.workerId}`)).status).toBe(204);
      const list = await as(api, customer).get(SHORTLIST);
      const body = list.body as {
        data: Array<{ workerId: string; available: boolean; worker: { workerId: string } | null }>;
        meta: { total: number };
      };
      expect(body.meta.total).toBe(1);
      expect(body.data[0]).toMatchObject({ workerId: visible.workerId, available: true });
      expect(body.data[0].worker?.workerId).toBe(visible.workerId);
      expect(JSON.stringify(list.body)).not.toMatch(/Secret Private Name/);
      expect((await as(api, customer).delete(`${SHORTLIST}/${visible.workerId}`)).status).toBe(204);
      expect((await as(api, customer).delete(`${SHORTLIST}/${visible.workerId}`)).status).toBe(204);
      expect(
        ((await as(api, customer).get(SHORTLIST)).body as { meta: { total: number } }).meta.total,
      ).toBe(0);
    });

    it('stores one row for parallel adds of the same worker', async () => {
      const results = await Promise.all(
        Array.from({ length: 10 }, () => as(api, customer).put(`${SHORTLIST}/${visible.workerId}`)),
      );
      expect(results.every((r) => r.status === 204)).toBe(true);
      expect(
        await api.prisma.customerShortlistItem.count({
          where: { customerUserId: customer.userId },
        }),
      ).toBe(1);
      await as(api, customer).delete(`${SHORTLIST}/${visible.workerId}`);
    });

    it('refuses workers customers cannot see with one identical answer, and bad ids', async () => {
      for (const id of [
        UNKNOWN_ID,
        draft.workerId,
        unverified.workerId,
        suspended.workerId,
        expired.workerId,
      ]) {
        const res = await as(api, customer).put(`${SHORTLIST}/${id}`);
        expect(res.status).toBe(404);
        expect((res.body as { code: string }).code).toBe('WORKER_NOT_FOUND');
      }
      expect((await as(api, customer).put(`${SHORTLIST}/nope`)).status).toBe(400);
      expect((await as(api, customer).delete(`${SHORTLIST}/nope`)).status).toBe(400);
      expect(
        await api.prisma.customerShortlistItem.count({
          where: { customerUserId: customer.userId },
        }),
      ).toBe(0);
    });

    it("never shows or changes another customer's shortlist", async () => {
      await as(api, customer).put(`${SHORTLIST}/${visible.workerId}`).expect(204);
      const theirs = await as(api, other).get(SHORTLIST);
      expect((theirs.body as { meta: { total: number } }).meta.total).toBe(0);
      // the other customer "removing" the same worker only touches their own (empty) list
      await as(api, other).delete(`${SHORTLIST}/${visible.workerId}`).expect(204);
      expect(
        await api.prisma.customerShortlistItem.count({
          where: { customerUserId: customer.userId },
        }),
      ).toBe(1);
    });

    it('keeps an entry whose worker stops being visible, marked unavailable, and lets it be removed', async () => {
      const gone = await make();
      await verify(gone);
      await as(api, customer).put(`${SHORTLIST}/${gone.workerId}`).expect(204);
      await as(api, admin)
        .patch(`/api/v1/admin/users/${gone.userId}/status`, { status: 'SUSPENDED' })
        .expect(200);
      const list = await as(api, customer).get(SHORTLIST);
      const items = (
        list.body as { data: Array<{ workerId: string; available: boolean; worker: unknown }> }
      ).data;
      const entry = items.find((i) => i.workerId === gone.workerId)!;
      expect(entry.available).toBe(false);
      expect(entry.worker).toBeNull();
      await as(api, customer).delete(`${SHORTLIST}/${gone.workerId}`).expect(204);
    });

    it('needs a customer token', async () => {
      expect((await api.http().get(SHORTLIST)).status).toBe(401);
      expect((await as(api, visible).get(SHORTLIST)).status).toBe(403);
      expect((await as(api, admin).get(SHORTLIST)).status).toBe(403);
      expect((await as(api, visible).put(`${SHORTLIST}/${visible.workerId}`)).status).toBe(403);
    });

    it('stops working for a suspended customer (session is revoked)', async () => {
      const temp = await loginWithOtp(api, { appType: 'CUSTOMER' });
      await as(api, admin)
        .patch(`/api/v1/admin/users/${temp.userId}/status`, { status: 'SUSPENDED' })
        .expect(200);
      expect((await as(api, temp).get(SHORTLIST)).status).toBe(403);
      expect((await as(api, temp).put(`${SHORTLIST}/${visible.workerId}`)).status).toBe(403);
    });
  });

  describe('worker profile photo', () => {
    const request = (w: OnboardedWorker, body: object) => as(api, w).post(PHOTO, body);

    it('uploads, verifies size and file signature, then becomes the current photo shown to customers', async () => {
      const res = await request(visible, { contentType: 'image/jpeg', sizeBytes: 5000 });
      expect(res.status).toBe(201);
      const created = res.body as {
        photoId: string;
        url: string;
        method: string;
        maxBytes: number;
      };
      expect(created.method).toBe('PUT');
      const key = api.storage.issuedUploads.at(-1)!.objectKey;
      expect(key).toMatch(/^photos\/[0-9a-f-]{36}\/[0-9a-f-]{36}$/);
      const confirm = () => as(api, visible).post(`${PHOTO}/${created.photoId}/confirm`);

      const early = await confirm();
      expect(early.status).toBe(422);
      expect((early.body as { code: string }).code).toBe('PHOTO_NOT_UPLOADED');
      api.storage.simulateUpload(key, 5000, Buffer.from('<html><script>'));
      const bad = await confirm();
      expect(bad.status).toBe(422);
      expect((bad.body as { code: string }).code).toBe('PHOTO_CONTENT_MISMATCH');
      expect(
        await api.prisma.auditLog.count({
          where: { action: 'worker.photo_content_rejected', entityId: created.photoId },
        }),
      ).toBe(1);
      expect((await as(api, visible).get(PHOTO)).status).toBe(404);

      api.storage.simulateUpload(key, 5000, SAMPLE_JPEG);
      const results = await Promise.all([confirm(), confirm(), confirm()]);
      expect(results.map((r) => r.status)).toEqual([200, 200, 200]);
      expect(
        await api.prisma.auditLog.count({
          where: { action: 'worker.photo_confirm', entityId: created.photoId },
        }),
      ).toBe(1);

      // D-69: WebP renditions are stored and the original (which may carry GPS metadata) is gone
      expect(api.storage.contentTypeOf(`${key}.card.webp`)).toBe('image/webp');
      expect(api.storage.contentTypeOf(`${key}.large.webp`)).toBe('image/webp');
      expect(api.storage.has(key)).toBe(false);
      expect(
        await api.prisma.workerProfilePhoto.findUniqueOrThrow({ where: { id: created.photoId } }),
      ).toMatchObject({ cardObjectKey: `${key}.card.webp`, largeObjectKey: `${key}.large.webp` });

      const mine = await as(api, visible).get(PHOTO);
      expect(mine.status).toBe(200);
      expect(mine.body).toMatchObject({ cacheKey: created.photoId });
      expect((mine.body as { url: string }).url).toContain(encodeURIComponent(`${key}.card.webp`));
      expect((mine.body as { largeUrl: string }).largeUrl).toContain(
        encodeURIComponent(`${key}.large.webp`),
      );
      expect((mine.body as { url: string }).url).toContain(encodeURIComponent(key));
      const profile = await as(api, customer).get(`${PROFILE}/${visible.workerId}`);
      expect((profile.body as { photo: { url: string } | null }).photo?.url).toContain(
        encodeURIComponent(key),
      );
      const me = await as(api, visible).get('/api/v1/workers/me');
      expect((me.body as { hasProfilePhoto: boolean }).hasProfilePhoto).toBe(true);
      // the storage key itself is never returned to a customer
      expect(JSON.stringify(profile.body)).not.toContain(`photos/${visible.workerId}`);
    });

    it('scans the photo when a scanner is configured: unavailable -> 503 and retry, infected -> 422', async () => {
      const scanner = api.app.get<MalwareScanner>(MALWARE_SCANNER);
      const enabled = jest.replaceProperty(scanner, 'enabled', true);
      const scan = jest.spyOn(scanner, 'scan');
      try {
        const res = await request(unverified, { contentType: 'image/jpeg', sizeBytes: 5000 });
        const { photoId } = res.body as { photoId: string };
        const key = api.storage.issuedUploads.at(-1)!.objectKey;
        api.storage.simulateUpload(key, 5000, SAMPLE_JPEG);
        const confirm = () => as(api, unverified).post(`${PHOTO}/${photoId}/confirm`);

        scan.mockRejectedValueOnce(new Error('clamd down'));
        const down = await confirm();
        expect(down.status).toBe(503);
        expect(api.storage.has(key)).toBe(true); // left in place for a retry

        scan.mockResolvedValueOnce({ clean: false, signature: 'Eicar-Test-Signature' });
        const infected = await confirm();
        expect(infected.status).toBe(422);
        expect((infected.body as { code: string }).code).toBe('PHOTO_MALWARE_DETECTED');
        expect(
          await api.prisma.auditLog.count({
            where: { action: 'worker.photo_malware_rejected', entityId: photoId },
          }),
        ).toBe(1);
        expect(
          (await api.prisma.workerProfilePhoto.findUniqueOrThrow({ where: { id: photoId } }))
            .status,
        ).toBe('PENDING_UPLOAD');

        scan.mockResolvedValueOnce({ clean: true });
        expect((await confirm()).status).toBe(200);
        expect(scan).toHaveBeenCalledTimes(3);
      } finally {
        scan.mockRestore();
        enabled.restore();
      }
    });

    it('refuses wrong types, oversized images and an unconfigured limit', async () => {
      const gif = await request(unverified, { contentType: 'image/gif', sizeBytes: 100 });
      expect(gif.status).toBe(422);
      expect((gif.body as { code: string }).code).toBe('PHOTO_TYPE_NOT_ALLOWED');
      expect(
        (await request(unverified, { contentType: 'image/png', sizeBytes: 300000 })).status,
      ).toBe(413);
      expect((await request(unverified, { contentType: 'image/png', sizeBytes: 0 })).status).toBe(
        400,
      );
      expect((await request(unverified, { sizeBytes: 100 })).status).toBe(400);
      const config = api.app.get(AppConfigService);
      const spy = jest
        .spyOn(config, 'profilePhoto', 'get')
        .mockReturnValue({ maxBytes: undefined, signedUrlTtlSeconds: 120 });
      try {
        const off = await request(unverified, { contentType: 'image/png', sizeBytes: 100 });
        expect(off.status).toBe(503);
        expect((off.body as { code: string }).code).toBe('PHOTO_NOT_CONFIGURED');
      } finally {
        spy.mockRestore();
      }
    });

    it("hides another worker's photo and enforces roles, ids and the pending cap", async () => {
      const mine = await request(draft, { contentType: 'image/png', sizeBytes: 100 });
      const photoId = (mine.body as { photoId: string }).photoId;
      api.storage.simulateUpload(api.storage.issuedUploads.at(-1)!.objectKey, 100, SAMPLE_PNG);
      const stolen = await as(api, unverified).post(`${PHOTO}/${photoId}/confirm`);
      const unknown = await as(api, unverified).post(`${PHOTO}/${UNKNOWN_ID}/confirm`);
      expect(stolen.status).toBe(404);
      expect(unknown.status).toBe(404);
      expect((stolen.body as { code: string }).code).toBe((unknown.body as { code: string }).code);
      expect(
        (await api.prisma.workerProfilePhoto.findUniqueOrThrow({ where: { id: photoId } })).status,
      ).toBe('PENDING_UPLOAD');
      expect((await as(api, unverified).post(`${PHOTO}/nope/confirm`)).status).toBe(400);
      expect(
        (await as(api, customer).post(PHOTO, { contentType: 'image/png', sizeBytes: 1 })).status,
      ).toBe(403);
      expect(
        (await as(api, admin).post(PHOTO, { contentType: 'image/png', sizeBytes: 1 })).status,
      ).toBe(403);
      expect((await api.http().post(PHOTO).send({})).status).toBe(401);
      // pending cap: 1 already open for `draft`, 4 more allowed, the 6th is refused
      for (let i = 0; i < 4; i += 1) {
        expect((await request(draft, { contentType: 'image/png', sizeBytes: 1 })).status).toBe(201);
      }
      const sixth = await request(draft, { contentType: 'image/png', sizeBytes: 1 });
      expect(sixth.status).toBe(422);
      expect((sixth.body as { code: string }).code).toBe('TOO_MANY_PENDING_PHOTOS');
    });

    it('a worker cannot set the photo reference through the profile endpoint (mass assignment)', async () => {
      const res = await as(api, expired).patch('/api/v1/workers/me', {
        profilePhotoRef: 'photos/x/y',
      });
      expect([200, 400]).toContain(res.status);
      const row = await api.prisma.workerProfile.findUniqueOrThrow({
        where: { id: expired.workerId },
      });
      expect(row.profilePhotoRef).toBeNull();
    });
  });
});
