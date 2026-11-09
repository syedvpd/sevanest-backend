import { HttpStatus } from '@nestjs/common';
import { DomainException } from '../../common/errors/domain.exception';
import { ErrorCode } from '../../common/errors/error-codes';
import type { AuditService } from '../../common/audit/audit.service';
import type { WorkersService } from '../workers/workers.service';
import { WalletService } from './wallet.service';
import type { WalletRepository } from './wallet.repository';

describe('Worker Earnings Analytics & Shift Breakdown (Track C)', () => {
  let service: WalletService;
  let mockRepo: jest.Mocked<Partial<WalletRepository>>;
  let mockWorkers: jest.Mocked<Partial<WorkersService>>;
  let mockAudit: jest.Mocked<Partial<AuditService>>;

  beforeEach(() => {
    mockRepo = {
      listCountedWagePayments: jest.fn().mockResolvedValue([
        {
          id: 'pay-1',
          amountMinor: 300000, // ₹3,000.00
          recordedAt: new Date('2026-11-02T10:00:00.000Z'),
          bookingId: 'bk-1',
          booking: { categoryId: 'cat-maid' },
        },
        {
          id: 'pay-2',
          amountMinor: 150000, // ₹1,500.00
          recordedAt: new Date('2026-11-03T10:00:00.000Z'),
          bookingId: 'bk-2',
          booking: { categoryId: 'cat-cook' },
        },
      ]),
      listCompletedAttendance: jest.fn().mockResolvedValue([
        {
          id: 'att-1',
          date: new Date('2026-11-02T00:00:00.000Z'),
          status: 'PRESENT',
          bookingId: 'bk-1',
          booking: { categoryId: 'cat-maid' },
        },
        {
          id: 'att-2',
          date: new Date('2026-11-03T00:00:00.000Z'),
          status: 'PRESENT',
          bookingId: 'bk-1',
          booking: { categoryId: 'cat-maid' },
        },
        {
          id: 'att-3',
          date: new Date('2026-11-03T00:00:00.000Z'),
          status: 'LATE',
          bookingId: 'bk-2',
          booking: { categoryId: 'cat-cook' },
        },
      ]),
      listServiceCategories: jest.fn().mockResolvedValue([
        { id: 'cat-maid', code: 'HOUSE_MAID', name: 'House Maid' },
        { id: 'cat-cook', code: 'COOK', name: 'Cook' },
        { id: 'cat-driver', code: 'DRIVER', name: 'Driver' },
      ]),
    };

    mockWorkers = {
      requireRefByUserId: jest.fn().mockResolvedValue({
        workerId: 'worker-1',
        userId: 'user-1',
        onboardingStatus: 'SUBMITTED',
        applicationReference: 'SEVA00000001',
        signedOffAt: new Date(),
        activatedAt: new Date(),
      }),
    };

    mockAudit = {
      record: jest.fn().mockResolvedValue(undefined),
    };

    service = new WalletService(
      mockRepo as unknown as WalletRepository,
      mockWorkers as unknown as WorkersService,
      mockAudit as unknown as AuditService,
    );
  });

  it('aggregates period earnings, completed shifts, and category breakdown', async () => {
    const analytics = await service.getAnalytics('user-1', {
      period: 'THIS_MONTH',
    });

    expect(analytics.period).toBe('THIS_MONTH');
    expect(analytics.currency).toBe('INR');
    expect(analytics.totalEarningsMinor).toBe(450000);
    expect(analytics.completedShiftsCount).toBe(3);

    // Verify category breakdown
    expect(analytics.categoryBreakdown).toHaveLength(2);

    const maidCategory = analytics.categoryBreakdown.find((c) => c.categoryCode === 'HOUSE_MAID');
    expect(maidCategory).toBeDefined();
    expect(maidCategory?.categoryName).toBe('House Cleaning');
    expect(maidCategory?.earningsMinor).toBe(300000);
    expect(maidCategory?.completedShiftsCount).toBe(2);
    expect(maidCategory?.percentage).toBe(66.67);

    const cookCategory = analytics.categoryBreakdown.find((c) => c.categoryCode === 'COOK');
    expect(cookCategory).toBeDefined();
    expect(cookCategory?.categoryName).toBe('Cooking & Meal Prep');
    expect(cookCategory?.earningsMinor).toBe(150000);
    expect(cookCategory?.completedShiftsCount).toBe(1);
    expect(cookCategory?.percentage).toBe(33.33);

    // Verify daily earnings breakdown
    expect(analytics.dailyEarnings.length).toBeGreaterThanOrEqual(2);
  });

  it('supports CUSTOM date range filter with valid dates', async () => {
    const analytics = await service.getAnalytics('user-1', {
      period: 'CUSTOM',
      from: '2026-11-01',
      to: '2026-11-10',
    });

    expect(analytics.period).toBe('CUSTOM');
    expect(analytics.from).toBe('2026-11-01');
    expect(analytics.to).toBe('2026-11-10');
  });

  it('rejects CUSTOM period when from date is missing or invalid', async () => {
    await expect(
      service.getAnalytics('user-1', {
        period: 'CUSTOM',
        to: '2026-11-10',
      }),
    ).rejects.toThrow(DomainException);

    try {
      await service.getAnalytics('user-1', {
        period: 'CUSTOM',
        from: '2026-02-30',
        to: '2026-11-10',
      });
    } catch (err: unknown) {
      if (!(err instanceof DomainException)) throw err;
      expect(err.code).toBe(ErrorCode.VALIDATION_FAILED);
      expect(err.getStatus()).toBe(HttpStatus.BAD_REQUEST);
    }
  });

  it('rejects CUSTOM period when from date is after to date', async () => {
    await expect(
      service.getAnalytics('user-1', {
        period: 'CUSTOM',
        from: '2026-11-15',
        to: '2026-11-10',
      }),
    ).rejects.toThrow(DomainException);
  });
});
