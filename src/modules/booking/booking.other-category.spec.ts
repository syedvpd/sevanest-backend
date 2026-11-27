import { validate } from 'class-validator';
import { plainToInstance } from 'class-transformer';
import { BookingService } from './booking.service';
import { CreateBookingDto } from './dto/booking.dto';

describe('BUG-CUST-014: OTHER service category and requirementNote booking persistence', () => {
  describe('CreateBookingDto validation for OTHER category', () => {
    it('accepts uppercase OTHER category code with requirementNote', async () => {
      const dto = plainToInstance(CreateBookingDto, {
        category: 'OTHER',
        areaId: 'b7b897e9-6f10-4d7a-8f92-5eb5fa6d1a10',
        engagement: 'FULL_TIME',
        availableFrom: '09:00',
        availableTo: '17:00',
        requirementNote: 'Need daily plant watering and general balcony maintenance',
      });
      const errors = await validate(dto);
      expect(errors).toHaveLength(0);
      expect(dto.category).toBe('OTHER');
      expect(dto.requirementNote).toBe('Need daily plant watering and general balcony maintenance');
    });

    it('rejects lowercase "other" category code matching audit findings', async () => {
      const dto = plainToInstance(CreateBookingDto, {
        category: 'other',
        areaId: 'b7b897e9-6f10-4d7a-8f92-5eb5fa6d1a10',
        engagement: 'FULL_TIME',
        availableFrom: '09:00',
        availableTo: '17:00',
        requirementNote: 'Custom work',
      });
      const errors = await validate(dto);
      expect(errors.length).toBeGreaterThan(0);
      expect(errors.some((e) => e.property === 'category')).toBe(true);
    });

    it('rejects requirementNote containing HTML tags < or >', async () => {
      const dto = plainToInstance(CreateBookingDto, {
        category: 'OTHER',
        areaId: 'b7b897e9-6f10-4d7a-8f92-5eb5fa6d1a10',
        engagement: 'FULL_TIME',
        availableFrom: '09:00',
        availableTo: '17:00',
        requirementNote: '<script>alert("hack")</script>',
      });
      const errors = await validate(dto);
      expect(errors.some((e) => e.property === 'requirementNote')).toBe(true);
    });
  });

  describe('BookingService.create with OTHER category', () => {
    let bookingService: BookingService;
    let mockCategories: {
      requireEnabledByCode: jest.Mock;
      assertEngagementOffered: jest.Mock;
      findByIds: jest.Mock;
    };
    let mockAreas: {
      requireEnabled: jest.Mock;
      findByIds: jest.Mock;
    };
    let mockRepo: {
      findByIdempotencyKey: jest.Mock;
      transaction: jest.Mock;
      create: jest.Mock;
      findById: jest.Mock;
      findDetail: jest.Mock;
      addEvent: jest.Mock;
      listEvents: jest.Mock;
      findActiveCustomerBookings: jest.Mock;
    };
    let mockAudit: { record: jest.Mock };
    let mockOutbox: { emit: jest.Mock };

    beforeEach(() => {
      mockCategories = {
        requireEnabledByCode: jest.fn((code: string) =>
          Promise.resolve({ id: `cat-${code}`, code, isEnabled: true }),
        ),
        assertEngagementOffered: jest.fn(() => Promise.resolve(undefined)),
        findByIds: jest.fn((ids: string[]) =>
          Promise.resolve([{ id: ids[0], code: 'OTHER', isEnabled: true }]),
        ),
      };

      mockAreas = {
        requireEnabled: jest.fn((id: string) =>
          Promise.resolve({ id, name: 'HITEC City', city: 'Hyderabad', isEnabled: true }),
        ),
        findByIds: jest.fn((ids: string[]) =>
          Promise.resolve([{ id: ids[0], name: 'HITEC City', city: 'Hyderabad', isEnabled: true }]),
        ),
      };

      mockRepo = {
        findByIdempotencyKey: jest.fn(() => Promise.resolve(null)),
        transaction: jest.fn((cb: (tx: unknown) => Promise<unknown>) => cb({})),
        create: jest.fn((input: { categoryId: string; requirementNote: string | null }) =>
          Promise.resolve({
            id: 'booking-other-1',
            categoryId: input.categoryId,
            requirementNote: input.requirementNote,
            status: 'NEW_REQUEST',
          }),
        ),
        findById: jest.fn(() => Promise.resolve({ id: 'booking-other-1' })),
        findDetail: jest.fn(() =>
          Promise.resolve({
            id: 'booking-other-1',
            categoryId: 'cat-OTHER',
            areaId: 'area-1',
            requirementNote: 'Special gardening task',
            status: 'NEW_REQUEST',
            events: [],
          }),
        ),
        addEvent: jest.fn(() => Promise.resolve({})),
        listEvents: jest.fn(() => Promise.resolve([])),
        findActiveCustomerBookings: jest.fn(() => Promise.resolve([])),
      };

      mockAudit = { record: jest.fn(() => Promise.resolve(undefined)) };
      mockOutbox = { emit: jest.fn(() => Promise.resolve(undefined)) };

      const mockWorkers = { assertEligible: jest.fn(() => Promise.resolve(undefined)) };
      const mockSearch = {};
      const mockHooks = {
        onTransition: jest.fn(() => Promise.resolve(undefined)),
        ratedBookingIds: jest.fn(() => Promise.resolve(new Set())),
      };
      const mockCustomers = {
        findActiveAddressForBooking: jest.fn(),
        activeUserIdOf: jest.fn(() => Promise.resolve('cust-user-1')),
      };
      const mockLegal = { assertAccepted: jest.fn(() => Promise.resolve(undefined)) };
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
    });

    it('resolves OTHER category code, permits unrestricted engagement, and persists requirementNote', async () => {
      const dto: CreateBookingDto = {
        category: 'OTHER',
        areaId: 'b7b897e9-6f10-4d7a-8f92-5eb5fa6d1a10',
        engagement: 'ONE_TIME',
        availableFrom: '10:00',
        availableTo: '12:00',
        requirementNote: 'Special gardening task',
      };

      const result = await bookingService.create('cust-user-1', dto);

      expect(mockCategories.requireEnabledByCode).toHaveBeenCalledWith('OTHER');
      expect(mockCategories.assertEngagementOffered).toHaveBeenCalledWith('cat-OTHER', 'ONE_TIME');
      expect(mockRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({
          categoryId: 'cat-OTHER',
          requirementNote: 'Special gardening task',
        }),
        expect.anything(),
      );
      expect(result.created).toBe(true);
      expect(result.booking).toBeDefined();
    });
  });
});
