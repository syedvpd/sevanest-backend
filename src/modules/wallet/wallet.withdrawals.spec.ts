import { HttpStatus } from '@nestjs/common';
import { DomainException } from '../../common/errors/domain.exception';
import type { AuditService } from '../../common/audit/audit.service';
import type { WorkersService } from '../workers/workers.service';
import { WalletService } from './wallet.service';
import type { WalletRepository } from './wallet.repository';
import { WalletErrorCode } from './wallet.constants';
import type {
  Prisma,
  WorkerBankAccount,
  WorkerWallet,
  WorkerWalletLedger,
  WorkerWithdrawal,
} from '../../generated/prisma/client';

describe('Worker Withdrawals & Payouts Lifecycle (Track D & D2)', () => {
  let service: WalletService;
  let mockRepo: jest.Mocked<Partial<WalletRepository>>;
  let mockWorkers: jest.Mocked<Partial<WorkersService>>;
  let mockAudit: jest.Mocked<Partial<AuditService>>;

  const mockBankAccount: WorkerBankAccount = {
    id: '0192e47b-1111-7000-8000-000000000001',
    workerId: 'worker-1',
    accountHolderName: 'Ramesh Kumar',
    bankName: 'State Bank of India',
    accountNumber: '123456789012',
    accountNumberMasked: '••••••••9012',
    ifsc: 'SBIN0001234',
    verificationStatus: 'VERIFIED',
    isPrimary: true,
    verifiedAt: new Date(),
    verifiedByUserId: 'admin-1',
    isDeleted: false,
    deletedAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  const mockWithdrawal: WorkerWithdrawal = {
    id: '0192e47b-9999-7000-8000-000000000001',
    walletId: 'wallet-1',
    workerId: 'worker-1',
    bankAccountId: mockBankAccount.id,
    amountMinor: 20000, // ₹200.00
    currency: 'INR',
    status: 'REQUESTED',
    bankAccountMasked: 'State Bank of India (••••••••9012)',
    idempotencyKey: 'idem-123',
    failureReason: null,
    providerReference: null,
    processedAt: null,
    createdAt: new Date('2026-11-06T10:00:00.000Z'),
    updatedAt: new Date('2026-11-06T10:00:00.000Z'),
  };

  const mockWallet: WorkerWallet = {
    id: 'wallet-1',
    workerId: 'worker-1',
    availableBalanceMinor: 50000,
    pendingBalanceMinor: 0,
    currency: 'INR',
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  const mockLedger: WorkerWalletLedger = {
    id: 'ledger-1',
    walletId: 'wallet-1',
    workerId: 'worker-1',
    type: 'WITHDRAWAL_RESERVE',
    status: 'COMPLETED',
    amountMinor: 20000,
    currency: 'INR',
    referenceType: 'WITHDRAWAL',
    referenceId: mockWithdrawal.id,
    description: 'Withdrawal reservation',
    idempotencyKey: null,
    createdAt: new Date(),
  };

  beforeEach(() => {
    mockRepo = {
      transaction: jest
        .fn()
        .mockImplementation(<T>(fn: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> => {
          return fn({} as Prisma.TransactionClient);
        }),
      getOrCreateWallet: jest.fn().mockResolvedValue(mockWallet),
      lockWallet: jest.fn().mockResolvedValue({
        id: 'wallet-1',
        availableBalanceMinor: 50000,
        pendingBalanceMinor: 0,
      }),
      updateWalletBalances: jest.fn().mockResolvedValue(mockWallet),
      findBankAccountById: jest
        .fn()
        .mockImplementation((id: string): Promise<WorkerBankAccount | null> => {
          if (id === mockBankAccount.id) return Promise.resolve(mockBankAccount);
          return Promise.resolve(null);
        }),
      createWithdrawal: jest.fn().mockResolvedValue(mockWithdrawal),
      createLedgerEntry: jest.fn().mockResolvedValue(mockLedger),
      findWithdrawalByIdempotency: jest.fn().mockResolvedValue(null),
      findWithdrawalById: jest
        .fn()
        .mockImplementation((id: string): Promise<WorkerWithdrawal | null> => {
          if (id === mockWithdrawal.id) return Promise.resolve(mockWithdrawal);
          return Promise.resolve(null);
        }),
      listWithdrawals: jest.fn().mockResolvedValue({
        items: [mockWithdrawal],
        total: 1,
      }),
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

  describe('requestWithdrawal', () => {
    it('enforces minimum withdrawal amount of ₹100 (10000 minor units)', async () => {
      await expect(
        service.requestWithdrawal('user-1', {
          amountMinor: 5000, // ₹50.00 < ₹100.00
          bankAccountId: mockBankAccount.id,
        }),
      ).rejects.toThrow(DomainException);

      try {
        await service.requestWithdrawal('user-1', {
          amountMinor: 5000,
          bankAccountId: mockBankAccount.id,
        });
      } catch (err: unknown) {
        const error = err as DomainException;
        expect(error.code).toBe(WalletErrorCode.MINIMUM_WITHDRAWAL_REQUIRED);
        expect(error.status).toBe(HttpStatus.BAD_REQUEST);
      }
    });

    it('rejects withdrawal if bank account is not found', async () => {
      await expect(
        service.requestWithdrawal('user-1', {
          amountMinor: 20000,
          bankAccountId: '0192e47b-0000-7000-8000-000000000000',
        }),
      ).rejects.toThrow(DomainException);
    });

    it('rejects withdrawal if bank account is rejected', async () => {
      mockRepo.findBankAccountById = jest.fn().mockResolvedValue({
        ...mockBankAccount,
        verificationStatus: 'REJECTED',
      });

      await expect(
        service.requestWithdrawal('user-1', {
          amountMinor: 20000,
          bankAccountId: mockBankAccount.id,
        }),
      ).rejects.toThrow(DomainException);

      try {
        await service.requestWithdrawal('user-1', {
          amountMinor: 20000,
          bankAccountId: mockBankAccount.id,
        });
      } catch (err: unknown) {
        const error = err as DomainException;
        expect(error.code).toBe(WalletErrorCode.BANK_ACCOUNT_NOT_VERIFIED);
        expect(error.status).toBe(HttpStatus.UNPROCESSABLE_ENTITY);
      }
    });

    it('rejects withdrawal when requested amount exceeds available balance', async () => {
      mockRepo.lockWallet = jest.fn().mockResolvedValue({
        id: 'wallet-1',
        availableBalanceMinor: 15000, // only ₹150 available
        pendingBalanceMinor: 0,
      });

      await expect(
        service.requestWithdrawal('user-1', {
          amountMinor: 20000, // requesting ₹200
          bankAccountId: mockBankAccount.id,
        }),
      ).rejects.toThrow(DomainException);

      try {
        await service.requestWithdrawal('user-1', {
          amountMinor: 20000,
          bankAccountId: mockBankAccount.id,
        });
      } catch (err: unknown) {
        const error = err as DomainException;
        expect(error.code).toBe(WalletErrorCode.INSUFFICIENT_BALANCE);
        expect(error.status).toBe(HttpStatus.UNPROCESSABLE_ENTITY);
      }
    });

    it('successfully processes withdrawal, decrements balance, creates ledger reservation, and audits', async () => {
      const result = await service.requestWithdrawal('user-1', {
        amountMinor: 20000,
        bankAccountId: mockBankAccount.id,
        idempotencyKey: 'idem-123',
      });

      expect(mockRepo.updateWalletBalances).toHaveBeenCalledWith(
        'worker-1',
        { availableBalanceMinor: 30000 }, // 50000 - 20000
        expect.anything(),
      );

      expect(mockRepo.createWithdrawal).toHaveBeenCalledWith(
        expect.objectContaining({
          walletId: 'wallet-1',
          workerId: 'worker-1',
          bankAccountId: mockBankAccount.id,
          amountMinor: 20000,
          currency: 'INR',
          idempotencyKey: 'idem-123',
        }),
        expect.anything(),
      );

      expect(mockRepo.createLedgerEntry).toHaveBeenCalledWith(
        expect.objectContaining({
          walletId: 'wallet-1',
          workerId: 'worker-1',
          type: 'WITHDRAWAL_RESERVE',
          status: 'COMPLETED',
          amountMinor: 20000,
          referenceType: 'WITHDRAWAL',
        }),
        expect.anything(),
      );

      expect(mockAudit.record).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'wallet.withdrawal_request',
          entityType: 'worker_withdrawal',
        }),
        expect.anything(),
      );

      expect(result.amountMinor).toBe(20000);
      expect(result.status).toBe('REQUESTED');
    });

    it('returns existing withdrawal idempotently on key replay', async () => {
      mockRepo.findWithdrawalByIdempotency = jest.fn().mockResolvedValue(mockWithdrawal);

      const result = await service.requestWithdrawal('user-1', {
        amountMinor: 20000,
        bankAccountId: mockBankAccount.id,
        idempotencyKey: 'idem-123',
      });

      expect(result.id).toBe(mockWithdrawal.id);
      expect(mockRepo.updateWalletBalances).not.toHaveBeenCalled();
    });
  });

  describe('listPayouts & getPayout', () => {
    it('returns paginated payouts list', async () => {
      const payouts = await service.listPayouts('user-1', { page: 1, limit: 10 });

      expect(payouts.data).toHaveLength(1);
      expect(payouts.data[0].id).toBe(mockWithdrawal.id);
      expect(payouts.meta.total).toBe(1);
    });

    it('retrieves specific payout detail', async () => {
      const payout = await service.getPayout('user-1', mockWithdrawal.id);

      expect(payout.id).toBe(mockWithdrawal.id);
      expect(payout.amountMinor).toBe(mockWithdrawal.amountMinor);
      expect(payout.status).toBe('REQUESTED');
    });

    it('throws NOT_FOUND for non-existent payout', async () => {
      await expect(
        service.getPayout('user-1', '0192e47b-0000-7000-8000-000000000000'),
      ).rejects.toThrow(DomainException);
    });
  });
});
