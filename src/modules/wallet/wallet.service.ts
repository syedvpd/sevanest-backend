import { HttpStatus, Injectable } from '@nestjs/common';
import { AuditService } from '../../common/audit/audit.service';
import { DomainException } from '../../common/errors/domain.exception';
import { ErrorCode } from '../../common/errors/error-codes';
import { Page, skipFor } from '../../common/pagination/pagination';
import { indiaToday, isRealDate } from '../../common/time/india';
import type { WorkerBankAccount, WorkerWithdrawal } from '../../generated/prisma/client';
import { WorkersService } from '../workers/workers.service';
import {
  AnalyticsPeriodValue,
  CategoryEarningsItem,
  CreateWithdrawalDto,
  CreateWorkerBankAccountDto,
  DailyEarningsItem,
  MIN_WITHDRAWAL_MINOR,
  PayoutListQueryDto,
  UpdateWorkerBankAccountDto,
  WalletAnalyticsQueryDto,
  WalletAnalyticsResponse,
  WalletTransactionItem,
  WalletTransactionsQueryDto,
  WithdrawalResponse,
  WorkerBankAccountResponse,
  WorkerWalletSummaryResponse,
} from './dto/wallet.dto';
import { CATEGORY_DISPLAY_NAMES, maskAccountNumber, WalletErrorCode } from './wallet.constants';
import { WalletRepository } from './wallet.repository';

@Injectable()
export class WalletService {
  constructor(
    private readonly repository: WalletRepository,
    private readonly workers: WorkersService,
    private readonly audit: AuditService,
  ) {}

  private async requireWorkerId(userId: string): Promise<string> {
    const ref = await this.workers.requireRefByUserId(userId);
    return ref.workerId;
  }

  // --- Track A: Wallet Summary ---

  async getSummary(userId: string): Promise<WorkerWalletSummaryResponse> {
    const workerId = await this.requireWorkerId(userId);
    const wallet = await this.repository.getOrCreateWallet(workerId);

    const [wagePayments, totalLedgerCredits, totalPaidWithdrawals] = await Promise.all([
      this.repository.listCountedWagePayments(workerId),
      this.repository.sumSettledCredits(workerId),
      this.repository.sumPaidWithdrawals(workerId),
    ]);

    const totalWageEarnings = wagePayments.reduce((sum, p) => sum + p.amountMinor, 0);
    const totalEarningsMinor = totalWageEarnings + totalLedgerCredits;
    // Total paid includes directly disbursed wage payments and completed wallet payouts
    const totalPaidMinor = totalWageEarnings + totalPaidWithdrawals;

    return {
      availableBalanceMinor: wallet.availableBalanceMinor,
      pendingEarningsMinor: wallet.pendingBalanceMinor,
      totalEarningsMinor,
      totalPaidMinor,
      currency: wallet.currency,
      updatedAt: wallet.updatedAt,
    };
  }

  // --- Track B: Bank Account Management ---

  async listBankAccounts(userId: string): Promise<WorkerBankAccountResponse[]> {
    const workerId = await this.requireWorkerId(userId);
    const accounts = await this.repository.listBankAccounts(workerId);
    return accounts.map(toBankAccountResponse);
  }

  async createBankAccount(
    userId: string,
    dto: CreateWorkerBankAccountDto,
  ): Promise<WorkerBankAccountResponse> {
    const workerId = await this.requireWorkerId(userId);

    const totalExisting = await this.repository.countBankAccounts(workerId);
    const shouldBePrimary = totalExisting === 0 ? true : (dto.isPrimary ?? false);

    const created = await this.repository.transaction(async (tx) => {
      if (shouldBePrimary && totalExisting > 0) {
        await this.repository.clearPrimaryBankAccounts(workerId, tx);
      }

      const account = await this.repository.createBankAccount(
        {
          workerId,
          accountHolderName: dto.accountHolderName,
          bankName: dto.bankName,
          accountNumber: dto.accountNumber,
          accountNumberMasked: maskAccountNumber(dto.accountNumber),
          ifsc: dto.ifscCode,
          isPrimary: shouldBePrimary,
          verificationStatus: 'PENDING',
        },
        tx,
      );

      await this.audit.record(
        {
          action: 'wallet.bank_account_create',
          entityType: 'worker_bank_account',
          entityId: account.id,
          actorId: userId,
          metadata: { isPrimary: shouldBePrimary, bankName: account.bankName },
        },
        tx,
      );

      return account;
    });

    return toBankAccountResponse(created);
  }

  async updateBankAccount(
    userId: string,
    accountId: string,
    dto: UpdateWorkerBankAccountDto,
  ): Promise<WorkerBankAccountResponse> {
    const workerId = await this.requireWorkerId(userId);
    const existing = await this.repository.findBankAccountById(accountId, workerId);

    if (!existing) {
      throw new DomainException(
        WalletErrorCode.BANK_ACCOUNT_NOT_FOUND,
        'Bank account not found',
        HttpStatus.NOT_FOUND,
      );
    }

    if (
      (dto.accountNumber !== undefined && dto.accountNumber !== existing.accountNumber) ||
      (dto.ifscCode !== undefined && dto.ifscCode !== existing.ifsc)
    ) {
      const inUse = await this.repository.hasActiveWithdrawals(accountId);
      if (inUse) {
        throw new DomainException(
          WalletErrorCode.ACTIVE_WITHDRAWAL_EXISTS,
          'Cannot modify bank account details while a withdrawal is in progress',
          HttpStatus.UNPROCESSABLE_ENTITY,
        );
      }
    }

    const updated = await this.repository.transaction(async (tx) => {
      if (dto.isPrimary) {
        await this.repository.clearPrimaryBankAccounts(workerId, tx);
      }

      const updateData: Parameters<typeof this.repository.updateBankAccount>[1] = {};
      if (dto.accountHolderName !== undefined) updateData.accountHolderName = dto.accountHolderName;
      if (dto.bankName !== undefined) updateData.bankName = dto.bankName;
      if (dto.isPrimary !== undefined) updateData.isPrimary = dto.isPrimary;

      if (dto.accountNumber !== undefined) {
        updateData.accountNumber = dto.accountNumber;
        updateData.accountNumberMasked = maskAccountNumber(dto.accountNumber);
        updateData.verificationStatus = 'PENDING';
      }

      if (dto.ifscCode !== undefined) {
        updateData.ifsc = dto.ifscCode;
        updateData.verificationStatus = 'PENDING';
      }

      const acc = await this.repository.updateBankAccount(accountId, updateData, tx);

      await this.audit.record(
        {
          action: 'wallet.bank_account_update',
          entityType: 'worker_bank_account',
          entityId: accountId,
          actorId: userId,
          metadata: { isPrimary: acc.isPrimary },
        },
        tx,
      );

      return acc;
    });

    return toBankAccountResponse(updated);
  }

  async deleteBankAccount(userId: string, accountId: string): Promise<{ success: boolean }> {
    const workerId = await this.requireWorkerId(userId);
    const existing = await this.repository.findBankAccountById(accountId, workerId);

    if (!existing) {
      throw new DomainException(
        WalletErrorCode.BANK_ACCOUNT_NOT_FOUND,
        'Bank account not found',
        HttpStatus.NOT_FOUND,
      );
    }

    const inUse = await this.repository.hasActiveWithdrawals(accountId);
    if (inUse) {
      throw new DomainException(
        WalletErrorCode.BANK_ACCOUNT_IN_USE,
        'Cannot delete bank account with active withdrawals',
        HttpStatus.UNPROCESSABLE_ENTITY,
      );
    }

    if (existing.isPrimary) {
      const totalAccounts = await this.repository.countBankAccounts(workerId);
      if (totalAccounts > 1) {
        throw new DomainException(
          WalletErrorCode.CANNOT_DELETE_PRIMARY_ACCOUNT,
          'Cannot delete primary bank account while other accounts exist. Set another account as primary first.',
          HttpStatus.UNPROCESSABLE_ENTITY,
        );
      }
    }

    await this.repository.transaction(async (tx) => {
      await this.repository.softDeleteBankAccount(accountId, tx);
      await this.audit.record(
        {
          action: 'wallet.bank_account_delete',
          entityType: 'worker_bank_account',
          entityId: accountId,
          actorId: userId,
        },
        tx,
      );
    });

    return { success: true };
  }

  // --- Track C: Earnings Analytics ---

  async getAnalytics(
    userId: string,
    query: WalletAnalyticsQueryDto,
  ): Promise<WalletAnalyticsResponse> {
    const workerId = await this.requireWorkerId(userId);
    const { fromStr, toStr, fromDate, toDate } = getDateRangeForPeriod(
      query.period,
      query.from,
      query.to,
    );

    const [wagePayments, attendanceRecords, categories] = await Promise.all([
      this.repository.listCountedWagePayments(workerId, fromDate, toDate),
      this.repository.listCompletedAttendance(workerId, fromDate, toDate),
      this.repository.listServiceCategories(),
    ]);

    const categoryMap = new Map(
      categories.map((c) => [
        c.id,
        {
          code: c.code,
          name: CATEGORY_DISPLAY_NAMES[c.code] ?? c.name,
        },
      ]),
    );

    // Group daily metrics
    const dailyMap = new Map<string, { earningsMinor: number; shiftsCount: number }>();

    let totalEarningsMinor = 0;
    for (const payment of wagePayments) {
      totalEarningsMinor += payment.amountMinor;
      const day = toIndiaDateString(payment.recordedAt);
      const curr = dailyMap.get(day) ?? { earningsMinor: 0, shiftsCount: 0 };
      curr.earningsMinor += payment.amountMinor;
      dailyMap.set(day, curr);
    }

    let completedShiftsCount = 0;
    for (const attendance of attendanceRecords) {
      completedShiftsCount += 1;
      const day = toIndiaDateString(attendance.date);
      const curr = dailyMap.get(day) ?? { earningsMinor: 0, shiftsCount: 0 };
      curr.shiftsCount += 1;
      dailyMap.set(day, curr);
    }

    const dailyEarnings: DailyEarningsItem[] = Array.from(dailyMap.entries())
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([date, data]) => ({
        date,
        earningsMinor: data.earningsMinor,
        shiftsCount: data.shiftsCount,
      }));

    // Group category metrics
    const categoryTotals = new Map<
      string,
      { earningsMinor: number; completedShiftsCount: number }
    >();

    for (const payment of wagePayments) {
      const catId = payment.booking.categoryId;
      const curr = categoryTotals.get(catId) ?? { earningsMinor: 0, completedShiftsCount: 0 };
      curr.earningsMinor += payment.amountMinor;
      categoryTotals.set(catId, curr);
    }

    for (const attendance of attendanceRecords) {
      const catId = attendance.booking.categoryId;
      const curr = categoryTotals.get(catId) ?? { earningsMinor: 0, completedShiftsCount: 0 };
      curr.completedShiftsCount += 1;
      categoryTotals.set(catId, curr);
    }

    const categoryBreakdown: CategoryEarningsItem[] = Array.from(categoryTotals.entries()).map(
      ([catId, stats]) => {
        const catInfo = categoryMap.get(catId) ?? { code: 'UNKNOWN', name: 'Other Service' };
        const percentage =
          totalEarningsMinor > 0
            ? Math.round((stats.earningsMinor / totalEarningsMinor) * 10000) / 100
            : 0;
        return {
          categoryCode: catInfo.code,
          categoryName: catInfo.name,
          earningsMinor: stats.earningsMinor,
          completedShiftsCount: stats.completedShiftsCount,
          percentage,
        };
      },
    );

    return {
      period: query.period ?? 'THIS_MONTH',
      from: fromStr,
      to: toStr,
      currency: 'INR',
      totalEarningsMinor,
      completedShiftsCount,
      dailyEarnings,
      categoryBreakdown,
    };
  }

  // --- Track C2: Transactions ---

  async listTransactions(
    userId: string,
    query: WalletTransactionsQueryDto,
  ): Promise<Page<WalletTransactionItem>> {
    const workerId = await this.requireWorkerId(userId);

    // Map query type to ledger types
    let ledgerType: Parameters<typeof this.repository.listLedgerEntries>[0]['type'];
    if (query.type === 'CREDIT') {
      ledgerType = 'EARNING';
    } else if (query.type === 'DEBIT') {
      ledgerType = 'WITHDRAWAL_RESERVE';
    }

    let ledgerStatus: Parameters<typeof this.repository.listLedgerEntries>[0]['status'];
    if (query.status === 'SETTLED') ledgerStatus = 'COMPLETED';
    else if (query.status === 'PENDING') ledgerStatus = 'PENDING';
    else if (query.status === 'FAILED' || query.status === 'REVERSED') ledgerStatus = 'CANCELLED';

    const { items, total } = await this.repository.listLedgerEntries(
      {
        workerId,
        type: ledgerType,
        status: ledgerStatus,
      },
      skipFor(query),
      query.limit,
    );

    return {
      data: items.map((item) => {
        const isCredit =
          item.type === 'EARNING' || item.type === 'ADJUSTMENT' || item.type === 'EARNING_RELEASE';
        const type: 'CREDIT' | 'DEBIT' = isCredit ? 'CREDIT' : 'DEBIT';
        const status: 'PENDING' | 'SETTLED' | 'FAILED' | 'REVERSED' =
          item.status === 'COMPLETED'
            ? 'SETTLED'
            : item.status === 'PENDING'
              ? 'PENDING'
              : 'FAILED';

        return {
          id: item.id,
          amountMinor: item.amountMinor,
          currency: item.currency,
          type,
          status,
          description: item.description ?? 'Wallet Transaction',
          referenceType: item.referenceType ?? 'LEDGER',
          referenceId: item.referenceId,
          createdAt: item.createdAt,
        };
      }),
      meta: {
        page: query.page,
        limit: query.limit,
        total,
      },
    };
  }

  // --- Track D & D2: Withdrawals & Payouts ---

  async requestWithdrawal(userId: string, dto: CreateWithdrawalDto): Promise<WithdrawalResponse> {
    const workerId = await this.requireWorkerId(userId);

    if (dto.amountMinor < MIN_WITHDRAWAL_MINOR) {
      throw new DomainException(
        WalletErrorCode.MINIMUM_WITHDRAWAL_REQUIRED,
        `Withdrawal amount must be at least ₹${MIN_WITHDRAWAL_MINOR / 100}`,
        HttpStatus.BAD_REQUEST,
        [{ field: 'amountMinor', messages: [`minimum is ${MIN_WITHDRAWAL_MINOR}`] }],
      );
    }

    const bankAccount = await this.repository.findBankAccountById(dto.bankAccountId, workerId);
    if (!bankAccount) {
      throw new DomainException(
        WalletErrorCode.BANK_ACCOUNT_NOT_FOUND,
        'Selected bank account not found or does not belong to you',
        HttpStatus.NOT_FOUND,
      );
    }

    if (bankAccount.verificationStatus === 'REJECTED') {
      throw new DomainException(
        WalletErrorCode.BANK_ACCOUNT_NOT_VERIFIED,
        'Cannot withdraw to a rejected bank account',
        HttpStatus.UNPROCESSABLE_ENTITY,
      );
    }

    if (dto.idempotencyKey) {
      const existing = await this.repository.findWithdrawalByIdempotency(
        workerId,
        dto.idempotencyKey,
      );
      if (existing) {
        return toWithdrawalResponse(existing);
      }
    }

    // Ensure wallet exists before locking
    await this.repository.getOrCreateWallet(workerId);

    const withdrawal = await this.repository.transaction(async (tx) => {
      const lockedWallet = await this.repository.lockWallet(workerId, tx);
      if (!lockedWallet) {
        throw new DomainException(
          ErrorCode.INTERNAL_ERROR,
          'Failed to lock worker wallet',
          HttpStatus.INTERNAL_SERVER_ERROR,
        );
      }

      if (lockedWallet.availableBalanceMinor < dto.amountMinor) {
        throw new DomainException(
          WalletErrorCode.INSUFFICIENT_BALANCE,
          'Insufficient available balance for withdrawal',
          HttpStatus.UNPROCESSABLE_ENTITY,
          [
            {
              field: 'amountMinor',
              messages: [
                `Available balance is ${lockedWallet.availableBalanceMinor}, requested ${dto.amountMinor}`,
              ],
            },
          ],
        );
      }

      const newAvailable = lockedWallet.availableBalanceMinor - dto.amountMinor;
      await this.repository.updateWalletBalances(
        workerId,
        { availableBalanceMinor: newAvailable },
        tx,
      );

      const maskedDescription = `${bankAccount.bankName} (${bankAccount.accountNumberMasked})`;

      const created = await this.repository.createWithdrawal(
        {
          walletId: lockedWallet.id,
          workerId,
          bankAccountId: bankAccount.id,
          amountMinor: dto.amountMinor,
          currency: 'INR',
          bankAccountMasked: maskedDescription,
          idempotencyKey: dto.idempotencyKey ?? null,
        },
        tx,
      );

      await this.repository.createLedgerEntry(
        {
          walletId: lockedWallet.id,
          workerId,
          type: 'WITHDRAWAL_RESERVE',
          status: 'COMPLETED',
          amountMinor: dto.amountMinor,
          currency: 'INR',
          referenceType: 'WITHDRAWAL',
          referenceId: created.id,
          description: `Withdrawal request to ${maskedDescription}`,
          idempotencyKey: dto.idempotencyKey ? `ledger-${dto.idempotencyKey}` : null,
        },
        tx,
      );

      await this.audit.record(
        {
          action: 'wallet.withdrawal_request',
          entityType: 'worker_withdrawal',
          entityId: created.id,
          actorId: userId,
          metadata: {
            amountMinor: dto.amountMinor,
            bankAccountId: bankAccount.id,
            remainingBalanceMinor: newAvailable,
          },
        },
        tx,
      );

      return created;
    });

    return toWithdrawalResponse(withdrawal);
  }

  async listPayouts(userId: string, query: PayoutListQueryDto): Promise<Page<WithdrawalResponse>> {
    const workerId = await this.requireWorkerId(userId);

    const { items, total } = await this.repository.listWithdrawals(
      {
        workerId,
        status: query.status,
      },
      skipFor(query),
      query.limit,
    );

    return {
      data: items.map(toWithdrawalResponse),
      meta: {
        page: query.page,
        limit: query.limit,
        total,
      },
    };
  }

  async getPayout(userId: string, payoutId: string): Promise<WithdrawalResponse> {
    const workerId = await this.requireWorkerId(userId);
    const payout = await this.repository.findWithdrawalById(payoutId, workerId);

    if (!payout) {
      throw new DomainException(
        WalletErrorCode.PAYOUT_NOT_FOUND,
        'Payout not found',
        HttpStatus.NOT_FOUND,
      );
    }

    return toWithdrawalResponse(payout);
  }
}

// --- Helpers ---

function toBankAccountResponse(account: WorkerBankAccount): WorkerBankAccountResponse {
  return {
    id: account.id,
    accountHolderName: account.accountHolderName,
    bankName: account.bankName,
    accountNumberMasked: account.accountNumberMasked,
    ifscCode: account.ifsc,
    verificationStatus: account.verificationStatus,
    isPrimary: account.isPrimary,
    createdAt: account.createdAt,
    updatedAt: account.updatedAt,
  };
}

function toWithdrawalResponse(withdrawal: WorkerWithdrawal): WithdrawalResponse {
  return {
    id: withdrawal.id,
    amountMinor: withdrawal.amountMinor,
    currency: withdrawal.currency,
    status: withdrawal.status,
    bankAccountId: withdrawal.bankAccountId,
    bankAccountMasked: withdrawal.bankAccountMasked,
    failureReason: withdrawal.failureReason,
    requestedAt: withdrawal.createdAt,
    processedAt: withdrawal.processedAt,
  };
}

function toIndiaDateString(date: Date): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Kolkata',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(date);
}

function getDateRangeForPeriod(
  period: AnalyticsPeriodValue = 'THIS_MONTH',
  from?: string,
  to?: string,
): { fromStr: string; toStr: string; fromDate: Date; toDate: Date } {
  const todayStr = indiaToday();
  const todayParts = todayStr.split('-').map(Number);
  const year = todayParts[0];
  const month = todayParts[1];

  let fromStr = todayStr;
  let toStr = todayStr;

  if (period === 'THIS_WEEK') {
    const todayDate = new Date(`${todayStr}T00:00:00.000+05:30`);
    const dayOfWeek = todayDate.getDay();
    const diffToMonday = dayOfWeek === 0 ? 6 : dayOfWeek - 1;
    const monday = new Date(todayDate.getTime() - diffToMonday * 24 * 60 * 60 * 1000);
    fromStr = toIndiaDateString(monday);
    toStr = todayStr;
  } else if (period === 'THIS_MONTH') {
    fromStr = `${year}-${String(month).padStart(2, '0')}-01`;
    toStr = todayStr;
  } else if (period === 'LAST_MONTH') {
    const lastMonthYear = month === 1 ? year - 1 : year;
    const lastMonth = month === 1 ? 12 : month - 1;
    const lastDay = new Date(Date.UTC(lastMonthYear, lastMonth, 0)).getUTCDate();
    fromStr = `${lastMonthYear}-${String(lastMonth).padStart(2, '0')}-01`;
    toStr = `${lastMonthYear}-${String(lastMonth).padStart(2, '0')}-${String(lastDay).padStart(2, '0')}`;
  } else if (period === 'ALL_TIME') {
    fromStr = '2020-01-01';
    toStr = todayStr;
  } else if (period === 'CUSTOM') {
    if (!from || !isRealDate(from)) {
      throw new DomainException(
        ErrorCode.VALIDATION_FAILED,
        'Request validation failed',
        HttpStatus.BAD_REQUEST,
        [
          {
            field: 'from',
            messages: ['from date is required and must be YYYY-MM-DD for CUSTOM period'],
          },
        ],
      );
    }
    if (!to || !isRealDate(to)) {
      throw new DomainException(
        ErrorCode.VALIDATION_FAILED,
        'Request validation failed',
        HttpStatus.BAD_REQUEST,
        [
          {
            field: 'to',
            messages: ['to date is required and must be YYYY-MM-DD for CUSTOM period'],
          },
        ],
      );
    }
    if (from > to) {
      throw new DomainException(
        ErrorCode.VALIDATION_FAILED,
        'Request validation failed',
        HttpStatus.BAD_REQUEST,
        [{ field: 'from', messages: ['from date must not be after to date'] }],
      );
    }
    fromStr = from;
    toStr = to;
  }

  const fromDate = new Date(`${fromStr}T00:00:00.000+05:30`);
  const toDate = new Date(`${toStr}T23:59:59.999+05:30`);

  return { fromStr, toStr, fromDate, toDate };
}
