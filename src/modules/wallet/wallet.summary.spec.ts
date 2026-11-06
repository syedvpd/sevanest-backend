import type { AuditService } from '../../common/audit/audit.service';
import type { WorkersService } from '../workers/workers.service';
import { WalletService } from './wallet.service';
import type { WalletRepository } from './wallet.repository';
import type { WorkerWallet } from '../../generated/prisma/client';

describe('Worker Wallet Summary (Track A)', () => {
  let service: WalletService;
  let mockRepo: jest.Mocked<Partial<WalletRepository>>;
  let mockWorkers: jest.Mocked<Partial<WorkersService>>;
  let mockAudit: jest.Mocked<Partial<AuditService>>;

  const mockWallet: WorkerWallet = {
    id: 'wallet-1',
    workerId: 'worker-1',
    availableBalanceMinor: 450000, // ₹4,500.00
    pendingBalanceMinor: 50000, // ₹500.00
    currency: 'INR',
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    updatedAt: new Date('2026-01-05T12:00:00.000Z'),
  };

  beforeEach(() => {
    mockRepo = {
      getOrCreateWallet: jest.fn().mockResolvedValue(mockWallet),
      listCountedWagePayments: jest.fn().mockResolvedValue([
        {
          id: 'pay-1',
          amountMinor: 250000, // ₹2,500.00
          recordedAt: new Date('2026-01-02T10:00:00.000Z'),
          bookingId: 'bk-1',
          booking: { categoryId: 'cat-1' },
        },
        {
          id: 'pay-2',
          amountMinor: 150000, // ₹1,500.00
          recordedAt: new Date('2026-01-03T10:00:00.000Z'),
          bookingId: 'bk-2',
          booking: { categoryId: 'cat-2' },
        },
      ]),
      sumSettledCredits: jest.fn().mockResolvedValue(100000), // ₹1,000.00
      sumPaidWithdrawals: jest.fn().mockResolvedValue(50000), // ₹500.00
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

  it('calculates wallet summary accurately in minor currency units (paise)', async () => {
    const summary = await service.getSummary('user-1');

    // Available and pending come from WorkerWallet record
    expect(summary.availableBalanceMinor).toBe(450000);
    expect(summary.pendingEarningsMinor).toBe(50000);
    expect(summary.currency).toBe('INR');
    expect(summary.updatedAt).toEqual(mockWallet.updatedAt);

    // Total earnings = wagePayments (250000 + 150000 = 400000) + ledger credits (100000) = 500000
    expect(summary.totalEarningsMinor).toBe(500000);

    // Total paid = wage disbursements (400000) + paid withdrawals (50000) = 450000
    expect(summary.totalPaidMinor).toBe(450000);
  });

  it('handles workers with zero prior earnings and clean wallet', async () => {
    mockRepo.getOrCreateWallet = jest.fn().mockResolvedValue({
      id: 'wallet-2',
      workerId: 'worker-2',
      availableBalanceMinor: 0,
      pendingBalanceMinor: 0,
      currency: 'INR',
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    mockRepo.listCountedWagePayments = jest.fn().mockResolvedValue([]);
    mockRepo.sumSettledCredits = jest.fn().mockResolvedValue(0);
    mockRepo.sumPaidWithdrawals = jest.fn().mockResolvedValue(0);

    const summary = await service.getSummary('user-2');

    expect(summary.availableBalanceMinor).toBe(0);
    expect(summary.pendingEarningsMinor).toBe(0);
    expect(summary.totalEarningsMinor).toBe(0);
    expect(summary.totalPaidMinor).toBe(0);
  });
});
