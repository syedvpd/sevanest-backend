import '../support/env-api-integration';
import { AppConfigService } from '../../src/config/app-config.service';
import { CustomerPhotoService } from '../../src/modules/customer-photo/customer-photo.service';
import { ApiApp, createApiApp, loginAdmin, loginWithOtp } from '../support/api-app';
import { ensureFee, inDays, makeBooking } from '../support/bookings';
import { SAMPLE_JPEG, SAMPLE_PNG } from '../support/images';
import { as, createArea, setRequiredChecks } from '../support/workforce';

const PHOTO = '/api/v1/customers/me/photo';
const FEE = '/api/v1/fees/booking';
const UNKNOWN_ID = '00000000-0000-7000-8000-000000000000';

type Customer = Awaited<ReturnType<typeof loginWithOtp>>;

/** Customer-app gap closure (2026-10-15): booking-fee quote and the customer's own profile photo. */
describe('Customer app gap closure (integration)', () => {
  let api: ApiApp;
  let admin: Awaited<ReturnType<typeof loginAdmin>>;
  let customer: Customer;
  let other: Customer;
  let area: { id: string };

  const newCustomer = async (name: string): Promise<Customer> => {
    const c = await loginWithOtp(api, { appType: 'CUSTOMER' });
    await as(api, c)
      .post('/api/v1/customers/me', {
        name,
        email: `c.${Date.now()}.${Math.round(Math.random() * 1e6)}@example.test`,
        preferredLanguage: 'en',
      })
      .expect(201);
    return c;
  };

  beforeAll(async () => {
    api = await createApiApp();
    admin = await loginAdmin(api);
    area = await createArea(api, admin);
    customer = await newCustomer('Photo Owner');
    other = await newCustomer('Other Customer');
    await setRequiredChecks(api, admin, ['IDENTITY']);
  });
  afterAll(async () => {
    await setRequiredChecks(api, admin, []);
    await ensureFee(api, admin, 50000);
    await api.close();
  });

  describe('GET /fees/booking (request 12)', () => {
    it('quotes exactly what POST /payments then charges, and follows the fee configuration', async () => {
      await ensureFee(api, admin, 73500);
      const quote = await as(api, customer).get(FEE);
      expect(quote.status).toBe(200);
      expect(quote.body).toEqual({ code: 'BOOKING_FEE', amountMinor: 73500, currency: 'INR' });

      const booking = await makeBooking(api, admin, customer, area.id, 'PENDING_PAYMENT');
      const paid = await as(api, customer).post('/api/v1/payments', { bookingId: booking.id });
      expect(paid.status).toBe(201);
      expect(paid.body).toMatchObject({ amountMinor: 73500, currency: 'INR' });

      // a later fee change affects new bookings only; the open payment keeps the amount it was created with
      await ensureFee(api, admin, 99000);
      const general = await as(api, customer).get(FEE);
      expect((general.body as { amountMinor: number }).amountMinor).toBe(99000);
      const forBooking = await as(api, customer).get(`${FEE}?bookingId=${booking.id}`);
      expect(forBooking.status).toBe(200);
      expect(forBooking.body).toEqual({ code: 'BOOKING_FEE', amountMinor: 73500, currency: 'INR' });
      await ensureFee(api, admin, 50000);
    });

    it('answers 422 FEE_NOT_CONFIGURED when no active fee exists, like POST /payments', async () => {
      await as(api, admin)
        .put('/api/v1/admin/fees/booking-fee', { amountMinor: 50000, isActive: false })
        .expect(200);
      try {
        const quote = await as(api, customer).get(FEE);
        expect(quote.status).toBe(422);
        expect((quote.body as { code: string }).code).toBe('FEE_NOT_CONFIGURED');
      } finally {
        await ensureFee(api, admin, 50000);
      }
    });

    it("hides another customer's booking, validates the id and enforces roles", async () => {
      await ensureFee(api, admin, 50000);
      const booking = await makeBooking(api, admin, customer, area.id, 'PENDING_PAYMENT');
      expect((await as(api, other).get(`${FEE}?bookingId=${booking.id}`)).status).toBe(404);
      expect((await as(api, customer).get(`${FEE}?bookingId=${UNKNOWN_ID}`)).status).toBe(404);
      expect((await as(api, customer).get(`${FEE}?bookingId=nope`)).status).toBe(400);
      expect((await as(api, booking.worker).get(FEE)).status).toBe(403);
      expect((await as(api, admin).get(FEE)).status).toBe(403);
      expect((await api.http().get(FEE)).status).toBe(401);
    });
  });

  describe('booking actions, allowedActions and timeline (request 9)', () => {
    const B = '/api/v1/bookings';
    const future = (hours: number): string => new Date(Date.now() + hours * 3600_000).toISOString();
    const actions = async (id: string): Promise<string[]> =>
      ((await as(api, customer).get(`${B}/${id}`).expect(200)).body as { allowedActions: string[] })
        .allowedActions;

    it('allowedActions agree with the server: listed actions pass the state check, the others answer 409', async () => {
      const b = await makeBooking(api, admin, customer, area.id, 'MATCHED');
      const listed = await actions(b.id);
      expect(listed).toEqual(expect.arrayContaining(['schedule', 'cancel']));
      for (const action of [
        'interview-complete',
        'confirm-worker',
        'start',
        'complete',
        'reopen-matching',
      ]) {
        expect(listed).not.toContain(action);
        const res = await as(api, customer).post(`${B}/${b.id}/${action}`, {
          startDate: inDays(1),
          outcomeNote: 'fine',
        });
        expect([409, 422]).toContain(res.status);
        expect((res.body as { code: string }).code).toBe('INVALID_TRANSITION');
      }
      // the listed action works
      const scheduled = await as(api, customer).post(`${B}/${b.id}/schedule`, {
        scheduleType: 'INTERVIEW',
        scheduledAt: future(48),
      });
      expect(scheduled.status).toBe(200);
      expect(await actions(b.id)).toEqual(
        expect.arrayContaining(['reopen-matching', 'interview-complete', 'cancel']),
      );
      expect(await actions(b.id)).not.toContain('schedule');
    });

    it('schedule is not repeatable (reschedule goes through /interviews); reopen-matching returns to MATCHED and keeps the worker', async () => {
      const b = await makeBooking(api, admin, customer, area.id, 'MATCHED');
      const first = await as(api, customer).post(`${B}/${b.id}/schedule`, {
        scheduleType: 'TRIAL',
        scheduledAt: future(48),
      });
      expect(first.status).toBe(200);
      const again = await as(api, customer).post(`${B}/${b.id}/schedule`, {
        scheduleType: 'TRIAL',
        scheduledAt: future(72),
      });
      expect(again.status).toBe(409);
      expect((again.body as { code: string }).code).toBe('INVALID_TRANSITION');
      const past = await as(api, customer).post(
        `${B}/${(await makeBooking(api, admin, customer, area.id, 'MATCHED')).id}/schedule`,
        {
          scheduleType: 'TRIAL',
          scheduledAt: future(-2),
        },
      );
      expect(past.status).toBe(400);

      const reopened = await as(api, customer).post(`${B}/${b.id}/reopen-matching`, {});
      expect(reopened.status).toBe(200);
      expect(reopened.body).toMatchObject({
        status: 'MATCHED',
        workerId: b.worker.workerId,
        scheduleType: null,
        scheduledAt: null,
      });
      const timeline = (reopened.body as { timeline: Array<{ to: string; by: string }> }).timeline;
      expect(timeline.map((t) => t.to)).toEqual([
        'NEW_REQUEST',
        'MATCHED',
        'INTERVIEW_TRIAL_SCHEDULED',
        'MATCHED',
      ]);
      expect(timeline.at(-1)).toMatchObject({ by: 'CUSTOMER' });
    });

    it('refuses actions on a booking of another customer, worker-only actions and a repeated cancel', async () => {
      const b = await makeBooking(api, admin, customer, area.id, 'MATCHED');
      expect(
        (await as(api, other).post(`${B}/${b.id}/cancel`, { reason: 'not mine' })).status,
      ).toBe(404);
      expect((await as(api, customer).post(`${B}/${b.id}/accept`, {})).status).toBe(403);
      expect((await as(api, customer).post(`${B}/${b.id}/cancel`, {})).status).toBe(400); // reason is required
      const cancelled = await as(api, customer).post(`${B}/${b.id}/cancel`, {
        reason: 'changed my mind',
      });
      expect(cancelled.status).toBe(200);
      expect(cancelled.body).toMatchObject({ status: 'CANCELLED', allowedActions: [] });
      const twice = await as(api, customer).post(`${B}/${b.id}/cancel`, { reason: 'again' });
      // a repeated cancel is an idempotent replay: it changes nothing and adds no second timeline entry
      expect(twice.status).toBe(200);
      expect(
        (twice.body as { timeline: Array<{ to: string }> }).timeline.filter(
          (t) => t.to === 'CANCELLED',
        ),
      ).toHaveLength(1);
      expect(await actions(b.id)).toEqual([]);
    });

    it("does not show a worker's own decline reason in the customer's timeline", async () => {
      const b = await makeBooking(api, admin, customer, area.id, 'MATCHED');
      const declined = await as(api, b.worker).post(`/api/v1/workers/me/bookings/${b.id}/decline`, {
        reason: 'PRIVATE-WORKER-REASON',
      });
      expect(declined.status).toBe(200);
      const detail = await as(api, customer).get(`${B}/${b.id}`);
      expect(detail.status).toBe(200);
      const body = detail.body as {
        timeline: Array<{ by: string; to: string; note: string | null }>;
      };
      expect(JSON.stringify(detail.body)).not.toContain('PRIVATE-WORKER-REASON');
      expect(body.timeline.at(-1)).toMatchObject({ by: 'WORKER', to: 'NEW_REQUEST', note: null });
      // staff still see what the worker wrote
      const staff = await as(api, admin).get(`/api/v1/admin/bookings/${b.id}`);
      expect(JSON.stringify(staff.body)).toContain('PRIVATE-WORKER-REASON');
    });
  });

  describe('rating scale in search (request 1)', () => {
    it('refuses a minRating above the configured scale and accepts the scale itself', async () => {
      const base = `/api/v1/search/workers?category=HOUSE_MAID&areaId=${area.id}`;
      const scale = (await as(api, customer).get('/api/v1/reference-data')).body
        .ratingScaleMax as number;
      const over = await as(api, customer).get(`${base}&minRating=${scale + 1}`);
      expect(over.status).toBe(400);
      expect(JSON.stringify(over.body)).toContain('minRating');
      expect((await as(api, customer).get(`${base}&minRating=${scale}`)).status).toBe(200);
    });
  });

  describe('customer profile photo (request 8)', () => {
    const request = (c: Customer, body: object) => as(api, c).post(PHOTO, body);

    it('uploads, verifies size and file signature, then becomes the current photo; a new photo replaces it', async () => {
      const mine0 = await as(api, customer).get(PHOTO);
      expect(mine0.status).toBe(404);
      expect((mine0.body as { code: string }).code).toBe('PHOTO_NOT_FOUND');

      const res = await request(customer, { contentType: 'image/jpeg', sizeBytes: 5000 });
      expect(res.status).toBe(201);
      const created = res.body as { photoId: string; method: string; maxBytes: number };
      expect(created.method).toBe('PUT');
      const key = api.storage.issuedUploads.at(-1)!.objectKey;
      expect(key).toMatch(/^customer-photos\/[0-9a-f-]{36}\/[0-9a-f-]{36}$/);
      const confirm = () => as(api, customer).post(`${PHOTO}/${created.photoId}/confirm`);

      const early = await confirm();
      expect(early.status).toBe(422);
      expect((early.body as { code: string }).code).toBe('PHOTO_NOT_UPLOADED');
      api.storage.simulateUpload(key, 5000, Buffer.from('<html><script>'));
      const bad = await confirm();
      expect(bad.status).toBe(422);
      expect((bad.body as { code: string }).code).toBe('PHOTO_CONTENT_MISMATCH');
      expect(
        await api.prisma.auditLog.count({
          where: { action: 'customer.photo_content_rejected', entityId: created.photoId },
        }),
      ).toBe(1);
      expect((await as(api, customer).get(PHOTO)).status).toBe(404);

      api.storage.simulateUpload(key, 5000, SAMPLE_JPEG);
      const results = await Promise.all([confirm(), confirm(), confirm()]);
      expect(results.map((r) => r.status)).toEqual([200, 200, 200]);
      expect(results[0].body).toEqual({ photoId: created.photoId, status: 'READY' });
      expect(
        await api.prisma.auditLog.count({
          where: { action: 'customer.photo_confirm', entityId: created.photoId },
        }),
      ).toBe(1);
      // WebP renditions are stored, the original (which may carry GPS metadata) is gone
      expect(api.storage.contentTypeOf(`${key}.card.webp`)).toBe('image/webp');
      expect(api.storage.contentTypeOf(`${key}.large.webp`)).toBe('image/webp');
      expect(api.storage.has(key)).toBe(false);

      const mine = await as(api, customer).get(PHOTO);
      expect(mine.status).toBe(200);
      const link = mine.body as {
        url: string;
        largeUrl: string;
        expiresAt: string;
        cacheKey: string;
      };
      expect(link.cacheKey).toBe(created.photoId);
      expect(link.url).toContain(encodeURIComponent(`${key}.card.webp`));
      expect(link.largeUrl).toContain(encodeURIComponent(`${key}.large.webp`));
      expect(new Date(link.expiresAt).getTime()).toBeGreaterThan(Date.now());
      expect(Object.keys(link).sort()).toEqual(['cacheKey', 'expiresAt', 'largeUrl', 'url']);

      // replace it: the previous photo, its row and its renditions are removed
      const second = await request(customer, { contentType: 'image/png', sizeBytes: 4000 });
      const secondId = (second.body as { photoId: string }).photoId;
      const secondKey = api.storage.issuedUploads.at(-1)!.objectKey;
      api.storage.simulateUpload(secondKey, 4000, SAMPLE_PNG);
      expect((await as(api, customer).post(`${PHOTO}/${secondId}/confirm`)).status).toBe(200);
      expect((await as(api, customer).get(PHOTO)).body).toMatchObject({ cacheKey: secondId });
      expect(api.storage.has(`${key}.card.webp`)).toBe(false);
      expect(api.storage.has(`${key}.large.webp`)).toBe(false);
      expect(
        await api.prisma.customerProfilePhoto.findUnique({ where: { id: created.photoId } }),
      ).toBeNull();
    });

    it("keeps one customer's photo from another customer, a worker or an admin", async () => {
      const own = await request(customer, { contentType: 'image/png', sizeBytes: 100 });
      const photoId = (own.body as { photoId: string }).photoId;
      const key = api.storage.issuedUploads.at(-1)!.objectKey;
      api.storage.simulateUpload(key, 100, SAMPLE_PNG);
      const stolen = await as(api, other).post(`${PHOTO}/${photoId}/confirm`);
      expect(stolen.status).toBe(404);
      expect((await as(api, other).post(`${PHOTO}/${UNKNOWN_ID}/confirm`)).status).toBe(404);
      expect((await as(api, other).get(PHOTO)).status).toBe(404);
      expect((await as(api, other).post(`${PHOTO}/nope/confirm`)).status).toBe(400);
      expect(
        (await api.prisma.customerProfilePhoto.findUniqueOrThrow({ where: { id: photoId } }))
          .status,
      ).toBe('PENDING_UPLOAD');

      const body = { contentType: 'image/png', sizeBytes: 1 };
      expect((await as(api, admin).post(PHOTO, body)).status).toBe(403);
      expect((await as(api, admin).get(PHOTO)).status).toBe(403);
      expect((await api.http().post(PHOTO).send(body)).status).toBe(401);
      expect((await api.http().get(PHOTO)).status).toBe(401);
    });

    it('refuses wrong types, oversized or invalid sizes, an unconfigured limit and too many open uploads', async () => {
      const gif = await request(other, { contentType: 'image/gif', sizeBytes: 100 });
      expect(gif.status).toBe(422);
      expect((gif.body as { code: string }).code).toBe('PHOTO_TYPE_NOT_ALLOWED');
      expect((await request(other, { contentType: 'image/png', sizeBytes: 300000 })).status).toBe(
        413,
      );
      expect((await request(other, { contentType: 'image/png', sizeBytes: 0 })).status).toBe(400);
      expect((await request(other, { sizeBytes: 100 })).status).toBe(400);

      const config = api.app.get(AppConfigService);
      const spy = jest
        .spyOn(config, 'profilePhoto', 'get')
        .mockReturnValue({ maxBytes: undefined, signedUrlTtlSeconds: 120 });
      try {
        const off = await request(other, { contentType: 'image/png', sizeBytes: 100 });
        expect(off.status).toBe(503);
        expect((off.body as { code: string }).code).toBe('PHOTO_NOT_CONFIGURED');
      } finally {
        spy.mockRestore();
      }

      const fresh = await newCustomer('Many Uploads');
      for (let i = 0; i < 3; i++) {
        expect((await request(fresh, { contentType: 'image/png', sizeBytes: 1 })).status).toBe(201);
      }
      const fourth = await request(fresh, { contentType: 'image/png', sizeBytes: 1 });
      expect(fourth.status).toBe(422);
      expect((fourth.body as { code: string }).code).toBe('TOO_MANY_PENDING_PHOTOS');
    });

    it('discards uploads that were never confirmed and keeps confirmed photos', async () => {
      const fresh = await newCustomer('Abandoned Upload');
      const abandoned = await request(fresh, { contentType: 'image/png', sizeBytes: 100 });
      const abandonedId = (abandoned.body as { photoId: string }).photoId;
      const abandonedKey = api.storage.issuedUploads.at(-1)!.objectKey;
      api.storage.simulateUpload(abandonedKey, 100, SAMPLE_PNG);
      const kept = await request(fresh, { contentType: 'image/png', sizeBytes: 100 });
      const keptId = (kept.body as { photoId: string }).photoId;
      const keptKey = api.storage.issuedUploads.at(-1)!.objectKey;
      api.storage.simulateUpload(keptKey, 100, SAMPLE_PNG);
      expect((await as(api, fresh).post(`${PHOTO}/${keptId}/confirm`)).status).toBe(200);

      const service = api.app.get(CustomerPhotoService);
      // the upload is younger than a day: nothing is discarded
      expect(await service.purgeAbandonedUploads(24 * 3600 * 1000)).toBe(0);
      expect(await service.purgeAbandonedUploads(-60_000)).toBeGreaterThanOrEqual(1);
      expect(api.storage.has(abandonedKey)).toBe(false);
      expect(
        await api.prisma.customerProfilePhoto.findUnique({ where: { id: abandonedId } }),
      ).toBeNull();
      expect((await as(api, fresh).get(PHOTO)).body).toMatchObject({ cacheKey: keptId });
    });

    it('is never part of the customer profile or any worker-facing response', async () => {
      const me = await as(api, customer).get('/api/v1/customers/me');
      expect(JSON.stringify(me.body)).not.toContain('customer-photos');
      expect(Object.keys(me.body as object).filter((k) => /photo/i.test(k))).toEqual([]);
    });
  });
});
