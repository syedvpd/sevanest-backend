import { HttpStatus, Injectable } from '@nestjs/common';
import { AuditService } from '../../common/audit/audit.service';
import { DomainException } from '../../common/errors/domain.exception';
import { isUniqueViolation } from '../../common/errors/prisma-errors';
import { Page, skipFor } from '../../common/pagination/pagination';
import type { PageQueryDto } from '../../common/pagination/pagination';
import { BookingService } from '../booking/booking.service';
import type {
  AdminWagePaymentQuery,
  AdminWagePaymentView,
  RecordWagePaymentDto,
  VoidWagePaymentDto,
  WagePaymentView,
  WorkerEarningsView,
} from './dto/earnings.dto';
import { EarningsRepository, type WagePaymentRow } from './earnings.repository';

export const EarningsErrorCode = {
  WAGE_PAYMENT_NOT_FOUND: 'WAGE_PAYMENT_NOT_FOUND',
  NO_WORKER_ASSIGNED: 'NO_WORKER_ASSIGNED',
  BOOKING_NOT_STARTED: 'BOOKING_NOT_STARTED',
  WAGE_PAYMENT_ALREADY_CORRECTED: 'WAGE_PAYMENT_ALREADY_CORRECTED',
  WAGE_PAYMENT_IS_VOID: 'WAGE_PAYMENT_IS_VOID',
} as const;

export interface EarningsActor {
  userId: string;
  roles: string[];
}

/** A wage can only have been paid for work that started. */
const PAYABLE_STATUSES = new Set(['ACTIVE', 'REPLACEMENT_REQUESTED', 'REPLACED', 'COMPLETED']);

/**
 * Worker earnings reference (FR-WJ-008, DEC-05). V1 is not payroll: the platform never pays or calculates wages. Staff record that a
 * customer paid a worker off-platform (amount, period label, method, reference text); the worker sees those entries and their total, read
 * only. Entries are append-only (database trigger): a mistake is fixed by a new row that corrects or voids the old one, and every write is audited.
 */
@Injectable()
export class EarningsService {
  constructor(
    private readonly repository: EarningsRepository,
    private readonly bookings: BookingService,
    private readonly audit: AuditService,
  ) {}

  async record(
    bookingId: string,
    dto: RecordWagePaymentDto,
    actor: EarningsActor,
  ): Promise<AdminWagePaymentView> {
    const booking = await this.bookings.getRequirement(bookingId);
    if (!booking.workerId) {
      throw new DomainException(
        EarningsErrorCode.NO_WORKER_ASSIGNED,
        'This booking has no worker, so there is nobody to record a payment for',
        HttpStatus.CONFLICT,
      );
    }
    if (!PAYABLE_STATUSES.has(booking.status)) {
      throw new DomainException(
        EarningsErrorCode.BOOKING_NOT_STARTED,
        'A wage payment can only be recorded for a booking that has started',
        HttpStatus.CONFLICT,
      );
    }
    const workerId = booking.workerId;
    const row = await this.repository.transaction(async (tx) => {
      const created = await this.repository.create(
        { ...dto, bookingId, workerId, recordedByUserId: actor.userId },
        tx,
      );
      await this.auditRow('earnings.wage_payment_recorded', created, actor, tx);
      return created;
    });
    return this.adminView(row);
  }

  /** A new row replaces the old one in the totals; the old one stays as history. Answers 409 when it was already corrected or voided. */
  async correct(
    id: string,
    dto: RecordWagePaymentDto,
    actor: EarningsActor,
  ): Promise<AdminWagePaymentView> {
    const original = await this.requireOriginal(id);
    return this.replaceWith(
      original,
      { ...dto, isVoid: false },
      'earnings.wage_payment_corrected',
      actor,
    );
  }

  async voidEntry(
    id: string,
    dto: VoidWagePaymentDto,
    actor: EarningsActor,
  ): Promise<AdminWagePaymentView> {
    const original = await this.requireOriginal(id);
    return this.replaceWith(
      original,
      {
        amountMinor: original.amountMinor,
        periodLabel: original.periodLabel,
        method: original.method,
        referenceText: dto.reason,
        isVoid: true,
      },
      'earnings.wage_payment_voided',
      actor,
    );
  }

  async listForAdmin(query: AdminWagePaymentQuery): Promise<Page<AdminWagePaymentView>> {
    const { items, total } = await this.repository.listAll(
      { workerId: query.workerId, bookingId: query.bookingId },
      skipFor(query),
      query.limit,
    );
    return {
      data: items.map((r) => this.adminView(r)),
      meta: { page: query.page, limit: query.limit, total },
    };
  }

  /** The worker's own counted entries (newest first) and the total of ALL of them. Another worker's rows are unreachable by construction. */
  async listForWorker(workerId: string, query: PageQueryDto): Promise<WorkerEarningsView> {
    const { items, total, sumMinor } = await this.repository.listCountedForWorker(
      workerId,
      skipFor(query),
      query.limit,
    );
    return {
      data: items.map((r) => this.workerView(r)),
      meta: { page: query.page, limit: query.limit, total },
      totals: { currency: 'INR', amountMinor: sumMinor, paymentCount: total },
    };
  }

  private async requireOriginal(id: string): Promise<WagePaymentRow> {
    const row = await this.repository.findById(id);
    if (!row) {
      throw new DomainException(
        EarningsErrorCode.WAGE_PAYMENT_NOT_FOUND,
        'Wage payment entry not found',
        HttpStatus.NOT_FOUND,
      );
    }
    if (row.isVoid) {
      throw new DomainException(
        EarningsErrorCode.WAGE_PAYMENT_IS_VOID,
        'This entry only cancels an earlier one and cannot be corrected',
        HttpStatus.CONFLICT,
      );
    }
    return row;
  }

  private async replaceWith(
    original: WagePaymentRow,
    change: Pick<
      Parameters<EarningsRepository['create']>[0],
      'amountMinor' | 'periodLabel' | 'method' | 'referenceText' | 'isVoid'
    >,
    action: string,
    actor: EarningsActor,
  ): Promise<AdminWagePaymentView> {
    try {
      const row = await this.repository.transaction(async (tx) => {
        const created = await this.repository.create(
          {
            ...change,
            bookingId: original.bookingId,
            workerId: original.workerId,
            correctsId: original.id,
            recordedByUserId: actor.userId,
          },
          tx,
        );
        await this.auditRow(action, created, actor, tx);
        return created;
      });
      return this.adminView(row);
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new DomainException(
          EarningsErrorCode.WAGE_PAYMENT_ALREADY_CORRECTED,
          'This entry was already corrected or voided; correct the newer entry instead',
          HttpStatus.CONFLICT,
        );
      }
      throw error;
    }
  }

  private auditRow(
    action: string,
    row: WagePaymentRow,
    actor: EarningsActor,
    tx: Parameters<Parameters<EarningsRepository['transaction']>[0]>[0],
  ): Promise<void> {
    return this.audit.record(
      {
        action,
        entityType: 'worker_payment_reference',
        entityId: row.id,
        actorId: actor.userId,
        actorRole: actor.roles.join(',') || null,
        // The reference text is free text from staff: it stays out of the audit log.
        metadata: {
          bookingId: row.bookingId,
          workerId: row.workerId,
          amountMinor: row.amountMinor,
          method: row.method,
          periodLabel: row.periodLabel,
          correctsId: row.correctsId,
          isVoid: row.isVoid,
        },
      },
      tx,
    );
  }

  private workerView(r: WagePaymentRow): WagePaymentView {
    return {
      id: r.id,
      bookingId: r.bookingId,
      amountMinor: r.amountMinor,
      currency: r.currency,
      periodLabel: r.periodLabel,
      method: r.method,
      referenceText: r.referenceText,
      recordedAt: r.recordedAt,
    };
  }

  private adminView(r: WagePaymentRow): AdminWagePaymentView {
    return {
      ...this.workerView(r),
      workerId: r.workerId,
      recordedByUserId: r.recordedByUserId,
      correctsId: r.correctsId,
      isVoid: r.isVoid,
      superseded: r.superseded,
    };
  }
}
