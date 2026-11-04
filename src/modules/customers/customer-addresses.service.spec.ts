import { AddressErrorCode, CustomerAddressesService } from './customer-addresses.service';
import type { AddressRecord } from './customers.repository';
import type { ServiceabilityResult } from '../availability/service-areas.service';
import { DomainException } from '../../common/errors/domain.exception';

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
          photoObjectKey: null,
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
    setAddressPhoto: jest.fn((addressId: string, photoObjectKey: string | null) => {
      const addr = addresses.find((a) => a.id === addressId);
      if (!addr) return Promise.resolve(null as unknown as AddressRecord);
      addr.photoObjectKey = photoObjectKey;
      return Promise.resolve(addr);
    }),
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
  let mockStorage: {
    createUploadUrl: jest.Mock;
    createDownloadUrl: jest.Mock;
    getObjectInfo: jest.Mock;
    readObjectHead: jest.Mock;
    readObject: jest.Mock;
    deleteObject: jest.Mock;
  };
  let mockScanner: {
    enabled: boolean;
    scan: jest.Mock;
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

    mockStorage = {
      createUploadUrl: jest.fn(() =>
        Promise.resolve({
          url: 'https://s3.example.com/upload-signed-url',
          expiresAt: new Date(Date.now() + 900000),
        }),
      ),
      createDownloadUrl: jest.fn(({ objectKey }: { objectKey: string }) =>
        Promise.resolve({
          url: `https://s3.example.com/signed/${objectKey}`,
          expiresAt: new Date(Date.now() + 900000),
        }),
      ),
      getObjectInfo: jest.fn(() =>
        Promise.resolve({
          sizeBytes: 1024,
          etag: 'tag-1',
        }),
      ),
      readObjectHead: jest.fn(() =>
        // Return valid JPEG magic bytes: 0xFF, 0xD8, 0xFF, 0xE0
        Promise.resolve(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46])),
      ),
      readObject: jest.fn(() =>
        Promise.resolve({
          bytes: Buffer.from([0xff, 0xd8, 0xff, 0xe0]),
          truncated: false,
        }),
      ),
      deleteObject: jest.fn(() => Promise.resolve()),
    };

    mockScanner = {
      enabled: false,
      scan: jest.fn(() => Promise.resolve({ clean: true })),
    };

    service = new CustomerAddressesService(
      repo as never,
      audit as never,
      config as never,
      mockAreasService as never,
      maps as never,
      mockStorage as never,
      mockScanner,
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
        photoObjectKey: null,
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
        photoObjectKey: null,
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
        photoObjectKey: null,
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
        photoObjectKey: null,
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
        photoObjectKey: null,
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

  describe('Address photos (D-103)', () => {
    beforeEach(() => {
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
          photoObjectKey: null,
          isDefault: true,
          isActive: true,
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      ]);
    });

    describe('requestPhotoUpload', () => {
      it('succeeds for valid image/jpeg within 5 MB', async () => {
        const res = await service.requestPhotoUpload('user-1', 'addr-1', {
          contentType: 'image/jpeg',
          sizeBytes: 2 * 1024 * 1024,
        });

        expect(res.photoId).toBeDefined();
        expect(res.url).toBe('https://s3.example.com/upload-signed-url');
        expect(res.method).toBe('PUT');
        expect(res.contentType).toBe('image/jpeg');
        expect(res.maxBytes).toBe(5 * 1024 * 1024);
        expect(mockStorage.createUploadUrl).toHaveBeenCalled();
      });

      it('succeeds for valid image/png within 5 MB', async () => {
        const res = await service.requestPhotoUpload('user-1', 'addr-1', {
          contentType: 'image/png',
          sizeBytes: 500 * 1024,
        });

        expect(res.photoId).toBeDefined();
        expect(res.contentType).toBe('image/png');
      });

      it('rejects unsupported content type with PHOTO_TYPE_NOT_ALLOWED', async () => {
        await expect(
          service.requestPhotoUpload('user-1', 'addr-1', {
            contentType: 'image/gif',
            sizeBytes: 1024,
          }),
        ).rejects.toThrow(DomainException);

        try {
          await service.requestPhotoUpload('user-1', 'addr-1', {
            contentType: 'application/pdf',
            sizeBytes: 1024,
          });
          fail('should have thrown');
        } catch (err: unknown) {
          expect((err as DomainException).code).toBe(AddressErrorCode.PHOTO_TYPE_NOT_ALLOWED);
        }
      });

      it('rejects payload exceeding 5 MB with PHOTO_TOO_LARGE', async () => {
        try {
          await service.requestPhotoUpload('user-1', 'addr-1', {
            contentType: 'image/jpeg',
            sizeBytes: 5 * 1024 * 1024 + 1,
          });
          fail('should have thrown');
        } catch (err: unknown) {
          expect((err as DomainException).code).toBe(AddressErrorCode.PHOTO_TOO_LARGE);
        }
      });

      it('rejects unknown address with ADDRESS_NOT_FOUND', async () => {
        try {
          await service.requestPhotoUpload('user-1', 'addr-999', {
            contentType: 'image/jpeg',
            sizeBytes: 1024,
          });
          fail('should have thrown');
        } catch (err: unknown) {
          expect((err as DomainException).code).toBe(AddressErrorCode.ADDRESS_NOT_FOUND);
        }
      });
    });

    describe('confirmPhoto', () => {
      it('confirms photo and returns address response with signed photoUrl', async () => {
        const res = await service.confirmPhoto('user-1', 'addr-1', 'photo-123');

        expect(res.photoUrl).toContain('https://s3.example.com/signed/');
        expect(repo.setAddressPhoto).toHaveBeenCalledWith(
          'addr-1',
          'customers/prof-1/addresses/addr-1/photos/photo-123',
        );
      });

      it('deletes old superseded photo when new photo is confirmed', async () => {
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
            photoObjectKey: 'customers/prof-1/addresses/addr-1/photos/old-photo',
            isDefault: true,
            isActive: true,
            createdAt: new Date(),
            updatedAt: new Date(),
          },
        ]);

        await service.confirmPhoto('user-1', 'addr-1', 'new-photo-456');

        expect(mockStorage.deleteObject).toHaveBeenCalledWith(
          'customers/prof-1/addresses/addr-1/photos/old-photo',
        );
      });

      it('throws PHOTO_NOT_UPLOADED if object is missing in storage', async () => {
        mockStorage.getObjectInfo.mockRejectedValueOnce(new Error('NotFound'));

        try {
          await service.confirmPhoto('user-1', 'addr-1', 'missing-photo');
          fail('should have thrown');
        } catch (err: unknown) {
          expect((err as DomainException).code).toBe(AddressErrorCode.PHOTO_NOT_UPLOADED);
        }
      });

      it('throws PHOTO_TOO_LARGE and cleans up if uploaded object exceeds 5 MB', async () => {
        mockStorage.getObjectInfo.mockResolvedValueOnce({
          sizeBytes: 5 * 1024 * 1024 + 1,
          contentType: 'image/jpeg',
          eTag: 'tag-1',
          lastModified: new Date(),
        });

        try {
          await service.confirmPhoto('user-1', 'addr-1', 'oversized-photo');
          fail('should have thrown');
        } catch (err: unknown) {
          expect((err as DomainException).code).toBe(AddressErrorCode.PHOTO_TOO_LARGE);
          expect(mockStorage.deleteObject).toHaveBeenCalledWith(
            'customers/prof-1/addresses/addr-1/photos/oversized-photo',
          );
        }
      });

      it('throws PHOTO_CONTENT_MISMATCH and cleans up if magic bytes do not match', async () => {
        // Return corrupt non-JPEG magic bytes: 0x00 0x00 0x00 0x00
        mockStorage.readObjectHead.mockResolvedValueOnce(Buffer.from([0x00, 0x00, 0x00, 0x00]));

        try {
          await service.confirmPhoto('user-1', 'addr-1', 'corrupted-photo');
          fail('should have thrown');
        } catch (err: unknown) {
          expect((err as DomainException).code).toBe(AddressErrorCode.PHOTO_CONTENT_MISMATCH);
          expect(mockStorage.deleteObject).toHaveBeenCalledWith(
            'customers/prof-1/addresses/addr-1/photos/corrupted-photo',
          );
        }
      });

      it('rejects with PHOTO_MALWARE_DETECTED if malware scanner is active and flags file', async () => {
        mockScanner.enabled = true;
        mockScanner.scan.mockResolvedValueOnce({ clean: false, threat: 'Eicar-Test-Signature' });

        try {
          await service.confirmPhoto('user-1', 'addr-1', 'infected-photo');
          fail('should have thrown');
        } catch (err: unknown) {
          expect((err as DomainException).code).toBe(AddressErrorCode.PHOTO_MALWARE_DETECTED);
          expect(mockStorage.deleteObject).toHaveBeenCalledWith(
            'customers/prof-1/addresses/addr-1/photos/infected-photo',
          );
        }
      });
    });

    describe('deletePhoto', () => {
      it('clears photoObjectKey from repository and deletes from storage', async () => {
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
            photoObjectKey: 'customers/prof-1/addresses/addr-1/photos/existing-photo',
            isDefault: true,
            isActive: true,
            createdAt: new Date(),
            updatedAt: new Date(),
          },
        ]);

        await service.deletePhoto('user-1', 'addr-1');

        expect(repo.setAddressPhoto).toHaveBeenCalledWith('addr-1', null);
        expect(mockStorage.deleteObject).toHaveBeenCalledWith(
          'customers/prof-1/addresses/addr-1/photos/existing-photo',
        );
      });

      it('does nothing if address had no photo', async () => {
        await service.deletePhoto('user-1', 'addr-1');

        expect(repo.setAddressPhoto).not.toHaveBeenCalled();
        expect(mockStorage.deleteObject).not.toHaveBeenCalled();
      });
    });

    describe('list and get with photoUrl', () => {
      it('returns signed photoUrl for address with photoObjectKey', async () => {
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
            photoObjectKey: 'customers/prof-1/addresses/addr-1/photos/photo-1',
            isDefault: true,
            isActive: true,
            createdAt: new Date(),
            updatedAt: new Date(),
          },
        ]);

        const addr = await service.get('user-1', 'addr-1');
        expect(addr.photoUrl).toBe(
          'https://s3.example.com/signed/customers/prof-1/addresses/addr-1/photos/photo-1',
        );

        const list = await service.list('user-1');
        expect(list[0].photoUrl).toBe(
          'https://s3.example.com/signed/customers/prof-1/addresses/addr-1/photos/photo-1',
        );
      });

      it('returns null photoUrl for address without photoObjectKey', async () => {
        const addr = await service.get('user-1', 'addr-1');
        expect(addr.photoUrl).toBeNull();
      });
    });
  });
});
