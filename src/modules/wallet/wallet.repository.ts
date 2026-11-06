import { Injectable } from '@nestjs/common';
import type {
  Prisma,
  WorkerBankAccount,
  WorkerWallet,
  WorkerWalletLedger,
  WorkerWithdrawal,
  WalletLedgerType,
  WalletLedgerStatus,
  WorkerWithdrawalStatus,
} from '../../generated/prisma/client';
import { PrismaService } from '../../infrastructure/database/prisma.service';

type Db = Prisma.TransactionClient | PrismaService;

@Injectable()
export class WalletRepository {
  constructor(private readonly prisma: PrismaService) {}

  transaction<T>(work: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
    return this.prisma.$transaction(work);
  }

  // --- WorkerWallet ---

  async getOrCreateWallet(workerId: string, db: Db = this.prisma): Promise<WorkerWallet> {
    const existing = await db.workerWallet.findUnique({ where: { workerId } });
    if (existing) return existing;

    return db.workerWallet.create({
      data: {
        workerId,
        availableBalanceMinor: 0,
        pendingBalanceMinor: 0,
        currency: 'INR',
      },
    });
  }

  async lockWallet(
    workerId: string,
    tx: Prisma.TransactionClient,
  ): Promise<{ id: string; availableBalanceMinor: number; pendingBalanceMinor: number } | null> {
    const rows = await tx.$queryRaw<
      Array<{ id: string; available_balance_minor: number; pending_balance_minor: number }>
    >`SELECT id, available_balance_minor, pending_balance_minor FROM worker_wallets WHERE worker_id = ${workerId}::uuid FOR UPDATE`;

    if (rows.length === 0) return null;
    return {
      id: rows[0].id,
      availableBalanceMinor: rows[0].available_balance_minor,
      pendingBalanceMinor: rows[0].pending_balance_minor,
    };
  }

  async updateWalletBalances(
    workerId: string,
    data: { availableBalanceMinor?: number; pendingBalanceMinor?: number },
    tx: Prisma.TransactionClient,
  ): Promise<WorkerWallet> {
    return tx.workerWallet.update({
      where: { workerId },
      data,
    });
  }

  // --- WorkerBankAccount ---

  async listBankAccounts(workerId: string, db: Db = this.prisma): Promise<WorkerBankAccount[]> {
    return db.workerBankAccount.findMany({
      where: { workerId, isDeleted: false },
      orderBy: [{ isPrimary: 'desc' }, { createdAt: 'desc' }],
    });
  }

  async findBankAccountById(
    id: string,
    workerId?: string,
    db: Db = this.prisma,
  ): Promise<WorkerBankAccount | null> {
    return db.workerBankAccount.findFirst({
      where: {
        id,
        isDeleted: false,
        ...(workerId ? { workerId } : {}),
      },
    });
  }

  async countBankAccounts(workerId: string, db: Db = this.prisma): Promise<number> {
    return db.workerBankAccount.count({
      where: { workerId, isDeleted: false },
    });
  }

  async clearPrimaryBankAccounts(workerId: string, tx: Prisma.TransactionClient): Promise<void> {
    await tx.workerBankAccount.updateMany({
      where: { workerId, isPrimary: true, isDeleted: false },
      data: { isPrimary: false },
    });
  }

  async createBankAccount(
    data: {
      workerId: string;
      accountHolderName: string;
      bankName: string;
      accountNumber: string;
      accountNumberMasked: string;
      ifsc: string;
      isPrimary: boolean;
      verificationStatus?: 'UNVERIFIED' | 'PENDING' | 'VERIFIED' | 'REJECTED';
    },
    tx: Prisma.TransactionClient,
  ): Promise<WorkerBankAccount> {
    return tx.workerBankAccount.create({
      data: {
        ...data,
        verificationStatus: data.verificationStatus ?? 'PENDING',
      },
    });
  }

  async updateBankAccount(
    id: string,
    data: Prisma.WorkerBankAccountUpdateInput,
    tx: Prisma.TransactionClient,
  ): Promise<WorkerBankAccount> {
    return tx.workerBankAccount.update({
      where: { id },
      data,
    });
  }

  async softDeleteBankAccount(id: string, tx: Prisma.TransactionClient): Promise<void> {
    await tx.workerBankAccount.update({
      where: { id },
      data: {
        isDeleted: true,
        deletedAt: new Date(),
        isPrimary: false,
      },
    });
  }

  async hasActiveWithdrawals(bankAccountId: string, db: Db = this.prisma): Promise<boolean> {
    const count = await db.workerWithdrawal.count({
      where: {
        bankAccountId,
        status: { in: ['REQUESTED', 'PROCESSING'] },
      },
    });
    return count > 0;
  }

  // --- WorkerWithdrawal & Payouts ---

  async createWithdrawal(
    data: {
      walletId: string;
      workerId: string;
      bankAccountId: string;
      amountMinor: number;
      currency?: string;
      bankAccountMasked: string;
      idempotencyKey?: string | null;
    },
    tx: Prisma.TransactionClient,
  ): Promise<WorkerWithdrawal> {
    return tx.workerWithdrawal.create({
      data: {
        ...data,
        currency: data.currency ?? 'INR',
        status: 'REQUESTED',
      },
    });
  }

  async findWithdrawalById(
    id: string,
    workerId?: string,
    db: Db = this.prisma,
  ): Promise<WorkerWithdrawal | null> {
    return db.workerWithdrawal.findFirst({
      where: {
        id,
        ...(workerId ? { workerId } : {}),
      },
    });
  }

  async findWithdrawalByIdempotency(
    workerId: string,
    idempotencyKey: string,
    db: Db = this.prisma,
  ): Promise<WorkerWithdrawal | null> {
    return db.workerWithdrawal.findFirst({
      where: { workerId, idempotencyKey },
    });
  }

  async listWithdrawals(
    filter: { workerId: string; status?: WorkerWithdrawalStatus },
    skip: number,
    take: number,
    db: Db = this.prisma,
  ): Promise<{ items: WorkerWithdrawal[]; total: number }> {
    const where: Prisma.WorkerWithdrawalWhereInput = {
      workerId: filter.workerId,
      ...(filter.status ? { status: filter.status } : {}),
    };

    const [items, total] = await Promise.all([
      db.workerWithdrawal.findMany({
        where,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip,
        take,
      }),
      db.workerWithdrawal.count({ where }),
    ]);

    return { items, total };
  }

  // --- WorkerWalletLedger ---

  async createLedgerEntry(
    data: {
      walletId: string;
      workerId: string;
      type: WalletLedgerType;
      status?: WalletLedgerStatus;
      amountMinor: number;
      currency?: string;
      referenceType?: string | null;
      referenceId?: string | null;
      description?: string | null;
      idempotencyKey?: string | null;
    },
    tx: Prisma.TransactionClient,
  ): Promise<WorkerWalletLedger> {
    return tx.workerWalletLedger.create({
      data: {
        ...data,
        status: data.status ?? 'COMPLETED',
        currency: data.currency ?? 'INR',
      },
    });
  }

  async listLedgerEntries(
    filter: {
      workerId: string;
      type?: WalletLedgerType;
      status?: WalletLedgerStatus;
    },
    skip: number,
    take: number,
    db: Db = this.prisma,
  ): Promise<{ items: WorkerWalletLedger[]; total: number }> {
    const where: Prisma.WorkerWalletLedgerWhereInput = {
      workerId: filter.workerId,
      ...(filter.type ? { type: filter.type } : {}),
      ...(filter.status ? { status: filter.status } : {}),
    };

    const [items, total] = await Promise.all([
      db.workerWalletLedger.findMany({
        where,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip,
        take,
      }),
      db.workerWalletLedger.count({ where }),
    ]);

    return { items, total };
  }

  async sumSettledCredits(workerId: string, db: Db = this.prisma): Promise<number> {
    const agg = await db.workerWalletLedger.aggregate({
      where: {
        workerId,
        type: { in: ['EARNING', 'ADJUSTMENT'] },
        status: 'COMPLETED',
      },
      _sum: { amountMinor: true },
    });
    return agg._sum.amountMinor ?? 0;
  }

  async sumPaidWithdrawals(workerId: string, db: Db = this.prisma): Promise<number> {
    const agg = await db.workerWithdrawal.aggregate({
      where: {
        workerId,
        status: 'PAID',
      },
      _sum: { amountMinor: true },
    });
    return agg._sum.amountMinor ?? 0;
  }

  // --- Analytics Queries ---

  async listCountedWagePayments(
    workerId: string,
    fromDate?: Date,
    toDate?: Date,
    db: Db = this.prisma,
  ): Promise<
    Array<{
      id: string;
      amountMinor: number;
      recordedAt: Date;
      bookingId: string;
      booking: { categoryId: string };
    }>
  > {
    return db.workerPaymentReference.findMany({
      where: {
        workerId,
        isVoid: false,
        correctedBy: { none: {} },
        ...(fromDate || toDate
          ? {
              recordedAt: {
                ...(fromDate ? { gte: fromDate } : {}),
                ...(toDate ? { lte: toDate } : {}),
              },
            }
          : {}),
      },
      select: {
        id: true,
        amountMinor: true,
        recordedAt: true,
        bookingId: true,
        booking: {
          select: { categoryId: true },
        },
      },
      orderBy: { recordedAt: 'asc' },
    });
  }

  async listCompletedAttendance(
    workerId: string,
    fromDate?: Date,
    toDate?: Date,
    db: Db = this.prisma,
  ): Promise<
    Array<{
      id: string;
      date: Date;
      status: string;
      bookingId: string;
      booking: { categoryId: string };
    }>
  > {
    return db.attendanceRecord.findMany({
      where: {
        workerId,
        status: { in: ['PRESENT', 'LATE'] },
        ...(fromDate || toDate
          ? {
              date: {
                ...(fromDate ? { gte: fromDate } : {}),
                ...(toDate ? { lte: toDate } : {}),
              },
            }
          : {}),
      },
      select: {
        id: true,
        date: true,
        status: true,
        bookingId: true,
        booking: {
          select: { categoryId: true },
        },
      },
      orderBy: { date: 'asc' },
    });
  }

  async listServiceCategories(
    db: Db = this.prisma,
  ): Promise<Array<{ id: string; code: string; name: string }>> {
    return db.serviceCategory.findMany({
      select: { id: true, code: true, name: true },
    });
  }
}

