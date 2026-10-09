import '../support/env-api-integration';
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

/** Availability + service areas against the REAL PostgreSQL + Redis (dedicated test database), through the HTTP API. */
describe('Availability API (integration)', () => {
  let api: ApiApp;
  let superAdmin: Awaited<ReturnType<typeof loginAdmin>>;
  let cookId: string;

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

  async function newArea(extra: object = {}): Promise<{ id: string; name: string; city: string }> {
    const res = await as(superAdmin).post('/api/v1/admin/service-areas', {
      name: `Area ${unique()}`,
      city: `City ${unique()}`,
      ...extra,
    });
    expect(res.status).toBe(201);
    return res.body as { id: string; name: string; city: string };
  }

  const windowsOf = async (worker: Worker): Promise<Array<{ start: string; end: string }>> =>
    (await as(worker).get('/api/v1/workers/me/availability')).body.timeWindows as Array<{
      start: string;
      end: string;
    }>;

  beforeAll(async () => {
    api = await createApiApp();
    superAdmin = await loginAdmin(api);
    cookId = (await api.prisma.serviceCategory.findUniqueOrThrow({ where: { code: 'COOK' } })).id;
  });
  afterAll(async () => {
    await api.close();
  });

  describe('service areas (master)', () => {
    const base = '/api/v1/admin/service-areas';

    it('lets an admin add an area (audited) that customers and workers can then read', async () => {
      const city = `City ${unique()}`;
      const res = await as(superAdmin).post(base, { name: '  Madhapur ', city });
      expect(res.status).toBe(201);
      expect(res.body).toMatchObject({ name: 'Madhapur', city, isEnabled: true });
      const audit = await api.prisma.auditLog.findMany({
        where: { action: 'service_area.create', entityId: res.body.id },
      });
      expect(audit).toHaveLength(1);
      expect(audit[0]).toMatchObject({ actorId: superAdmin.userId, actorRole: 'SUPER_ADMIN' });

      const customer = await loginWithOtp(api, { appType: 'CUSTOMER' });
      const list = await as(customer).get(
        `/api/v1/service-areas?city=${encodeURIComponent(city.toUpperCase())}`,
      );
      expect(list.status).toBe(200);
      expect(list.body.data).toEqual([{ id: res.body.id, name: 'Madhapur', city }]);
      expect(list.body.meta).toEqual({ page: 1, limit: 20, total: 1 });
      expect((await as(customer).get(`/api/v1/service-areas/${res.body.id}`)).status).toBe(200);
    });

    it('keeps names unique within a city (ignoring case) but allows the same name in another city', async () => {
      const city = `City ${unique()}`;
      await as(superAdmin).post(base, { name: 'Gachibowli', city }).expect(201);
      const dup = await as(superAdmin).post(base, { name: 'GACHIBOWLI', city: city.toLowerCase() });
      expect(dup.status).toBe(409);
      expect(dup.body.code).toBe('AREA_DUPLICATE');
      await as(superAdmin)
        .post(base, { name: 'Gachibowli', city: `Other ${unique()}` })
        .expect(201);
    });

    it('creates exactly one area when the same request is sent in parallel', async () => {
      const payload = { name: `Parallel ${unique()}`, city: `City ${unique()}` };
      const results = await Promise.all(
        Array.from({ length: 5 }, () => as(superAdmin).post(base, payload)),
      );
      expect(results.filter((r) => r.status === 201)).toHaveLength(1);
      expect(results.filter((r) => r.status === 409)).toHaveLength(4);
    });

    it.each([
      ['name too short', { name: 'A' }],
      ['city too short', { city: 'H' }],
      ['name too long', { name: 'N'.repeat(101) }],
      ['missing name', { name: undefined }],
      ['missing city', { city: undefined }],
    ])('rejects %s', async (_n, bad) => {
      const res = await as(superAdmin).post(base, {
        name: `Area ${unique()}`,
        city: `City ${unique()}`,
        ...bad,
      });
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('VALIDATION_FAILED');
    });

    it('ignores server-controlled fields (mass assignment) and audits before/after on update', async () => {
      const created = await as(superAdmin).post(base, {
        name: `Area ${unique()}`,
        city: `City ${unique()}`,
        id: UNKNOWN_ID,
        isEnabled: false,
      });
      expect(created.status).toBe(201);
      expect(created.body.id).not.toBe(UNKNOWN_ID);
      expect(created.body.isEnabled).toBe(true);

      const newName = `Renamed ${unique()}`;
      const updated = await as(superAdmin).patch(`${base}/${created.body.id}`, {
        name: newName,
        isEnabled: false,
      });
      expect(updated.status).toBe(200);
      const audit = await api.prisma.auditLog.findMany({
        where: { action: 'service_area.update', entityId: created.body.id },
      });
      expect(audit).toHaveLength(1);
      expect(audit[0].metadata).toEqual({
        changes: {
          name: { from: created.body.name, to: newName },
          isEnabled: { from: true, to: false },
        },
      });
      await as(superAdmin).patch(`${base}/${created.body.id}`, { name: newName }).expect(200);
      expect(
        await api.prisma.auditLog.count({
          where: { action: 'service_area.update', entityId: created.body.id },
        }),
      ).toBe(1);
    });

    it('rejects clashing renames, empty updates and unknown ids', async () => {
      const city = `City ${unique()}`;
      const a = await as(superAdmin).post(base, { name: 'Alpha Area', city }).expect(201);
      const b = await as(superAdmin).post(base, { name: 'Beta Area', city }).expect(201);
      const clash = await as(superAdmin).patch(`${base}/${b.body.id}`, { name: 'alpha area' });
      expect(clash.status).toBe(409);
      expect((await as(superAdmin).patch(`${base}/${a.body.id}`, {})).status).toBe(400);
      expect(
        (await as(superAdmin).patch(`${base}/${UNKNOWN_ID}`, { name: 'Valid Name' })).status,
      ).toBe(404);
      expect((await as(superAdmin).patch(`${base}/nope`, { name: 'Valid Name' })).status).toBe(400);
    });

    it('hides disabled areas from customers and workers but not from admins', async () => {
      const area = await newArea();
      await as(superAdmin).patch(`${base}/${area.id}`, { isEnabled: false }).expect(200);
      const customer = await loginWithOtp(api, { appType: 'CUSTOMER' });
      const list = await as(customer).get(
        `/api/v1/service-areas?city=${encodeURIComponent(area.city)}`,
      );
      expect(list.body.data).toEqual([]);
      expect((await as(customer).get(`/api/v1/service-areas/${area.id}`)).status).toBe(404);
      const adminView = await as(superAdmin).get(
        `${base}?city=${encodeURIComponent(area.city)}&isEnabled=false`,
      );
      expect(adminView.body.data.map((a: { id: string }) => a.id)).toEqual([area.id]);
      expect((await as(superAdmin).get(`${base}/${area.id}`)).body.isEnabled).toBe(false);
      expect((await as(customer).get('/api/v1/service-areas?page=0')).status).toBe(400);
    });

    it('refuses modification to workers, customers and admins without area.manage', async () => {
      const area = await newArea();
      const worker = await newWorker();
      const customer = await loginWithOtp(api, { appType: 'CUSTOMER' });
      const wrongPermission = await loginAdminWithPermissions(api, [
        'category.manage',
        'worker.manage',
      ]);
      for (const caller of [worker, customer, wrongPermission]) {
        for (const res of [
          await as(caller).get(base),
          await as(caller).post(base, { name: `Hijack ${unique()}`, city: 'Nowhere City' }),
          await as(caller).patch(`${base}/${area.id}`, { isEnabled: false }),
        ]) {
          expect(res.status).toBe(403);
        }
      }
      await api.http().post(base).send({ name: 'Anonymous', city: 'Nowhere City' }).expect(401);
      expect(
        (await api.prisma.serviceArea.findUniqueOrThrow({ where: { id: area.id } })).isEnabled,
      ).toBe(true);
      const manager = await loginAdminWithPermissions(api, ['area.manage']);
      expect((await as(manager).patch(`${base}/${area.id}`, { isEnabled: false })).status).toBe(
        200,
      );
    });
  });

  describe('worker availability', () => {
    const url = '/api/v1/workers/me/availability';

    it('needs a profile first, then starts empty', async () => {
      const worker = await newWorker(false);
      const res = await as(worker).get(url);
      expect(res.status).toBe(404);
      expect(res.body.code).toBe('WORKER_PROFILE_NOT_FOUND');
      expect((await as(worker).patch(url, { engagementPreference: 'FULL_TIME' })).status).toBe(404);

      const withProfile = await newWorker();
      expect((await as(withProfile).get(url)).body).toEqual({
        engagementPreference: null,
        areas: [],
        timeWindows: [],
      });
    });

    it('saves preference, areas and windows; windows come back as sorted HH:mm', async () => {
      const worker = await newWorker();
      const [a1, a2] = [await newArea(), await newArea()];
      const res = await as(worker).patch(url, {
        engagementPreference: 'PART_TIME',
        areaIds: [a2.id, a1.id],
        timeWindows: [
          { start: '14:00', end: '18:30' },
          { start: '06:00', end: '10:00' },
        ],
      });
      expect(res.status).toBe(200);
      expect(res.body.engagementPreference).toBe('PART_TIME');
      expect(res.body.areas.map((a: { id: string }) => a.id).sort()).toEqual([a1.id, a2.id].sort());
      expect(res.body.areas[0]).toEqual(expect.objectContaining({ isEnabled: true }));
      expect(res.body.timeWindows).toEqual([
        { start: '06:00', end: '10:00' },
        { start: '14:00', end: '18:30' },
      ]);
      expect((await as(worker).get(url)).body).toEqual(res.body);
    });

    it('treats each part independently: only the parts sent are replaced', async () => {
      const worker = await newWorker();
      const [a1, a2] = [await newArea(), await newArea()];
      await as(worker)
        .patch(url, {
          engagementPreference: 'FULL_TIME',
          areaIds: [a1.id],
          timeWindows: [{ start: '08:00', end: '12:00' }],
        })
        .expect(200);

      const onlyPreference = await as(worker).patch(url, { engagementPreference: 'LIVE_IN' });
      expect(onlyPreference.body).toMatchObject({
        engagementPreference: 'LIVE_IN',
        timeWindows: [{ start: '08:00', end: '12:00' }],
      });
      expect(onlyPreference.body.areas).toHaveLength(1);

      const onlyAreas = await as(worker).patch(url, { areaIds: [a2.id] });
      expect(onlyAreas.body.areas.map((a: { id: string }) => a.id)).toEqual([a2.id]);
      expect(onlyAreas.body.engagementPreference).toBe('LIVE_IN');

      const onlyWindows = await as(worker).patch(url, {
        timeWindows: [{ start: '09:00', end: '10:00' }],
      });
      expect(onlyWindows.body.timeWindows).toEqual([{ start: '09:00', end: '10:00' }]);
      expect(onlyWindows.body.areas.map((a: { id: string }) => a.id)).toEqual([a2.id]);
    });

    it('accepts windows that touch each other, a window ending at midnight, and whole-day coverage', async () => {
      const worker = await newWorker();
      const res = await as(worker).patch(url, {
        timeWindows: [
          { start: '12:00', end: '24:00' },
          { start: '00:00', end: '12:00' },
        ],
      });
      expect(res.status).toBe(200);
      expect(res.body.timeWindows).toEqual([
        { start: '00:00', end: '12:00' },
        { start: '12:00', end: '24:00' },
      ]);
    });

    it.each([
      ['single-digit hour', [{ start: '9:00', end: '10:00' }]],
      ['hour 25', [{ start: '09:00', end: '25:00' }]],
      ['minute 60', [{ start: '09:60', end: '10:00' }]],
      ['24:01', [{ start: '09:00', end: '24:01' }]],
      ['start equals end', [{ start: '09:00', end: '09:00' }]],
      ['start after end', [{ start: '18:00', end: '09:00' }]],
      ['overnight window', [{ start: '22:00', end: '02:00' }]],
      ['start at 24:00', [{ start: '24:00', end: '24:00' }]],
      [
        'overlap',
        [
          { start: '09:00', end: '13:00' },
          { start: '12:59', end: '15:00' },
        ],
      ],
      [
        'contained window',
        [
          { start: '08:00', end: '18:00' },
          { start: '10:00', end: '12:00' },
        ],
      ],
      [
        'duplicate window',
        [
          { start: '09:00', end: '12:00' },
          { start: '09:00', end: '12:00' },
        ],
      ],
      ['empty list', []],
      ['missing end', [{ start: '09:00' }]],
      ['not an array', 'morning'],
      [
        '25 windows',
        Array.from({ length: 25 }, (_v, i) => ({
          start: `${String(i).padStart(2, '0')}:00`,
          end: `${String(i).padStart(2, '0')}:30`,
        })),
      ],
    ])('rejects windows: %s', async (_n, timeWindows) => {
      const worker = await newWorker();
      await as(worker)
        .patch(url, { timeWindows: [{ start: '07:00', end: '08:00' }] })
        .expect(200);
      const res = await as(worker).patch(url, { timeWindows });
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('VALIDATION_FAILED');
      expect(await windowsOf(worker)).toEqual([{ start: '07:00', end: '08:00' }]); // untouched
    });

    it.each([
      ['unknown preference', { engagementPreference: 'DAILY' }],
      ['lower-case preference', { engagementPreference: 'full_time' }],
      ['empty area list', { areaIds: [] }],
      ['duplicate areas', { areaIds: [UNKNOWN_ID, UNKNOWN_ID] }],
      ['non-uuid area', { areaIds: ['madhapur'] }],
      ['empty body', {}],
      ['server-only fields', { workerId: UNKNOWN_ID, id: UNKNOWN_ID }],
    ])('rejects %s', async (_n, bad) => {
      const worker = await newWorker();
      expect((await as(worker).patch(url, bad)).status).toBe(400);
    });

    it('is atomic: a failed request saves none of its parts', async () => {
      const worker = await newWorker();
      const area = await newArea();
      await as(worker)
        .patch(url, { engagementPreference: 'FULL_TIME', areaIds: [area.id] })
        .expect(200);

      const unknownArea = await as(worker).patch(url, {
        engagementPreference: 'LIVE_IN',
        timeWindows: [{ start: '09:00', end: '10:00' }],
        areaIds: [UNKNOWN_ID],
      });
      expect(unknownArea.status).toBe(400);
      const after = (await as(worker).get(url)).body;
      expect(after.engagementPreference).toBe('FULL_TIME');
      expect(after.timeWindows).toEqual([]);
      expect(after.areas.map((a: { id: string }) => a.id)).toEqual([area.id]);

      const overlap = await as(worker).patch(url, {
        engagementPreference: 'PART_TIME',
        timeWindows: [
          { start: '09:00', end: '12:00' },
          { start: '11:00', end: '13:00' },
        ],
      });
      expect(overlap.status).toBe(400);
      expect((await as(worker).get(url)).body.engagementPreference).toBe('FULL_TIME');
    });

    it('rejects a disabled area the worker does not hold (422) but lets a held one stay', async () => {
      const worker = await newWorker();
      const area = await newArea();
      const other = await newArea();
      await as(worker)
        .patch(url, { areaIds: [area.id] })
        .expect(200);
      await as(superAdmin)
        .patch(`/api/v1/admin/service-areas/${area.id}`, { isEnabled: false })
        .expect(200);
      await as(superAdmin)
        .patch(`/api/v1/admin/service-areas/${other.id}`, { isEnabled: false })
        .expect(200);

      const blocked = await as(worker).patch(url, { areaIds: [area.id, other.id] });
      expect(blocked.status).toBe(422);
      expect(blocked.body.code).toBe('AREA_NOT_AVAILABLE');
      const kept = await as(worker).patch(url, { areaIds: [area.id] });
      expect(kept.status).toBe(200);
      expect(kept.body.areas).toEqual([expect.objectContaining({ id: area.id, isEnabled: false })]);
    });

    it('audits what changed (counts and ids, no personal data) and nothing for rejected requests', async () => {
      const worker = await newWorker();
      const area = await newArea();
      await as(worker)
        .patch(url, {
          engagementPreference: 'PART_TIME',
          areaIds: [area.id],
          timeWindows: [{ start: '09:00', end: '12:00' }],
        })
        .expect(200);
      await as(worker)
        .patch(url, {
          timeWindows: [
            { start: '09:00', end: '12:00' },
            { start: '13:00', end: '17:00' },
          ],
        })
        .expect(200);
      await as(worker)
        .patch(url, {
          timeWindows: [
            { start: '09:00', end: '10:00' },
            { start: '09:30', end: '11:00' },
          ],
        })
        .expect(400);
      const audit = await api.prisma.auditLog.findMany({
        where: { action: 'availability.update', entityId: worker.workerId },
        orderBy: { createdAt: 'asc' },
      });
      expect(audit).toHaveLength(2);
      expect(audit[0].metadata).toEqual({
        changedParts: ['areaIds', 'engagementPreference', 'timeWindows'],
        engagementPreference: { from: null, to: 'PART_TIME' },
        areas: { added: [area.id], removed: [] },
        timeWindows: { before: 0, after: 1 },
      });
      expect(audit[1].metadata).toEqual({
        changedParts: ['timeWindows'],
        timeWindows: { before: 1, after: 2 },
      });
      expect(audit.every((a) => a.actorId === worker.userId)).toBe(true);
    });

    it('stays consistent when different window sets are saved in parallel (exactly one wins, never overlapping)', async () => {
      const worker = await newWorker();
      const sets = [
        [{ start: '06:00', end: '09:00' }],
        [
          { start: '09:00', end: '12:00' },
          { start: '14:00', end: '16:00' },
        ],
        [{ start: '00:00', end: '24:00' }],
        [
          { start: '18:00', end: '20:00' },
          { start: '20:00', end: '22:00' },
        ],
        [{ start: '10:00', end: '11:00' }],
        [
          { start: '07:00', end: '08:00' },
          { start: '08:30', end: '09:30' },
          { start: '12:00', end: '13:00' },
        ],
      ];
      const results = await Promise.all(
        sets.map((timeWindows) => as(worker).patch(url, { timeWindows })),
      );
      expect(results.every((r) => r.status === 200)).toBe(true);
      const final = JSON.stringify(await windowsOf(worker));
      expect(sets.map((s) => JSON.stringify(s))).toContain(final);
      const rows = await api.prisma.workerTimeWindow.findMany({
        where: { workerId: worker.workerId },
        orderBy: { startMinute: 'asc' },
      });
      for (let i = 1; i < rows.length; i++) {
        expect(rows[i].startMinute).toBeGreaterThanOrEqual(rows[i - 1].endMinute);
      }
    });

    it('stays consistent when different area sets are saved in parallel', async () => {
      const worker = await newWorker();
      const areas = await Promise.all(Array.from({ length: 4 }, () => newArea()));
      const sets = [
        [areas[0].id],
        [areas[1].id, areas[2].id],
        [areas[3].id],
        [areas[0].id, areas[3].id],
      ];
      const results = await Promise.all(sets.map((areaIds) => as(worker).patch(url, { areaIds })));
      expect(results.every((r) => r.status === 200)).toBe(true);
      const final = (
        await api.prisma.workerPreferredArea.findMany({ where: { workerId: worker.workerId } })
      )
        .map((r) => r.areaId)
        .sort();
      expect(sets.map((s) => [...s].sort().join(','))).toContain(final.join(','));
    });

    it('lets the database itself refuse overlapping, inverted and out-of-range windows', async () => {
      const worker = await newWorker();
      const insert = (startMinute: number, endMinute: number) =>
        api.prisma.workerTimeWindow.create({
          data: { workerId: worker.workerId, startMinute, endMinute },
        });
      await insert(540, 720); // 09:00-12:00
      await expect(insert(600, 780)).rejects.toThrow(); // overlaps
      await expect(insert(540, 720)).rejects.toThrow(); // duplicate
      await expect(insert(500, 541)).rejects.toThrow(); // overlaps the start
      await expect(insert(800, 800)).rejects.toThrow(); // empty
      await expect(insert(900, 800)).rejects.toThrow(); // inverted
      await expect(insert(-1, 10)).rejects.toThrow();
      await expect(insert(1000, 1441)).rejects.toThrow(); // past midnight
      await insert(720, 840); // touching is fine
      await insert(0, 540);
      expect(
        await api.prisma.workerTimeWindow.count({ where: { workerId: worker.workerId } }),
      ).toBe(3);
    });
  });

  describe('ownership and role isolation', () => {
    const url = '/api/v1/workers/me/availability';

    it("keeps every worker's availability separate", async () => {
      const a = await newWorker();
      const b = await newWorker();
      await as(a)
        .patch(url, { timeWindows: [{ start: '06:00', end: '09:00' }] })
        .expect(200);
      await as(b)
        .patch(url, { timeWindows: [{ start: '15:00', end: '18:00' }] })
        .expect(200);
      expect(await windowsOf(a)).toEqual([{ start: '06:00', end: '09:00' }]);
      expect(await windowsOf(b)).toEqual([{ start: '15:00', end: '18:00' }]);
    });

    it('is reserved for workers; the admin endpoints are reserved for admins with the right permission', async () => {
      const worker = await newWorker();
      const other = await newWorker();
      const customer = await loginWithOtp(api, { appType: 'CUSTOMER' });
      for (const caller of [customer, superAdmin]) {
        expect((await as(caller).get(url)).status).toBe(403);
        expect((await as(caller).patch(url, { engagementPreference: 'FULL_TIME' })).status).toBe(
          403,
        );
      }
      const adminUrl = `/api/v1/admin/workers/${worker.workerId}/availability`;
      for (const caller of [other, customer]) {
        expect((await as(caller).get(adminUrl)).status).toBe(403);
        expect((await as(caller).patch(adminUrl, { engagementPreference: 'LIVE_IN' })).status).toBe(
          403,
        );
      }
      await api.http().get(url).expect(401);
      await api.http().patch(adminUrl).send({ engagementPreference: 'LIVE_IN' }).expect(401);
      expect((await as(worker).get(url)).body.engagementPreference).toBeNull();
    });

    it('enforces view vs manage on the admin endpoints and records the admin as actor for assisted edits', async () => {
      const worker = await newWorker();
      const area = await newArea();
      const adminUrl = `/api/v1/admin/workers/${worker.workerId}/availability`;
      const viewer = await loginAdminWithPermissions(api, ['worker.view']);
      const manager = await loginAdminWithPermissions(api, ['worker.manage']);

      expect((await as(viewer).get(adminUrl)).status).toBe(200);
      expect((await as(viewer).patch(adminUrl, { engagementPreference: 'LIVE_IN' })).status).toBe(
        403,
      );
      expect((await as(manager).get(adminUrl)).status).toBe(403);
      const edited = await as(manager).patch(adminUrl, {
        engagementPreference: 'LIVE_IN',
        areaIds: [area.id],
        timeWindows: [{ start: '08:00', end: '20:00' }],
      });
      expect(edited.status).toBe(200);
      expect((await as(worker).get(url)).body).toMatchObject({
        engagementPreference: 'LIVE_IN',
        timeWindows: [{ start: '08:00', end: '20:00' }],
      });
      const audit = await api.prisma.auditLog.findFirstOrThrow({
        where: { action: 'availability.update', entityId: worker.workerId },
      });
      expect(audit.actorId).toBe(manager.userId);

      expect(
        (await as(superAdmin).get(`/api/v1/admin/workers/${UNKNOWN_ID}/availability`)).status,
      ).toBe(404);
      expect(
        (
          await as(superAdmin).patch(`/api/v1/admin/workers/${UNKNOWN_ID}/availability`, {
            engagementPreference: 'LIVE_IN',
          })
        ).status,
      ).toBe(404);
      expect((await as(superAdmin).get('/api/v1/admin/workers/nope/availability')).status).toBe(
        400,
      );
    });

    it('stops a suspended worker at once and changes nothing behind the rejected request', async () => {
      const worker = await newWorker();
      await as(superAdmin)
        .patch(`/api/v1/admin/users/${worker.userId}/status`, { status: 'SUSPENDED' })
        .expect(200);
      expect((await as(worker).patch(url, { engagementPreference: 'FULL_TIME' })).status).toBe(401);
      expect(
        await api.prisma.workerWorkPreference.count({ where: { workerId: worker.workerId } }),
      ).toBe(0);
    });
  });

  describe('submission journey (Workers + Categories + Availability together)', () => {
    it('lists the availability items as missing, then submits once everything required is saved', async () => {
      const worker = await newWorker();
      await as(worker)
        .patch('/api/v1/workers/me', {
          address,
          emergencyContact: { name: 'Lakshmi Devi', mobile: '9876543210' },
          languages: ['en'],
          experienceMonths: 24,
        })
        .expect(200);
      await as(worker)
        .put('/api/v1/workers/me/categories', { categoryIds: [cookId] })
        .expect(200);

      const early = await as(worker).post('/api/v1/workers/me/submit');
      expect(early.status).toBe(422);
      expect(early.body.details[0].messages.sort()).toEqual([
        'areas',
        'engagementPreference',
        'timeWindows',
      ]);
      expect((await as(worker).get('/api/v1/workers/me')).body.missingForSubmission.sort()).toEqual(
        ['areas', 'engagementPreference', 'timeWindows'],
      );

      const area = await newArea();
      await as(worker)
        .patch('/api/v1/workers/me/availability', { areaIds: [area.id] })
        .expect(200);
      expect(
        (await as(worker).post('/api/v1/workers/me/submit')).body.details[0].messages.sort(),
      ).toEqual(['engagementPreference', 'timeWindows']);
      await as(worker)
        .patch('/api/v1/workers/me/availability', {
          engagementPreference: 'FULL_TIME',
          timeWindows: [{ start: '08:00', end: '17:00' }],
        })
        .expect(200);

      const submitted = await as(worker).post('/api/v1/workers/me/submit');
      expect(submitted.status).toBe(200);
      expect(submitted.body).toMatchObject({
        onboardingStatus: 'SUBMITTED',
        missingForSubmission: [],
      });
      expect(submitted.body.submittedAt).not.toBeNull();

      // Idempotent: a repeat changes nothing and writes no second audit record.
      const again = await as(worker).post('/api/v1/workers/me/submit');
      expect(again.status).toBe(200);
      expect(again.body.submittedAt).toBe(submitted.body.submittedAt);
      expect(
        await api.prisma.auditLog.count({
          where: { action: 'worker.profile_submit', entityId: worker.workerId },
        }),
      ).toBe(1);

      // The admin queue sees it; later edits are still allowed and keep the status (open decision, documented).
      const queue = await as(superAdmin).get(
        '/api/v1/admin/workers?onboardingStatus=SUBMITTED&limit=100',
      );
      expect(queue.body.data.map((w: { id: string }) => w.id)).toContain(worker.workerId);
      const edit = await as(worker).patch('/api/v1/workers/me', { experienceMonths: 30 });
      expect(edit.status).toBe(200);
      expect(edit.body.onboardingStatus).toBe('SUBMITTED');
    });

    it('submits exactly once when the request is repeated in parallel', async () => {
      const worker = await newWorker();
      const area = await newArea();
      await as(worker)
        .patch('/api/v1/workers/me', {
          address,
          emergencyContact: { name: 'Lakshmi Devi', mobile: '9876543210' },
          languages: ['en'],
          experienceMonths: 1,
        })
        .expect(200);
      await as(worker)
        .put('/api/v1/workers/me/categories', { categoryIds: [cookId] })
        .expect(200);
      await as(worker)
        .patch('/api/v1/workers/me/availability', {
          engagementPreference: 'PART_TIME',
          areaIds: [area.id],
          timeWindows: [{ start: '09:00', end: '13:00' }],
        })
        .expect(200);
      const results = await Promise.all(
        Array.from({ length: 5 }, () => as(worker).post('/api/v1/workers/me/submit')),
      );
      expect(results.every((r) => r.status === 200)).toBe(true);
      expect(
        await api.prisma.auditLog.count({
          where: { action: 'worker.profile_submit', entityId: worker.workerId },
        }),
      ).toBe(1);
    });
  });

  describe('readiness for future Search/Matching', () => {
    it('answers "workers in area X available 09:00-12:00" with plain SQL, and the area lookup can use its index', async () => {
      const target = await newArea();
      const elsewhere = await newArea();
      const make = async (areaId: string, windows: Array<{ start: string; end: string }>) => {
        const worker = await newWorker();
        await as(worker)
          .patch('/api/v1/workers/me/availability', { areaIds: [areaId], timeWindows: windows })
          .expect(200);
        return worker;
      };
      const fits = await make(target.id, [{ start: '08:00', end: '13:00' }]);
      const fitsExactly = await make(target.id, [{ start: '09:00', end: '12:00' }]);
      const tooShort = await make(target.id, [{ start: '10:00', end: '12:00' }]);
      const wrongArea = await make(elsewhere.id, [{ start: '08:00', end: '13:00' }]);

      const query = (areaId: string) => api.prisma.$queryRaw<Array<{ worker_id: string }>>`
        SELECT DISTINCT a.worker_id
          FROM worker_preferred_areas a
          JOIN worker_time_windows w ON w.worker_id = a.worker_id
         WHERE a.area_id = ${areaId}::uuid
           AND w.start_minute <= ${540}
           AND w.end_minute >= ${720}`;
      const found = (await query(target.id)).map((r) => r.worker_id).sort();
      expect(found).toEqual([fits.workerId, fitsExactly.workerId].sort());
      expect(found).not.toContain(tooShort.workerId);
      expect(found).not.toContain(wrongArea.workerId);

      // With sequential scans disabled the planner must show it CAN use the reverse (area) index.
      const plan = await api.prisma.$transaction(async (tx) => {
        await tx.$executeRawUnsafe('SET LOCAL enable_seqscan = off');
        const rows = await tx.$queryRawUnsafe<Array<{ 'QUERY PLAN': string }>>(
          `EXPLAIN SELECT worker_id FROM worker_preferred_areas WHERE area_id = '${target.id}'`,
        );
        return rows.map((r) => r['QUERY PLAN']).join('\n');
      });
      expect(plan).toContain('worker_preferred_areas_area_id_idx');
    });
  });
});
