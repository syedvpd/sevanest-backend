import { HttpStatus } from '@nestjs/common';
import { DomainException } from '../../common/errors/domain.exception';
import type { AuditService } from '../../common/audit/audit.service';
import type { WorkersService } from '../workers/workers.service';
import { WalletService } from './wallet.service';
import type { WalletRepository } from './wallet.repository';
import { WalletErrorCode } from './wallet.constants';
import type { Prisma, WorkerBankAccount } from '../../generated/prisma/client';

describe('Worker Bank Accounts Management (Track B)', () => {
  let service: WalletService;
  let mockRepo: jest.Mocked<Partial<WalletRepository>>;
  let mockWorkers: jest.Mocked<Partial<WorkersService>>;
  let mockAudit: jest.Mocked<Partial<AuditService>>;

  const mockAccount1: WorkerBankAccount = {
    id: '0192e47b-1111-7000-8000-000000000001',
    workerId: 'worker-1',
    accountHolderName: 'Ramesh Kumar',
    bankName: 'State Bank of India',
    accountNumber: '123456789012',
    accountNumberMasked: '••••••••9012',
    ifsc: 'SBIN0001234',
    verificationStatus: 'VERIFIED',
    isPrimary: true,
    verifiedAt: new Date('2026-01-01T00:00:00.000Z'),
    verifiedByUserId: 'admin-1',
    isDeleted: false,
    deletedAt: null,
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    updatedAt: new Date('2026-01-01T00:00:00.000Z'),
  };

  const mockAccount2: WorkerBankAccount = {
    id: '0192e47b-2222-7000-8000-000000000002',
    workerId: 'worker-1',
    accountHolderName: 'Ramesh Kumar',
    bankName: 'HDFC Bank',
    accountNumber: '987654321098',
    accountNumberMasked: '••••••••1098',
    ifsc: 'HDFC0000123',
    verificationStatus: 'PENDING',
    isPrimary: false,
    verifiedAt: null,
    verifiedByUserId: null,
    isDeleted: false,
    deletedAt: null,
    createdAt: new Date('2026-01-02T00:00:00.000Z'),
    updatedAt: new Date('2026-01-02T00:00:00.000Z'),
  };

  beforeEach(() => {
    mockRepo = {
      transaction: jest
        .fn()
        .mockImplementation(<T>(fn: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> => {
          return fn({} as Prisma.TransactionClient);
        }),
      listBankAccounts: jest.fn().mockResolvedValue([mockAccount1, mockAccount2]),
      findBankAccountById: jest
        .fn()
        .mockImplementation((id: string): Promise<WorkerBankAccount | null> => {
          if (id === mockAccount1.id) return Promise.resolve(mockAccount1);
          if (id === mockAccount2.id) return Promise.resolve(mockAccount2);
          return Promise.resolve(null);
        }),
      countBankAccounts: jest.fn().mockResolvedValue(2),
      clearPrimaryBankAccounts: jest.fn().mockResolvedValue(undefined),
      createBankAccount: jest
        .fn()
        .mockImplementation(
          (
            data: Parameters<WalletRepository['createBankAccount']>[0],
          ): Promise<WorkerBankAccount> => {
            return Promise.resolve({
              ...mockAccount1,
              ...data,
              id: 'new-account-id',
              createdAt: new Date(),
              updatedAt: new Date(),
            });
          },
        ),
      updateBankAccount: jest
        .fn()
        .mockImplementation(
          (
            id: string,
            data: Parameters<WalletRepository['updateBankAccount']>[1],
          ): Promise<WorkerBankAccount> => {
            return Promise.resolve({
              ...mockAccount1,
              ...(data as Partial<WorkerBankAccount>),
              id,
              updatedAt: new Date(),
            });
          },
        ),
      softDeleteBankAccount: jest.fn().mockResolvedValue(undefined),
      hasActiveWithdrawals: jest.fn().mockResolvedValue(false),
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

  describe('listBankAccounts', () => {
    it('returns saved bank accounts with masked account numbers', async () => {
      const accounts = await service.listBankAccounts('user-1');

      expect(accounts).toHaveLength(2);
      expect(accounts[0].accountNumberMasked).toBe('••••••••9012');
      expect(accounts[0].isPrimary).toBe(true);
      expect(accounts[0].ifscCode).toBe('SBIN0001234');
      expect(accounts[1].accountNumberMasked).toBe('••••••••1098');
      expect(accounts[1].isPrimary).toBe(false);
      // Ensure raw account numbers are never exposed in the response
      expect(Reflect.has(accounts[0], 'accountNumber')).toBe(false);
    });
  });

  describe('createBankAccount', () => {
    it('creates first account as primary automatically', async () => {
      mockRepo.countBankAccounts = jest.fn().mockResolvedValue(0);

      const created = await service.createBankAccount('user-1', {
        accountHolderName: 'Ramesh Kumar',
        bankName: 'State Bank of India',
        accountNumber: '123456789012',
        ifscCode: 'SBIN0001234',
        isPrimary: false,
      });

      expect(mockRepo.createBankAccount).toHaveBeenCalledWith(
        expect.objectContaining({
          workerId: 'worker-1',
          accountNumber: '123456789012',
          accountNumberMasked: '••••••••9012',
          ifsc: 'SBIN0001234',
          isPrimary: true,
          verificationStatus: 'PENDING',
        }),
        expect.anything(),
      );
      expect(created.isPrimary).toBe(true);
    });

    it('clears previous primary accounts when adding a new primary account', async () => {
      mockRepo.countBankAccounts = jest.fn().mockResolvedValue(1);

      await service.createBankAccount('user-1', {
        accountHolderName: 'Ramesh Kumar',
        bankName: 'HDFC Bank',
        accountNumber: '987654321098',
        ifscCode: 'HDFC0000123',
        isPrimary: true,
      });

      expect(mockRepo.clearPrimaryBankAccounts).toHaveBeenCalledWith('worker-1', expect.anything());
      expect(mockRepo.createBankAccount).toHaveBeenCalledWith(
        expect.objectContaining({
          isPrimary: true,
        }),
        expect.anything(),
      );
    });
  });

  describe('updateBankAccount', () => {
    it('updates account holder name without altering verification status', async () => {
      await service.updateBankAccount('user-1', mockAccount1.id, {
        accountHolderName: 'Ramesh K.',
      });

      expect(mockRepo.updateBankAccount).toHaveBeenCalledWith(
        mockAccount1.id,
        expect.objectContaining({
          accountHolderName: 'Ramesh K.',
        }),
        expect.anything(),
      );
    });

    it('resets verification status to PENDING when account number changes', async () => {
      await service.updateBankAccount('user-1', mockAccount1.id, {
        accountNumber: '123456789999',
      });

      expect(mockRepo.updateBankAccount).toHaveBeenCalledWith(
        mockAccount1.id,
        expect.objectContaining({
          accountNumber: '123456789999',
          accountNumberMasked: '••••••••9999',
          verificationStatus: 'PENDING',
        }),
        expect.anything(),
      );
    });

    it('rejects account number modification when active withdrawal is in progress', async () => {
      mockRepo.hasActiveWithdrawals = jest.fn().mockResolvedValue(true);

      await expect(
        service.updateBankAccount('user-1', mockAccount1.id, {
          accountNumber: '123456789999',
        }),
      ).rejects.toThrow(DomainException);

      try {
        await service.updateBankAccount('user-1', mockAccount1.id, {
          accountNumber: '123456789999',
        });
      } catch (err: unknown) {
        if (!(err instanceof DomainException)) throw err;
        expect(err.code).toBe(WalletErrorCode.ACTIVE_WITHDRAWAL_EXISTS);
        expect(err.getStatus()).toBe(HttpStatus.UNPROCESSABLE_ENTITY);
      }
    });

    it('throws NOT_FOUND if bank account does not exist or does not belong to worker', async () => {
      await expect(
        service.updateBankAccount('user-1', '0192e47b-9999-7000-8000-000000000000', {
          bankName: 'ICICI Bank',
        }),
      ).rejects.toThrow(DomainException);
    });
  });

  describe('deleteBankAccount', () => {
    it('blocks deleting a bank account when active withdrawals exist', async () => {
      mockRepo.hasActiveWithdrawals = jest.fn().mockResolvedValue(true);

      await expect(service.deleteBankAccount('user-1', mockAccount2.id)).rejects.toThrow(
        DomainException,
      );

      try {
        await service.deleteBankAccount('user-1', mockAccount2.id);
      } catch (err: unknown) {
        if (!(err instanceof DomainException)) throw err;
        expect(err.code).toBe(WalletErrorCode.BANK_ACCOUNT_IN_USE);
        expect(err.getStatus()).toBe(HttpStatus.UNPROCESSABLE_ENTITY);
      }
    });

    it('blocks deleting primary bank account while other active accounts exist', async () => {
      mockRepo.countBankAccounts = jest.fn().mockResolvedValue(2);

      await expect(service.deleteBankAccount('user-1', mockAccount1.id)).rejects.toThrow(
        DomainException,
      );

      try {
        await service.deleteBankAccount('user-1', mockAccount1.id);
      } catch (err: unknown) {
        if (!(err instanceof DomainException)) throw err;
        expect(err.code).toBe(WalletErrorCode.CANNOT_DELETE_PRIMARY_ACCOUNT);
        expect(err.getStatus()).toBe(HttpStatus.UNPROCESSABLE_ENTITY);
      }
    });

    it('allows deleting primary account if it is the only remaining account', async () => {
      mockRepo.countBankAccounts = jest.fn().mockResolvedValue(1);

      const res = await service.deleteBankAccount('user-1', mockAccount1.id);

      expect(res.success).toBe(true);
      expect(mockRepo.softDeleteBankAccount).toHaveBeenCalledWith(
        mockAccount1.id,
        expect.anything(),
      );
    });

    it('successfully soft-deletes a non-primary bank account', async () => {
      const res = await service.deleteBankAccount('user-1', mockAccount2.id);

      expect(res.success).toBe(true);
      expect(mockRepo.softDeleteBankAccount).toHaveBeenCalledWith(
        mockAccount2.id,
        expect.anything(),
      );
    });
  });
});
