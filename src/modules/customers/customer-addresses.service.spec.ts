import { CustomerAddressesService } from './customer-addresses.service';
import type { AddressRecord } from './customers.repository';
import type { ServiceabilityResult } from '../availability/service-areas.service';

function createMockRepository() {
  const profile = { id: 'prof-1', userId: 'user-1' };
  let addresses: AddressRecord[] = [];

  return {
    findProfileByUserId: jest.fn((userId: string) =>
      Promise.resolve(userId === 'user-1' ? profile : null),
    ),
    lockProfile: jest.fn(() => Promise.resolve(true)),
    transaction: jest.fn((cb: (tx: unknown) => Promise<unknown>) => cb({})),
    listActiveAddresses: jest.fn(() => Promise.resolve(addresses.filter((a) => a.isActive))),
    findActiveAddress: jest.fn((_profId: string, addressId: string) =>
      Promise.resolve(addresses.find((a) => a.id === addressId && a.isActive) ?? null),
    ),
    countActiveAddresses: jest.fn(() =>
      Promise.resolve(addresses.filter((a) => a.isActive).length),
    ),
    clearDefault: jest.fn(() => {
      addresses.forEach((a) => (a.isDefault = false));
      return Promise.resolve();
    }),
    createAddress: jest.fn(
      (data: Omit<AddressRecord, 'id' | 'isActive' | 'createdAt' | 'updatedAt'>) => {
        const created: AddressRecord = {
          id: `addr-${addresses.length + 1}`,
          customerId: data.customerId,
          line: data.line,
          line2: data.line2 ?? null,
          area: data.area,
          city: data.city,
          state: data.state ?? null,
          pincode: data.pincode,
          latitude: data.latitude ?? null,
          longitude: data.longitude ?? null,
          label: data.label ?? null,
          isDefault: data.isDefault,
          isActive: true,
          createdAt: new Date(),
          updatedAt: new Date(),
        };
        addresses.push(created);
        return Promise.resolve(created);
      },
    ),
    updateAddress: jest.fn((addressId: string, data: Partial<AddressRecord>) => {
      const idx = addresses.findIndex((a) => a.id === addressId);
      if (idx === -1) return Promise.resolve(null);
      const cleanData: Partial<AddressRecord> = {};
      for (const [k, v] of Object.entries(data)) {
        if (v !== undefined) {
          (cleanData as Record<string, unknown>)[k] = v;
        }
      }
      addresses[idx] = { ...addresses[idx], ...cleanData, updatedAt: new Date() };
      return Promise.resolve(addresses[idx]);
    }),
    markDefault: jest.fn((addressId: string) => {
      const addr = addresses.find((a) => a.id === addressId)!;
      addr.isDefault = true;
      return Promise.resolve(addr);
    }),
    setAddressCoordinates: jest.fn(
      (_profId: string, addressId: string, coords: { latitude: number; longitude: number }) => {
        const addr = addresses.find((a) => a.id === addressId)!;
        addr.latitude = coords.latitude;
        addr.longitude = coords.longitude;
        return Promise.resolve(addr);
      },
    ),
    verificationState: jest.fn(() =>
      Promise.resolve({
        activeAddresses: addresses.length,
        adminSet: false,
        status: 'PENDING',
      }),
    ),
    setVerificationStatus: jest.fn(() => Promise.resolve()),
    _setAddresses: (list: AddressRecord[]) => {
      addresses = [...list];
    },
  };
}

describe('CustomerAddressesService serviceability', () => {
  let service: CustomerAddressesService;
  let repo: ReturnType<typeof createMockRepository>;
  let mockAreasService: {
    evaluateServiceability: jest.Mock<
      Promise<ServiceabilityResult>,
      [{ area: string; city: string; latitude?: number | null; longitude?: number | null }]
    >;
  };

  beforeEach(() => {
    repo = createMockRepository();
    const audit = { record: jest.fn(() => Promise.resolve()) };
    const config = { customerAutoVerify: false };
    const maps = { geocode: jest.fn(() => Promise.resolve(null)) };
    mockAreasService = {
      evaluateServiceability: jest.fn(({ city, area }) => {
        if ((city ?? '').toLowerCase() !== 'hyderabad') {
          return Promise.resolve({
            isServiceable: false,
            unserviceableReason: 'CITY_NOT_SERVICEABLE' as const,
          });
        }
        if ((area ?? '').toLowerCase() === 'madhapur') {
          return Promise.resolve({ isServiceable: true, unserviceableReason: null });
        }
        return Promise.resolve({
          isServiceable: false,
          unserviceableReason: 'AREA_NOT_SERVICEABLE' as const,
        });
      }),
    };

    service = new CustomerAddressesService(
      repo as never,
      audit as never,
      config as never,
      mockAreasService as never,
      maps as never,
    );
  });

  it('create: allows saving an address outside Hyderabad, returning isServiceable=false and CITY_NOT_SERVICEABLE', async () => {
    const created = await service.create('user-1', {
      line: 'Flat 101, Prestige Towers',
      area: 'Whitefield',
      city: 'Bengaluru',
      pincode: '560066',
    });

    expect(created.id).toBeDefined();
    expect(created.city).toBe('Bengaluru');
    expect(created.isServiceable).toBe(false);
    expect(created.unserviceableReason).toBe('CITY_NOT_SERVICEABLE');
  });

  it('create: allows saving an address in Hyderabad with valid area, returning isServiceable=true and unserviceableReason=null', async () => {
    const created = await service.create('user-1', {
      line: 'Plot 42, Hitech City',
      area: 'Madhapur',
      city: 'Hyderabad',
      pincode: '500081',
    });

    expect(created.isServiceable).toBe(true);
    expect(created.unserviceableReason).toBeNull();
  });

  it('list: populates isServiceable and unserviceableReason for each address in the list', async () => {
    repo._setAddresses([
      {
        id: 'addr-1',
        customerId: 'prof-1',
        line: 'Plot 42',
        line2: null,
        area: 'Madhapur',
        city: 'Hyderabad',
        state: 'Telangana',
        pincode: '500081',
        latitude: 17.4483,
        longitude: 78.3915,
        label: 'Home',
        isDefault: true,
        isActive: true,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
      {
        id: 'addr-2',
        customerId: 'prof-1',
        line: 'Flat 5B',
        line2: null,
        area: 'Unknown Locality',
        city: 'Hyderabad',
        state: 'Telangana',
        pincode: '500001',
        latitude: null,
        longitude: null,
        label: 'Other',
        isDefault: false,
        isActive: true,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    ]);

    const list = await service.list('user-1');
    expect(list).toHaveLength(2);
    expect(list[0].isServiceable).toBe(true);
    expect(list[0].unserviceableReason).toBeNull();
    expect(list[1].isServiceable).toBe(false);
    expect(list[1].unserviceableReason).toBe('AREA_NOT_SERVICEABLE');
  });

  it('get: returns single address with serviceability fields', async () => {
    repo._setAddresses([
      {
        id: 'addr-1',
        customerId: 'prof-1',
        line: 'Plot 42',
        line2: null,
        area: 'Madhapur',
        city: 'Hyderabad',
        state: 'Telangana',
        pincode: '500081',
        latitude: 17.4483,
        longitude: 78.3915,
        label: 'Home',
        isDefault: true,
        isActive: true,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    ]);

    const address = await service.get('user-1', 'addr-1');
    expect(address.isServiceable).toBe(true);
    expect(address.unserviceableReason).toBeNull();
  });

  it('setDefault: returns address with serviceability fields', async () => {
    repo._setAddresses([
      {
        id: 'addr-1',
        customerId: 'prof-1',
        line: 'Plot 42',
        line2: null,
        area: 'Madhapur',
        city: 'Hyderabad',
        state: 'Telangana',
        pincode: '500081',
        latitude: null,
        longitude: null,
        label: 'Home',
        isDefault: false,
        isActive: true,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    ]);

    const updated = await service.setDefault('user-1', 'addr-1');
    expect(updated.isDefault).toBe(true);
    expect(updated.isServiceable).toBe(true);
    expect(updated.unserviceableReason).toBeNull();
  });

  it('update: updating an address to an unserviceable area reflects updated serviceability', async () => {
    repo._setAddresses([
      {
        id: 'addr-1',
        customerId: 'prof-1',
        line: 'Plot 42',
        line2: null,
        area: 'Madhapur',
        city: 'Hyderabad',
        state: 'Telangana',
        pincode: '500081',
        latitude: null,
        longitude: null,
        label: 'Home',
        isDefault: false,
        isActive: true,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    ]);

    const updated = await service.update('user-1', 'addr-1', {
      area: 'Unknown Locality',
    });
    expect(updated.isServiceable).toBe(false);
    expect(updated.unserviceableReason).toBe('AREA_NOT_SERVICEABLE');
  });
});
