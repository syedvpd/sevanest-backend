import { haversineMeters } from './haversine';
import {
  DisabledMapsProvider,
  GoogleGeocodingProvider,
  InMemoryMapsProvider,
} from './maps-providers';

const settings = {
  apiKey: 'test-only-google-key',
  timeoutMs: 1000,
  baseUrl: 'https://maps.example.test',
};

describe('haversine', () => {
  it('measures known distances and is symmetric and zero on the same point', () => {
    const hyderabad = { latitude: 17.385, longitude: 78.4867 };
    const bengaluru = { latitude: 12.9716, longitude: 77.5946 };
    const km = haversineMeters(hyderabad, bengaluru) / 1000;
    expect(km).toBeGreaterThan(495);
    expect(km).toBeLessThan(505);
    expect(haversineMeters(bengaluru, hyderabad)).toBeCloseTo(
      haversineMeters(hyderabad, bengaluru),
      3,
    );
    expect(haversineMeters(hyderabad, hyderabad)).toBe(0);
  });
});

describe('Google Geocoding adapter (mocked HTTP, DEC-18)', () => {
  let fetchMock: jest.SpyInstance;
  afterEach(() => fetchMock?.mockRestore());
  const reply = (status: number, body: unknown) =>
    (fetchMock = jest
      .spyOn(global, 'fetch')
      .mockResolvedValue(new Response(JSON.stringify(body), { status })));

  it('returns the first location and restricts the search to India', async () => {
    reply(200, {
      status: 'OK',
      results: [{ geometry: { location: { lat: 17.45, lng: 78.38 } } }],
    });
    const point = await new GoogleGeocodingProvider(settings).geocode('12 Lake Road, Madhapur');
    expect(point).toEqual({ latitude: 17.45, longitude: 78.38 });
    const url = fetchMock.mock.calls[0][0] as string;
    expect(url).toContain('/maps/api/geocode/json?address=12%20Lake%20Road%2C%20Madhapur');
    expect(url).toContain('components=country:IN');
  });

  it('treats ZERO_RESULTS as not found', async () => {
    reply(200, { status: 'ZERO_RESULTS', results: [] });
    expect(await new GoogleGeocodingProvider(settings).geocode('nowhere')).toBeNull();
  });

  it.each([['OVER_QUERY_LIMIT'], ['UNKNOWN_ERROR']])('%s is retryable', async (status) => {
    reply(200, { status });
    await expect(new GoogleGeocodingProvider(settings).geocode('x')).rejects.toMatchObject({
      retryable: true,
    });
  });

  it.each([['REQUEST_DENIED'], ['INVALID_REQUEST']])(
    '%s is permanent and never leaks the key or the address',
    async (status) => {
      reply(200, { status });
      const error = await new GoogleGeocodingProvider(settings)
        .geocode('secret address')
        .catch((e: unknown) => e);
      expect((error as { retryable: boolean }).retryable).toBe(false);
      expect((error as Error).message).not.toContain('test-only-google-key');
      expect((error as Error).message).not.toContain('secret address');
    },
  );

  it('treats HTTP 5xx and network failures as retryable and an unusable location as permanent', async () => {
    reply(503, {});
    await expect(new GoogleGeocodingProvider(settings).geocode('x')).rejects.toMatchObject({
      retryable: true,
    });
    fetchMock.mockRestore();
    fetchMock = jest.spyOn(global, 'fetch').mockRejectedValue(new Error('down'));
    await expect(new GoogleGeocodingProvider(settings).geocode('x')).rejects.toMatchObject({
      retryable: true,
    });
    fetchMock.mockRestore();
    reply(200, { status: 'OK', results: [{ geometry: { location: { lat: 'x', lng: 1 } } }] });
    await expect(new GoogleGeocodingProvider(settings).geocode('x')).rejects.toMatchObject({
      retryable: false,
    });
  });
});

describe('disabled and memory adapters', () => {
  it('disabled finds nothing but still measures distance', async () => {
    const provider = new DisabledMapsProvider();
    expect(await provider.geocode()).toBeNull();
    expect(
      await provider.distanceMeters({ latitude: 0, longitude: 0 }, { latitude: 0, longitude: 1 }),
    ).toBeGreaterThan(100_000);
  });

  it('memory is deterministic, can be told a point, and can fail', async () => {
    const provider = new InMemoryMapsProvider();
    provider.points.set('Lake Road', { latitude: 17.4, longitude: 78.4 });
    expect(await provider.geocode('12 Lake Road, Hyderabad')).toEqual({
      latitude: 17.4,
      longitude: 78.4,
    });
    const first = await provider.geocode('some street');
    expect(await provider.geocode('some street')).toEqual(first);
    provider.unknownIsNotFound = true;
    expect(await provider.geocode('unmapped')).toBeNull();
    provider.failWith = new Error('boom');
    await expect(provider.geocode('x')).rejects.toThrow('boom');
  });
});
