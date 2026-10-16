import '../support/env-api-integration';
import { randomUUID } from 'node:crypto';
import { IdempotencyService } from '../../src/common/idempotency/idempotency.service';
import { indiaToday } from '../../src/common/time/india';
import {
  MALWARE_SCANNER,
  type MalwareScanner,
} from '../../src/integrations/malware/malware-scanner';
import { buildSampleFile } from '../../src/integrations/storage/file-signature';
import { ProviderError } from '../../src/integrations/provider-error';
import {
  ADMIN_PASSWORD,
  adminLogin,
  ApiApp,
  createAdmin,
  createApiApp,
  loginAdmin,
  loginAdminWithPermissions,
  loginWithOtp,
  unique,
} from '../support/api-app';
import { ensureFee, inDays, makeBooking, payForBooking } from '../support/bookings';
import {
  approveCheck,
  as,
  createArea,
  onboardWorker,
  setRequiredChecks,
} from '../support/workforce';

const A = '/api/v1/admin';
const UNKNOWN_ID = '00000000-0000-7000-8000-000000000000';

type Session = Awaited<ReturnType<typeof loginWithOtp>>;

/** Interim-default items that were left open by the business, and the small backlog items (summary, filters, export, idempotency, ...). */
describe('Small backlog items and interim defaults (integration)', () => {
  let api: ApiApp;
  let admin: Awaited<ReturnType<typeof loginAdmin>>;
  let area: { id: string; name: string; city: string };
  let customer: Session & { addressId: string; customerId: string };

  const audits = (action: string, entityId?: string) =>
    api.prisma.auditLog.findMany({ where: { action, ...(entityId ? { entityId } : {}) } });

  async function newCustomer(name = 'Asha Rao', withAddress = true) {
    const session = await loginWithOtp(api, { appType: 'CUSTOMER' });
    const profile = await as(api, session)
      .post('/api/v1/customers/me', {
        name,
        email: `c.${unique()}@example.test`,
        preferredLanguage: 'en',
      })
      .expect(201);
    let addressId = '';
    if (withAddress) {
      const res = await as(api, session)
        .post('/api/v1/customers/me/addresses', {
          line: '12 Lake View Road',
          area: area.name,
          city: area.city,
          pincode: '500081',
        })
        .expect(201);
      addressId = (res.body as { id: string }).id;
    }
    return { ...session, addressId, customerId: (profile.body as { id: string }).id };
  }

  beforeAll(async () => {
    api = await createApiApp();
    admin = await loginAdmin(api);
    area = await createArea(api, admin);
    customer = await newCustomer();
    await setRequiredChecks(api, admin, ['IDENTITY']);
    await ensureFee(api, admin);
  });

  afterAll(async () => {
    await setRequiredChecks(api, admin, []);
    await api.close();
  });

  // ------------------------------------------------------------------------------------------------------------
  describe('attendance month summary', () => {
    it('counts the month for worker, customer and staff, and refuses foreign callers and bad months', async () => {
      const b = await makeBooking(api, admin, customer, area.id, 'ACTIVE');
      await as(api, b.worker)
        .post(`/api/v1/workers/me/attendance/bookings/${b.id}`, { status: 'PRESENT' })
        .expect(201);
      const month = indiaToday().slice(0, 7);

      const mine = await as(api, b.worker).get(
        `/api/v1/workers/me/attendance/bookings/${b.id}/summary?month=${month}`,
      );
      expect(mine.status).toBe(200);
      expect(mine.body).toMatchObject({
        bookingId: b.id,
        month,
        present: 1,
        absent: 0,
        exception: 0,
        recorded: 1,
      });
      expect(mine.body.daysInMonth).toBeGreaterThanOrEqual(28);
      expect(mine.body.from).toBe(`${month}-01`);

      const theirs = await as(api, customer).get(
        `/api/v1/attendance/bookings/${b.id}/summary?month=${month}`,
      );
      expect(theirs.body).toMatchObject({ present: 1, recorded: 1 });
      const staff = await as(api, admin).get(
        `${A}/attendance/bookings/${b.id}/summary?month=${month}`,
      );
      expect(staff.body).toMatchObject({ present: 1 });

      const empty = await as(api, customer).get(
        `/api/v1/attendance/bookings/${b.id}/summary?month=2020-01`,
      );
      expect(empty.body).toMatchObject({ present: 0, recorded: 0, daysInMonth: 31 });

      for (const bad of ['2026-13', '2026-1', 'abc', '']) {
        const res = await as(api, customer).get(
          `/api/v1/attendance/bookings/${b.id}/summary?month=${bad}`,
        );
        expect(res.status).toBe(400);
      }
      expect(
        (await as(api, customer).get(`/api/v1/attendance/bookings/${b.id}/summary`)).status,
      ).toBe(400);

      const stranger = await newCustomer();
      expect(
        (await as(api, stranger).get(`/api/v1/attendance/bookings/${b.id}/summary?month=${month}`))
          .status,
      ).toBe(404);
      const otherWorker = await onboardWorker(api, { areaIds: [area.id] });
      expect(
        (
          await as(api, otherWorker).get(
            `/api/v1/workers/me/attendance/bookings/${b.id}/summary?month=${month}`,
          )
        ).status,
      ).toBe(404);
      expect(
        (
          await as(api, customer).get(
            `/api/v1/attendance/bookings/${UNKNOWN_ID}/summary?month=${month}`,
          )
        ).status,
      ).toBe(404);
    });
  });

  // ------------------------------------------------------------------------------------------------------------
  describe('list filters', () => {
    it('filters customers by name, account status, city and creation date', async () => {
      const marker = `Zed${Array.from({ length: 8 }, () => String.fromCharCode(97 + Math.floor(Math.random() * 26))).join('')}`;
      const c = await newCustomer(`${marker} Kumar`);
      const byName = await as(api, admin).get(`${A}/customers?name=${marker.toLowerCase()}`);
      expect(byName.status).toBe(200);
      expect(byName.body.data.map((x: { id: string }) => x.id)).toEqual([c.customerId]);

      const byCity = await as(api, admin).get(
        `${A}/customers?city=${encodeURIComponent(area.city.toUpperCase())}&limit=100`,
      );
      expect(byCity.body.data.map((x: { id: string }) => x.id)).toContain(c.customerId);
      expect(
        (await as(api, admin).get(`${A}/customers?city=NoSuchCity${unique()}`)).body.data,
      ).toEqual([]);

      const today = indiaToday();
      const dated = await as(api, admin).get(
        `${A}/customers?name=${marker}&createdFrom=${today}&createdTo=${today}`,
      );
      expect(dated.body.data).toHaveLength(1);
      const past = await as(api, admin).get(
        `${A}/customers?name=${marker}&createdFrom=2020-01-01&createdTo=2020-12-31`,
      );
      expect(past.body.data).toEqual([]);

      await as(api, admin)
        .patch(`${A}/users/${c.userId}/status`, { status: 'SUSPENDED', reason: 'test' })
        .expect(200);
      const suspended = await as(api, admin).get(
        `${A}/customers?name=${marker}&accountStatus=SUSPENDED`,
      );
      expect(suspended.body.data).toHaveLength(1);
      expect(
        (await as(api, admin).get(`${A}/customers?name=${marker}&accountStatus=ACTIVE`)).body.data,
      ).toEqual([]);

      for (const bad of ['createdFrom=2026-02-30', 'createdTo=nope', 'accountStatus=GONE']) {
        expect((await as(api, admin).get(`${A}/customers?${bad}`)).status).toBe(400);
      }
      expect(
        (await as(api, admin).get(`${A}/customers?createdFrom=2026-05-02&createdTo=2026-05-01`))
          .status,
      ).toBe(400);
    });

    it('filters bookings by category, area, engagement and request date for staff, customer and worker', async () => {
      const otherArea = await createArea(api, admin);
      const worker = await onboardWorker(api, { areaIds: [area.id] });
      await approveCheck(api, admin, worker, 'IDENTITY');
      const made = await as(api, customer)
        .post('/api/v1/bookings', {
          category: 'HOUSE_MAID',
          areaId: area.id,
          engagement: 'PART_TIME',
          availableFrom: '09:00',
          availableTo: '12:00',
          workerId: worker.workerId,
        })
        .expect(201);
      const id = (made.body as { id: string }).id;
      const today = indiaToday();

      const ids = async (who: { accessToken: string }, path: string, query: string) =>
        (
          (await as(api, who).get(`${path}?limit=100&${query}`)).body.data as Array<{ id: string }>
        ).map((b) => b.id);

      for (const [who, path] of [
        [admin, `${A}/bookings`],
        [customer, '/api/v1/bookings'],
        [worker, '/api/v1/workers/me/bookings'],
      ] as const) {
        expect(await ids(who, path, `areaId=${area.id}&engagement=PART_TIME`)).toContain(id);
        expect(await ids(who, path, `areaId=${otherArea.id}`)).not.toContain(id);
        expect(await ids(who, path, `engagement=LIVE_IN&areaId=${area.id}`)).not.toContain(id);
        expect(
          await ids(who, path, `createdFrom=${today}&createdTo=${today}&areaId=${area.id}`),
        ).toContain(id);
        expect(await ids(who, path, 'createdTo=2020-01-01')).not.toContain(id);
        expect(await ids(who, path, 'status=MATCHED&areaId=' + area.id)).toContain(id);
      }
      const category = (made.body as { category: { code: string } }).category.code;
      expect(category).toBe('HOUSE_MAID');
      const categoryId = (
        await api.prisma.serviceCategory.findFirstOrThrow({ where: { code: category } })
      ).id;
      expect(
        await ids(admin, `${A}/bookings`, `categoryId=${categoryId}&areaId=${area.id}`),
      ).toContain(id);
      expect(await ids(admin, `${A}/bookings`, `categoryId=${randomUUID()}`)).toEqual([]);
      for (const bad of ['areaId=nope', 'engagement=SOMETIMES', 'createdFrom=2026-99-99']) {
        expect((await as(api, admin).get(`${A}/bookings?${bad}`)).status).toBe(400);
      }
    });
  });

  // ------------------------------------------------------------------------------------------------------------
  describe('report CSV export', () => {
    it('returns any report as a CSV file, audited, and refuses bad ranges, unknown reports and missing permission', async () => {
      await newCustomer();
      const today = indiaToday();
      const res = await as(api, admin).get(
        `${A}/reports/export/new-customers?from=${today}&to=${today}`,
      );
      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toContain('text/csv');
      expect(res.headers['content-disposition']).toContain('attachment');
      const lines = res.text.trim().split('\r\n');
      expect(lines[0]).toContain('count');
      expect(lines.length).toBeGreaterThanOrEqual(2);

      const point = await as(api, admin).get(`${A}/reports/export/worker-utilization`);
      expect(point.status).toBe(200);
      expect(point.text.split('\r\n')[0]).toContain('verifiedWorkers');
      expect((await as(api, admin).get(`${A}/reports/export/top-rated-workers`)).status).toBe(200);
      expect(
        (await as(api, admin).get(`${A}/reports/export/demand-by-area?from=${today}&to=${today}`))
          .status,
      ).toBe(200);

      expect((await audits('report.export')).length).toBeGreaterThanOrEqual(3);
      expect((await as(api, admin).get(`${A}/reports/export/new-customers`)).status).toBe(400);
      expect(
        (
          await as(api, admin).get(
            `${A}/reports/export/new-customers?from=2026-03-01&to=2026-02-01`,
          )
        ).status,
      ).toBe(400);
      expect(
        (await as(api, admin).get(`${A}/reports/export/not-a-report?from=${today}&to=${today}`))
          .status,
      ).toBe(404);

      const noReports = await loginAdminWithPermissions(api, ['booking.view']);
      expect(
        (
          await as(api, noReports).get(
            `${A}/reports/export/new-customers?from=${today}&to=${today}`,
          )
        ).status,
      ).toBe(403);
      expect(
        (await api.http().get(`${A}/reports/export/new-customers?from=${today}&to=${today}`))
          .status,
      ).toBe(401);
    });
  });

  // ------------------------------------------------------------------------------------------------------------
  describe('staff create a booking and a worker on someone else behalf', () => {
    const request = (extra: object = {}) => ({
      category: 'HOUSE_MAID',
      areaId: area.id,
      engagement: 'PART_TIME',
      availableFrom: '09:00',
      availableTo: '12:00',
      ...extra,
    });

    it('creates a booking for a customer, audited as an admin action, with the same validation', async () => {
      const res = await as(api, admin).post(`${A}/bookings`, {
        ...request({
          addressId: customer.addressId,
          startDate: inDays(3),
          requirementNote: 'by phone',
        }),
        customerId: customer.customerId,
      });
      expect(res.status).toBe(201);
      expect(res.body.status).toBe('NEW_REQUEST');
      expect(res.body.requirementNote).toBe('by phone');
      const mine = await as(api, customer).get(`/api/v1/bookings/${res.body.id}`);
      expect(mine.status).toBe(200);
      expect(mine.body.timeline[0]).toMatchObject({ to: 'NEW_REQUEST', by: 'ADMIN' });
      const rows = await audits('booking.admin_create', res.body.id as string);
      expect(rows).toHaveLength(1);
      expect(rows[0].actorId).toBe(admin.userId);
      expect(rows[0].metadata).toMatchObject({ customerUserId: customer.userId });

      // the customer's own validation still applies
      const wrongAddress = await as(api, admin).post(`${A}/bookings`, {
        ...request({ addressId: UNKNOWN_ID }),
        customerId: customer.customerId,
      });
      expect(wrongAddress.status).toBe(404);
      const past = await as(api, admin).post(`${A}/bookings`, {
        ...request({ startDate: '2020-01-01' }),
        customerId: customer.customerId,
      });
      expect(past.status).toBe(400);
    });

    it('honours Idempotency-Key, refuses unknown and suspended customers and needs booking.manage', async () => {
      const key = `phone-${unique()}`;
      const body = { ...request(), customerId: customer.customerId };
      const first = await as(api, admin).post(`${A}/bookings`, body).set('Idempotency-Key', key);
      const second = await as(api, admin).post(`${A}/bookings`, body).set('Idempotency-Key', key);
      expect(first.status).toBe(201);
      expect(second.status).toBe(200);
      expect(second.body.id).toBe(first.body.id);

      expect(
        (await as(api, admin).post(`${A}/bookings`, { ...body, customerId: UNKNOWN_ID })).status,
      ).toBe(404);
      const other = await newCustomer();
      await as(api, admin)
        .patch(`${A}/users/${other.userId}/status`, { status: 'SUSPENDED', reason: 'test' })
        .expect(200);
      const suspended = await as(api, admin).post(`${A}/bookings`, {
        ...request(),
        customerId: other.customerId,
      });
      expect(suspended.status).toBe(409);
      expect(suspended.body.code).toBe('CUSTOMER_NOT_ACTIVE');

      const viewOnly = await loginAdminWithPermissions(api, ['booking.view']);
      expect((await as(api, viewOnly).post(`${A}/bookings`, body)).status).toBe(403);
      expect((await as(api, customer).post(`${A}/bookings`, body)).status).toBe(403);
    });

    it('creates a worker account and empty profile for a mobile; the worker signs in with OTP and finds it', async () => {
      const mobile = `9${Math.floor(100000000 + Math.random() * 899999999)}`;
      const res = await as(api, admin).post(`${A}/workers`, { mobile, name: 'Lakshmi Devi' });
      expect(res.status).toBe(201);
      expect(res.body).toMatchObject({ name: 'Lakshmi Devi', onboardingStatus: 'DRAFT' });
      const rows = await audits('worker.admin_create', res.body.id as string);
      expect(rows).toHaveLength(1);
      expect(rows[0].actorId).toBe(admin.userId);

      const again = await as(api, admin).post(`${A}/workers`, { mobile, name: 'Lakshmi Devi' });
      expect(again.status).toBe(409);
      expect(again.body.code).toBe('WORKER_PROFILE_EXISTS');

      const signedIn = await loginWithOtp(api, { appType: 'WORKER', mobile: `+91${mobile}` });
      expect(signedIn.isNewUser).toBe(false);
      const mine = await as(api, signedIn).get('/api/v1/workers/me');
      expect(mine.status).toBe(200);
      expect(mine.body.name).toBe('Lakshmi Devi');
    });

    it('refuses a customer number, bad input and missing permission', async () => {
      const taken = await as(api, admin).post(`${A}/workers`, {
        mobile: customer.mobile!.replace('+91', ''),
        name: 'Someone',
      });
      expect(taken.status).toBe(409);
      expect(taken.body.code).toBe('MOBILE_IN_USE');
      expect(
        (await as(api, admin).post(`${A}/workers`, { mobile: '12345', name: 'X' })).status,
      ).toBe(400);
      expect(
        (await as(api, admin).post(`${A}/workers`, { mobile: '9876543210', name: '<b>' })).status,
      ).toBe(400);
      const viewOnly = await loginAdminWithPermissions(api, ['worker.view']);
      expect(
        (await as(api, viewOnly).post(`${A}/workers`, { mobile: '9876500000', name: 'Y' })).status,
      ).toBe(403);
    });
  });

  // ------------------------------------------------------------------------------------------------------------
  describe('generic Idempotency-Key', () => {
    let categoryId: string;
    const raise = (who: Session, key: string | null, description = 'Worker did not come') => {
      const call = as(api, who).post('/api/v1/support/tickets', { categoryId, description });
      return key ? call.set('Idempotency-Key', key) : call;
    };
    const tickets = (who: Session) =>
      api.prisma.supportTicket.count({ where: { creatorUserId: who.userId } });

    beforeAll(async () => {
      categoryId = (
        await as(api, admin)
          .post(`${A}/support/categories`, {
            code: `IDEM_${unique().toUpperCase().slice(0, 8)}`,
            name: 'General',
          })
          .expect(201)
      ).body.id as string;
    });

    it('replays the first response for the same key and request, and does the work once', async () => {
      const who = await newCustomer();
      const key = `key-${unique()}`;
      const first = await raise(who, key);
      const second = await raise(who, key);
      expect(first.status).toBe(201);
      expect(second.status).toBe(201);
      expect(second.body.id).toBe(first.body.id);
      expect(second.headers['idempotent-replay']).toBe('true');
      expect(first.headers['idempotent-replay']).toBeUndefined();
      expect(await tickets(who)).toBe(1);
    });

    it('refuses the same key with a different request, and keeps keys per user', async () => {
      const who = await newCustomer();
      const key = `key-${unique()}`;
      await raise(who, key).expect(201);
      const reused = await raise(who, key, 'A completely different complaint');
      expect(reused.status).toBe(422);
      expect(reused.body.code).toBe('IDEMPOTENCY_KEY_REUSED');
      expect(await tickets(who)).toBe(1);

      const someoneElse = await newCustomer();
      expect((await raise(someoneElse, key)).status).toBe(201); // same key text, another user
    });

    it('runs one request when the same key arrives concurrently; the other is told it is in progress or replayed', async () => {
      const who = await newCustomer();
      const key = `key-${unique()}`;
      const results = await Promise.all([raise(who, key), raise(who, key), raise(who, key)]);
      const statuses = results.map((r) => r.status);
      expect(statuses.filter((s) => s === 201).length).toBeGreaterThanOrEqual(1);
      expect(statuses.every((s) => s === 201 || s === 409)).toBe(true);
      for (const r of results.filter((x) => x.status === 409)) {
        expect(r.body.code).toBe('IDEMPOTENCY_IN_PROGRESS');
      }
      expect(await tickets(who)).toBe(1);
    });

    it('forgets a failed request so the client can retry with the same key; no key means no memory', async () => {
      const who = await newCustomer();
      const key = `key-${unique()}`;
      const bad = await as(api, who)
        .post('/api/v1/support/tickets', {
          categoryId: UNKNOWN_ID,
          description: 'Worker did not come',
        })
        .set('Idempotency-Key', key);
      expect(bad.status).toBeGreaterThanOrEqual(400);
      expect(await tickets(who)).toBe(0);
      const retry = await raise(who, key, 'Worker did not come');
      expect(retry.status).toBe(201);

      await raise(who, null).expect(201);
      await raise(who, null).expect(201);
      expect(await tickets(who)).toBe(3);
    });

    it('rejects a malformed key, and expired keys are purged', async () => {
      const who = await newCustomer();
      expect((await raise(who, 'short')).status).toBe(400);
      expect((await raise(who, 'has spaces in it!')).status).toBe(400);
      const stale = `old-${unique()}`;
      await raise(who, stale).expect(201);
      await api.prisma
        .$executeRaw`UPDATE idempotency_keys SET expires_at = now() - interval '1 hour' WHERE key = ${stale}`;
      expect(await api.app.get(IdempotencyService).purgeExpired()).toBeGreaterThanOrEqual(1);
      expect(await api.prisma.idempotencyKey.count({ where: { key: stale } })).toBe(0);
      // an expired key that has not been purged yet is treated as new
      const lapsed = `lapsed-${unique()}`;
      await raise(who, lapsed).expect(201);
      await api.prisma
        .$executeRaw`UPDATE idempotency_keys SET expires_at = now() - interval '1 hour' WHERE key = ${lapsed}`;
      const fresh = await raise(who, lapsed);
      expect(fresh.status).toBe(201);
      expect(fresh.headers['idempotent-replay']).toBeUndefined();
    });
  });

  // ------------------------------------------------------------------------------------------------------------
  describe('If-Match on admin edits', () => {
    it('applies an edit made on the current version, refuses a stale one with 412, and keeps working without the header', async () => {
      const worker = await onboardWorker(api, { areaIds: [area.id] });
      const got = await as(api, admin).get(`${A}/workers/${worker.workerId}`);
      expect(got.status).toBe(200);
      const etag = got.headers.etag;
      expect(etag).toMatch(/^"\d+"$/);

      const edit = (name: string, ifMatch?: string) => {
        const call = as(api, admin).patch(`${A}/workers/${worker.workerId}`, { name });
        return ifMatch ? call.set('If-Match', ifMatch) : call;
      };
      const ok = await edit('Renamed One', etag);
      expect(ok.status).toBe(200);
      expect(ok.body.name).toBe('Renamed One');

      const stale = await edit('Renamed Two', etag);
      expect(stale.status).toBe(412);
      expect(stale.body.code).toBe('STALE_VERSION');
      expect((await as(api, admin).get(`${A}/workers/${worker.workerId}`)).body.name).toBe(
        'Renamed One',
      );

      const latest = (await as(api, admin).get(`${A}/workers/${worker.workerId}`)).headers.etag;
      expect(latest).not.toBe(etag);
      expect((await edit('Renamed Three', latest)).status).toBe(200);
      expect((await edit('Renamed Four')).status).toBe(200); // no header: as before
      expect((await edit('Renamed Five', '*')).status).toBe(200);
    });

    it('guards the customer verification status the same way', async () => {
      const c = await newCustomer('Guarded One', false);
      const etag = (await as(api, admin).get(`${A}/customers/${c.customerId}`)).headers.etag;
      const set = (status: string, ifMatch?: string) => {
        const call = as(api, admin).patch(`${A}/customers/${c.customerId}/verification-status`, {
          status,
        });
        return ifMatch ? call.set('If-Match', ifMatch) : call;
      };
      expect((await set('PENDING', '"1"')).status).toBe(412);
      expect((await set('VERIFIED', etag)).status).toBe(200);
      expect((await set('PENDING', etag)).status).toBe(412);
    });
  });

  // ------------------------------------------------------------------------------------------------------------
  describe('start-date guard', () => {
    it('stops a customer or worker starting before the agreed start date; staff may', async () => {
      const worker = await onboardWorker(api, { areaIds: [area.id] });
      await approveCheck(api, admin, worker, 'IDENTITY');
      const c = as(api, customer);
      const created = await c
        .post('/api/v1/bookings', {
          category: 'HOUSE_MAID',
          areaId: area.id,
          engagement: 'PART_TIME',
          availableFrom: '09:00',
          availableTo: '12:00',
          workerId: worker.workerId,
        })
        .expect(201);
      const id = (created.body as { id: string }).id;
      await c
        .post(`/api/v1/bookings/${id}/schedule`, {
          scheduleType: 'INTERVIEW',
          scheduledAt: new Date(Date.now() + 2 * 86400000).toISOString(),
        })
        .expect(200);
      await c.post(`/api/v1/bookings/${id}/interview-complete`, { outcomeNote: 'ok' }).expect(200);
      await c.post(`/api/v1/bookings/${id}/confirm-worker`, { startDate: inDays(3) }).expect(200);
      await payForBooking(api, admin, customer, id);

      const early = await c.post(`/api/v1/bookings/${id}/start`);
      expect(early.status).toBe(422);
      expect(early.body.code).toBe('START_TOO_EARLY');
      const byWorker = await as(api, worker).post(`/api/v1/workers/me/bookings/${id}/start`);
      expect(byWorker.status).toBe(422);
      expect((await as(api, customer).get(`/api/v1/bookings/${id}`)).body.status).toBe('CONFIRMED');

      const staff = await as(api, admin).post(`${A}/bookings/${id}/start`);
      expect(staff.status).toBe(200);
      expect(staff.body.status).toBe('ACTIVE');
    });

    it('lets a booking start on its start date', async () => {
      const b = await makeBooking(api, admin, customer, area.id, 'ACTIVE');
      expect((await as(api, customer).get(`/api/v1/bookings/${b.id}`)).body.status).toBe('ACTIVE');
    });
  });

  // ------------------------------------------------------------------------------------------------------------
  describe('Super Admin password reset', () => {
    it('sets a temporary password once, signs the admin out everywhere and is audited without the secret', async () => {
      const target = await loginAdmin(api, 'OPERATIONS_ADMIN');
      const targetPassword = target.password;
      const res = await as(api, admin).post(`${A}/users/${target.userId}/password-reset`);
      expect(res.status).toBe(200);
      expect(res.headers['cache-control']).toContain('no-store');
      const temporary = res.body.temporaryPassword as string;
      expect(temporary.length).toBeGreaterThanOrEqual(20);
      expect(temporary).toMatch(/[a-z]/);
      expect(temporary).toMatch(/[A-Z]/);
      expect(temporary).toMatch(/[0-9]/);
      expect(temporary).toMatch(/[^A-Za-z0-9]/);

      const stale = await adminLogin(api, { email: target.email!, password: targetPassword });
      expect(stale.status).toBe(401);
      const fresh = await adminLogin(api, { email: target.email!, password: temporary });
      expect(fresh.status).toBe(200);

      // the sessions that existed before the reset are gone (the revocation runs right after the response)
      await new Promise((r) => setTimeout(r, 300));
      const refreshed = await api
        .http()
        .post('/api/v1/auth/token/refresh')
        .send({ refreshToken: target.refreshToken });
      expect(refreshed.status).toBe(401);

      const rows = await audits('admin.password_reset', target.userId);
      expect(rows).toHaveLength(1);
      expect(rows[0].actorId).toBe(admin.userId);
      expect(JSON.stringify(rows[0])).not.toContain(temporary);

      const second = await as(api, admin).post(`${A}/users/${target.userId}/password-reset`);
      expect(second.body.temporaryPassword).not.toBe(temporary);
    });

    it('refuses your own account, customers and anyone but a Super Admin', async () => {
      const own = await as(api, admin).post(`${A}/users/${admin.userId}/password-reset`);
      expect(own.status).toBe(422);
      expect(own.body.code).toBe('USE_CHANGE_PASSWORD');
      const notAdmin = await as(api, admin).post(`${A}/users/${customer.userId}/password-reset`);
      expect(notAdmin.status).toBe(422);
      expect(notAdmin.body.code).toBe('NOT_AN_ADMIN');
      expect((await as(api, admin).post(`${A}/users/${UNKNOWN_ID}/password-reset`)).status).toBe(
        404,
      );

      const ops = await loginAdmin(api, 'OPERATIONS_ADMIN');
      const victim = await createAdmin(api, 'SUPPORT_EXECUTIVE');
      expect((await as(api, ops).post(`${A}/users/${victim.id}/password-reset`)).status).toBe(403);
      expect((await as(api, customer).post(`${A}/users/${victim.id}/password-reset`)).status).toBe(
        403,
      );
      expect((await api.http().post(`${A}/users/${victim.id}/password-reset`)).status).toBe(401);
      // the victim's password did not change
      expect(
        (await adminLogin(api, { email: victim.email, password: ADMIN_PASSWORD })).status,
      ).toBe(200);
    });
  });

  // ------------------------------------------------------------------------------------------------------------
  describe('emergency-contact and address reads are audited', () => {
    it('records who opened a worker profile with its sensitive groups', async () => {
      const worker = await onboardWorker(api, { areaIds: [area.id] });
      const before = (await audits('worker.sensitive_view', worker.workerId)).length;
      await as(api, admin).get(`${A}/workers/${worker.workerId}`).expect(200);
      const rows = await audits('worker.sensitive_view', worker.workerId);
      expect(rows).toHaveLength(before + 1);
      expect(rows.at(-1)).toMatchObject({ actorId: admin.userId });
      expect(rows.at(-1)!.metadata).toMatchObject({
        groups: ['address', 'criminalDeclaration'],
      });
      // the list never opens the sensitive groups, so it is not an access event
      await as(api, admin).get(`${A}/workers?limit=5`).expect(200);
      expect(await audits('worker.sensitive_view', worker.workerId)).toHaveLength(before + 1);
    });
  });

  // ------------------------------------------------------------------------------------------------------------
  describe('customer auto-verification', () => {
    const status = async (c: { customerId: string }): Promise<string> =>
      (await as(api, admin).get(`${A}/customers/${c.customerId}`)).body
        .verificationStatus as string;
    const addAddress = (c: Session) =>
      as(api, c)
        .post('/api/v1/customers/me/addresses', {
          line: '5 Market Street',
          area: area.name,
          city: area.city,
          pincode: '500081',
        })
        .expect(201);

    it('verifies a customer once they have a complete profile and an address, and unverifies without one', async () => {
      const c = await newCustomer('Auto One', false);
      expect(await status(c)).toBe('PENDING');
      const first = await addAddress(c);
      expect(await status(c)).toBe('VERIFIED');
      const second = await addAddress(c);
      await as(api, c).delete(`/api/v1/customers/me/addresses/${first.body.id}`).expect(204);
      expect(await status(c)).toBe('VERIFIED'); // still has one
      await as(api, c).delete(`/api/v1/customers/me/addresses/${second.body.id}`).expect(204);
      expect(await status(c)).toBe('PENDING');
      expect((await audits('customer.auto_verification', c.customerId)).length).toBe(2);
    });

    it('never overrides what staff decided', async () => {
      const c = await newCustomer('Auto Two', false);
      await as(api, admin)
        .patch(`${A}/customers/${c.customerId}/verification-status`, {
          status: 'PENDING',
          note: 'hold',
        })
        .expect(200);
      await addAddress(c);
      expect(await status(c)).toBe('PENDING'); // staff said PENDING: the address does not change it
      await as(api, admin)
        .patch(`${A}/customers/${c.customerId}/verification-status`, { status: 'VERIFIED' })
        .expect(200);
      const profile = await as(api, c).get('/api/v1/customers/me');
      const addresses = (await as(api, c).get('/api/v1/customers/me/addresses')).body as Array<{
        id: string;
      }>;
      for (const a of addresses)
        await as(api, c).delete(`/api/v1/customers/me/addresses/${a.id}`).expect(204);
      expect(profile.status).toBe(200);
      expect(await status(c)).toBe('VERIFIED'); // staff said VERIFIED: removing addresses does not change it
    });
  });

  // ------------------------------------------------------------------------------------------------------------
  describe('malware scanning of KYC uploads', () => {
    const V = '/api/v1/workers/me/verification';
    let scanner: MalwareScanner & { enabled: boolean };
    const original = { enabled: false, scan: undefined as unknown };

    beforeAll(() => {
      scanner = api.app.get<MalwareScanner & { enabled: boolean }>(MALWARE_SCANNER);
      original.enabled = scanner.enabled;
      original.scan = scanner.scan;
    });
    afterEach(() => {
      Object.defineProperty(scanner, 'enabled', { value: original.enabled, configurable: true });
      scanner.scan = original.scan as MalwareScanner['scan'];
    });
    const upload = async () => {
      const w = await onboardWorker(api, { areaIds: [area.id], previousEmployer: true });
      const slot = await as(api, w)
        .post(`${V}/checks/IDENTITY/documents`, { contentType: 'application/pdf', sizeBytes: 400 })
        .expect(201);
      const key = api.storage.issuedUploads.at(-1)!.objectKey;
      api.storage.simulateUpload(key, 400, buildSampleFile('application/pdf', 400));
      const documentId = slot.body.documentId as string;
      return {
        w,
        key,
        documentId,
        confirm: () => as(api, w).post(`${V}/documents/${documentId}/confirm`),
      };
    };
    const enable = (scan: MalwareScanner['scan']) => {
      Object.defineProperty(scanner, 'enabled', { value: true, configurable: true });
      scanner.scan = scan;
    };

    it('is off by default: the readiness report says documents are not scanned, and uploads still work', async () => {
      expect(scanner.enabled).toBe(false);
      const u = await upload();
      expect((await u.confirm()).status).toBe(200);
      const report = await as(api, admin).get(`${A}/system/readiness`);
      const check = (
        report.body.checks as Array<{ key: string; ok: boolean; message: string }>
      ).find((c) => c.key === 'malware_scanning')!;
      expect(check.ok).toBe(false);
      expect(check.message).toContain('NOT scanned');
      const templates = (report.body.checks as Array<{ key: string; message: string }>).find(
        (c) => c.key === 'notification_templates',
      )!;
      expect(templates.message).not.toContain('PAYMENT_EXCEPTION_ALERT');
    });

    it('accepts a clean file, scanned', async () => {
      const scan = jest.fn().mockResolvedValue({ clean: true });
      enable(scan);
      const u = await upload();
      expect((await u.confirm()).status).toBe(200);
      expect(scan).toHaveBeenCalledTimes(1);
      expect((scan.mock.calls[0] as [Buffer])[0].length).toBe(400);
    });

    it('rejects and deletes an infected file, and leaves the document unconfirmed', async () => {
      enable(jest.fn().mockResolvedValue({ clean: false, signature: 'Eicar-Test-Signature' }));
      const u = await upload();
      const res = await u.confirm();
      expect(res.status).toBe(422);
      expect(res.body.code).toBe('DOCUMENT_MALWARE_DETECTED');
      expect(api.storage.has(u.key)).toBe(false);
      const row = await api.prisma.verificationDocument.findUniqueOrThrow({
        where: { id: u.documentId },
      });
      expect(row).toMatchObject({
        status: 'PENDING_UPLOAD',
        uploadedAt: null,
        rejectionCode: 'MALWARE_DETECTED',
      });
    });

    it('never accepts a file it could not scan: 503, the document stays unconfirmed and can be confirmed later', async () => {
      enable(jest.fn().mockRejectedValue(new ProviderError('clamav', 'down', true)));
      const u = await upload();
      const res = await u.confirm();
      expect(res.status).toBe(503);
      expect(api.storage.has(u.key)).toBe(true);
      const row = await api.prisma.verificationDocument.findUniqueOrThrow({
        where: { id: u.documentId },
      });
      expect(row).toMatchObject({ status: 'PENDING_UPLOAD', uploadedAt: null });

      enable(jest.fn().mockResolvedValue({ clean: true }));
      expect((await u.confirm()).status).toBe(200);
    });
  });
});
