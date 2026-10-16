import { Injectable } from '@nestjs/common';
import type { Prisma } from '../../generated/prisma/client';
import { PrismaService } from '../../infrastructure/database/prisma.service';
import type { WagePaymentMethodValue } from './dto/earnings.dto';

type Db = Prisma.TransactionClient | PrismaService;

export interface WagePaymentRow {
  id: string;
  bookingId: string;
  workerId: string;
  amountMinor: number;
  currency: string;
  periodLabel: string;
  method: WagePaymentMethodValue;
  referenceText: string;
  correctsId: string | null;
  isVoid: boolean;
  recordedByUserId: string;
  recordedAt: Date;
  superseded: boolean;
}

export interface NewWagePayment {
  bookingId: string;
  workerId: string;
  amountMinor: number;
  periodLabel: string;
  method: WagePaymentMethodValue;
  referenceText: string;
  correctsId?: string;
  isVoid?: boolean;
  recordedByUserId: string;
}

type Row = Prisma.WorkerPaymentReferenceGetPayload<{
  include: { correctedBy: { select: { id: true } } };
}>;

const INCLUDE = { correctedBy: { select: { id: true } } } as const;

/** Rows that count toward a worker's totals: nothing corrects them and they are not a cancelling row. */
const COUNTED: Prisma.WorkerPaymentReferenceWhereInput = {
  isVoid: false,
  correctedBy: { none: {} },
};

function toRow(r: Row): WagePaymentRow {
  return {
    id: r.id,
    bookingId: r.bookingId,
    workerId: r.workerId,
    amountMinor: r.amountMinor,
    currency: r.currency,
    periodLabel: r.periodLabel,
    method: r.method,
    referenceText: r.referenceText,
    correctsId: r.correctsId,
    isVoid: r.isVoid,
    recordedByUserId: r.recordedByUserId,
    recordedAt: r.recordedAt,
    superseded: r.correctedBy.length > 0,
  };
}

/** The only place that touches the worker_payment_references table. */
@Injectable()
export class EarningsRepository {
  constructor(private readonly prisma: PrismaService) {}

  transaction<T>(work: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
    return this.prisma.$transaction(work);
  }

  async create(input: NewWagePayment, tx: Prisma.TransactionClient): Promise<WagePaymentRow> {
    const created = await tx.workerPaymentReference.create({
      data: { ...input, isVoid: input.isVoid ?? false },
      include: INCLUDE,
    });
    return toRow(created);
  }

  async findById(id: string, db: Db = this.prisma): Promise<WagePaymentRow | null> {
    const row = await db.workerPaymentReference.findUnique({ where: { id }, include: INCLUDE });
    return row ? toRow(row) : null;
  }

  async listCountedForWorker(
    workerId: string,
    skip: number,
    take: number,
  ): Promise<{ items: WagePaymentRow[]; total: number; sumMinor: number }> {
    const where = { workerId, ...COUNTED };
    const [rows, total, sum] = await Promise.all([
      this.prisma.workerPaymentReference.findMany({
        where,
        include: INCLUDE,
        orderBy: [{ recordedAt: 'desc' }, { id: 'desc' }],
        skip,
        take,
      }),
      this.prisma.workerPaymentReference.count({ where }),
      this.prisma.workerPaymentReference.aggregate({ where, _sum: { amountMinor: true } }),
    ]);
    return { items: rows.map(toRow), total, sumMinor: sum._sum.amountMinor ?? 0 };
  }

  async listAll(
    filter: { workerId?: string; bookingId?: string },
    skip: number,
    take: number,
  ): Promise<{ items: WagePaymentRow[]; total: number }> {
    const where: Prisma.WorkerPaymentReferenceWhereInput = {
      ...(filter.workerId ? { workerId: filter.workerId } : {}),
      ...(filter.bookingId ? { bookingId: filter.bookingId } : {}),
    };
    const [rows, total] = await Promise.all([
      this.prisma.workerPaymentReference.findMany({
        where,
        include: INCLUDE,
        orderBy: [{ recordedAt: 'desc' }, { id: 'desc' }],
        skip,
        take,
      }),
      this.prisma.workerPaymentReference.count({ where }),
    ]);
    return { items: rows.map(toRow), total };
  }
}
