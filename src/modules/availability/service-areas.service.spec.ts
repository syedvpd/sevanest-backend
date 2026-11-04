import { ServiceAreasService } from './service-areas.service';
import type { AreaRecord } from './availability.repository';

function createMockRepository() {
  const enabledAreas: AreaRecord[] = [
    {
      id: 'area-1',
      name: 'Madhapur',
      city: 'Hyderabad',
      isEnabled: true,
      centerLatitude: 17.4483,
      centerLongitude: 78.3915,
      radiusMeters: 5000,
      createdAt: new Date(),
      updatedAt: new Date(),
    },
    {
      id: 'area-2',
      name: 'Banjara Hills',
      city: 'Hyderabad',
      isEnabled: true,
      centerLatitude: 17.4156,
      centerLongitude: 78.4357,
      radiusMeters: 3000,
      createdAt: new Date(),
      updatedAt: new Date(),
    },
    {
      id: 'area-disabled-hyd',
      name: 'Gachibowli',
      city: 'Hyderabad',
      isEnabled: false, // disabled area in serviceable city
      centerLatitude: 17.4401,
      centerLongitude: 78.3489,
      radiusMeters: 3000,
      createdAt: new Date(),
      updatedAt: new Date(),
    },
    {
      id: 'area-3',
      name: 'Koramangala',
      city: 'Bengaluru',
      isEnabled: false, // disabled area
      centerLatitude: 12.9352,
      centerLongitude: 77.6245,
      radiusMeters: 4000,
      createdAt: new Date(),
      updatedAt: new Date(),
    },
  ];

  return {
    findAreaById: jest.fn((id: string) =>
      Promise.resolve(enabledAreas.find((a) => a.id === id) ?? null),
    ),
    findAreasByIds: jest.fn((ids: string[]) =>
      Promise.resolve(enabledAreas.filter((a) => ids.includes(a.id))),
    ),
    listAreas: jest.fn(() => Promise.resolve({ items: enabledAreas, total: enabledAreas.length })),
    findAreaCovering: jest.fn((lat: number, lng: number, city?: string) => {
      // Simple mock distance check for Madhapur center
      if (
        city?.toLowerCase() === 'hyderabad' &&
        Math.abs(lat - 17.4483) < 0.04 &&
        Math.abs(lng - 78.3915) < 0.04
      ) {
        return Promise.resolve(enabledAreas[0]);
      }
      return Promise.resolve(null);
    }),
    findEnabledAreaByName: jest.fn((name: string, city?: string) => {
      const match = enabledAreas.find(
        (a) =>
          a.isEnabled &&
          a.name.toLowerCase() === name.trim().toLowerCase() &&
          (!city || a.city.toLowerCase() === city.trim().toLowerCase()),
      );
      return Promise.resolve(match ?? null);
    }),
    hasEnabledAreasInCity: jest.fn((city: string) => {
      return Promise.resolve(
        enabledAreas.some((a) => a.isEnabled && a.city.toLowerCase() === city.trim().toLowerCase()),
      );
    }),
  };
}

describe('ServiceAreasService.evaluateServiceability', () => {
  let service: ServiceAreasService;
  let repo: ReturnType<typeof createMockRepository>;

  beforeEach(() => {
    repo = createMockRepository();
    const audit = { record: jest.fn() };
    service = new ServiceAreasService(repo as never, audit as never);
  });

  it('positive: area name match in serviceable city (Hyderabad)', async () => {
    const result = await service.evaluateServiceability({
      area: 'Madhapur',
      city: 'Hyderabad',
    });
    expect(result).toEqual({ isServiceable: true, unserviceableReason: null });
  });

  it('positive: coordinates covering enabled area within radius', async () => {
    const result = await service.evaluateServiceability({
      area: 'Somewhere Nearby',
      city: 'Hyderabad',
      latitude: 17.4485,
      longitude: 78.3916,
    });
    expect(result).toEqual({ isServiceable: true, unserviceableReason: null });
    expect(repo.findAreaCovering).toHaveBeenCalledWith(17.4485, 78.3916, 'Hyderabad');
  });

  it('fallback: coordinates outside radius fall back to valid area name', async () => {
    const result = await service.evaluateServiceability({
      area: 'Madhapur',
      city: 'Hyderabad',
      latitude: 17.9, // far away
      longitude: 78.9,
    });
    expect(result).toEqual({ isServiceable: true, unserviceableReason: null });
    expect(repo.findEnabledAreaByName).toHaveBeenCalledWith('Madhapur', 'Hyderabad');
  });

  it('negative: coordinates outside radius and unknown area in serviceable city', async () => {
    const result = await service.evaluateServiceability({
      area: 'Unknown Area',
      city: 'Hyderabad',
      latitude: 17.9,
      longitude: 78.9,
    });
    expect(result).toEqual({
      isServiceable: false,
      unserviceableReason: 'AREA_NOT_SERVICEABLE',
    });
  });

  it('negative: unsupported city with no enabled areas returns CITY_NOT_SERVICEABLE', async () => {
    const result = await service.evaluateServiceability({
      area: 'Indiranagar',
      city: 'Bengaluru',
    });
    expect(result).toEqual({
      isServiceable: false,
      unserviceableReason: 'CITY_NOT_SERVICEABLE',
    });
  });

  it('negative: empty city returns CITY_NOT_SERVICEABLE', async () => {
    const result = await service.evaluateServiceability({
      area: 'Madhapur',
      city: '',
    });
    expect(result).toEqual({
      isServiceable: false,
      unserviceableReason: 'CITY_NOT_SERVICEABLE',
    });
  });

  it('missing coordinates: null latitude and longitude falls back to area name', async () => {
    const result = await service.evaluateServiceability({
      area: 'Banjara Hills',
      city: 'Hyderabad',
      latitude: null,
      longitude: null,
    });
    expect(result).toEqual({ isServiceable: true, unserviceableReason: null });
    expect(repo.findAreaCovering).not.toHaveBeenCalled();
  });

  it('invalid coordinates: NaN latitude falls back to area name', async () => {
    const result = await service.evaluateServiceability({
      area: 'Banjara Hills',
      city: 'Hyderabad',
      latitude: NaN,
      longitude: 78.4357,
    });
    expect(result).toEqual({ isServiceable: true, unserviceableReason: null });
  });

  it('case-insensitive matching for area and city', async () => {
    const result = await service.evaluateServiceability({
      area: 'madhapur',
      city: 'HYDERABAD',
    });
    expect(result).toEqual({ isServiceable: true, unserviceableReason: null });
  });

  it('negative: disabled area in serviceable city returns AREA_NOT_SERVICEABLE', async () => {
    const result = await service.evaluateServiceability({
      area: 'Gachibowli',
      city: 'Hyderabad',
    });
    expect(result).toEqual({
      isServiceable: false,
      unserviceableReason: 'AREA_NOT_SERVICEABLE',
    });
  });

  it('partially supplied coordinates: latitude without longitude falls back to area name', async () => {
    const result = await service.evaluateServiceability({
      area: 'Madhapur',
      city: 'Hyderabad',
      latitude: 17.4483,
      longitude: null,
    });
    expect(result).toEqual({ isServiceable: true, unserviceableReason: null });
    expect(repo.findAreaCovering).not.toHaveBeenCalled();
  });
});
