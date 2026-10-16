import '../support/env-api-integration';
import { ApiApp, createApiApp, loginAdmin, loginWithOtp, unique } from '../support/api-app';
import {
  MAPS_PROVIDER,
  type MapsProvider,
} from '../../src/integrations/maps/maps-provider.interface';
import { InMemoryMapsProvider } from '../../src/integrations/maps/maps-providers';
import { ProviderError } from '../../src/integrations/provider-error';
import {
  approveCheck,
  as,
  createArea,
  onboardWorker,
  setRequiredChecks,
  OnboardedWorker,
} from '../support/workforce';

const ADDRESSES = '/api/v1/customers/me/addresses';

/** Maps (DEC-18): geocoding on save never blocks a save; DISTANCE_ASC orders by an approximate worker location. */
describe('Maps: geocoding and distance ordering (integration)', () => {
  let api: ApiApp;
  let admin: Awaited<ReturnType<typeof loginAdmin>>;
  let area: { id: string };
  let maps: InMemoryMapsProvider;

  const address = (line: string, extra: object = {}) => ({
    line,
    area: 'Madhapur',
    city: 'Hyderabad',
    pincode: '500081',
    ...extra,
  });
  const customerWithProfile = async () => {
    const session = await loginWithOtp(api, { appType: 'CUSTOMER' });
    await as(api, session)
      .post('/api/v1/customers/me', {
        name: 'Maps Test',
        email: `maps.${unique()}@example.test`,
        preferredLanguage: 'en',
      })
      .expect(201);
    return session;
  };
  const workerAt = async (line: string): Promise<OnboardedWorker> => {
    const worker = await onboardWorker(api, { areaIds: [area.id] });
    await approveCheck(api, admin, worker, 'IDENTITY');
    await as(api, worker)
      .patch('/api/v1/workers/me', { address: address(line) })
      .expect(200);
    return worker;
  };
  const locationOf = async (workerId: string) =>
    api.prisma.workerProfile.findUniqueOrThrow({
      where: { id: workerId },
      select: { addressLatitude: true, addressLongitude: true },
    });

  beforeAll(async () => {
    api = await createApiApp();
    maps = api.app.get<MapsProvider>(MAPS_PROVIDER) as InMemoryMapsProvider;
    admin = await loginAdmin(api);
    area = await createArea(api, admin);
    await setRequiredChecks(api, admin, ['IDENTITY']);
  });
  afterAll(async () => {
    await setRequiredChecks(api, admin, []);
    await api.close();
  });
  afterEach(() => {
    maps.failWith = null;
    maps.unknownIsNotFound = false;
    maps.points.clear();
  });

  describe('customer addresses', () => {
    it('geocodes a saved address, keeps a location the customer sent, and re-geocodes when the text changes', async () => {
      const customer = await customerWithProfile();
      maps.points.set('Lake View', { latitude: 17.4501234, longitude: 78.3801234 });
      const created = await as(api, customer)
        .post(ADDRESSES, address('12 Lake View Road'))
        .expect(201);
      expect(created.body.latitude).toBeCloseTo(17.450123, 5);
      expect(created.body.longitude).toBeCloseTo(78.380123, 5);

      const before = maps.requests.length;
      const explicit = await as(api, customer)
        .post(ADDRESSES, address('Somewhere Else', { latitude: 12.5, longitude: 77.5 }))
        .expect(201);
      expect(explicit.body).toMatchObject({ latitude: 12.5, longitude: 77.5 });
      expect(maps.requests.length).toBe(before); // nothing to look up

      // an existing location is never replaced behind the customer's back, even when the text is edited
      maps.points.set('Hill Top', { latitude: 17.1, longitude: 78.1 });
      const edited = await as(api, customer)
        .patch(`${ADDRESSES}/${created.body.id}`, { line: '9 Hill Top Lane' })
        .expect(200);
      expect(edited.body.latitude).toBeCloseTo(17.450123, 5);

      // an address without a location gets one when it is edited
      maps.unknownIsNotFound = true;
      const bare = await as(api, customer).post(ADDRESSES, address('Unmapped Colony')).expect(201);
      expect(bare.body.latitude).toBeNull();
      maps.unknownIsNotFound = false;
      const found = await as(api, customer)
        .patch(`${ADDRESSES}/${bare.body.id}`, { line: '9 Hill Top Lane' })
        .expect(200);
      expect(found.body).toMatchObject({ latitude: 17.1, longitude: 78.1 });
    });

    it('never blocks a save: provider failure, no result, or a disabled lookup leave the address without coordinates', async () => {
      const customer = await customerWithProfile();
      maps.failWith = new ProviderError('google-maps', 'google-maps answered HTTP 503', true);
      const failing = await as(api, customer).post(ADDRESSES, address('1 Outage Street'));
      expect(failing.status).toBe(201);
      expect(failing.body).toMatchObject({
        latitude: null,
        longitude: null,
        line: '1 Outage Street',
      });

      maps.failWith = null;
      maps.unknownIsNotFound = true;
      const notFound = await as(api, customer).post(ADDRESSES, address('Nowhere Lane'));
      expect(notFound.status).toBe(201);
      expect(notFound.body.latitude).toBeNull();

      // editing never fails either, and a failed lookup keeps whatever location is there
      maps.unknownIsNotFound = false;
      maps.points.set('Old Place', { latitude: 17.2, longitude: 78.2 });
      const good = await as(api, customer).post(ADDRESSES, address('3 Old Place')).expect(201);
      expect(good.body.latitude).toBe(17.2);
      maps.failWith = new ProviderError('google-maps', 'down', true);
      const kept = await as(api, customer)
        .patch(`${ADDRESSES}/${good.body.id}`, { line: '3 New Place' })
        .expect(200);
      expect(kept.body).toMatchObject({ line: '3 New Place', latitude: 17.2, longitude: 78.2 });
    });
  });

  describe('worker addresses and distance ordering', () => {
    it('stores only an approximate point (about 1 km) and never returns it', async () => {
      const worker = await onboardWorker(api, { areaIds: [area.id] });
      maps.points.set('Rounded Road', { latitude: 17.456789, longitude: 78.387654 });
      const saved = await as(api, worker)
        .patch('/api/v1/workers/me', { address: address('5 Rounded Road') })
        .expect(200);
      expect(await locationOf(worker.workerId)).toEqual({
        addressLatitude: 17.46,
        addressLongitude: 78.39,
      });
      expect(JSON.stringify(saved.body)).not.toMatch(/17\.4|78\.3|latitude|longitude/i);

      // a failing lookup does not block the edit and clears the stale point
      maps.failWith = new ProviderError('google-maps', 'down', true);
      await as(api, worker)
        .patch('/api/v1/workers/me', { address: address('6 Other Road') })
        .expect(200);
      expect(await locationOf(worker.workerId)).toEqual({
        addressLatitude: null,
        addressLongitude: null,
      });
      // editing something else leaves the location alone
      maps.failWith = null;
      maps.points.set('Kept Road', { latitude: 17.5, longitude: 78.5 });
      await as(api, worker)
        .patch('/api/v1/workers/me', { address: address('7 Kept Road') })
        .expect(200);
      await as(api, worker).patch('/api/v1/workers/me', { experienceMonths: 40 }).expect(200);
      expect(await locationOf(worker.workerId)).toEqual({
        addressLatitude: 17.5,
        addressLongitude: 78.5,
      });
    });

    it('orders workers nearest first with unknown locations last, and validates the origin', async () => {
      maps.points.set('NearHouse', { latitude: 17.4, longitude: 78.4 });
      maps.points.set('MidHouse', { latitude: 17.6, longitude: 78.6 });
      maps.points.set('FarHouse', { latitude: 18.5, longitude: 79.5 });
      const far = await workerAt('FarHouse 1');
      const near = await workerAt('NearHouse 1');
      const mid = await workerAt('MidHouse 1');
      maps.unknownIsNotFound = true;
      const unknown = await workerAt('Unmapped 1');
      expect((await locationOf(unknown.workerId)).addressLatitude).toBeNull();

      const customer = await loginWithOtp(api, { appType: 'CUSTOMER' });
      const search = async (query: string) =>
        as(api, customer).get(
          `/api/v1/search/workers?category=HOUSE_MAID&areaId=${area.id}&limit=100${query}`,
        );
      const ids = (res: { body: { data: Array<{ workerId: string }> } }) =>
        res.body.data.map((w) => w.workerId);

      const nearest = await search('&sort=DISTANCE_ASC&latitude=17.4&longitude=78.4');
      expect(nearest.status).toBe(200);
      expect(ids(nearest)).toEqual([near.workerId, mid.workerId, far.workerId, unknown.workerId]);

      const fromFar = await search('&sort=DISTANCE_ASC&latitude=18.5&longitude=79.5');
      expect(ids(fromFar)).toEqual([far.workerId, mid.workerId, near.workerId, unknown.workerId]);

      // no coordinates leak into the cards
      expect(JSON.stringify(nearest.body)).not.toMatch(/latitude|longitude|addressLine/i);

      expect((await search('&sort=DISTANCE_ASC')).status).toBe(400);
      expect((await search('&sort=DISTANCE_ASC&latitude=17.4')).status).toBe(400);
      expect((await search('&sort=DISTANCE_ASC&latitude=95&longitude=78')).status).toBe(400);
      expect((await search('&sort=DISTANCE_ASC&latitude=abc&longitude=78')).status).toBe(400);
      // other orderings ignore the origin
      expect((await search('&latitude=17.4&longitude=78.4')).status).toBe(200);
    });
  });
});
