import { HttpStatus } from '@nestjs/common';
import { DomainException } from '../../common/errors/domain.exception';
import { BookingErrorCode, BookingService, HOME_SERVICE_CATEGORY_CODES } from './booking.service';
import type { CreateBookingDto, RebookDto } from './dto/booking.dto';

describe('BookingService address serviceability and mandatory address validation', () => {
  let bookingService: BookingService;
  let mockCustomers: {
    findActiveAddressForBooking: jest.Mock<
      Promise<{
        id: string;
        city: string;
        area: string;
        latitude: number | null;
        longitude: number | null;
      } | null>,
      [string, string]
    >;
    activeUserIdOf: jest.Mock;
  };
  let mockAreas: {
    requireEnabled: jest.Mock;
    evaluateServiceability: jest.Mock;
  };
  let mockCategories: {
    requireEnabledByCode: jest.Mock;
    assertEngagementOffered: jest.Mock;
    findByIds: jest.Mock;
  };
  let mockRepo: {
    findByIdempotencyKey: jest.Mock;
    transaction: jest.Mock;
    create: jest.Mock;
    findById: jest.Mock;
    findDetail: jest.Mock;
    addEvent: jest.Mock;
    recordWorkerMatch: jest.Mock;
    findActiveCustomerBookings: jest.Mock;
  };

  beforeEach(() => {
    mockRepo = {
      findByIdempotencyKey: jest.fn(() => Promise.resolve(null)),
      transaction: jest.fn((cb: (tx: unknown) => Promise<unknown>) => cb({})),
      create: jest.fn(() => Promise.resolve({ id: 'booking-1' })),
      findById: jest.fn(() => Promise.resolve({ id: 'booking-1' })),
      findDetail: jest.fn(() => Promise.resolve({ id: 'booking-1', events: [] })),
      addEvent: jest.fn(() => Promise.resolve({})),
      recordWorkerMatch: jest.fn(() => Promise.resolve({})),
      findActiveCustomerBookings: jest.fn(() => Promise.resolve([])),
    };

    mockCategories = {
      requireEnabledByCode: jest.fn((code: string) =>
        Promise.resolve({ id: `cat-${code}`, code, isEnabled: true }),
      ),
      assertEngagementOffered: jest.fn(() => Promise.resolve(undefined)),
      findByIds: jest.fn((ids: string[]) =>
        Promise.resolve([{ id: ids[0], code: 'HOUSE_MAID', isEnabled: true }]),
      ),
    };

    mockAreas = {
      requireEnabled: jest.fn(() =>
        Promise.resolve({
          id: 'area-1',
          name: 'Madhapur',
          city: 'Hyderabad',
          isEnabled: true,
        }),
      ),
      evaluateServiceability: jest.fn(),
    };

    mockCustomers = {
      findActiveAddressForBooking: jest.fn(),
      activeUserIdOf: jest.fn(() => Promise.resolve('user-customer-1')),
    };

    const mockLegal = {
      assertAccepted: jest.fn(() => Promise.resolve(undefined)),
    };

    const mockWorkers = { assertEligible: jest.fn(() => Promise.resolve(undefined)) };
    const mockSearch = {};
    const mockAudit = { record: jest.fn(() => Promise.resolve(undefined)) };
    const mockOutbox = { emit: jest.fn(() => Promise.resolve(undefined)) };
    const mockHooks = { onTransition: jest.fn(() => Promise.resolve(undefined)) };
    const mockAlerts = { raise: jest.fn(() => Promise.resolve(undefined)) };
    const mockConfig = { booking: { defaultTimeWindowMinutes: 60 } };
    const mockInterviews = {};

    bookingService = new BookingService(
      mockRepo as never,
      mockCategories as never,
      mockAreas as never,
      mockWorkers as never,
      mockSearch as never,
      mockAudit as never,
      mockOutbox as never,
      mockHooks as never,
      mockCustomers as never,
      mockLegal as never,
      mockAlerts as never,
      mockConfig as never,
      mockInterviews as never,
    );
    (bookingService as unknown as { detail: () => Promise<unknown> }).detail = jest.fn(() =>
      Promise.resolve({ id: 'booking-1' }),
    );
  });

  const validHomeDto: CreateBookingDto = {
    category: 'HOUSE_MAID',
    areaId: 'area-1',
    engagement: 'FULL_TIME',
    availableFrom: '09:00',
    availableTo: '11:00',
    addressId: 'addr-1',
    startDate: '2026-12-01',
  };

  describe('D-98: Address serviceability validation', () => {
    it('rejects booking when address is outside enabled service areas with 422 OUTSIDE_SERVICE_AREA', async () => {
      mockCustomers.findActiveAddressForBooking.mockResolvedValue({
        id: 'addr-1',
        city: 'Hyderabad',
        area: 'OutsideArea',
        latitude: null,
        longitude: null,
      });

      mockAreas.evaluateServiceability.mockResolvedValue({
        isServiceable: false,
        unserviceableReason: 'AREA_NOT_SERVICEABLE',
      });

      try {
        await bookingService.create('user-1', validHomeDto);
        fail('Expected OUTSIDE_SERVICE_AREA exception');
      } catch (err) {
        const error = err as DomainException;
        expect(error.code).toBe(BookingErrorCode.OUTSIDE_SERVICE_AREA);
        expect(error.getStatus()).toBe(HttpStatus.UNPROCESSABLE_ENTITY);
        expect(error.message).toBe('The address is outside enabled service areas');
        expect(error.details).toEqual([
          { field: 'addressId', messages: ['the address is not in an enabled service area'] },
        ]);
      }
    });

    it('rejects booking when address city does not match selected area city with 422 OUTSIDE_SERVICE_AREA', async () => {
      mockCustomers.findActiveAddressForBooking.mockResolvedValue({
        id: 'addr-1',
        city: 'Bengaluru',
        area: 'Whitefield',
        latitude: null,
        longitude: null,
      });

      try {
        await bookingService.create('user-1', validHomeDto);
        fail('Expected OUTSIDE_SERVICE_AREA exception');
      } catch (err) {
        const error = err as DomainException;
        expect(error.code).toBe(BookingErrorCode.OUTSIDE_SERVICE_AREA);
        expect(error.getStatus()).toBe(HttpStatus.UNPROCESSABLE_ENTITY);
        expect(error.message).toBe('The address is outside the city of the selected service area');
      }
    });

    it('accepts booking when address is within enabled service area', async () => {
      mockCustomers.findActiveAddressForBooking.mockResolvedValue({
        id: 'addr-1',
        city: 'Hyderabad',
        area: 'Madhapur',
        latitude: 17.4483,
        longitude: 78.3915,
      });

      mockAreas.evaluateServiceability.mockResolvedValue({
        isServiceable: true,
        unserviceableReason: null,
      });

      const result = await bookingService.create('user-1', validHomeDto);
      expect(result.created).toBe(true);
      expect(mockAreas.evaluateServiceability).toHaveBeenCalledWith({
        area: 'Madhapur',
        city: 'Hyderabad',
        latitude: 17.4483,
        longitude: 78.3915,
      });
    });

    it('rejects booking with 404 ADDRESS_NOT_FOUND when address belongs to another customer or does not exist', async () => {
      mockCustomers.findActiveAddressForBooking.mockResolvedValue(null);

      try {
        await bookingService.create('user-1', validHomeDto);
        fail('Expected ADDRESS_NOT_FOUND exception');
      } catch (err) {
        const error = err as DomainException;
        expect(error.code).toBe(BookingErrorCode.ADDRESS_NOT_FOUND);
        expect(error.getStatus()).toBe(HttpStatus.NOT_FOUND);
      }
    });

    it('rejects booking when areaId is disabled with 422 AREA_NOT_AVAILABLE', async () => {
      mockAreas.requireEnabled.mockRejectedValue(
        new DomainException(
          'AREA_NOT_AVAILABLE',
          'The location is not in an enabled service area',
          HttpStatus.UNPROCESSABLE_ENTITY,
        ),
      );
      try {
        await bookingService.create('user-1', validHomeDto);
        fail('Expected AREA_NOT_AVAILABLE exception');
      } catch (err) {
        const error = err as DomainException;
        expect(error.code).toBe('AREA_NOT_AVAILABLE');
        expect(error.getStatus()).toBe(HttpStatus.UNPROCESSABLE_ENTITY);
      }
    });
  });

  describe('D-99: Mandatory address for home services', () => {
    const homeCategories = Array.from(HOME_SERVICE_CATEGORY_CODES);

    test.each(homeCategories)(
      'rejects %s booking with 422 ADDRESS_REQUIRED when addressId is omitted',
      async (category) => {
        const dtoWithoutAddress: CreateBookingDto = {
          category,
          areaId: 'area-1',
          engagement: 'FULL_TIME',
          availableFrom: '09:00',
          availableTo: '11:00',
          addressId: undefined,
        };

        try {
          await bookingService.create('user-1', dtoWithoutAddress);
          fail(`Expected ADDRESS_REQUIRED for ${category}`);
        } catch (err) {
          const error = err as DomainException;
          expect(error.code).toBe(BookingErrorCode.ADDRESS_REQUIRED);
          expect(error.getStatus()).toBe(HttpStatus.UNPROCESSABLE_ENTITY);
          expect(error.message).toBe('An address is required for this service');
          expect(error.details).toEqual([
            { field: 'addressId', messages: ['addressId is required for home services'] },
          ]);
        }
      },
    );

    test.each(homeCategories)(
      'accepts %s booking when serviceable addressId is provided',
      async (category) => {
        mockCustomers.findActiveAddressForBooking.mockResolvedValue({
          id: 'addr-1',
          city: 'Hyderabad',
          area: 'Madhapur',
          latitude: 17.4483,
          longitude: 78.3915,
        });
        mockAreas.evaluateServiceability.mockResolvedValue({
          isServiceable: true,
          unserviceableReason: null,
        });

        const dto: CreateBookingDto = {
          category,
          areaId: 'area-1',
          engagement: 'FULL_TIME',
          availableFrom: '09:00',
          availableTo: '11:00',
          addressId: 'addr-1',
        };

        const result = await bookingService.create('user-1', dto);
        expect(result.created).toBe(true);
      },
    );

    it('accepts DRIVER booking without addressId', async () => {
      const driverDto: CreateBookingDto = {
        category: 'DRIVER',
        areaId: 'area-1',
        engagement: 'DAILY',
        availableFrom: '09:00',
        availableTo: '11:00',
        addressId: undefined,
      };

      const result = await bookingService.create('user-1', driverDto);
      expect(result.created).toBe(true);
      expect(mockCustomers.findActiveAddressForBooking).not.toHaveBeenCalled();
    });

    it('validates address serviceability when DRIVER booking includes an addressId', async () => {
      mockCustomers.findActiveAddressForBooking.mockResolvedValue({
        id: 'addr-driver',
        city: 'Hyderabad',
        area: 'OutsideArea',
        latitude: null,
        longitude: null,
      });
      mockAreas.evaluateServiceability.mockResolvedValue({
        isServiceable: false,
        unserviceableReason: 'AREA_NOT_SERVICEABLE',
      });

      const driverDtoWithAddress: CreateBookingDto = {
        category: 'DRIVER',
        areaId: 'area-1',
        engagement: 'DAILY',
        availableFrom: '09:00',
        availableTo: '11:00',
        addressId: 'addr-driver',
      };

      try {
        await bookingService.create('user-1', driverDtoWithAddress);
        fail('Expected OUTSIDE_SERVICE_AREA for driver with unserviceable address');
      } catch (err) {
        const error = err as DomainException;
        expect(error.code).toBe(BookingErrorCode.OUTSIDE_SERVICE_AREA);
      }
    });

    it('enforces mandatory address on admin creation for customer (createForCustomer)', async () => {
      const adminDtoWithoutAddress: CreateBookingDto = {
        category: 'COOK',
        areaId: 'area-1',
        engagement: 'PART_TIME',
        availableFrom: '09:00',
        availableTo: '11:00',
        addressId: undefined,
      };

      try {
        await bookingService.createForCustomer('customer-123', adminDtoWithoutAddress, {
          userId: 'admin-1',
          roles: ['admin'],
        });
        fail('Expected ADDRESS_REQUIRED for admin-created home service without address');
      } catch (err) {
        const error = err as DomainException;
        expect(error.code).toBe(BookingErrorCode.ADDRESS_REQUIRED);
        expect(error.getStatus()).toBe(HttpStatus.UNPROCESSABLE_ENTITY);
      }
    });

    it('enforces mandatory address on rebooking when saved address is no longer available', async () => {
      // Source booking was HOUSE_MAID and had an address, but address is no longer active
      mockRepo.findById.mockResolvedValue({
        id: 'booking-completed-1',
        customerUserId: 'user-1',
        status: 'COMPLETED',
        workerId: 'worker-1',
        categoryId: 'cat-HOUSE_MAID',
        areaId: 'area-1',
        engagement: 'FULL_TIME',
        fromMinute: 540,
        toMinute: 660,
        addressId: 'addr-deleted',
        budgetMinMinor: null,
        budgetMaxMinor: null,
        budgetPeriod: null,
        requirementNote: null,
      });

      // Customer no longer has this active address
      mockCustomers.findActiveAddressForBooking.mockResolvedValue(null);

      const rebookDto: RebookDto = {
        bookingId: 'booking-completed-1',
      };

      try {
        await bookingService.rebook('user-1', rebookDto);
        fail('Expected ADDRESS_REQUIRED on rebook when address is lost');
      } catch (err) {
        const error = err as DomainException;
        expect(error.code).toBe(BookingErrorCode.ADDRESS_REQUIRED);
        expect(error.getStatus()).toBe(HttpStatus.UNPROCESSABLE_ENTITY);
      }
    });
  });
});
